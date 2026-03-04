# OpenClaw Sentinel Usage Guide

This guide shows practical ways to use `@coffeexdev/openclaw-sentinel` in OpenClaw and skill-driven flows.

## 1) Install + Enable

```bash
openclaw plugins install @coffeexdev/openclaw-sentinel
openclaw gateway restart
```

In config, you **must** set `allowedHosts` — no hosts are allowed by default. Watchers can only connect to explicitly listed hostnames:

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        enabled: true,
        config: {
          allowedHosts: ["api.github.com", "api.coingecko.com", "status.example.com"],
          localDispatchBase: "http://127.0.0.1:18789",
          hookSessionPrefix: "agent:main:hooks:sentinel",
          hookRelayDedupeWindowMs: 120000,
          notificationPayloadMode: "concise",
          // optional legacy alias (supported): hookSessionKey: "agent:main:hooks:sentinel",
        },
      },
    },
  },
}
```

### Troubleshooting: `Unrecognized key: "sentinel"`

If config validation says `Unrecognized key: "sentinel"`, you are using the legacy root-level key.
Move the config to `plugins.entries.openclaw-sentinel.config`.

---

`/hooks/sentinel` payload notes:

- Send a JSON object.
- Preferred shape is a callback envelope (`type: "sentinel.callback"`).
- Sentinel prepends instructions for the agent to interpret intent/context, apply policy, act, and notify configured targets.
- Callback processing is isolated by watcher session by default (`...:watcher:<id>`), with optional explicit grouping via `hookSessionGroup`.
- Legacy `text`/`message` payloads remain supported for backward compatibility.

Example structured wake event text:

```text
SENTINEL_TRIGGER: This system event came from /hooks/sentinel. Evaluate action policy, decide whether to notify configured deliveryTargets, and execute safe follow-up actions.
SENTINEL_ENVELOPE_JSON:
{
  "type": "sentinel.callback",
  "version": "1",
  "intent": "service_health_triage",
  "actionable": true,
  "watcher": { "id": "status-watch", "skillId": "skills.ops", "eventName": "service_degraded" },
  "trigger": { "matchedAt": "2026-03-04T14:12:00.000Z", "dedupeKey": "4f3f2bd2ce1a57cd", "priority": "high" },
  "context": { "component": "api", "status": "degraded", "runbook": "ops-degraded-service" },
  "payload": { "component": "api", "status": "degraded" },
  "deliveryTargets": [{ "channel": "telegram", "to": "5613673222" }],
  "source": { "route": "/hooks/sentinel", "plugin": "openclaw-sentinel" }
}
```

Agent interpretation guidance: treat this as a sentinel trigger, evaluate action policy against the envelope context, and only notify/act using the declared targets and safe tool policy.

## 2) Basic watcher creation (agent tool)

Create a watcher via `sentinel_control`:

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
      "intent": "service_health_triage",
      "contextTemplate": {
        "component": "${payload.component}",
        "status": "${payload.status}",
        "runbook": "ops-degraded-service"
      },
      "priority": "high",
      "sessionGroup": "ops-degraded",
      "payloadTemplate": {
        "event": "${event.name}",
        "component": "${payload.component}",
        "status": "${payload.status}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 8, "baseMs": 500, "maxMs": 30000 }
  }
}
```

### Hook-session routing notes

- `/hooks/sentinel` callbacks are routed to isolated sessions by default: `hookSessionPrefix:watcher:<watcher-id>`.
- To intentionally group multiple watchers into one isolated session, set either:
  - plugin config: `hookSessionGroup`, or
  - per-watcher: `watcher.fire.sessionGroup` (wins over config default).
- Shared global callback sessions are intentionally not supported.

---

## 3) Delivery targets (default + override)

By default, when you create a watcher via `sentinel_control` in a channel session, Sentinel stores a delivery target for that current chat context.

You can override with explicit `deliveryTargets` (supports multiple destinations):

```json
{
  "action": "create",
  "watcher": {
    "id": "status-watch-multi",
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
      "payloadTemplate": { "event": "${event.name}", "status": "${payload.status}" }
    },
    "retry": { "maxRetries": 8, "baseMs": 500, "maxMs": 30000 },
    "deliveryTargets": [
      { "channel": "telegram", "to": "5613673222" },
      { "channel": "discord", "to": "123456789012345678", "accountId": "main" }
    ]
  }
}
```

---

## 4) Notification payload modes (global + per-watcher override)

Sentinel always dispatches the callback envelope on match.
`notificationPayloadMode` only controls whether/how additional `deliveryTargets` messages are sent.

Global options:

- `"notificationPayloadMode": "none"` (suppress delivery-target messages)
- `"notificationPayloadMode": "concise"` (default relay line only)
- `"notificationPayloadMode": "debug"` (relay line + `SENTINEL_DEBUG_ENVELOPE_JSON` block)

Per watcher, override under `watcher.fire.notificationPayloadMode`:

```json
{
  "action": "create",
  "watcher": {
    "id": "status-watch-callback-only",
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
    "retry": { "maxRetries": 8, "baseMs": 500, "maxMs": 30000 },
    "deliveryTargets": [{ "channel": "telegram", "to": "5613673222" }]
  }
}
```

Allowed override values:

- `inherit` (or omitted): use global mode
- `none`: suppress delivery-target messages for this watcher
- `concise`: force concise output for this watcher
- `debug`: force debug envelope for this watcher

Precedence: **watcher override > global setting**.

Migration note: existing installs remain `concise` by default. Use `none` when you want callback-only behavior (including `/hooks/sentinel` wake + LLM loop) without extra delivery-target chat noise.

---

## 5) One-shot trigger (`fireOnce`)

Use `fireOnce: true` to dispatch once and auto-disable:

```json
{
  "action": "create",
  "watcher": {
    "id": "price-threshold-once",
    "skillId": "skills.alerts",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    "intervalMs": 15000,
    "match": "all",
    "conditions": [{ "path": "ethereum.usd", "op": "gte", "value": 5000 }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "eth_target_hit",
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

---

## 6) CI run completion monitor

```json
{
  "action": "create",
  "watcher": {
    "id": "ci-run-12345",
    "skillId": "skills.github",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.github.com/repos/owner/repo/actions/runs/12345",
    "headers": {
      "Authorization": "Bearer ${secrets.github_pat}",
      "Accept": "application/vnd.github+json"
    },
    "intervalMs": 30000,
    "match": "all",
    "conditions": [{ "path": "status", "op": "eq", "value": "completed" }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "ci_completed",
      "payloadTemplate": {
        "event": "${event.name}",
        "conclusion": "${payload.conclusion}",
        "url": "${payload.html_url}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 10, "baseMs": 1000, "maxMs": 60000 },
    "fireOnce": true
  }
}
```

---

## 7) Runtime control actions

Check status:

```json
{ "action": "status", "id": "status-watch" }
```

Disable:

```json
{ "action": "disable", "id": "status-watch" }
```

Remove:

```json
{ "action": "remove", "id": "status-watch" }
```

---

## 8) Skill integration pattern

Typical skill flow:

1. Skill creates watcher when user asks to monitor an external event.
2. Sentinel watches with zero token burn while idle.
3. On condition match, Sentinel dispatches webhook payload.
4. If routed to `/hooks/sentinel`, OpenClaw enqueues a system event and triggers heartbeat wake.
5. Agent wakes, acts, and optionally disables/removes watcher.

This pattern keeps the model active only at decision points.

---

## Callback envelope contract

On watcher match, Sentinel emits:

```json
{
  "type": "sentinel.callback",
  "version": "1",
  "intent": "service_health_triage",
  "actionable": true,
  "watcher": { "id": "status-watch", "skillId": "skills.ops", "eventName": "service_degraded" },
  "trigger": { "matchedAt": "<iso>", "dedupeKey": "<sha256>", "priority": "high" },
  "context": { "component": "api", "status": "degraded", "runbook": "ops-degraded-service" },
  "payload": { "...": "bounded/truncated when large" },
  "deliveryTargets": [],
  "source": { "plugin": "openclaw-sentinel", "route": "/hooks/agent" }
}
```

If `intent`/`contextTemplate` are omitted, Sentinel falls back to:

- `intent`: derived from `eventName`
- `context`: rendered `payloadTemplate` (or payload summary)
