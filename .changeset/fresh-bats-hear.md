---
"@coffeexdev/openclaw-sentinel": patch
---

Fix plugin installation metadata by adding `openclaw.extensions` to `package.json`.
Also add a `prepack` build step so published npm tarballs include fresh `dist/` artifacts.
