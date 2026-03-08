# HARDENING_PLAN.md — openclaw-sentinel

**Version:** 0.4.5  
**Date:** 2026-03-04  
**Author:** coder (subagent review)  
**Scope:** Full codebase review — input validation, failure modes, duplication, security, setup UX, testing, and release strategy.

---

## 1. Executive Summary

`openclaw-sentinel` is a well-structured, security-conscious plugin with good bones: strict TypeBox schemas, RE2-based regex, host allowlists, and isolated hook sessions. However, the codebase has accumulated several friction points and gaps that affect robustness, developer UX, and maintainability:

1. **Setup friction (P0):** `dispatchAuthToken` must be manually copied from gateway config. This is the #1 pain point reported by users.
2. **Schema drift:** The standalone JSON schema (`schema/sentinel.schema.json`) is missing `deliveryTargets` and several `fire` sub-fields present in the TypeBox runtime schema.
3. **Duplicated config surface:** Config keys are defined in three places (`openclaw.plugin.json`, `configSchema.ts` jsonSchema, `configSchema.ts` TypeBox schema) with subtle divergences.
4. **Incomplete failure handling:** HTTP strategies silently drop non-JSON responses, SSE strategy doesn't maintain persistent connections, and dispatch failures are fire-and-forget.
5. **Missing test coverage:** No tests for SSE/long-poll strategies, no test for state file corruption recovery, no integration test for the full `register()` → config merge path.
6. **Security edge cases:** `allowedHosts` doesn't handle IP addresses, wildcard subdomains, or redirects. Watcher `headers` can leak auth tokens in state file.

**Recommendation:** A phased approach — P0 quick wins (1-2 days), P1 hardening (1 week), P2 longer-term refactors (2+ weeks).

---

## 2. Current Architecture & Data/Control Flow

### Module Dependency Graph

```
index.ts (plugin entrypoint)
  ├── configSchema.ts     — TypeBox schema + safeParse + jsonSchema + uiHints
  ├── tool.ts             — sentinel_control tool registration
  │   ├── toolSchema.ts   — TypeBox tool parameter schemas
  │   └── templateValueSchema.ts — recursive TemplateValue type
  ├── watcherManager.ts   — watcher lifecycle, dispatch, notification fan-out
  │   ├── evaluator.ts    — condition evaluation, RE2 regex, payload hashing
  │   ├── template.ts     — ${...} placeholder rendering
  │   ├── limits.ts       — host allowlist + resource limit assertions
  │   ├── stateStore.ts   — JSON file persistence (load/save/merge)
  │   ├── callbackEnvelope.ts — sentinel.callback envelope construction
  │   └── strategies/     — http-poll, http-long-poll, sse, websocket
  ├── validator.ts        — WatcherSchema validation + code-like field rejection
  ├── cli.ts              — standalone CLI (list/status/enable/disable/audit)
  └── types.ts            — shared type definitions
```

### `/hooks/sentinel` Control Flow

```
1. Watcher condition matches (watcherManager → evaluateConditions)
2. renderTemplate(fire.payloadTemplate, context)
3. createCallbackEnvelope() → structured envelope body
4. dispatcher.dispatch(webhookPath, body) → POST to localDispatchBase + path
5. Gateway receives POST at /hooks/sentinel:
   a. readSentinelWebhookPayload() — parse + size-check body
   b. buildSentinelEventEnvelope() — normalize fields, clip payload
   c. buildIsolatedHookSessionKey() — compute per-watcher or per-group session key
   d. buildSentinelSystemEvent() — prepend SENTINEL_TRIGGER instruction
   e. api.runtime.system.enqueueSystemEvent(text, {sessionKey})
   f. api.runtime.system.requestHeartbeatNow()
   g. hookResponseRelayManager.register() — create response-delivery contract
6. LLM processes system event in isolated hook session
7. On llm_output, HookResponseRelayManager.handleLlmOutput() relays to deliveryTargets
8. On timeout, optional concise fallback relay
```

### State Persistence

- File: `~/.openclaw/sentinel-state.json` (default) or `config.stateFilePath`
- Written on every watcher create/enable/disable/remove and after every poll cycle
- Contains full watcher definitions (including `headers` with potential auth tokens) + runtime state
- File permissions: `0o600`, directory: `0o700`

---

## 3. Input Validation Audit

### 3.1 Webhook Payload Shape (`readSentinelWebhookPayload`)

**File:** `src/index.ts:readSentinelWebhookPayload()`

| Check                    | Status     | Notes                                                          |
| ------------------------ | ---------- | -------------------------------------------------------------- |
| Body size limit          | ✅ 64KB    | `MAX_SENTINEL_WEBHOOK_BODY_BYTES`                              |
| JSON parse validation    | ✅         | Returns 400 on parse failure                                   |
| Object shape check       | ✅         | Rejects arrays/primitives                                      |
| Pre-parsed body shortcut | ⚠️         | Trusts `req.body` if already an object — no size/shape recheck |
| Content-Type enforcement | ❌ Missing | Accepts any Content-Type as long as body parses as JSON        |

**Recommendation:**

- **P1:** Validate `Content-Type: application/json` header before parsing.
- **P1:** When using pre-parsed `req.body`, still validate it's a plain object (not a prototype-polluted proxy).

### 3.2 Tool Arguments (`sentinel_control`)

**File:** `src/tool.ts:validateParams()`

| Check                                  | Status | Notes                                          |
| -------------------------------------- | ------ | ---------------------------------------------- |
| TypeBox discriminated union validation | ✅     | `SentinelToolValidationSchema`                 |
| Action-dependent field validation      | ✅     | create requires watcher, id-actions require id |
| Missing params fallback                | ✅     | `params ?? {}`                                 |

**Issue:** `status`/`get` action returns `undefined` for unknown watcher IDs without an explicit "not found" error. The `normalizeToolResultText` will produce the fallback text `"Watcher not found: <id>"` but the JSON payload is `undefined`, which may confuse LLM tool-result parsing.

**Recommendation:**

- **P2:** Return `{ found: false, id }` instead of `undefined` for status/get on missing watchers.

### 3.3 Watcher Definitions (`validateWatcherDefinition`)

**File:** `src/validator.ts`

| Check                           | Status     | Notes                                                           |
| ------------------------------- | ---------- | --------------------------------------------------------------- |
| TypeBox strict schema           | ✅         | `additionalProperties: false`                                   |
| Code-like field/value rejection | ✅         | `scanNoCodeLike()` with patterns                                |
| URL validation                  | ✅         | `new URL(endpoint)`                                             |
| Template placeholder allowlist  | ✅         | Only `watcher.*`, `event.*`, `payload.*`, `timestamp`           |
| Condition value type checking   | ⚠️         | `value` is `Type.Unknown()` — accepts functions, nested objects |
| `id` format validation          | ❌ Missing | Accepts `id: "../../etc/passwd"` or `id: " "` (whitespace)      |
| `headers` value sanitization    | ❌ Missing | Arbitrary header values accepted, persisted to state file       |
| `body` content validation       | ❌ Missing | Arbitrary string accepted for POST body                         |

**Recommendations:**

- **P1:** Add `id` format validation — alphanumeric + hyphens + underscores, max 128 chars.
- **P1:** Sanitize/restrict watcher `headers` — warn on `Authorization` values being persisted (consider env-var references instead).
- **P2:** Add depth/size limits to condition `value` to prevent storing excessively large condition values.

### 3.4 Config Parsing

**File:** `src/configSchema.ts:sentinelConfigSchema.safeParse()`

| Check                   | Status | Notes                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------ |
| TypeBox validation      | ✅     | After `withDefaults()`                                                   |
| URL format validation   | ✅     | `new URL()` on `localDispatchBase`                                       |
| Default fallbacks       | ✅     | `withDefaults()` applies all defaults                                    |
| Type coercion safety    | ⚠️     | `typeof limitsIn.maxWatchersTotal === "number"` allows `NaN`, `Infinity` |
| Empty dispatchAuthToken | ⚠️     | Empty string `""` is accepted as a valid token                           |

**Recommendations:**

- **P1:** Reject `NaN`/`Infinity` for numeric config values — use `Number.isFinite()`.
- **P2:** Treat empty-string `dispatchAuthToken` as `undefined` (no token).

### 3.5 Environment Variable Handling

**File:** `src/index.ts:createSentinelPlugin()`

The only env var: `SENTINEL_DISPATCH_TOKEN` (fallback for `dispatchAuthToken`).

| Check                  | Status | Notes                                             |
| ---------------------- | ------ | ------------------------------------------------- |
| Env var read           | ✅     | `process.env.SENTINEL_DISPATCH_TOKEN`             |
| Priority: config > env | ✅     | `Object.assign(config, runtimeConfig)` overwrites |
| Empty env var          | ⚠️     | `""` becomes the token                            |

**Recommendation:**

- **P1:** Trim and reject empty env var values: `process.env.SENTINEL_DISPATCH_TOKEN?.trim() || undefined`.

---

## 4. Failure-Mode Audit

### 4.1 Network Errors in Strategies

| Strategy         | Non-2xx            | Network Error | Timeout        | JSON Parse Failure           | Reconnect   |
| ---------------- | ------------------ | ------------- | -------------- | ---------------------------- | ----------- |
| `http-poll`      | ✅ Error → onError | ✅ → onError  | ✅ AbortSignal | ❌ Crashes if non-JSON 2xx   | Via backoff |
| `http-long-poll` | ✅ → onError       | ✅ → onError  | ✅ AbortSignal | ❌ Crashes if non-JSON 2xx   | Via backoff |
| `sse`            | ✅ → onError       | ✅ → onError  | ✅ AbortSignal | ✅ Falls back to `{message}` | Via backoff |
| `websocket`      | N/A                | ✅ → onError  | ❌ No timeout  | ✅ Falls back to `{message}` | Via backoff |

**Critical Issues:**

1. **`http-poll` and `http-long-poll` check Content-Type header but then call `response.json()` unconditionally.** If the Content-Type check throws, it enters `onError`. But there's a race: if the server returns `Content-Type: application/json` but invalid JSON body, `response.json()` throws an unhandled error that won't be caught by the strategy's try/catch properly (it is caught, but the error message is confusing — "Unexpected token" rather than descriptive).

2. **SSE strategy is not a true SSE client.** It uses `fetch()` → `response.text()` and then re-polls, losing the persistent connection model. This means:
   - No `Last-Event-ID` support
   - No reconnection on stream interruption
   - Entire response must buffer in memory before processing events
   - `intervalMs` introduces artificial delay between full re-fetches

3. **WebSocket strategy has no connect timeout.** A hanging WebSocket handshake will never trigger `onError`.

4. **No AbortController propagation on stop.** When `active = false`, in-flight HTTP requests continue to completion. For long-poll, this means the watcher may not actually stop for up to `timeoutMs` (default 60s).

**Recommendations:**

- **P0:** Wrap `response.json()` in strategies with try/catch for parse failures.
- **P1:** Add AbortController to all strategies; abort on stop.
- **P1:** Add WebSocket connect timeout (e.g., 30s default).
- **P2:** Rewrite SSE strategy to use streaming `ReadableStream` or `EventSource`-compatible approach.

### 4.2 Dispatch Failures

**File:** `src/watcherManager.ts:startWatcher()` → `this.dispatcher.dispatch()`

**Issue:** `dispatch()` failures are not caught. If the POST to `localDispatchBase` fails (network error, gateway down, auth rejected), the error propagates to the strategy callback and is swallowed. The watcher continues polling but the fire event is lost.

```typescript
await this.dispatcher.dispatch(webhookPath, body);
// No try/catch — unhandled rejection if fetch fails
```

**Recommendations:**

- **P0:** Wrap `dispatch()` in try/catch. Log the failure. Consider retry with backoff for transient dispatch errors.
- **P1:** Record dispatch failures in `WatcherRuntimeState` (new field: `lastDispatchError`).
- **P2:** Add a dispatch retry queue with configurable depth.

### 4.3 Missing Auth Token

When `dispatchAuthToken` is not set but gateway auth is enabled:

- Dispatch POST returns 401/403
- Error is unhandled (see 4.2)
- Watcher continues polling indefinitely, wasting resources
- No user-visible error or doctor hint

**Recommendations:**

- **P0:** On first dispatch 401/403, log a clear warning: "dispatchAuthToken may be missing or invalid."
- **P0:** Add a `doctor` check that validates dispatch connectivity on plugin init (see Section 7).

### 4.4 Session Routing Failures

`enqueueSystemEvent()` or `requestHeartbeatNow()` can fail if:

- The session key format is unexpected
- The gateway is shutting down
- Memory pressure / queue full

The webhook handler catches these and returns 500, which is correct. But the watcher side (dispatch) doesn't know the webhook handler failed — it just gets a non-2xx response.

**Recommendation:**

- **P1:** Check dispatch response status and log non-2xx results to `WatcherRuntimeState`.

### 4.5 Dedupe Edge Cases

**File:** `src/index.ts:HookResponseRelayManager`

| Scenario                     | Behavior                           | Issue                                         |
| ---------------------------- | ---------------------------------- | --------------------------------------------- |
| Same dedupeKey within window | Correctly deduped                  | ✅                                            |
| Expired entries cleanup      | Only on next `register()` call     | ⚠️ Memory leak if no new callbacks            |
| Process restart              | All pending contracts lost         | ⚠️ In-flight relay contracts silently dropped |
| Concurrent LLM outputs       | First match wins via FIFO queue    | ✅                                            |
| Timer leak on process exit   | `setTimeout` references prevent GC | ⚠️                                            |

**Recommendations:**

- **P1:** Add periodic cleanup timer (e.g., every 60s) for expired dedupe entries.
- **P2:** Persist pending relay contracts to state file for crash recovery.
- **P1:** Clear all pending timers on plugin shutdown/deregister.

### 4.6 Restart Behavior

On gateway restart:

1. `init()` loads state file
2. Invalid persisted watchers are logged to runtime state but not surfaced to user
3. Valid watchers are re-started
4. Pending relay contracts are lost (in-memory only)
5. `changed` operator may fire spuriously because `previousPayload` is loaded from state but may be stale

**Recommendations:**

- **P1:** Add `audit` output field showing watchers that failed to reload with their error messages.
- **P2:** Consider a `lastSeenPayloadAt` timestamp to detect staleness for `changed` operator.

---

## 5. Duplication & Complexity Audit

### 5.1 Duplicated Config Definitions

The same config schema is defined in **three** places:

| Location                            | Format               | Role                                    |
| ----------------------------------- | -------------------- | --------------------------------------- |
| `openclaw.plugin.json:configSchema` | JSON Schema          | OpenClaw plugin manifest (read by core) |
| `src/configSchema.ts:ConfigSchema`  | TypeBox              | Runtime validation                      |
| `src/configSchema.ts:jsonSchema`    | JSON Schema (inline) | Exported for external consumers         |

These have subtle differences:

- `openclaw.plugin.json` includes `uiHints` — also duplicated in `configSchema.ts`
- `openclaw.plugin.json:configSchema` uses `"type": "number"` for limits; `configSchema.ts` uses `Type.Integer()`
- Default values are expressed differently

**Recommendations:**

- **P1:** Generate `openclaw.plugin.json:configSchema` from the TypeBox schema at build time. Single source of truth.
- **P1:** Remove duplicate `uiHints` from `configSchema.ts` or `openclaw.plugin.json` (keep in one place).

### 5.2 Duplicated Watcher Schemas

The watcher schema is defined in **three** places:

| Location                          | Role                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `src/validator.ts:WatcherSchema`  | Used for `validateWatcherDefinition()` — strict, `additionalProperties: false`  |
| `src/toolSchema.ts:WatcherSchema` | Used for `sentinel_control` tool parameter schema — looser, for LLM consumption |
| `schema/sentinel.schema.json`     | Standalone JSON Schema for external use                                         |

Key drifts:

- `schema/sentinel.schema.json` **missing** `deliveryTargets` property on watcher
- `toolSchema.ts` has different validation constraints (no `minItems`, no `minimum`/`maximum` on retry)
- `toolSchema.ts:FireConfigSchema` requires `webhookPath` as non-optional string; `validator.ts` makes it optional with default

**Recommendations:**

- **P0:** Add `deliveryTargets` to `schema/sentinel.schema.json`.
- **P1:** Generate `schema/sentinel.schema.json` from `validator.ts:WatcherSchema` at build time.
- **P1:** Align `toolSchema.ts` constraints with `validator.ts` — the tool schema should be at least as permissive (for LLM input) while the validator enforces strictness.

### 5.3 Legacy Config Aliases

| Current Key         | Legacy Alias     | Handling                                                    |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `hookSessionPrefix` | `hookSessionKey` | Both accepted, `hookSessionKey` preferred (bug — see below) |

**Bug:** In `buildIsolatedHookSessionKey()`:

```typescript
const rawPrefix =
  asString(config.hookSessionKey) ?? // ← legacy key checked FIRST
  asString(config.hookSessionPrefix) ?? // ← new key is fallback
  DEFAULT_HOOK_SESSION_PREFIX;
```

This means the deprecated `hookSessionKey` takes **priority** over the new `hookSessionPrefix`. If both are set, the deprecated key wins silently.

**Recommendations:**

- **P0:** Swap priority: `hookSessionPrefix` should win when set.
- **P1:** Log deprecation warning when `hookSessionKey` is used.
- **P2:** Remove `hookSessionKey` support in next major version.

### 5.4 Duplicated `getPath()` Function

`getPath()` (dot-notation object traversal) is defined in:

1. `src/evaluator.ts`
2. `src/template.ts`
3. `src/callbackEnvelope.ts`

All three are identical implementations.

**Recommendation:**

- **P1:** Extract to a shared `src/utils.ts` module.

### 5.5 Duplicated Payload Truncation

Payload size limiting is done in two places:

1. `src/index.ts:clipPayloadForPrompt()` — `MAX_SENTINEL_PAYLOAD_JSON_CHARS = 2500`
2. `src/callbackEnvelope.ts:truncatePayload()` — `MAX_PAYLOAD_JSON_CHARS = 4000`

These have different limits and different output shapes (`__truncated` vs `truncated`).

**Recommendation:**

- **P1:** Unify into one function with configurable limit. Use consistent output shape.

---

## 6. Security & Abuse Resistance

### 6.1 Host Allowlist

**File:** `src/limits.ts:assertHostAllowed()`

| Check                  | Status | Notes                                                          |
| ---------------------- | ------ | -------------------------------------------------------------- |
| Hostname normalization | ✅     | Lowercase, trailing dot stripped                               |
| Port-aware matching    | ✅     | Checks both `hostname` and `host`                              |
| IP address support     | ⚠️     | Works for explicit IPs but no CIDR or range support            |
| Wildcard subdomain     | ❌     | `*.example.com` not supported                                  |
| Redirect following     | ❌     | `fetch()` follows redirects by default — can escape allowlist  |
| DNS rebinding          | ❌     | No DNS validation; allowlist is hostname-only                  |
| Private IP blocking    | ❌     | Localhost/private IPs not blocked unless absent from allowlist |

**Critical Issue:** HTTP strategies use `fetch()` which follows redirects by default. A monitored endpoint could redirect to a disallowed host (e.g., `http://allowed.com → http://internal-service.local/admin`).

**Recommendations:**

- **P0:** Set `redirect: "error"` or `redirect: "manual"` on all `fetch()` calls in strategies.
- **P1:** Re-validate host after redirect if using `redirect: "manual"`.
- **P1:** Add explicit blocklist for private IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`) unless explicitly allowlisted.
- **P2:** Support wildcard subdomains: `*.example.com`.

### 6.2 Payload Injection

Template rendering (`src/template.ts`) is safe:

- Allowlist-only placeholders via regex
- No eval/exec paths
- No nested template expansion

Webhook payload processing (`src/index.ts`) is safe:

- Fields are extracted by explicit key access
- System event text is instruction-prefixed, not user-controllable format
- Payload clipped to bounded size

**Low risk.** No issues found.

### 6.3 Message Relay Abuse

Potential abuse vectors:

1. **Crafted deliveryTargets:** An attacker with tool access could set `deliveryTargets` to arbitrary channel/user IDs, sending messages to victims.
   - Mitigated by: tool only accessible to agent, `SUPPORTED_DELIVERY_CHANNELS` set limits channel types.
   - Not mitigated: no rate limiting on relay messages.

2. **Webhook endpoint abuse:** External webhook POST to `/hooks/sentinel` could trigger relay messages.
   - Mitigated by: `auth: "gateway"` on route registration — requires gateway auth token.

3. **Notification storm:** Many watchers firing simultaneously could flood delivery targets.
   - Not mitigated: no global rate limit on delivery fan-out.

**Recommendations:**

- **P1:** Add per-target rate limiting for relay messages (e.g., max 10/minute/target).
- **P2:** Add configurable `maxDeliveryTargetsPerWatcher` limit (current: unbounded).

### 6.4 Token Handling

**Issue:** `dispatchAuthToken` and watcher `headers` (which may contain `Authorization` tokens) are:

1. Stored in config file (expected but sensitive)
2. Persisted to `sentinel-state.json` in plaintext (watcher headers)
3. Logged? No — headers are not logged. ✅

State file has `0o600` permissions, which is appropriate.

**Recommendations:**

- **P1:** Document that `sentinel-state.json` may contain sensitive headers.
- **P2:** Support environment variable references in watcher `headers` (e.g., `"Authorization": "$env:GITHUB_TOKEN"`) to avoid persisting secrets.

### 6.5 Regex Denial of Service

**File:** `src/evaluator.ts:safeRegexTest()`

- Uses RE2 (native or WASM) — inherently safe against catastrophic backtracking ✅
- Additional pattern/input length limits ✅
- Heuristic guard for alternation+quantifier patterns ✅ (defense in depth, RE2 doesn't need it)

**No issues found.** This is well-implemented.

---

## 7. Setup/Install UX Audit

### 7.1 First Install Flow

Current steps:

1. `openclaw plugins install @coffeexdev/openclaw-sentinel`
2. Edit `~/.openclaw/openclaw.json` — add `plugins.entries.openclaw-sentinel.config`
3. Set `allowedHosts` (required, no default)
4. **Manually find and copy gateway auth token → `dispatchAuthToken`** ← friction point
5. `openclaw gateway restart`
6. Create first watcher via tool

**Pain Points:**

- Step 4 is the reported UX problem. Users must:
  1. Know that gateway auth exists
  2. Find the token (unclear where it lives)
  3. Copy it into plugin config
  4. If they forget, watchers dispatch silently fails with no visible error

- Step 2 is error-prone: JSON5 config syntax, nested path, easy to get wrong
- No `openclaw sentinel doctor` or equivalent diagnostic command

### 7.2 Eliminating `dispatchAuthToken` Manual Setup

**Root cause:** Sentinel dispatches to `localDispatchBase` (the gateway itself) via HTTP POST. If gateway auth is enabled, Sentinel needs the gateway's auth token. But Sentinel is a plugin running inside the gateway — it shouldn't need to authenticate with itself.

**Proposed solutions (preference order):**

1. **Best (requires OpenClaw core change):** Plugin API provides `api.runtime.dispatchAuthToken` or equivalent, so plugins can read the gateway's own auth token automatically. Sentinel reads this at registration time.
   - **Owner:** OpenClaw core
   - **Effort:** Small core change
   - **Impact:** Eliminates the #1 setup friction point entirely

2. **Good (requires OpenClaw core change):** Plugin API provides `api.runtime.internalFetch()` that automatically includes auth headers for intra-gateway requests.
   - **Owner:** OpenClaw core
   - **Effort:** Medium core change
   - **Impact:** Eliminates auth token config for all plugins, not just Sentinel

3. **Acceptable (plugin-only):** On `register()`, Sentinel tries to read the gateway auth token from the well-known config location (`api.config.auth?.token` or `api.config.gateway?.authToken`) and auto-populates `dispatchAuthToken`.
   - **Owner:** Plugin
   - **Effort:** Small — add config sniffing to `resolveSentinelPluginConfig()`
   - **Risk:** Fragile if core moves the token location
   - **Implementation sketch:**
     ```typescript
     // In resolveSentinelPluginConfig():
     if (!pluginConfig.dispatchAuthToken) {
       const gatewayToken = api.config?.auth?.token ?? api.config?.gateway?.authToken;
       if (gatewayToken) pluginConfig.dispatchAuthToken = gatewayToken;
     }
     ```

4. **Fallback (plugin-only):** Better error messaging + doctor check. On first dispatch 401/403, log a specific remediation message.

**Recommendation:**

- **P0:** Implement option 3 (auto-sniff) as an immediate fix.
- **P0:** Implement option 4 (better errors) regardless.
- **P1:** Propose option 1 or 2 to OpenClaw core team as a proper fix.

### 7.3 Plugin Doctor / Diagnostic Hints

Currently there's no health-check for common misconfiguration. Proposed `doctor` checks to run on `init()`:

| Check                                                  | Severity | Message                                                           |
| ------------------------------------------------------ | -------- | ----------------------------------------------------------------- |
| `allowedHosts` empty                                   | warning  | "No allowed hosts configured. Watchers will fail to create."      |
| `dispatchAuthToken` missing (and gateway auth enabled) | error    | "dispatchAuthToken not set. Webhook dispatch will fail with 401." |
| Dispatch connectivity test                             | error    | "Cannot reach localDispatchBase. Check gateway is running."       |
| State file permissions                                 | warning  | "State file has overly permissive permissions."                   |
| Legacy `hookSessionKey` in use                         | info     | "hookSessionKey is deprecated. Use hookSessionPrefix."            |
| Legacy root-level `sentinel` config                    | warning  | Already implemented ✅                                            |

**Recommendations:**

- **P0:** Add `allowedHosts` empty warning on init.
- **P1:** Add dispatch auth connectivity probe on init (POST a no-op ping, check response).
- **P1:** Surface doctor results in `audit` command output.

### 7.4 Migration Path

Legacy root-level config (`config.sentinel`) is already handled with a warning. The migration path is clear.

**Gap:** No versioned migration guide. When breaking changes happen, users need a `MIGRATION.md`.

**Recommendation:**

- **P2:** Create `docs/MIGRATION.md` with per-version breaking changes.

---

## 8. Concrete Remediation Plan

### P0 — Ship This Week (1-2 days)

| #    | Item                                                                                          | File(s)                                         | Owner  | Effort |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------ | ------ |
| P0-1 | Fix `hookSessionKey`/`hookSessionPrefix` priority (legacy key wins over new key)              | `src/index.ts`                                  | Plugin | 15 min |
| P0-2 | Auto-sniff gateway auth token from `api.config` to eliminate manual `dispatchAuthToken` setup | `src/index.ts`                                  | Plugin | 30 min |
| P0-3 | Add `redirect: "error"` to all `fetch()` calls in strategies to prevent host allowlist bypass | `src/strategies/*.ts`                           | Plugin | 15 min |
| P0-4 | Wrap `dispatch()` in try/catch with error logging in `watcherManager.ts`                      | `src/watcherManager.ts`                         | Plugin | 15 min |
| P0-5 | Add `deliveryTargets` to `schema/sentinel.schema.json` (fix schema drift)                     | `schema/sentinel.schema.json`                   | Plugin | 15 min |
| P0-6 | Add empty `allowedHosts` warning on plugin init                                               | `src/index.ts`                                  | Plugin | 10 min |
| P0-7 | Wrap `response.json()` calls in strategies with descriptive try/catch                         | `src/strategies/httpPoll.ts`, `httpLongPoll.ts` | Plugin | 15 min |

**Acceptance Criteria:**

- All existing tests pass
- New tests for P0-1 (priority fix), P0-3 (redirect rejection), P0-4 (dispatch error handling)
- `dispatchAuthToken` no longer required in config when running inside gateway

### P1 — Next Release (3-5 days)

| #     | Item                                                                                   | File(s)                                              | Owner  | Effort |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ | ------ |
| P1-1  | Extract shared `getPath()` to `src/utils.ts`                                           | `evaluator.ts`, `template.ts`, `callbackEnvelope.ts` | Plugin | 30 min |
| P1-2  | Unify payload truncation functions                                                     | `index.ts`, `callbackEnvelope.ts`                    | Plugin | 30 min |
| P1-3  | Add watcher `id` format validation (alphanumeric/hyphen/underscore, max 128)           | `src/validator.ts`                                   | Plugin | 15 min |
| P1-4  | Add WebSocket connect timeout                                                          | `src/strategies/websocket.ts`                        | Plugin | 30 min |
| P1-5  | Add AbortController to all strategies for clean shutdown                               | `src/strategies/*.ts`                                | Plugin | 1 hr   |
| P1-6  | Validate Content-Type header on webhook POST                                           | `src/index.ts`                                       | Plugin | 15 min |
| P1-7  | Add periodic cleanup timer to `HookResponseRelayManager` + shutdown cleanup            | `src/index.ts`                                       | Plugin | 30 min |
| P1-8  | Generate `openclaw.plugin.json:configSchema` from TypeBox at build time                | Build script                                         | Plugin | 2 hr   |
| P1-9  | Generate `schema/sentinel.schema.json` from `validator.ts:WatcherSchema` at build time | Build script                                         | Plugin | 1 hr   |
| P1-10 | Add dispatch auth connectivity probe on init                                           | `src/index.ts` or `src/watcherManager.ts`            | Plugin | 1 hr   |
| P1-11 | Add per-target relay rate limiting (max 10/min/target)                                 | `src/index.ts`                                       | Plugin | 1 hr   |
| P1-12 | Reject `NaN`/`Infinity` in numeric config values                                       | `src/configSchema.ts`                                | Plugin | 15 min |
| P1-13 | Block private IP ranges in host allowlist by default                                   | `src/limits.ts`                                      | Plugin | 1 hr   |
| P1-14 | Deprecation warning when `hookSessionKey` is used                                      | `src/index.ts`                                       | Plugin | 15 min |
| P1-15 | Record dispatch failures in `WatcherRuntimeState`                                      | `src/watcherManager.ts`                              | Plugin | 30 min |

**Acceptance Criteria:**

- Single source of truth for config schema and watcher schema
- No duplicated utility functions
- Dispatch failures are visible in `status` and `audit` output
- WebSocket watchers have connect timeout
- Strategy shutdown is clean (AbortController-based)

### P2 — Backlog / Next Quarter

| #     | Item                                                                                      | Owner  | Effort   |
| ----- | ----------------------------------------------------------------------------------------- | ------ | -------- |
| P2-1  | Propose `api.runtime.dispatchAuthToken` or `api.runtime.internalFetch()` to OpenClaw core | Core   | Medium   |
| P2-2  | Rewrite SSE strategy with streaming `ReadableStream` + `Last-Event-ID` support            | Plugin | 3-5 days |
| P2-3  | Support env-var references in watcher `headers` (`$env:TOKEN_NAME`)                       | Plugin | 1 day    |
| P2-4  | Add wildcard subdomain support to `allowedHosts` (`*.example.com`)                        | Plugin | 1 day    |
| P2-5  | Create `docs/MIGRATION.md` with per-version guide                                         | Plugin | 2 hr     |
| P2-6  | Add dispatch retry queue with configurable depth                                          | Plugin | 2 days   |
| P2-7  | Persist pending relay contracts to state file for crash recovery                          | Plugin | 1 day    |
| P2-8  | Remove `hookSessionKey` support (breaking change — next major)                            | Plugin | 15 min   |
| P2-9  | Add depth/size limits to condition `value`                                                | Plugin | 30 min   |
| P2-10 | Add `maxDeliveryTargetsPerWatcher` config limit                                           | Plugin | 30 min   |
| P2-11 | Return `{ found: false }` for missing watcher status                                      | Plugin | 15 min   |

---

## 9. Test Strategy Improvements

### 9.1 Current Coverage Assessment

| Area                    | Test File(s)                                      | Coverage                   | Gap                                                                |
| ----------------------- | ------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| Condition evaluation    | `evaluator.test.ts`, `evaluator-security.test.ts` | Good                       | No test for `changed` with nested objects                          |
| Template rendering      | `template.test.ts`                                | Minimal (1 file, 10 lines) | Missing: error paths, nested templates, array values               |
| Watcher validation      | `validator.test.ts`                               | Good                       | Missing: `id` injection, oversized conditions                      |
| Config schema           | `config-schema.test.ts`                           | Good                       | Missing: `NaN`/`Infinity`, empty token                             |
| Tool registration       | `sentinel-control-commands.test.ts`               | Good                       | Missing: concurrent creates, error recovery                        |
| Webhook callbacks       | `sentinel-webhook-callback.test.ts`               | Excellent                  | Minor: no test for empty POST body                                 |
| Delivery targets        | `delivery-targets.test.ts`                        | Excellent                  | —                                                                  |
| State persistence       | `state.test.ts`                                   | Minimal                    | Missing: corruption recovery, concurrent writes, permission errors |
| Dispatch integration    | `dispatch-integration.test.ts`                    | Minimal                    | No test for dispatch failures, non-2xx responses                   |
| WS reconnect            | `ws-reconnect.test.ts`                            | Good                       | —                                                                  |
| HTTP poll strategy      | —                                                 | **None**                   | Missing entirely                                                   |
| HTTP long-poll strategy | —                                                 | **None**                   | Missing entirely                                                   |
| SSE strategy            | —                                                 | **None**                   | Missing entirely                                                   |
| CLI                     | —                                                 | **None**                   | Missing entirely                                                   |
| Callback envelope       | `callback-envelope.test.ts`                       | Good                       | —                                                                  |
| Limits/hosts            | `limits.test.ts`, `limits-hosts.test.ts`          | Good                       | Missing: redirect bypass, IP ranges                                |

### 9.2 Proposed New Tests

**P0 tests (ship with P0 fixes):**

```
tests/strategy-http-poll.test.ts          — mock fetch, test non-2xx, JSON parse failure, timeout
tests/strategy-redirect-block.test.ts     — verify redirect: "error" works
tests/dispatch-failure.test.ts            — dispatch returns 401/500, verify error logged
tests/hookSessionKey-priority.test.ts     — verify hookSessionPrefix wins over hookSessionKey
```

**P1 tests:**

```
tests/strategy-http-long-poll.test.ts     — mock fetch, test loop behavior, stop semantics
tests/strategy-sse.test.ts               — mock fetch, test event parsing, reconnection
tests/strategy-websocket-timeout.test.ts  — verify connect timeout fires
tests/watcher-id-format.test.ts           — injection strings, whitespace, oversized IDs
tests/config-edge-cases.test.ts           — NaN, Infinity, empty token, missing limits
tests/state-corruption.test.ts            — corrupt JSON, missing fields, permission denied
tests/relay-rate-limit.test.ts            — verify per-target rate limiting
tests/cli.test.ts                         — basic CLI command smoke tests
```

### 9.3 CI Improvements

Current CI (`ci-main.yml`) runs: lint → format check → build → test → smoke install.

**Proposed additions:**

- **P1:** Add test coverage reporting (e.g., `vitest --coverage` with threshold).
- **P1:** Add schema drift check: script that compares generated JSON Schema against committed `schema/sentinel.schema.json`.
- **P2:** Add mutation testing (e.g., Stryker) to validate test quality.
- **P2:** Add E2E test: spin up a mock HTTP server, create a watcher, verify dispatch fires.

### 9.4 Proposed CI Workflow Addition

```yaml
# In ci-main.yml, add after "Test":
- name: Coverage
  run: pnpm vitest run --coverage --reporter=json

- name: Schema drift check
  run: |
    pnpm run build
    node scripts/check-schema-drift.js
```

---

## 10. Release/Migration Plan

### 10.1 Version Strategy

| Version | Contents                                                         | Breaking?                              |
| ------- | ---------------------------------------------------------------- | -------------------------------------- |
| 0.4.6   | All P0 fixes                                                     | No                                     |
| 0.5.0   | All P1 items (schema generation, dedup refactors, rate limiting) | Minor (schema output shape may change) |
| 0.6.0   | SSE rewrite, env-var headers                                     | No                                     |
| 1.0.0   | Remove `hookSessionKey`, finalize public API                     | Yes                                    |

### 10.2 Backward Compatibility Guarantees

- **Config:** `hookSessionKey` remains supported until 1.0.0 with deprecation warning from 0.4.6.
- **State file:** Shape is backward-compatible. New fields are additive. Old state files load correctly.
- **Tool schema:** `sentinel_control` parameters are backward-compatible. New optional fields only.
- **Callback envelope:** `type: "sentinel.callback"`, `version: "1"` is stable. New fields are additive.
- **Webhook route:** `/hooks/sentinel` path and behavior is stable.

### 10.3 Deprecation Schedule

| Item                                        | Deprecated In | Warning Added   | Removed In                           |
| ------------------------------------------- | ------------- | --------------- | ------------------------------------ |
| `hookSessionKey` config                     | 0.4.6         | 0.4.6           | 1.0.0                                |
| Root-level `sentinel` config                | 0.3.x         | Already present | 1.0.0                                |
| `dispatchAuthToken` (when auto-sniff works) | 0.4.6         | 0.5.0           | Never (remains as explicit override) |

### 10.4 Migration Notes for 0.4.6

```markdown
## Upgrading to 0.4.6

### dispatchAuthToken auto-detection

Sentinel now attempts to read the gateway auth token automatically.
You can remove `dispatchAuthToken` from your plugin config if you're running
Sentinel inside the OpenClaw gateway (the standard deployment).

If you need to override (e.g., remote dispatch), `dispatchAuthToken` in config
or `SENTINEL_DISPATCH_TOKEN` env var still works and takes priority.

### hookSessionKey → hookSessionPrefix

`hookSessionKey` is now deprecated. If you have both set, `hookSessionPrefix`
now correctly takes priority (previously `hookSessionKey` won).
Rename `hookSessionKey` to `hookSessionPrefix` in your config.

### Redirect protection

HTTP strategies now reject redirects by default. If your monitored endpoints
use redirects, the watcher will fail with an error. Update the endpoint URL
to the final destination.
```

### 10.5 Proposed Config Schema Changes (0.5.0)

```typescript
// New optional fields in SentinelConfig:
interface SentinelConfig {
  // ... existing fields ...

  /** Block private/reserved IP ranges unless explicitly allowlisted. Default: true. */
  blockPrivateHosts?: boolean;

  /** Maximum delivery targets per watcher. Default: 10. */
  maxDeliveryTargetsPerWatcher?: number;

  /** Per-target message rate limit (messages per minute). Default: 10. */
  relayRateLimitPerMinute?: number;
}

// New optional field in WatcherRuntimeState:
interface WatcherRuntimeState {
  // ... existing fields ...

  /** Last dispatch error (if any). */
  lastDispatchError?: string;
  lastDispatchErrorAt?: string;
}
```

---

## Appendix: File-Level Review Notes

### `src/index.ts` (~580 lines)

- Largest file. Contains plugin entrypoint, webhook handler, `HookResponseRelayManager`, delivery logic, and many helper functions.
- **Recommendation:** Extract `HookResponseRelayManager` to its own file. Extract delivery functions. Target: <300 lines for `index.ts`.

### `src/strategies/sse.ts`

- Not a real SSE client. Uses fetch→text→split, losing streaming benefits.
- **Recommendation:** Complete rewrite in P2 using `ReadableStream` chunks.

### `src/strategies/httpPoll.ts`

- Uses recursive `setTimeout` instead of `setInterval`. This is actually correct (avoids overlapping ticks) but the `void tick()` pattern means errors in the first tick are swallowed.
- **Recommendation:** Ensure first-tick errors are caught and surfaced.

### `src/stateStore.ts`

- No file locking. Concurrent processes writing to the same state file could corrupt it.
- `loadState()` silently returns empty state on any error (including parse errors).
- **Recommendation (P2):** Add advisory file locking. Log a warning when state file parse fails vs file-not-found.

### `src/callbackEnvelope.ts`

- Clean, well-structured. The `getTemplateString()` function duplicates template rendering logic from `template.ts` but adds inline interpolation support.
- **Recommendation (P1):** Consolidate with `template.ts` rendering.
