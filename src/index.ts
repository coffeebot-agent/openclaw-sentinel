import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelControl } from "./tool.js";
import { DEFAULT_SENTINEL_WEBHOOK_PATH, DeliveryTarget, SentinelConfig } from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();
const DEFAULT_HOOK_SESSION_KEY = "agent:main:main";
const MAX_SENTINEL_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_SENTINEL_WEBHOOK_TEXT_CHARS = 8000;
const MAX_SENTINEL_PAYLOAD_JSON_CHARS = 2500;
const SENTINEL_EVENT_INSTRUCTION_PREFIX =
  "SENTINEL_TRIGGER: This system event came from /hooks/sentinel. Evaluate action policy, decide whether to notify configured deliveryTargets, and execute safe follow-up actions.";

function trimText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asIsoString(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveSentinelPluginConfig(api: OpenClawPluginApi): Partial<SentinelConfig> {
  const pluginConfig = isRecord(api.pluginConfig)
    ? (api.pluginConfig as Partial<SentinelConfig>)
    : {};

  const configRoot = isRecord(api.config) ? (api.config as Record<string, unknown>) : undefined;
  const legacyRootConfig = configRoot?.sentinel;
  if (legacyRootConfig === undefined) return pluginConfig;

  api.logger?.warn?.(
    '[openclaw-sentinel] Detected deprecated root-level config key "sentinel". Move settings to plugins.entries.openclaw-sentinel.config. Root-level "sentinel" may fail with: Unrecognized key: "sentinel".',
  );

  if (!isRecord(legacyRootConfig)) return pluginConfig;
  if (Object.keys(pluginConfig).length > 0) return pluginConfig;

  return legacyRootConfig as Partial<SentinelConfig>;
}

function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return (
    isRecord(value) &&
    typeof value.channel === "string" &&
    typeof value.to === "string" &&
    (value.accountId === undefined || typeof value.accountId === "string")
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_SENTINEL_WEBHOOK_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function clipPayloadForPrompt(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized) return value;
  if (serialized.length <= MAX_SENTINEL_PAYLOAD_JSON_CHARS) return value;

  const clipped = serialized.slice(0, MAX_SENTINEL_PAYLOAD_JSON_CHARS);
  const overflow = serialized.length - clipped.length;
  return {
    __truncated: true,
    truncatedChars: overflow,
    maxChars: MAX_SENTINEL_PAYLOAD_JSON_CHARS,
    preview: `${clipped}…`,
  };
}

type SentinelEventEnvelope = {
  watcherId: string | null;
  eventName: string | null;
  skillId?: string;
  matchedAt: string;
  payload: unknown;
  dedupeKey: string;
  correlationId: string;
  deliveryTargets?: DeliveryTarget[];
  source: {
    route: string;
    plugin: string;
  };
};

function buildSentinelEventEnvelope(payload: Record<string, unknown>): SentinelEventEnvelope {
  const watcherId =
    asString(payload.watcherId) ??
    (isRecord(payload.watcher) ? asString(payload.watcher.id) : undefined);
  const eventName =
    asString(payload.eventName) ??
    (isRecord(payload.event) ? asString(payload.event.name) : undefined);
  const skillId =
    asString(payload.skillId) ??
    (isRecord(payload.watcher) ? asString(payload.watcher.skillId) : undefined) ??
    undefined;
  const matchedAt =
    asIsoString(payload.matchedAt) ?? asIsoString(payload.timestamp) ?? new Date().toISOString();

  const rawPayload =
    payload.payload ??
    (isRecord(payload.event) ? (payload.event.payload ?? payload.event.data) : undefined) ??
    payload;
  const boundedPayload = clipPayloadForPrompt(rawPayload);

  const dedupeSeed = JSON.stringify({
    watcherId: watcherId ?? null,
    eventName: eventName ?? null,
    matchedAt,
  });
  const generatedDedupe = createHash("sha256").update(dedupeSeed).digest("hex").slice(0, 16);
  const dedupeKey =
    asString(payload.dedupeKey) ??
    asString(payload.correlationId) ??
    asString(payload.correlationID) ??
    generatedDedupe;

  const deliveryTargets = Array.isArray(payload.deliveryTargets)
    ? payload.deliveryTargets.filter(isDeliveryTarget)
    : undefined;

  const envelope: SentinelEventEnvelope = {
    watcherId: watcherId ?? null,
    eventName: eventName ?? null,
    matchedAt,
    payload: boundedPayload,
    dedupeKey,
    correlationId: dedupeKey,
    source: {
      route: DEFAULT_SENTINEL_WEBHOOK_PATH,
      plugin: "openclaw-sentinel",
    },
  };

  if (skillId) envelope.skillId = skillId;
  if (deliveryTargets && deliveryTargets.length > 0) envelope.deliveryTargets = deliveryTargets;

  return envelope;
}

function buildSentinelSystemEvent(payload: Record<string, unknown>): string {
  const envelope = buildSentinelEventEnvelope(payload);
  const jsonEnvelope = JSON.stringify(envelope, null, 2);
  const text = `${SENTINEL_EVENT_INSTRUCTION_PREFIX}\nSENTINEL_ENVELOPE_JSON:\n${jsonEnvelope}`;
  return trimText(text, MAX_SENTINEL_WEBHOOK_TEXT_CHARS);
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

async function notifyDeliveryTarget(
  api: OpenClawPluginApi,
  target: DeliveryTarget,
  message: string,
): Promise<void> {
  switch (target.channel) {
    case "telegram":
      await api.runtime.channel.telegram.sendMessageTelegram(target.to, message, {
        accountId: target.accountId,
      });
      return;
    case "discord":
      await api.runtime.channel.discord.sendMessageDiscord(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "slack":
      await api.runtime.channel.slack.sendMessageSlack(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "signal":
      await api.runtime.channel.signal.sendMessageSignal(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "imessage":
      await api.runtime.channel.imessage.sendMessageIMessage(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "whatsapp":
      await api.runtime.channel.whatsapp.sendMessageWhatsApp(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "line":
      await api.runtime.channel.line.sendMessageLine(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    default:
      throw new Error(`Unsupported delivery target channel: ${target.channel}`);
  }
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
      const runtimeConfig = resolveSentinelPluginConfig(api);
      if (Object.keys(runtimeConfig).length > 0) Object.assign(config, runtimeConfig);

      manager.setNotifier({
        async notify(target, message) {
          await notifyDeliveryTarget(api, target, message);
        },
      });

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
