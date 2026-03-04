import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelControl } from "./tool.js";
import { DEFAULT_SENTINEL_WEBHOOK_PATH, DeliveryTarget, SentinelConfig } from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();
const DEFAULT_HOOK_SESSION_PREFIX = "agent:main:hooks:sentinel";
const DEFAULT_RELAY_DEDUPE_WINDOW_MS = 120_000;
const MAX_SENTINEL_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_SENTINEL_WEBHOOK_TEXT_CHARS = 8000;
const MAX_SENTINEL_PAYLOAD_JSON_CHARS = 2500;
const SENTINEL_EVENT_INSTRUCTION_PREFIX =
  "SENTINEL_TRIGGER: This system event came from /hooks/sentinel. Evaluate action policy, decide whether to notify configured deliveryTargets, and execute safe follow-up actions.";

const SUPPORTED_DELIVERY_CHANNELS = new Set([
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
]);

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

function sanitizeSessionSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "unknown";
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
  hookSessionGroup?: string;
  deliveryTargets?: DeliveryTarget[];
  source: {
    route: string;
    plugin: string;
  };
};

function getNestedString(value: unknown, path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return asString(cursor);
}

function buildSentinelEventEnvelope(payload: Record<string, unknown>): SentinelEventEnvelope {
  const watcherId =
    asString(payload.watcherId) ??
    getNestedString(payload, ["watcher", "id"]) ??
    getNestedString(payload, ["context", "watcherId"]);

  const eventName =
    asString(payload.eventName) ??
    getNestedString(payload, ["watcher", "eventName"]) ??
    getNestedString(payload, ["event", "name"]);

  const skillId =
    asString(payload.skillId) ??
    getNestedString(payload, ["watcher", "skillId"]) ??
    getNestedString(payload, ["context", "skillId"]) ??
    undefined;

  const matchedAt =
    asIsoString(payload.matchedAt) ??
    asIsoString(payload.timestamp) ??
    asIsoString(getNestedString(payload, ["trigger", "matchedAt"])) ??
    new Date().toISOString();

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
    getNestedString(payload, ["trigger", "dedupeKey"]) ??
    generatedDedupe;

  const deliveryTargets = Array.isArray(payload.deliveryTargets)
    ? payload.deliveryTargets.filter(isDeliveryTarget)
    : undefined;

  const sourceRoute =
    getNestedString(payload, ["source", "route"]) ?? DEFAULT_SENTINEL_WEBHOOK_PATH;
  const sourcePlugin = getNestedString(payload, ["source", "plugin"]) ?? "openclaw-sentinel";

  const hookSessionGroup =
    asString(payload.hookSessionGroup) ??
    asString(payload.sessionGroup) ??
    getNestedString(payload, ["watcher", "sessionGroup"]);

  const envelope: SentinelEventEnvelope = {
    watcherId: watcherId ?? null,
    eventName: eventName ?? null,
    matchedAt,
    payload: boundedPayload,
    dedupeKey,
    correlationId: dedupeKey,
    source: {
      route: sourceRoute,
      plugin: sourcePlugin,
    },
  };

  if (skillId) envelope.skillId = skillId;
  if (hookSessionGroup) envelope.hookSessionGroup = hookSessionGroup;
  if (deliveryTargets && deliveryTargets.length > 0) envelope.deliveryTargets = deliveryTargets;

  return envelope;
}

function buildSentinelSystemEvent(envelope: SentinelEventEnvelope): string {
  const jsonEnvelope = JSON.stringify(envelope, null, 2);
  const text = `${SENTINEL_EVENT_INSTRUCTION_PREFIX}\nSENTINEL_ENVELOPE_JSON:\n${jsonEnvelope}`;
  return trimText(text, MAX_SENTINEL_WEBHOOK_TEXT_CHARS);
}

function normalizeDeliveryTargets(targets: DeliveryTarget[]): DeliveryTarget[] {
  const deduped = new Map<string, DeliveryTarget>();
  for (const target of targets) {
    const channel = asString(target.channel);
    const to = asString(target.to);
    if (!channel || !to || !SUPPORTED_DELIVERY_CHANNELS.has(channel)) continue;
    const accountId = asString(target.accountId);
    const key = `${channel}:${to}:${accountId ?? ""}`;
    deduped.set(key, { channel, to, ...(accountId ? { accountId } : {}) });
  }
  return [...deduped.values()];
}

function inferTargetFromSessionKey(
  sessionKey: string,
  accountId?: string,
): DeliveryTarget | undefined {
  const segments = sessionKey
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length < 5) return undefined;

  const channel = segments[2];
  const to = segments.at(-1);
  if (!channel || !to || !SUPPORTED_DELIVERY_CHANNELS.has(channel)) return undefined;

  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
  };
}

function inferRelayTargets(
  payload: Record<string, unknown>,
  envelope: SentinelEventEnvelope,
): DeliveryTarget[] {
  if (envelope.deliveryTargets?.length) {
    return normalizeDeliveryTargets(envelope.deliveryTargets);
  }

  const inferred: DeliveryTarget[] = [];

  if (isDeliveryTarget(payload.currentChat)) inferred.push(payload.currentChat);

  const sourceCurrentChat = isRecord(payload.source) ? payload.source.currentChat : undefined;
  if (isDeliveryTarget(sourceCurrentChat)) inferred.push(sourceCurrentChat);

  const messageChannel = asString(payload.messageChannel);
  const requesterSenderId = asString(payload.requesterSenderId);
  if (messageChannel && requesterSenderId && SUPPORTED_DELIVERY_CHANNELS.has(messageChannel)) {
    inferred.push({ channel: messageChannel, to: requesterSenderId });
  }

  const fromSessionKey = asString(payload.sessionKey);
  if (fromSessionKey) {
    const target = inferTargetFromSessionKey(fromSessionKey, asString(payload.agentAccountId));
    if (target) inferred.push(target);
  }

  const sourceSessionKey = getNestedString(payload, ["source", "sessionKey"]);
  if (sourceSessionKey) {
    const sourceAccountId = getNestedString(payload, ["source", "accountId"]);
    const target = inferTargetFromSessionKey(sourceSessionKey, sourceAccountId);
    if (target) inferred.push(target);
  }

  return normalizeDeliveryTargets(inferred);
}

function summarizeContext(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value).slice(0, 3);
  if (entries.length === 0) return undefined;

  const chunks = entries.map(([key, val]) => {
    if (typeof val === "string") return `${key}=${trimText(val, 64)}`;
    if (typeof val === "number" || typeof val === "boolean") return `${key}=${String(val)}`;
    return `${key}=${trimText(JSON.stringify(val), 64)}`;
  });
  return chunks.join(" · ");
}

function buildRelayMessage(envelope: SentinelEventEnvelope): string {
  const title = envelope.eventName ? `Sentinel alert: ${envelope.eventName}` : "Sentinel alert";
  const watcher = envelope.watcherId ? `watcher ${envelope.watcherId}` : "watcher unknown";

  const payloadRecord = isRecord(envelope.payload) ? envelope.payload : undefined;
  const contextSummary = summarizeContext(
    payloadRecord && isRecord(payloadRecord.context) ? payloadRecord.context : payloadRecord,
  );

  const lines = [title, `${watcher} · ${envelope.matchedAt}`];
  if (contextSummary) lines.push(contextSummary);

  const text = lines.join("\n").trim();
  return text.length > 0 ? text : "Sentinel callback received.";
}

function buildIsolatedHookSessionKey(
  envelope: SentinelEventEnvelope,
  config: SentinelConfig,
): string {
  const rawPrefix =
    asString(config.hookSessionKey) ??
    asString(config.hookSessionPrefix) ??
    DEFAULT_HOOK_SESSION_PREFIX;
  const prefix = rawPrefix.replace(/:+$/g, "");

  const group = asString(envelope.hookSessionGroup) ?? asString(config.hookSessionGroup);
  if (group) {
    return `${prefix}:group:${sanitizeSessionSegment(group)}`;
  }

  if (envelope.watcherId) {
    return `${prefix}:watcher:${sanitizeSessionSegment(envelope.watcherId)}`;
  }

  if (envelope.dedupeKey) {
    return `${prefix}:event:${sanitizeSessionSegment(envelope.dedupeKey.slice(0, 24))}`;
  }

  return `${prefix}:event:unknown`;
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
    hookSessionPrefix: DEFAULT_HOOK_SESSION_PREFIX,
    hookRelayDedupeWindowMs: DEFAULT_RELAY_DEDUPE_WINDOW_MS,
    notificationPayloadMode: "concise",
    limits: {
      maxWatchersTotal: 200,
      maxWatchersPerSkill: 20,
      maxConditionsPerWatcher: 25,
      maxIntervalMsFloor: 1000,
    },
    ...overrides,
  };

  const recentRelayByDedupe = new Map<string, number>();

  const shouldRelayForDedupe = (dedupeKey: string): boolean => {
    const windowMs = Math.max(0, config.hookRelayDedupeWindowMs ?? DEFAULT_RELAY_DEDUPE_WINDOW_MS);
    if (windowMs === 0) return true;

    const now = Date.now();
    for (const [key, ts] of recentRelayByDedupe.entries()) {
      if (now - ts > windowMs) recentRelayByDedupe.delete(key);
    }

    const prev = recentRelayByDedupe.get(dedupeKey);
    if (typeof prev === "number" && now - prev <= windowMs) return false;

    recentRelayByDedupe.set(dedupeKey, now);
    return true;
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
              const envelope = buildSentinelEventEnvelope(payload);
              const sessionKey = buildIsolatedHookSessionKey(envelope, config);
              const text = buildSentinelSystemEvent(envelope);
              const enqueued = api.runtime.system.enqueueSystemEvent(text, { sessionKey });
              api.runtime.system.requestHeartbeatNow({
                reason: "hook:sentinel",
                sessionKey,
              });

              const relayTargets = inferRelayTargets(payload, envelope);
              const relayMessage = buildRelayMessage(envelope);
              const relay = {
                dedupeKey: envelope.dedupeKey,
                attempted: relayTargets.length,
                delivered: 0,
                failed: 0,
                deduped: false,
              };

              if (relayTargets.length > 0) {
                if (!shouldRelayForDedupe(envelope.dedupeKey)) {
                  relay.deduped = true;
                } else {
                  await Promise.all(
                    relayTargets.map(async (target) => {
                      try {
                        await notifyDeliveryTarget(api, target, relayMessage);
                        relay.delivered += 1;
                      } catch {
                        relay.failed += 1;
                      }
                    }),
                  );
                }
              }

              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: true,
                  route: path,
                  sessionKey,
                  enqueued,
                  relay,
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
