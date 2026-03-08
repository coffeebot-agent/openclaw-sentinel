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
          hookResponseTimeoutMs: 30000,
          hookResponseFallbackMode: "concise",
          hookResponseDedupeWindowMs: 120000,
          notificationPayloadMode: "concise",
          // Optional explicit override; usually unnecessary because Sentinel auto-detects
          // gateway auth token from runtime config when available.
          // dispatchAuthToken: "<gateway-token>",
          // optional legacy alias (supported, deprecated): hookSessionKey: "agent:main:hooks:sentinel",
        },
      },
    },
  },
}
```

### Troubleshooting: `Unrecognized key: "sentinel"`

If config validation says `Unrecognized key: "sentinel"`, you are using the legacy root-level key.
Move the config to `plugins.entries.openclaw-sentinel.config`.

### Hardening behavior changes

- `hookSessionKey` remains supported but deprecated; if both are set, `hookSessionPrefix` takes precedence.
- HTTP-based strategies reject redirects (`redirect: "error"`) to prevent host allowlist bypass.
- Watcher IDs must match `^[A-Za-z0-9_-]{1,128}$`.
- `/hooks/sentinel` rejects unsupported `Content-Type` values with HTTP 415.

---

`/hooks/sentinel` payload notes:

- Send a JSON object.
- Preferred shape is a callback envelope (`type: "sentinel.callback"`).
- Sentinel prepends structured instructions for the agent to use watcher + payload context, apply policy, act safely, and return a user-facing response.
- Callback processing is isolated by watcher session by default (`...:watcher:<id>`), with optional explicit grouping via `hookSessionGroup`.
- Hook callbacks establish a response-delivery contract: `sentinel_act notify` is the sole delivery mechanism.
- If the LLM fails to call `sentinel_act` before the timeout, Sentinel sends a concise contextual fallback.
  Example structured wake event text:

```text
SENTINEL_TRIGGER: A sentinel watcher callback has fired. Analyze the callback and take appropriate action.

Instructions:
- Review the watcher intent, event payload, and operator goal (if present).
- Use sentinel_act to execute remediation actions when the situation calls for it.
- Use sentinel_act with action "notify" to send the result to delivery targets. This is the only way your response reaches the user.
- Use sentinel_escalate if the situation requires user attention or is beyond your ability to resolve.
- If escalating, also use sentinel_act notify to inform delivery targets of the escalation.
- Do not emit control tokens, routing directives, or internal processing notes in your text output.

SENTINEL_CALLBACK_JSON:
{
  "watcher": {
    "id": "status-watch",
    "skillId": "skills.ops",
    "eventName": "service_degraded",
    "intent": "service_health_triage",
    "strategy": "http-poll",
    "endpoint": "https://status.example.com/api/health",
    "match": "all",
    "conditions": [{ "path": "status", "op": "eq", "value": "degraded" }],
    "fireOnce": false,
    "tags": ["ops", "health"]
  },
  "trigger": { "matchedAt": "2026-03-04T14:12:00.000Z", "dedupeKey": "4f3f2bd2ce1a57cd", "priority": "high" },
  "source": { "route": "/hooks/sentinel", "plugin": "openclaw-sentinel" },
  "deliveryTargets": [{ "channel": "telegram", "to": "5613673222" }],
  "context": { "component": "api", "status": "degraded", "runbook": "ops-degraded-service" },
  "payload": { "component": "api", "status": "degraded" }
}
```

Agent interpretation guidance: treat this as a sentinel trigger, evaluate action policy against watcher+trigger+payload context, and only notify/act using the declared targets and safe tool policy.

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
      "operatorGoal": "Triage the degraded service, run safe remediation steps, and notify owners with status and next action.",
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

### `fire.operatorGoal` sizing guidance

- Default limit is `12000` chars (raised from `500`).
- Keep most goals concise (`200-2000` chars) and reserve very large goals for real runbook/policy context.
- You can tune the limit with plugin config `maxOperatorGoalChars` (hard capped at `20000`).
- Existing watchers under the old 500-char limit need no migration changes.

### `fire.operatorGoalFile` — runtime policy/config references

When policy values (bid caps, thresholds, tier lists, etc.) change frequently, hardcoding them into `operatorGoal` means watchers act on stale values until manually recreated.

`operatorGoalFile` solves this by pointing to a local file that Sentinel reads **fresh each time the watcher fires**. The file contents are injected into the callback envelope as `operatorGoalRuntimeContext`, ensuring the callback agent always uses current policy values.

**Example:** Separate static instructions from dynamic policy:

```json
{
  "action": "create",
  "watcher": {
    "id": "assembly-autobid",
    "skillId": "skills.defi",
    "enabled": true,
    "strategy": "evm-call",
    "endpoint": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    "intervalMs": 15000,
    "match": "all",
    "conditions": [{ "path": "resultNamed.settled", "op": "eq", "value": false }],
    "fire": {
      "webhookPath": "/hooks/sentinel",
      "eventName": "auction_active",
      "operatorGoal": "Evaluate the auction state and place a bid if appropriate. Follow the bidding policy from operatorGoalRuntimeContext for current caps and increment tiers.",
      "operatorGoalFile": "~/.openclaw/policies/bidding-policy.json",
      "payloadTemplate": {
        "event": "${event.name}",
        "highestBid": "${payload.resultNamed.highestBid}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 500, "maxMs": 15000 },
    "evmCall": {
      "to": "0x1234567890abcdef1234567890abcdef12345678",
      "signature": "function auction() view returns (uint256 highestBid, bool settled)"
    }
  }
}
```

The policy file (`~/.openclaw/policies/bidding-policy.json`):

```json
{
  "maxBidUsd": 50,
  "incrementTiers": [1, 5, 10],
  "cooldownSeconds": 30
}
```

When the policy changes (e.g., raising `maxBidUsd` to `75`), just update the file — no watcher recreation needed.

**Behavior notes:**

- Path must be absolute (`/...`) or tilde-prefixed (`~/...`).
- If the file cannot be read (missing, permissions), the dispatch proceeds without `operatorGoalRuntimeContext` and a warning is logged.
- File content is truncated to `maxOperatorGoalChars` (default `12000`).
- `operatorGoalFile` complements `operatorGoal` — use `operatorGoal` for static instructions and `operatorGoalFile` for dynamic policy values.

### `fire.model` — per-watcher hook session model selection

Sentinel hook sessions inherit the agent's default model. When the default is expensive (e.g., opus), every callback — even trivial "skip, no action" decisions — burns premium tokens.

**Per-watcher override:** Set `fire.model` to use a specific model for that watcher's hook sessions:

```json
{
  "fire": {
    "eventName": "price_check",
    "payloadTemplate": { "price": "${payload.price}" },
    "model": "anthropic/claude-sonnet-4-20250514"
  }
}
```

**Global default:** Set `defaultHookModel` in plugin config to override the agent default for all sentinel hook sessions:

```json5
{
  plugins: {
    entries: {
      "openclaw-sentinel": {
        config: {
          allowedHosts: ["api.example.com"],
          defaultHookModel: "anthropic/claude-sonnet-4-20250514",
        },
      },
    },
  },
}
```

**Resolution order:**

1. Per-watcher `fire.model` (highest priority)
2. Plugin config `defaultHookModel`
3. Agent's default model (current behavior, lowest priority)

**Use case:** An agent running opus as its primary model has sentinel watchers for auction monitoring. 95% of callbacks are "no change, skip" — these don't need opus-level reasoning. Set `defaultHookModel` to sonnet, and override individual high-stakes watchers with `fire.model: "anthropic/claude-opus-4-0"`.

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
`notificationPayloadMode` only controls whether/how additional `deliveryTargets` messages are sent for watcher fire fan-out.
`/hooks/sentinel` assistant-response relay and timeout fallback are controlled separately by `hookResponse*` settings.

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

## 5) Hook-response delivery contract (`/hooks/sentinel`)

For `/hooks/sentinel`, Sentinel tracks callback-triggered response contracts separately from notification payload mode.

Config knobs:

- `hookResponseTimeoutMs` — wait window for `sentinel_act` call before timeout fallback (default `30000`).
- `hookResponseFallbackMode` — timeout behavior: `concise` (default fail-safe relay) or `none`.
- `hookResponseDedupeWindowMs` — dedupe/idempotency window for repeated callback dedupe keys.
- `maxOperatorGoalChars` — watcher `fire.operatorGoal` limit (default `12000`, min `500`, max `20000`).
- `defaultHookModel` — default LLM model for all hook sessions (provider/model format). Per-watcher `fire.model` takes precedence.

Flow:

1. Callback is enqueued to isolated hook session.
2. Contract stores original delivery context (`deliveryTargets` and/or `deliveryContext`).
3. The LLM calls `sentinel_act notify` to deliver results to targets (sole delivery mechanism).
4. Any successful `sentinel_act` call fulfills the relay contract and cancels the timeout timer.
5. If no `sentinel_act` call arrives by timeout, optional concise timeout fallback relay is sent.
6. Duplicate callbacks with same dedupe key inside dedupe window are ignored for extra relay contracts.

---

## 6) One-shot trigger (`fireOnce`)

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

## 7) CI run completion monitor

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

## 8) HTTP POST Polling (JSON-RPC)

The `http-poll` strategy supports `method: "POST"` and `body` fields for endpoints that require POST requests, such as JSON-RPC APIs. This works with any JSON-RPC endpoint — EVM, Solana, Substrate, etc.

```json
{
  "action": "create",
  "watcher": {
    "id": "eth-block-watch",
    "skillId": "skills.chain",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    "method": "POST",
    "headers": { "content-type": "application/json" },
    "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}",
    "intervalMs": 15000,
    "match": "all",
    "conditions": [{ "path": "result", "op": "exists" }],
    "fire": {
      "webhookPath": "/hooks/sentinel",
      "eventName": "new_block",
      "payloadTemplate": {
        "event": "${event.name}",
        "blockHex": "${payload.result}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 500, "maxMs": 15000 }
  }
}
```

Note: `allowedHosts` must include your RPC endpoint hostname. The `body` field is a static string — for dynamic call parameters, use the `evm-call` strategy instead.

---

## 9) EVM Contract State Monitoring (`evm-call`)

The `evm-call` strategy provides high-level smart contract state polling. Instead of manually constructing JSON-RPC bodies, you provide a contract address and human-readable ABI signature — Sentinel handles encoding, calling, decoding, and BigInt-to-string conversion automatically.

```json
{
  "action": "create",
  "watcher": {
    "id": "usdc-whale-balance",
    "skillId": "skills.defi",
    "enabled": true,
    "strategy": "evm-call",
    "endpoint": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    "intervalMs": 30000,
    "match": "all",
    "conditions": [{ "path": "result.0", "op": "gt", "value": "1000000000000" }],
    "fire": {
      "webhookPath": "/hooks/sentinel",
      "eventName": "whale_balance_threshold",
      "intent": "defi_balance_alert",
      "payloadTemplate": {
        "event": "${event.name}",
        "balance": "${payload.result.0}",
        "contract": "${payload.to}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 500, "maxMs": 15000 },
    "evmCall": {
      "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "signature": "function balanceOf(address) view returns (uint256)",
      "args": ["0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"]
    }
  }
}
```

### Decoded payload structure

The strategy decodes the `eth_call` response and delivers a structured payload:

```json
{
  "result": ["1234567890123456789"],
  "resultNamed": {},
  "raw": "0x000000000000000000000000000000000000000000000000112210f47de98115",
  "blockTag": "latest",
  "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "signature": "function balanceOf(address) view returns (uint256)"
}
```

For signatures with named outputs (for example: `function auction() view returns (uint256 highestBid, bool settled)`), `resultNamed` includes direct field mapping:

```json
{
  "result": ["100", true],
  "resultNamed": { "highestBid": "100", "settled": true }
}
```

- `result` is always an array. Single return values are wrapped; multiple return values are decoded in order.
- `resultNamed` maps named ABI outputs to decoded values for stable condition paths.
- BigInt values (uint256, int256, etc.) are converted to strings to preserve precision and JSON safety.
- Tuple/struct return values are decoded as objects with named keys.
- Condition `path` values use dot-path notation (not JSONPath), e.g. `status`, `result.0`, `resultNamed.highestBid`.
- `blockTag` defaults to `"latest"` but can be overridden (e.g., `"0x1234"` for a specific block).

### `evmCall` config

| Field       | Required | Description                                                                     |
| ----------- | -------- | ------------------------------------------------------------------------------- |
| `to`        | Yes      | Contract address (0x-prefixed, 20-byte hex)                                     |
| `signature` | Yes      | Human-readable ABI, e.g. `"function balanceOf(address) view returns (uint256)"` |
| `args`      | No       | Call arguments matching signature parameters                                    |
| `blockTag`  | No       | Block tag for eth_call (default `"latest"`)                                     |

### Notes

- `allowedHosts` must include your RPC endpoint hostname.
- `redirect: "error"` is enforced (same as all HTTP strategies).
- `method`/`body` fields are not allowed with `evm-call` — the strategy constructs the JSON-RPC call automatically.
- ABI signatures use human-readable format from the [abitype](https://abitype.dev) spec.

---

## 10) Runtime control actions

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

## 11) Skill integration pattern

Typical skill flow:

1. Skill creates watcher when user asks to monitor an external event.
2. Sentinel watches with zero token burn while idle.
3. On condition match, Sentinel dispatches webhook payload.
4. If routed to `/hooks/sentinel`, OpenClaw enqueues a cron-tagged sentinel system event and triggers an immediate `cron:sentinel-callback` wake (not heartbeat-poll prompting).
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
