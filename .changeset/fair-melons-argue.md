---
"@coffeexdev/openclaw-sentinel": minor
---

Add watcher delivery target fan-out support with context-based defaults.

- Add optional `deliveryTargets` on watcher definitions (`[{ channel, to, accountId? }]`)
- Infer default delivery target from current tool/session channel context on `sentinel_control` create when omitted
- Deliver fire notifications to all configured targets via OpenClaw channel runtime interfaces
- Record per-target delivery diagnostics (including partial failures) in watcher runtime state
- Add tests for default inference, explicit multi-target override, and fan-out partial-failure behavior
- Update README and USAGE docs with new field and examples
