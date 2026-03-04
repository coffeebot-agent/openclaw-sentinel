# @coffeexdev/openclaw-sentinel

## 0.2.1

### Patch Changes

- ca36a9c: Fix OpenClaw extension metadata path by removing the leading `./` from `openclaw.extensions` so installs on v0.2.x no longer crash when loading the plugin entry.

## 0.2.0

### Minor Changes

- 2efffd7: Default webhook path to `/hooks/sentinel` when `fire.webhookPath` is omitted. Auto-register the default route on plugin init via `registerHttpRoute`.
- 2420675: Wire `/hooks/sentinel` into the OpenClaw agent loop by enqueueing a system event and requesting heartbeat wake on webhook receipt.

  Also adds:
  - optional `hookSessionKey` config (default `agent:main:main`)
  - webhook payload validation/size guards and error responses
  - route callback wiring + failure handling tests
  - README/USAGE docs for callback behavior and configuration

## 0.1.8

### Patch Changes

- 674c314: Remove remaining zod usage from plugin config validation by migrating `configSchema` to TypeBox runtime checks.
  This eliminates runtime `Cannot find module 'zod'` loader failures.

## 0.1.7

### Patch Changes

- 7d772ce: Migrate watcher definition validation from zod to TypeBox runtime checks (`Value.Check`/`Value.Errors`) for full schema/validation consistency.

## 0.1.6

### Patch Changes

- d1add1d: Refactor sentinel tool parameter validation to use TypeBox-only runtime checks (`Value.Check`/`Value.Errors`) and remove zod-based parameter validation drift risk.

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
