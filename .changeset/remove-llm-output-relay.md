---
"@coffeexdev/openclaw-sentinel": patch
---

Remove llm_output relay; use sentinel_act as sole delivery mechanism. The LLM now delivers results exclusively via sentinel_act notify, eliminating double-delivery of internal reasoning text. Timeout fallback remains as safety net.
