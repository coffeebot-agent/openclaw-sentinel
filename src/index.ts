import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelActionTools } from "./actionTools.js";
import { registerSentinelControl } from "./tool.js";
import {
  DEFAULT_SENTINEL_WEBHOOK_PATH,
  DeliveryTarget,
  HookResponseFallbackMode,
  SentinelCallbackEnvelope,
  SentinelConfig,
} from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();
const DEFAULT_HOOK_SESSION_PREFIX = "agent:main:hooks:sentinel";
const DEFAULT_RELAY_DEDUPE_WINDOW_MS = 120_000;
const DEFAULT_HOOK_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_RESPONSE_FALLBACK_MODE: HookResponseFallbackMode = "concise";
const HOOK_RESPONSE_RELAY_CLEANUP_INTERVAL_MS = 60_000;
const MAX_SENTINEL_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_SENTINEL_WEBHOOK_TEXT_CHARS = 8000;
const MAX_SENTINEL_PAYLOAD_JSON_CHARS = 2500;
const SENTINEL_CALLBACK_WAKE_REASON = "cron:sentinel-callback";
const SENTINEL_CALLBACK_CONTEXT_KEY = "cron:sentinel-callback";

const SUPPORTED_DELIVERY_CHANNELS = new Set([
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
]);

type RelayDeliverySummary = {
  dedupeKey: string;
  attempted: number;
  delivered: number;
  failed: number;
  deduped: boolean;
  pending: boolean;
  timeoutMs: number;
  fallbackMode: HookResponseFallbackMode;
};

type PendingHookResponse = {
  dedupeKey: string;
  sessionKey: string;
  relayTargets: DeliveryTarget[];
  fallbackMessage: string;
  createdAt: number;
  timeoutMs: number;
  fallbackMode: HookResponseFallbackMode;
  timer?: ReturnType<typeof setTimeout>;
  state: "pending" | "completed" | "timed_out";
};

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

function sniffGatewayDispatchToken(
  configRoot: Record<string, unknown> | undefined,
): string | undefined {
  if (!configRoot) return undefined;

  const auth = isRecord(configRoot.auth) ? configRoot.auth : undefined;
  const gateway = isRecord(configRoot.gateway) ? configRoot.gateway : undefined;
  const gatewayAuth = gateway && isRecord(gateway.auth) ? gateway.auth : undefined;
  const server = isRecord(configRoot.server) ? configRoot.server : undefined;
  const serverAuth = server && isRecord(server.auth) ? server.auth : undefined;

  const candidates: unknown[] = [
    auth?.token,
    gateway?.authToken,
    gatewayAuth?.token,
    serverAuth?.token,
    configRoot.gatewayAuthToken,
    configRoot.authToken,
  ];

  for (const candidate of candidates) {
    const token = asString(candidate);
    if (token) return token;
  }

  return undefined;
}

function resolveSentinelPluginConfig(api: OpenClawPluginApi): Partial<SentinelConfig> {
  const pluginConfig = isRecord(api.pluginConfig)
    ? ({ ...api.pluginConfig } as Partial<SentinelConfig>)
    : {};

  const configRoot = isRecord(api.config) ? (api.config as Record<string, unknown>) : undefined;
  const legacyRootConfig = configRoot?.sentinel;

  let resolved: Partial<SentinelConfig> = pluginConfig;
  if (legacyRootConfig !== undefined) {
    api.logger?.warn?.(
      '[openclaw-sentinel] Detected deprecated root-level config key "sentinel". Move settings to plugins.entries.openclaw-sentinel.config. Root-level "sentinel" may fail with: Unrecognized key: "sentinel".',
    );

    if (isRecord(legacyRootConfig) && Object.keys(pluginConfig).length === 0) {
      resolved = { ...(legacyRootConfig as Partial<SentinelConfig>) };
    }
  }

  if (!asString(resolved.dispatchAuthToken)) {
    const sniffedToken = sniffGatewayDispatchToken(configRoot);
    if (sniffedToken) resolved.dispatchAuthToken = sniffedToken;
  }

  return resolved;
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

function validateCallbackEnvelope(payload: Record<string, unknown>): SentinelCallbackEnvelope {
  if (payload.type !== "sentinel.callback" || !payload.version) {
    throw new Error("Invalid sentinel callback: missing type or version");
  }
  return payload as unknown as SentinelCallbackEnvelope;
}

function buildCallbackPrompt(envelope: SentinelCallbackEnvelope): string {
  const callbackJson = {
    watcher: envelope.watcher,
    trigger: envelope.trigger,
    ...(envelope.operatorGoal ? { operatorGoal: envelope.operatorGoal } : {}),
    context: envelope.context,
    payload: clipPayloadForPrompt(envelope.payload),
    deliveryTargets: envelope.deliveryTargets,
    source: envelope.source,
  };

  const text = [
    "SENTINEL_TRIGGER: A sentinel watcher callback has fired. Analyze the callback and take appropriate action.",
    "",
    "Instructions:",
    "- Review the watcher intent, event payload, and operator goal (if present).",
    "- Use sentinel_act to execute remediation actions when the situation calls for it.",
    '- Use sentinel_act with action "notify" to send the result to delivery targets. This is the only way your response reaches the user.',
    "- Use sentinel_escalate if the situation requires user attention or is beyond your ability to resolve.",
    "- If escalating, also use sentinel_act notify to inform delivery targets of the escalation.",
    "- Do not emit control tokens, routing directives, or internal processing notes in your text output.",
    "",
    "SENTINEL_CALLBACK_JSON:",
    JSON.stringify(callbackJson, null, 2),
  ].join("\n");

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

function resolveHookResponseDedupeWindowMs(config: SentinelConfig): number {
  const candidate =
    config.hookResponseDedupeWindowMs ??
    config.hookRelayDedupeWindowMs ??
    DEFAULT_RELAY_DEDUPE_WINDOW_MS;
  return Math.max(0, candidate);
}

function resolveHookResponseTimeoutMs(config: SentinelConfig): number {
  const candidate = config.hookResponseTimeoutMs ?? DEFAULT_HOOK_RESPONSE_TIMEOUT_MS;
  return Math.max(0, candidate);
}

function resolveHookResponseFallbackMode(config: SentinelConfig): HookResponseFallbackMode {
  return config.hookResponseFallbackMode === "none" ? "none" : DEFAULT_HOOK_RESPONSE_FALLBACK_MODE;
}

function buildSessionKey(envelope: SentinelCallbackEnvelope, config: SentinelConfig): string {
  const configuredPrefix = asString(config.hookSessionPrefix);
  const legacyPrefix = asString(config.hookSessionKey);
  const hasCustomPrefix =
    typeof configuredPrefix === "string" && configuredPrefix !== DEFAULT_HOOK_SESSION_PREFIX;

  const rawPrefix = hasCustomPrefix
    ? configuredPrefix
    : (legacyPrefix ?? configuredPrefix ?? DEFAULT_HOOK_SESSION_PREFIX);
  const prefix = rawPrefix.replace(/:+$/g, "");

  if (envelope.hookSessionGroup) {
    return `${prefix}:group:${sanitizeSessionSegment(envelope.hookSessionGroup)}`;
  }

  return `${prefix}:watcher:${sanitizeSessionSegment(envelope.watcher.id)}`;
}

function assertJsonContentType(req: IncomingMessage): void {
  const raw = req.headers["content-type"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return;

  const normalized = header.toLowerCase();
  const isJson =
    normalized.includes("application/json") ||
    normalized.includes("application/cloudevents+json") ||
    normalized.includes("+json");

  if (!isJson) {
    throw new Error(`Unsupported Content-Type: ${header}`);
  }
}

async function readSentinelWebhookPayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  assertJsonContentType(req);

  const preParsed = (req as { body?: unknown }).body;
  if (preParsed !== undefined) {
    if (!isRecord(preParsed)) {
      throw new Error("Payload must be a JSON object");
    }
    return preParsed;
  }

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

async function deliverMessageToTargets(
  api: OpenClawPluginApi,
  targets: DeliveryTarget[],
  message: string,
): Promise<{ delivered: number; failed: number }> {
  if (targets.length === 0) return { delivered: 0, failed: 0 };

  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        await notifyDeliveryTarget(api, target, message);
        return true;
      } catch {
        return false;
      }
    }),
  );

  const delivered = results.filter(Boolean).length;
  return {
    delivered,
    failed: results.length - delivered,
  };
}

class HookResponseRelayManager {
  private recentByDedupe = new Map<string, number>();
  private pendingByDedupe = new Map<string, PendingHookResponse>();
  private pendingQueueBySession = new Map<string, string[]>();
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly config: SentinelConfig,
    private readonly api: OpenClawPluginApi,
  ) {}

  register(args: {
    dedupeKey: string;
    sessionKey: string;
    relayTargets: DeliveryTarget[];
    fallbackMessage: string;
  }): RelayDeliverySummary {
    this.cleanup();

    const dedupeWindowMs = resolveHookResponseDedupeWindowMs(this.config);
    const now = Date.now();

    const existingTs = this.recentByDedupe.get(args.dedupeKey);
    if (
      dedupeWindowMs > 0 &&
      typeof existingTs === "number" &&
      now - existingTs <= dedupeWindowMs
    ) {
      return {
        dedupeKey: args.dedupeKey,
        attempted: args.relayTargets.length,
        delivered: 0,
        failed: 0,
        deduped: true,
        pending: false,
        timeoutMs: resolveHookResponseTimeoutMs(this.config),
        fallbackMode: resolveHookResponseFallbackMode(this.config),
      };
    }

    this.recentByDedupe.set(args.dedupeKey, now);
    this.scheduleCleanup();

    const timeoutMs = resolveHookResponseTimeoutMs(this.config);
    const fallbackMode = resolveHookResponseFallbackMode(this.config);

    if (args.relayTargets.length === 0) {
      return {
        dedupeKey: args.dedupeKey,
        attempted: 0,
        delivered: 0,
        failed: 0,
        deduped: false,
        pending: false,
        timeoutMs,
        fallbackMode,
      };
    }

    const pending: PendingHookResponse = {
      dedupeKey: args.dedupeKey,
      sessionKey: args.sessionKey,
      relayTargets: args.relayTargets,
      fallbackMessage: args.fallbackMessage,
      createdAt: now,
      timeoutMs,
      fallbackMode,
      state: "pending",
    };

    this.pendingByDedupe.set(args.dedupeKey, pending);
    const queue = this.pendingQueueBySession.get(args.sessionKey) ?? [];
    queue.push(args.dedupeKey);
    this.pendingQueueBySession.set(args.sessionKey, queue);

    if (timeoutMs === 0) {
      void this.handleTimeout(args.dedupeKey);
    } else {
      pending.timer = setTimeout(() => {
        void this.handleTimeout(args.dedupeKey);
      }, timeoutMs);
    }

    return {
      dedupeKey: args.dedupeKey,
      attempted: args.relayTargets.length,
      delivered: 0,
      failed: 0,
      deduped: false,
      pending: true,
      timeoutMs,
      fallbackMode,
    };
  }

  fulfill(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    const dedupeKey = this.popNextPendingDedupe(sessionKey);
    if (!dedupeKey) return;
    const pending = this.pendingByDedupe.get(dedupeKey);
    if (!pending || pending.state !== "pending") return;
    this.markClosed(pending, "completed");
    this.api.logger?.info?.(
      `[openclaw-sentinel] Relay contract fulfilled via sentinel_act for dedupe=${dedupeKey}`,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const pending of this.pendingByDedupe.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
    }

    this.pendingByDedupe.clear();
    this.pendingQueueBySession.clear();
    this.recentByDedupe.clear();
  }

  private scheduleCleanup(): void {
    if (this.disposed || this.cleanupTimer) return;

    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.cleanup();
    }, HOOK_RESPONSE_RELAY_CLEANUP_INTERVAL_MS);

    this.cleanupTimer.unref?.();
  }

  private cleanup(now = Date.now()): void {
    const dedupeWindowMs = resolveHookResponseDedupeWindowMs(this.config);

    if (dedupeWindowMs > 0) {
      for (const [key, ts] of this.recentByDedupe.entries()) {
        if (now - ts > dedupeWindowMs) {
          this.recentByDedupe.delete(key);
        }
      }
    }

    for (const [key, pending] of this.pendingByDedupe.entries()) {
      const gcAfterMs = Math.max(pending.timeoutMs, dedupeWindowMs, 1_000);
      if (pending.state !== "pending" && now - pending.createdAt > gcAfterMs) {
        this.pendingByDedupe.delete(key);
        this.removeFromSessionQueue(pending.sessionKey, key);
      }
    }

    if (this.pendingByDedupe.size > 0 || this.recentByDedupe.size > 0) {
      this.scheduleCleanup();
    }
  }

  private removeFromSessionQueue(sessionKey: string, dedupeKey: string): void {
    const queue = this.pendingQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const filtered = queue.filter((key) => key !== dedupeKey);
    if (filtered.length === 0) {
      this.pendingQueueBySession.delete(sessionKey);
      return;
    }

    this.pendingQueueBySession.set(sessionKey, filtered);
  }

  private popNextPendingDedupe(sessionKey: string): string | undefined {
    const queue = this.pendingQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) return undefined;

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) continue;
      const pending = this.pendingByDedupe.get(next);
      if (pending && pending.state === "pending") {
        if (queue.length === 0) this.pendingQueueBySession.delete(sessionKey);
        else this.pendingQueueBySession.set(sessionKey, queue);
        return next;
      }
    }

    this.pendingQueueBySession.delete(sessionKey);
    return undefined;
  }

  private async handleTimeout(dedupeKey: string): Promise<void> {
    const pending = this.pendingByDedupe.get(dedupeKey);
    if (!pending || pending.state !== "pending") return;

    if (pending.fallbackMode === "none") {
      this.markClosed(pending, "timed_out");
      return;
    }

    await this.completeWithMessage(pending, pending.fallbackMessage);
  }

  private async completeWithMessage(pending: PendingHookResponse, message: string): Promise<void> {
    const delivery = await deliverMessageToTargets(this.api, pending.relayTargets, message);

    this.markClosed(pending, "timed_out");

    this.api.logger?.info?.(
      `[openclaw-sentinel] Sent timeout fallback for dedupe=${pending.dedupeKey} delivered=${delivery.delivered} failed=${delivery.failed}`,
    );
  }

  private markClosed(pending: PendingHookResponse, state: "completed" | "timed_out"): void {
    pending.state = state;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.pendingByDedupe.set(pending.dedupeKey, pending);
  }
}

function isSentinelSession(sessionKey: string | undefined, config: SentinelConfig): boolean {
  if (!sessionKey) return false;
  const prefix = (config.hookSessionPrefix ?? DEFAULT_HOOK_SESSION_PREFIX).replace(/:+$/g, "");
  return sessionKey.startsWith(prefix + ":");
}

const DENIED_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*\s+)\/\s*$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b:\(\)\{.*\|.*&.*\}.*:/,
  /\bformat\b.*\/y/i,
  /\bshutdown\b/,
  /\breboot\b/,
];

function isDeniedCommand(cmd: string): boolean {
  return DENIED_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd));
}

export function createSentinelPlugin(overrides?: Partial<SentinelConfig>) {
  const config: SentinelConfig = {
    allowedHosts: [],
    localDispatchBase: "http://127.0.0.1:18789",
    dispatchAuthToken: asString(process.env.SENTINEL_DISPATCH_TOKEN),
    hookSessionPrefix: DEFAULT_HOOK_SESSION_PREFIX,
    hookRelayDedupeWindowMs: DEFAULT_RELAY_DEDUPE_WINDOW_MS,
    hookResponseTimeoutMs: DEFAULT_HOOK_RESPONSE_TIMEOUT_MS,
    hookResponseFallbackMode: DEFAULT_HOOK_RESPONSE_FALLBACK_MODE,
    hookResponseDedupeWindowMs: DEFAULT_RELAY_DEDUPE_WINDOW_MS,
    notificationPayloadMode: "concise",
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

      const response = await fetch(`${config.localDispatchBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let responseBody = "";
        try {
          responseBody = await response.text();
        } catch {
          responseBody = "";
        }
        const details = responseBody ? ` body=${trimText(responseBody, 256)}` : "";
        const error = new Error(
          `dispatch failed with status ${response.status}${details}`,
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
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
      config.dispatchAuthToken = asString(config.dispatchAuthToken);

      manager.setLogger(api.logger);

      if (Array.isArray(config.allowedHosts) && config.allowedHosts.length === 0) {
        api.logger?.warn?.(
          "[openclaw-sentinel] allowedHosts is empty. Watcher creation will fail until at least one host is configured.",
        );
      }

      const hasLegacyHookSessionKey = !!asString(config.hookSessionKey);
      const hasCustomHookSessionPrefix =
        !!asString(config.hookSessionPrefix) &&
        asString(config.hookSessionPrefix) !== DEFAULT_HOOK_SESSION_PREFIX;
      if (hasLegacyHookSessionKey) {
        api.logger?.warn?.(
          hasCustomHookSessionPrefix
            ? "[openclaw-sentinel] hookSessionKey is deprecated and ignored when hookSessionPrefix is set. Remove hookSessionKey from config."
            : "[openclaw-sentinel] hookSessionKey is deprecated. Rename it to hookSessionPrefix.",
        );
      }

      manager.setNotifier({
        async notify(target, message) {
          await notifyDeliveryTarget(api, target, message);
        },
      });

      registerSentinelControl(api.registerTool.bind(api), manager);
      registerSentinelActionTools(api.registerTool.bind(api), manager, api, config);

      let hookResponseRelayManager: HookResponseRelayManager | undefined;

      if (typeof api.on === "function") {
        api.on("before_tool_call", (event, ctx) => {
          if (!isSentinelSession(ctx.sessionKey, config)) return;

          if (event.toolName === "sentinel_act") {
            const cmd = String(event.params?.command ?? "");
            if (isDeniedCommand(cmd)) {
              return { block: true, blockReason: `Command not allowed: ${cmd}` };
            }
          }
        });

        api.on("after_tool_call", (event, ctx) => {
          if (!isSentinelSession(ctx.sessionKey, config)) return;

          if (event.toolName === "sentinel_act" && !event.error) {
            hookResponseRelayManager?.fulfill(ctx.sessionKey);
          }

          api.logger?.info?.(
            `[openclaw-sentinel] Action trace: tool=${event.toolName} duration=${event.durationMs}ms error=${event.error ?? "none"}`,
          );
        });
      }

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

      hookResponseRelayManager = new HookResponseRelayManager(config, api);

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
              const envelope = validateCallbackEnvelope(payload);
              const sessionKey = buildSessionKey(envelope, config);
              const text = buildCallbackPrompt(envelope);
              const enqueued = api.runtime.system.enqueueSystemEvent(text, {
                sessionKey,
                contextKey: SENTINEL_CALLBACK_CONTEXT_KEY,
              });
              api.runtime.system.requestHeartbeatNow({
                reason: SENTINEL_CALLBACK_WAKE_REASON,
                sessionKey,
              });

              const relayTargets = normalizeDeliveryTargets([
                ...(envelope.deliveryTargets ?? []),
                ...(envelope.deliveryContext?.deliveryTargets ?? []),
                ...(envelope.deliveryContext?.currentChat
                  ? [envelope.deliveryContext.currentChat]
                  : []),
              ]);
              const fallback = `Sentinel callback: ${envelope.watcher.eventName} (watcher ${envelope.watcher.id})`;
              const relay = hookResponseRelayManager.register({
                dedupeKey: envelope.trigger.dedupeKey,
                sessionKey,
                relayTargets,
                fallbackMessage: fallback,
              });

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
              const unsupportedMediaType = message.includes("Unsupported Content-Type");
              const status = message.includes("too large")
                ? 413
                : unsupportedMediaType
                  ? 415
                  : badRequest
                    ? 400
                    : 500;
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: message }));
            }
          },
        });
        registeredPaths.add(path);
        manager.setWebhookRegistrationStatus("ok", "Route registered", path);
        api.logger?.info?.(`[openclaw-sentinel] Registered default webhook route ${path}`);
      } catch (err) {
        hookResponseRelayManager.dispose();
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
    plugin.register(api);
    void plugin.init();
  },
};

export const register = sentinelPlugin.register.bind(sentinelPlugin);
export const activate = sentinelPlugin.register.bind(sentinelPlugin);
export default sentinelPlugin;

export * from "./types.js";
