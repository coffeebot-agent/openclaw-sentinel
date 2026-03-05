import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelControl } from "./tool.js";
import {
  DEFAULT_SENTINEL_WEBHOOK_PATH,
  SENTINEL_CALLBACK_ENVELOPE_KEY,
  SentinelCallbackEnvelope,
  SentinelConfig,
} from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();
const DEFAULT_HOOK_SESSION_KEY = "agent:main:main";
const MAX_SENTINEL_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_SENTINEL_WEBHOOK_TEXT_CHARS = 2000;
const CONTROL_TOKEN_PATTERN = /\[?\s*NO_REPLY\s*\]?/gi;

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_SENTINEL_WEBHOOK_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function trimText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeControlTokens(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replaceAll(CONTROL_TOKEN_PATTERN, " ").replace(/\s+/g, " ").trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function asCallbackEnvelope(value: unknown): SentinelCallbackEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "sentinel.callback" || value.version !== "1") return undefined;
  return value as unknown as SentinelCallbackEnvelope;
}

function sanitizeContextValue(value: unknown): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeControlTokens(value);
    return sanitized ?? "";
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeContextValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeContextValue(entry)]),
    );
  }
  return value;
}

function stringifyContext(context: unknown): string {
  try {
    return JSON.stringify(sanitizeContextValue(context ?? {}), null, 2);
  } catch {
    return JSON.stringify({ value: String(context) }, null, 2);
  }
}

function buildEnvelopeFallbackEvent(envelope: SentinelCallbackEnvelope): string {
  const eventName = envelope.watcher.eventName;
  const watcherId = envelope.watcher.id;
  const contextJson = stringifyContext(envelope.context);

  return trimText(
    [
      `Sentinel Callback: ${eventName}`,
      "",
      "SENTINEL_CALLBACK_CONTEXT_JSON:",
      "```json",
      contextJson,
      "```",
      "",
      `Watcher: ${watcherId}`,
      `MatchedAt: ${envelope.trigger.matchedAt}`,
      `Intent: ${envelope.intent}`,
    ].join("\n"),
    MAX_SENTINEL_WEBHOOK_TEXT_CHARS,
  );
}

function buildSentinelSystemEvent(payload: Record<string, unknown>): string {
  const rawText = asString(payload.text) ?? asString(payload.message);
  const sanitizedText = sanitizeControlTokens(rawText);
  if (sanitizedText) return trimText(sanitizedText, MAX_SENTINEL_WEBHOOK_TEXT_CHARS);

  const envelope = asCallbackEnvelope(payload[SENTINEL_CALLBACK_ENVELOPE_KEY]);
  if (envelope) return buildEnvelopeFallbackEvent(envelope);

  const watcherId = asString(payload.watcherId);
  const eventName =
    asString(payload.eventName) ??
    (isRecord(payload.event) ? asString(payload.event.name) : undefined);

  const labels: string[] = ["Sentinel webhook received"];
  if (eventName) labels.push(`event=${eventName}`);
  if (watcherId) labels.push(`watcher=${watcherId}`);
  return trimText(labels.join(" "), MAX_SENTINEL_WEBHOOK_TEXT_CHARS);
}

async function readSentinelWebhookPayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  const preParsed = (req as { body?: unknown }).body;
  if (isRecord(preParsed)) return preParsed;

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += next.length;
    if (total > MAX_SENTINEL_WEBHOOK_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(next);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }

  if (!isRecord(parsed)) {
    throw new Error("Payload must be a JSON object");
  }

  return parsed;
}

export function createSentinelPlugin(overrides?: Partial<SentinelConfig>) {
  const config: SentinelConfig = {
    allowedHosts: [],
    localDispatchBase: "http://127.0.0.1:18789",
    dispatchAuthToken: process.env.SENTINEL_DISPATCH_TOKEN,
    hookSessionKey: DEFAULT_HOOK_SESSION_KEY,
    limits: {
      maxWatchersTotal: 200,
      maxWatchersPerSkill: 20,
      maxConditionsPerWatcher: 25,
      maxIntervalMsFloor: 1000,
    },
    ...overrides,
  };

  const manager = new WatcherManager(config, {
    async dispatch(path, body) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.dispatchAuthToken) headers.authorization = `Bearer ${config.dispatchAuthToken}`;
      await fetch(`${config.localDispatchBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    },
  });

  return {
    manager,
    async init() {
      await manager.init();
    },
    register(api: OpenClawPluginApi) {
      registerSentinelControl(api.registerTool.bind(api), manager);

      const path = normalizePath(DEFAULT_SENTINEL_WEBHOOK_PATH);
      if (!api.registerHttpRoute) {
        const msg =
          "registerHttpRoute API not available; default sentinel webhook route was not registered";
        manager.setWebhookRegistrationStatus("error", msg, path);
        api.logger?.error?.(`[openclaw-sentinel] ${msg}`);
        return;
      }

      const registrarKey = api.registerHttpRoute as unknown as object;
      const registeredPaths =
        registeredWebhookPathsByRegistrar.get(registrarKey) ?? new Set<string>();
      registeredWebhookPathsByRegistrar.set(registrarKey, registeredPaths);
      if (registeredPaths.has(path)) {
        manager.setWebhookRegistrationStatus("ok", "Route already registered (idempotent)", path);
        return;
      }

      try {
        api.registerHttpRoute({
          path,
          auth: "gateway",
          match: "exact",
          replaceExisting: true,
          async handler(req, res) {
            if (req.method !== "POST") {
              res.writeHead(405, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }

            try {
              const payload = await readSentinelWebhookPayload(req);
              const sessionKey = config.hookSessionKey ?? DEFAULT_HOOK_SESSION_KEY;
              const text = buildSentinelSystemEvent(payload);
              const enqueued = api.runtime.system.enqueueSystemEvent(text, { sessionKey });
              api.runtime.system.requestHeartbeatNow({
                reason: "hook:sentinel",
                sessionKey,
              });

              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: true,
                  route: path,
                  sessionKey,
                  enqueued,
                }),
              );
            } catch (err) {
              const message = String((err as Error)?.message ?? err);
              const badRequest =
                message.includes("Invalid JSON payload") ||
                message.includes("Payload must be a JSON object");
              const status = message.includes("too large") ? 413 : badRequest ? 400 : 500;
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: message }));
            }
          },
        });
        registeredPaths.add(path);
        manager.setWebhookRegistrationStatus("ok", "Route registered", path);
        api.logger?.info?.(`[openclaw-sentinel] Registered default webhook route ${path}`);
      } catch (err) {
        const msg = `Failed to register default webhook route ${path}: ${String((err as Error)?.message ?? err)}`;
        manager.setWebhookRegistrationStatus("error", msg, path);
        api.logger?.error?.(`[openclaw-sentinel] ${msg}`);
      }
    },
  };
}

// OpenClaw plugin entrypoint (default plugin object with register)
const sentinelPlugin = {
  id: "openclaw-sentinel",
  name: "OpenClaw Sentinel",
  description: "Secure declarative gateway-native watcher plugin for OpenClaw",
  configSchema: sentinelConfigSchema,
  register(api: OpenClawPluginApi) {
    const plugin = createSentinelPlugin(api.pluginConfig as Partial<SentinelConfig>);
    void plugin.init();
    plugin.register(api);
  },
};

export const register = sentinelPlugin.register.bind(sentinelPlugin);
export const activate = sentinelPlugin.register.bind(sentinelPlugin);
export default sentinelPlugin;

export * from "./types.js";
