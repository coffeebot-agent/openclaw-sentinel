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

          // Optional: base prefix for isolated /hooks/sentinel callback sessions.
          // Sentinel appends :watcher:<id> by default (or :group:<key> when grouped).
          hookSessionPrefix: "agent:main:hooks:sentinel",

          // Optional: default group key for callbacks without explicit hookSessionGroup.
          // hookSessionGroup: "ops-alerts",

          // Optional: suppress duplicate relays by dedupe key within this time window.
          hookRelayDedupeWindowMs: 120000,

          // Optional: guarantee hook-response delivery contract for /hooks/sentinel callbacks.
          // Wait this long for assistant-authored output before fallback behavior applies.
          hookResponseTimeoutMs: 30000,

          // Optional: timeout fallback relay mode for /hooks/sentinel response contracts.
          // "none" = no fallback message, "concise" = send a fail-safe relay line.
          hookResponseFallbackMode: "concise",

          // Optional: dedupe repeated callback response contracts by dedupe key.
          hookResponseDedupeWindowMs: 120000,

          // Optional: payload style for non-/hooks/sentinel deliveryTargets notifications.
          // "none" suppresses delivery-target message fan-out (callback still fires).
          // "concise" (default) sends human-friendly relay text only.
          // "debug" appends a structured sentinel envelope block for diagnostics.
          // notificationPayloadMode: "concise",

          // Optional legacy alias for hookSessionPrefix (still supported).
          // hookSessionKey: "agent:main:hooks:sentinel",

          // Optional: explicit bearer token override for dispatch calls back to gateway.
          // Sentinel auto-detects gateway auth token from runtime config when available,
          // so manual token copy is usually no longer required.
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

### Hardening notes (0.6 minor)

- `hookSessionKey` remains supported but is deprecated. If both are present, `hookSessionPrefix` now wins.
- HTTP watcher strategies now set `redirect: "error"` to prevent host-allowlist bypass via redirects.
- Watcher IDs are now constrained to `^[A-Za-z0-9_-]{1,128}$`.
- `/hooks/sentinel` validates JSON `Content-Type` when provided and returns `415` for unsupported media types.

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
      "sessionGroup": "portfolio-risk",
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
3. The envelope includes stable keys (`intent`, `context`, `watcher`, `trigger`, bounded `payload`, `deliveryTargets`, `deliveryContext`, `source`) so downstream agent behavior is workflow-agnostic.
4. For `/hooks/sentinel`, Sentinel enqueues an instruction-prefixed system event plus structured JSON envelope with a cron-tagged callback context, then requests an immediate `cron:sentinel-callback` wake (avoids heartbeat-poll prompting).
5. The hook route creates a **response-delivery contract** keyed by callback dedupe key, preserving original chat/session context (`deliveryContext`) and intended relay targets.
6. OpenClaw processes each callback in an isolated hook session: per-watcher by default, or grouped when `hookSessionGroup` / `fire.sessionGroup` is set. Shared global hook-session mode is intentionally not supported.
7. When hook-session LLM output arrives, Sentinel relays assistant-authored text to the original chat context. If no assistant output arrives before `hookResponseTimeoutMs`, optional fallback relay behavior is applied (`hookResponseFallbackMode`).

The `/hooks/sentinel` route is auto-registered on plugin startup (idempotent). Response contracts are dedupe-aware by callback dedupe key (`hookResponseDedupeWindowMs`).

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
  "deliveryContext": {
    "sessionKey": "agent:main:telegram:direct:5613673222",
    "messageChannel": "telegram",
    "requesterSenderId": "5613673222",
    "currentChat": { "channel": "telegram", "to": "5613673222" }
  },
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

## Notification payload delivery modes

Sentinel always dispatches the callback envelope to `localDispatchBase + webhookPath` on match.
`notificationPayloadMode` only controls **additional fan-out messages** to `deliveryTargets` for watcher dispatches (for example `/hooks/agent`).
It does **not** control `/hooks/sentinel` hook-response contracts or assistant-output relay behavior.

Global mode options:

- `none`: suppress delivery-target notification messages (callback dispatch still occurs)
- `concise` (default): send short relay text only
- `debug`: send relay text plus `SENTINEL_DEBUG_ENVELOPE_JSON` block

### 1) Global notifications disabled (`none`)

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          allowedHosts: ["api.github.com"],
          notificationPayloadMode: "none",
        },
      },
    },
  },
}
```

### 2) Global concise relay (default)

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          allowedHosts: ["api.github.com"],
          notificationPayloadMode: "concise",
        },
      },
    },
  },
}
```

### 3) Global debug diagnostics

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          allowedHosts: ["api.github.com"],
          notificationPayloadMode: "debug",
        },
      },
    },
  },
}
```

In debug mode, delivery notifications include the same concise relay line plus a `SENTINEL_DEBUG_ENVELOPE_JSON` block for diagnostics.

### 4) Per-watcher override (`watcher.fire.notificationPayloadMode`)

```json
{
  "action": "create",
  "watcher": {
    "id": "status-watch",
    "skillId": "skills.ops",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://status.example.com/api/health",
    "intervalMs": 10000,
    "match": "all",
    "conditions": [{ "path": "status", "op": "eq", "value": "degraded" }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "service_degraded",
      "notificationPayloadMode": "none",
      "payloadTemplate": { "event": "${event.name}", "status": "${payload.status}" }
    },
    "retry": { "maxRetries": 5, "baseMs": 250, "maxMs": 5000 }
  }
}
```

Allowed values:

- `inherit` (or omitted): follow global `notificationPayloadMode`
- `none`: suppress delivery-target notification messages for this watcher
- `concise`: force concise notification text for this watcher
- `debug`: force debug envelope output for this watcher

Precedence: **watcher override > global setting**.

### Migration notes

- Existing installs keep default behavior (`concise`) unless you set `notificationPayloadMode` explicitly.
- If you want callback-only operation (wake LLM loop via `/hooks/sentinel` but no delivery-target chat message), set global or per-watcher mode to `none`.

## Hook-response delivery contract (`/hooks/sentinel`)

`/hooks/sentinel` now enforces a dedicated trigger → LLM → user-visible relay contract:

1. Callback is enqueued to isolated hook session.
2. Contract captures original delivery context (`deliveryContext` + resolved `deliveryTargets`).
3. First assistant-authored `llm_output` for that pending callback is relayed to target chat.
4. If no assistant output arrives in time (`hookResponseTimeoutMs`), fallback is configurable:
   - `hookResponseFallbackMode: "concise"` (default) sends a short fail-safe relay.
   - `hookResponseFallbackMode: "none"` suppresses fallback.
5. Repeated callbacks with same dedupe key are idempotent within `hookResponseDedupeWindowMs`.

Example config:

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          allowedHosts: ["api.github.com"],
          hookResponseTimeoutMs: 30000,
          hookResponseFallbackMode: "concise",
          hookResponseDedupeWindowMs: 120000,
        },
      },
    },
  },
}
```

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
