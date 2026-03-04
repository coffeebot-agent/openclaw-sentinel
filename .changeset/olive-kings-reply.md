---
"@coffeexdev/openclaw-sentinel": minor
---

Add reliable `/hooks/sentinel` response-delivery contracts so callback triggers can relay assistant-authored LLM output back to the original chat context.

### Included

- Keep existing callback enqueue + heartbeat wake path.
- Include callback `deliveryContext` (original chat/session origin) in emitted sentinel envelopes.
- Capture and relay assistant `llm_output` from hook sessions to callback delivery targets.
- Add configurable timeout/fallback behavior for missing assistant output:
  - `hookResponseTimeoutMs`
  - `hookResponseFallbackMode`
  - `hookResponseDedupeWindowMs`
- Deduplicate repeated callback events by dedupe key for idempotent response contracts.
- Keep `notificationPayloadMode` behavior separate and compatible.
- Add tests and docs updates for hook response relay, timeout fallback, and dedupe behavior.
