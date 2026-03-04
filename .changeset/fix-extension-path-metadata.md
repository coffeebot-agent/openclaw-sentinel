---
"@coffeexdev/openclaw-sentinel": patch
---

Fix OpenClaw extension metadata path by removing the leading `./` from `openclaw.extensions` so installs on v0.2.x no longer crash when loading the plugin entry.
