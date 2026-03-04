# @coffeexdev/openclaw-sentinel

Secure, declarative, gateway-native background watcher plugin for OpenClaw.

## Quick start (OpenClaw users)

If you only read one section, read this.

### 1) Install plugin

```bash
openclaw plugins install @coffeexdev/openclaw-sentinel
```

### 2) Configure Sentinel

Add/update `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          // Required: watchers can only call endpoints on these hosts.
          allowedHosts: ["api.github.com", "api.coingecko.com"],

          // Default dispatch base for internal webhook callbacks.
          localDispatchBase: "http://127.0.0.1:18789",

          // Optional: where /hooks/sentinel events are queued in the LLM loop.
          hookSessionKey: "agent:main:main",

          // Optional: bearer token used for dispatch calls back to gateway.
          // Set this to your gateway auth token when gateway auth is enabled.
          // dispatchAuthToken: "<gateway-token>"
        },
      },
    },
  },
}
```

### 3) Restart gateway

```bash
openclaw gateway restart
```

### Troubleshooting: `Unrecognized key: "sentinel"`

If gateway startup/validation reports:

```text
Unrecognized key: "sentinel"
```

your config is using the old root-level shape. Move Sentinel config under:

- `plugins.entries.openclaw-sentinel.config`

Sentinel also logs a runtime warning when that legacy root key is still observable, but it never writes a root-level `sentinel` key.

### 4) Create your first watcher (`sentinel_control`)

```json
{
  "action": "create",
  "watcher": {
    "id": "eth-price-watch",
    "skillId": "skills.alerts",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    "intervalMs": 15000,
    "match": "all",
    "conditions": [{ "path": "ethereum.usd", "op": "gte", "value": 5000 }],
    "fire": {
      "webhookPath": "/hooks/sentinel",
      "eventName": "eth_target_hit",
      "intent": "price_threshold_review",
      "contextTemplate": {
        "asset": "ETH",
        "priceUsd": "${payload.ethereum.usd}",
        "workflow": "alerts"
      },
      "priority": "high",
      "deadlineTemplate": "${timestamp}",
      "payloadTemplate": {
        "event": "${event.name}",
        "price": "${payload.ethereum.usd}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 500, "maxMs": 15000 },
    "fireOnce": true
  }
}
```

### 5) Verify

Use `sentinel_control`:

```json
{ "action": "list" }
```

```json
{ "action": "status", "id": "eth-price-watch" }
```

---

## What happens when a watcher fires?

1. Sentinel evaluates conditions.
2. On match, it dispatches a generic callback envelope (`type: "sentinel.callback"`) to `localDispatchBase + webhookPath`.
3. The envelope includes stable keys (`intent`, `context`, `watcher`, `trigger`, bounded `payload`, `deliveryTargets`, `source`) so downstream agent behavior is workflow-agnostic.
4. It also sends a notification message to each configured `deliveryTargets` destination (defaults to the current chat context when watcher is created from a channel session).
5. For `/hooks/sentinel`, the plugin route enqueues an instruction-prefixed system event plus structured JSON envelope and requests heartbeat wake.
6. OpenClaw wakes and processes that event in the configured session (`hookSessionKey`, default `agent:main:main`).

The `/hooks/sentinel` route is auto-registered on plugin startup (idempotent).

Sample emitted envelope:

```json
{
  "type": "sentinel.callback",
  "version": "1",
  "intent": "price_threshold_review",
  "actionable": true,
  "watcher": { "id": "eth-price-watch", "skillId": "skills.alerts", "eventName": "eth_target_hit" },
  "trigger": {
    "matchedAt": "2026-03-04T15:00:00.000Z",
    "dedupeKey": "<sha256>",
    "priority": "high"
  },
  "context": { "asset": "ETH", "priceUsd": 5001, "workflow": "alerts" },
  "payload": { "ethereum": { "usd": 5001 } },
  "deliveryTargets": [{ "channel": "telegram", "to": "5613673222" }],
  "source": { "plugin": "openclaw-sentinel", "route": "/hooks/sentinel" }
}
```

## Why Sentinel

Sentinel runs watcher lifecycles inside the gateway with fixed strategies and declarative conditions.
It **does not** execute user-authored code from watcher definitions.

## Features

- Tool registration: `sentinel_control`
  - actions: `create` (`add`), `enable`, `disable`, `remove` (`delete`), `status` (`get`), `list`
- Strict schema validation (TypeBox, strict object checks) + code-like field/value rejection
- Strategies:
  - `http-poll`
  - `websocket`
  - `sse`
  - `http-long-poll`
- Condition operators:
  - `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `exists`, `absent`, `contains`, `matches`, `changed`
- Match mode: `all` / `any`
- Fire templating: substitution-only placeholders, non-Turing-complete
- Local webhook dispatch model (no outbound custom fire URL)
- Default callback route: `/hooks/sentinel` (auto-registered)
- Persistence: `~/.openclaw/sentinel-state.json`
- Resource limits and per-skill limits
- `allowedHosts` endpoint enforcement
- CLI surface: `list`, `status`, `enable`, `disable`, `audit`

## Tool input example (`sentinel_control:create`)

```json
{
  "action": "create",
  "watcher": {
    "id": "sentinel-alert",
    "skillId": "skills.general-monitor",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.github.com/events",
    "intervalMs": 15000,
    "match": "any",
    "conditions": [{ "path": "type", "op": "eq", "value": "PushEvent" }],
    "fire": {
      "webhookPath": "/hooks/sentinel",
      "eventName": "sentinel_push",
      "payloadTemplate": {
        "watcher": "${watcher.id}",
        "event": "${event.name}",
        "type": "${payload.type}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 250, "maxMs": 5000 },
    "deliveryTargets": [
      { "channel": "telegram", "to": "5613673222" },
      { "channel": "discord", "to": "123456789012345678", "accountId": "main" }
    ]
  }
}
```

`deliveryTargets` is optional. If omitted on `create`, Sentinel infers a default target from the current tool/session context (channel + current peer).

## Runtime controls

```json
{ "action": "status", "id": "sentinel-alert" }
```

```json
{ "action": "disable", "id": "sentinel-alert" }
```

```json
{ "action": "remove", "id": "sentinel-alert" }
```

## JSON Schema

Formal JSON Schema for sentinel config/watchers:

- `schema/sentinel.schema.json`

## Documentation

- [Usage Guide](docs/USAGE.md)

## CLI

```bash
openclaw-sentinel list
openclaw-sentinel status <watcher-id>
openclaw-sentinel enable <watcher-id>
openclaw-sentinel disable <watcher-id>
openclaw-sentinel audit
```

## Development

```bash
pnpm install
pnpm run lint
pnpm test
pnpm run build
```

## License

MIT
