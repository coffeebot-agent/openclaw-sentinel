---
"@coffeexdev/openclaw-sentinel": minor
---

Improve `/hooks/sentinel` LLM wake context with a deterministic instruction prefix and structured JSON envelope.

- Preserve existing behavior (enqueue + heartbeat wake) while upgrading event text format.
- Add stable envelope keys: `watcherId`, `eventName`, `skillId` (if present), `matchedAt`, bounded `payload`, `dedupeKey`, `correlationId`, optional `deliveryTargets`, and `source` metadata.
- Add payload bounding/truncation marker to reduce oversized prompt risk.
- Keep backward compatibility with legacy/minimal webhook payload shapes.
- Add webhook callback tests for structured event text, truncation behavior, and compatibility.
- Document the structured hook event format and agent interpretation guidance in README and USAGE.
