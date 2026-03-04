---
"@coffeexdev/openclaw-sentinel": minor
---

Hardening + setup UX minor release for Sentinel:

- auto-detect gateway auth token for dispatch (`dispatchAuthToken`) from runtime config when unset, reducing manual setup
- keep `hookSessionKey` backward-compatible but deprecated; prefer `hookSessionPrefix` and warn when legacy key is used
- harden HTTP strategies with `redirect: "error"`, improved JSON parse errors, and abortable shutdown behavior
- add websocket connect timeout handling and stronger callback webhook content-type validation (`415` for unsupported media types)
- improve dispatch failure handling: non-2xx dispatch now surfaces errors, records runtime dispatch diagnostics, and logs auth remediation hints for 401/403
- add empty `allowedHosts` startup warning and relay-manager cleanup scheduling
- tighten watcher ID validation and align schemas/docs (`openclaw.plugin.json`, `schema/sentinel.schema.json`, TypeBox validator/tool schema) including `deliveryTargets`
- expand tests for config resolution, validation, strategy failure behavior, webhook validation, and schema consistency
