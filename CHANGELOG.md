# @coffeexdev/openclaw-sentinel

## 0.1.2

### Patch Changes

- 8ef60dd: Add required `openclaw.plugin.json` manifest to published package and include it in npm `files` so OpenClaw plugin install succeeds.

## 0.1.1

### Patch Changes

- e89f4ec: Fix plugin installation metadata by adding `openclaw.extensions` to `package.json`.
  Also add a `prepack` build step so published npm tarballs include fresh `dist/` artifacts.
