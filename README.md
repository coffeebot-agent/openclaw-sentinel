# @coffeexdev/openclaw-sentinel

Secure, declarative, gateway-native background watcher plugin for OpenClaw.

## Why Sentinel

OpenClaw Sentinel runs watcher lifecycles inside the gateway using fixed strategies and declarative conditions.
It **does not** execute user-authored code from watcher definitions.

## Features

- Tool registration: `sentinel_control`
  - actions: `create`, `enable`, `disable`, `remove`, `status`, `list`
- Strict schema validation (`zod.strict`) + code-like field/value rejection
- Strategies:
  - `http-poll`
  - `websocket`
  - `sse`
  - `http-long-poll`
- Condition operators:
  - `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `exists`, `absent`, `contains`, `matches`, `changed`
- Match mode: `all` / `any`
- Fire templating: substitution-only placeholders, non-Turing-complete
- Fire route: local internal webhook dispatch path (no outbound fire URL)
- Persistence: `~/.openclaw/sentinel-state.json`
- Resource limits and per-skill limits
- `allowedHosts` endpoint enforcement
- CLI surface: `list`, `status`, `enable`, `disable`, `audit`

## Install

```bash
npm i @coffeexdev/openclaw-sentinel
```

## Quick usage

```ts
import { createSentinelPlugin } from '@coffeexdev/openclaw-sentinel';

const sentinel = createSentinelPlugin({
  allowedHosts: ['api.github.com', 'api.coingecko.com'],
  localDispatchBase: 'http://127.0.0.1:4389'
});

await sentinel.init();
sentinel.register({
  registerTool(name, handler) {
    // gateway tool registry hook
  }
});
```

## Tool input example (`sentinel_control:create`)

```json
{
  "action": "create",
  "watcher": {
    "id": "sentinel-poker-alert",
    "skillId": "skills.sentinel-poker",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.github.com/events",
    "intervalMs": 15000,
    "match": "any",
    "conditions": [{ "path": "type", "op": "eq", "value": "PushEvent" }],
    "fire": {
      "webhookPath": "/internal/sentinel/fire",
      "eventName": "sentinel-poker_push",
      "payloadTemplate": {
        "watcher": "${watcher.id}",
        "event": "${event.name}",
        "type": "${payload.type}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 250, "maxMs": 5000 }
  }
}
```

## CLI

```bash
openclaw-sentinel list
openclaw-sentinel status <watcher-id>
openclaw-sentinel enable <watcher-id>
openclaw-sentinel disable <watcher-id>
openclaw-sentinel audit
```

## Example scenarios

### Sentinel Poker feed monitoring
Watch API changes and fire internal webhook events for orchestration.

### Blockchain price watch
`http-poll` against `api.coingecko.com`, `gt/lte/changed` conditions, routed to local webhook.

### CI monitoring
`sse` or `http-long-poll` against approved CI host endpoint; fire standardized internal events.

## Security model

- No dynamic code execution from watcher definitions
- No dynamic imports/requires from definitions
- Strict input schema, unknown field rejection
- Code-like fields/values rejected
- Allowed-host enforcement on endpoints
- Local-only fire routing through `localDispatchBase + webhookPath`
- Bounded retries with backoff
- Global/per-skill/condition limits

## Open Questions from RFC (conservative defaults applied)

1. **Changed operator memory model**: currently state uses hash + runtime metadata; deeper per-path history is not persisted yet.
2. **SSE/WebSocket durability**: reconnection behavior is conservative and minimal; production tuning for jitter/circuit breaking can be expanded.
3. **Dispatch auth**: local webhook dispatch assumes trusted local gateway plane; optional HMAC signing not included yet.
4. **Backpressure policy**: queueing/drop strategy is currently basic and should be expanded for extreme throughput.

## Development

```bash
npm i
npm run lint
npm run test
npm run build
```

## License

MIT
