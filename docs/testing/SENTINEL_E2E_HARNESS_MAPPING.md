# Sentinel E2E Harness Mapping (OpenClaw-core plan → sentinel repo)

This repository does not include OpenClaw-core gateway harness utilities like `withGatewayServer`, `hooks-mapping`, or `cronIsolatedRun` mocks.

To implement equivalent E2E coverage in `openclaw-sentinel`, we use a repo-local harness in `tests/sentinel-callback-e2e.test.ts`.

## Mapping

| OpenClaw-core plan concept     | Sentinel repo equivalent                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Hook route + mapping dispatch  | Real `/hooks/sentinel` plugin route handler registered via `registerHttpRoute` mock                                           |
| `cronIsolatedRun` call capture | `runtime.system.enqueueSystemEvent` spy (the plugin’s LLM-loop handoff point)                                                 |
| Hook auth + webhook callback   | Dispatch to `localDispatchBase + /hooks/sentinel` is mocked in `globalThis.fetch`; route handler is invoked with mock req/res |
| Enriched prompt template       | Fallback prompt generated from `__sentinelCallback` envelope and relayed as system-event text                                 |
| Delivery/relay assertions      | Assert dispatch body, envelope fields, bearer auth header, and relayed prompt content                                         |

## Why this adaptation is CI-safe

- No external network: all HTTP calls are mocked in-process.
- No real LLM calls: tests assert at the handoff boundary (`enqueueSystemEvent`).
- Deterministic: fixed fixtures + explicit wait helper + `fireOnce` watchers.

## Extra behavior covered

- Callback envelope generation and context propagation (`__sentinelCallback`).
- Control-token suppression (`NO_REPLY`) plus fallback to structured sentinel callback summary when suppression empties message text.
