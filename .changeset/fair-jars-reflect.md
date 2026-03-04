---
"@coffeexdev/openclaw-sentinel": patch
---

Fix `sentinel_control` remove action tool-result normalization so it always emits valid text content blocks and avoids malformed `{type:"text"}` output when handlers return `undefined`.
