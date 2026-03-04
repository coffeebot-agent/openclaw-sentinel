# @coffeexdev/openclaw-sentinel

## 0.1.5

### Patch Changes

- 9ef9bc4: fix tool schema for installation and usage

## 0.1.4

### Patch Changes

- 6385c98: Fix plugin entrypoint exports by providing a default plugin object with `register`, plus named `register`/`activate` exports for compatibility with OpenClaw loaders.

## 0.1.2

### Patch Changes

- 8ef60dd: Add required `openclaw.plugin.json` manifest to published package and include it in npm `files` so OpenClaw plugin install succeeds.

## 0.1.1

### Patch Changes

- e89f4ec: Fix plugin installation metadata by adding `openclaw.extensions` to `package.json`.
  Also add a `prepack` build step so published npm tarballs include fresh `dist/` artifacts.
