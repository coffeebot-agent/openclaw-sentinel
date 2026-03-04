# @coffeexdev/openclaw-sentinel

## 0.5.1

### Patch Changes

- bc40aa6: Fix `/hooks/sentinel` callback wake flow to avoid heartbeat-poll prompting. Callback events are now enqueued with a cron-tagged context and woken with `cron:sentinel-callback`, preserving isolated hook-session routing, dedupe, and relay behavior while driving sentinel-context processing (`SENTINEL_TRIGGER` + envelope).

  Add callback relay guardrails so literal `HEARTBEAT_OK` is never forwarded to users. When no assistant-authored callback output is available, sentinel fallback relay remains concise and sentinel-specific.

## Unreleased

### Patch Notes

- Sentinel `/hooks/sentinel` callbacks now enqueue with a cron-tagged callback context and wake via `cron:sentinel-callback`, so callback sessions process `SENTINEL_TRIGGER` envelope context instead of heartbeat-poll prompting.
- Added relay guardrails so literal `HEARTBEAT_OK` is never forwarded as callback output; concise fallback relay remains sentinel-specific.

## 0.5.0

### Minor Changes

- 051684c: Add reliable `/hooks/sentinel` response-delivery contracts so callback triggers can relay assistant-authored LLM output back to the original chat context.

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

## 0.4.5

### Patch Changes

- c1139bb: dd configurable sentinel notification payload delivery modes
- 4a5ad5c: Improve hook-session relay behavior for Sentinel watchers by defaulting to per-watcher isolated hook sessions while supporting optional grouped sessions. This also improves relay-to-chat delivery with stronger dedupe controls to reduce duplicate notifications.

## 0.4.4

### Patch Changes

- 82887d4: Fix `sentinel_control` remove action tool-result normalization so it always emits valid text content blocks and avoids malformed `{type:"text"}` output when handlers return `undefined`.

## 0.4.3

### Patch Changes

- 9844255: Fix `sentinel_control` runtime schema compatibility after OpenClaw schema normalization so action payloads compile and validate correctly at runtime.

## 0.4.2

### Patch Changes

- Fix `sentinel_control` schema `$ref` ambiguity by storing the recursive template schema once (under `$defs`) and referencing it from both `payloadTemplate` and `contextTemplate`.
- Ensure runtime TypeBox validation resolves recursive refs deterministically by supplying the shared template schema as explicit references in `Value.Check`/`Value.Errors`.
- Expand `sentinel_control` action support with aliases: `add` → `create`, `delete` → `remove`, `get` → `status`.
- Tighten tool parameter validation with action-specific payload shapes (required `watcher` for create/add, required `id` for id-targeted actions, no extra fields for `list`).
- Add comprehensive command-path tests and error-path coverage, including Ajv-based schema compile tests that reproduce the prior ambiguity failure mode.

## 0.4.1

### Patch Changes

- beb93d8: Fix a v0.4.0 schema regression where recursive TypeBox schemas could generate duplicate auto refs (for example `T0`) and fail validation/registration at runtime.
  - Introduce a shared recursive `TemplateValueSchema` module with explicit stable `$id`
  - Reuse that shared schema in both tool parameters schema and watcher validator schema
  - Add runtime-focused tests for `sentinel_control` create/list flows to guard against schema ref collisions

## 0.4.0

### Minor Changes

- fed5d82: Add generic sentinel callback envelope semantics for watcher matches.
  - Extend watcher fire schema with optional `intent`, `contextTemplate`, `priority`, `deadlineTemplate`, and `dedupeKeyTemplate`
  - Emit stable callback envelopes (`type: sentinel.callback`, `version: 1`) including watcher/trigger/context/payload/source fields
  - Add deterministic trigger `dedupeKey` generation
  - Add generic fallback behavior when `intent`/`contextTemplate` are omitted
  - Upgrade `/hooks/sentinel` enqueue text to include instruction prefix and JSON envelope block
  - Keep legacy `text`/`message` webhook payload behavior for backward compatibility
  - Add tests for explicit/fallback callback behavior, payload truncation, and callback route formatting
  - Update README and docs/USAGE with generic workflow examples

## 0.3.0

### Minor Changes

- 604077b: Add watcher delivery target fan-out support with context-based defaults.
  - Add optional `deliveryTargets` on watcher definitions (`[{ channel, to, accountId? }]`)
  - Infer default delivery target from current tool/session channel context on `sentinel_control` create when omitted
  - Deliver fire notifications to all configured targets via OpenClaw channel runtime interfaces
  - Record per-target delivery diagnostics (including partial failures) in watcher runtime state
  - Add tests for default inference, explicit multi-target override, and fan-out partial-failure behavior
  - Update README and USAGE docs with new field and examples

- 4141ed4: Improve `/hooks/sentinel` LLM wake context with a deterministic instruction prefix and structured JSON envelope.
  - Preserve existing behavior (enqueue + heartbeat wake) while upgrading event text format.
  - Add stable envelope keys: `watcherId`, `eventName`, `skillId` (if present), `matchedAt`, bounded `payload`, `dedupeKey`, `correlationId`, optional `deliveryTargets`, and `source` metadata.
  - Add payload bounding/truncation marker to reduce oversized prompt risk.
  - Keep backward compatibility with legacy/minimal webhook payload shapes.
  - Add webhook callback tests for structured event text, truncation behavior, and compatibility.
  - Document the structured hook event format and agent interpretation guidance in README and USAGE.

- 9508a15: Harden websocket reconnect with error/close dedupe, backoff reset after sustained healthy connection, and reconnect telemetry fields

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
