---
"@coffeexdev/openclaw-sentinel": minor
---

Add model selection for sentinel watcher hook sessions.

- Per-watcher `fire.model` field to override the LLM model for individual watcher hook sessions
- Global `defaultHookModel` plugin config to set a default model for all sentinel hook sessions
- Resolution order: per-watcher `fire.model` > config `defaultHookModel` > agent default model
- Model is included in callback envelope as `hookModel` for transparency
- Uses the `before_model_resolve` plugin hook — no gateway changes required
