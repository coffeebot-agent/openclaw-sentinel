import { evaluateConditions, hashPayload } from "./evaluator.js";
import { assertHostAllowed, assertWatcherLimits } from "./limits.js";
import { defaultStatePath, loadState, saveState } from "./stateStore.js";
import { renderTemplate } from "./template.js";
import { validateWatcherDefinition } from "./validator.js";
import { createCallbackEnvelope } from "./callbackEnvelope.js";
import { httpPollStrategy } from "./strategies/httpPoll.js";
import { httpLongPollStrategy } from "./strategies/httpLongPoll.js";
import { sseStrategy } from "./strategies/sse.js";
import { websocketStrategy } from "./strategies/websocket.js";
import {
  DEFAULT_SENTINEL_WEBHOOK_PATH,
  DeliveryTarget,
  GatewayWebhookDispatcher,
  NotificationPayloadMode,
  SentinelConfig,
  WatcherDefinition,
  WatcherRuntimeState,
} from "./types.js";

export const RESET_BACKOFF_AFTER_MS = 60_000;
const MAX_DEBUG_NOTIFICATION_CHARS = 7000;

function trimForChat(text: string): string {
  if (text.length <= MAX_DEBUG_NOTIFICATION_CHARS) return text;
  return `${text.slice(0, MAX_DEBUG_NOTIFICATION_CHARS)}…`;
}

function resolveNotificationPayloadMode(
  config: SentinelConfig,
  watcher: WatcherDefinition,
): NotificationPayloadMode {
  const override = watcher.fire.notificationPayloadMode;
  if (override === "none" || override === "concise" || override === "debug") return override;
  if (config.notificationPayloadMode === "none") return "none";
  return config.notificationPayloadMode === "debug" ? "debug" : "concise";
}

function buildDeliveryNotificationMessage(
  watcher: WatcherDefinition,
  body: Record<string, unknown>,
  mode: NotificationPayloadMode,
): string {
  const matchedAt =
    typeof body.trigger === "object" &&
    body.trigger !== null &&
    typeof (body.trigger as Record<string, unknown>).matchedAt === "string"
      ? ((body.trigger as Record<string, unknown>).matchedAt as string)
      : new Date().toISOString();

  const concise = `Sentinel watcher "${watcher.id}" fired event "${watcher.fire.eventName}" at ${matchedAt}.`;
  if (mode !== "debug") return concise;

  const envelopeJson = JSON.stringify(body, null, 2) ?? "{}";
  return trimForChat(`${concise}\n\nSENTINEL_DEBUG_ENVELOPE_JSON:\n${envelopeJson}`);
}

export interface WatcherCreateContext {
  deliveryTargets?: DeliveryTarget[];
}

export interface WatcherNotifier {
  notify(target: DeliveryTarget, message: string): Promise<void>;
}

export const backoff = (base: number, max: number, failures: number): number => {
  const raw = Math.min(max, base * 2 ** failures);
  const jitter = Math.floor(raw * 0.25 * (Math.random() * 2 - 1));
  return Math.max(base, raw + jitter);
};

export class WatcherManager {
  private watchers = new Map<string, WatcherDefinition>();
  private runtime: Record<string, WatcherRuntimeState> = {};
  private stops = new Map<string, () => void | Promise<void>>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statePath: string;
  private webhookRegistration: {
    path: string;
    status: "pending" | "ok" | "error";
    message?: string;
    updatedAt?: string;
  } = {
    path: DEFAULT_SENTINEL_WEBHOOK_PATH,
    status: "pending",
  };

  constructor(
    private config: SentinelConfig,
    private dispatcher: GatewayWebhookDispatcher,
    private notifier?: WatcherNotifier,
  ) {
    this.statePath = config.stateFilePath ?? defaultStatePath();
  }

  async init(): Promise<void> {
    const state = await loadState(this.statePath);
    this.runtime = state.runtime;

    for (const rawWatcher of state.watchers) {
      try {
        const watcher = validateWatcherDefinition(rawWatcher);
        assertHostAllowed(this.config, watcher.endpoint);
        assertWatcherLimits(this.config, this.list(), watcher);
        this.watchers.set(watcher.id, watcher);
      } catch (err) {
        const prev = this.runtime[rawWatcher.id];
        this.runtime[rawWatcher.id] = {
          id: rawWatcher.id,
          consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
          reconnectAttempts: prev?.reconnectAttempts ?? 0,
          lastError: `Invalid persisted watcher: ${String((err as any)?.message ?? err)}`,
          lastResponseAt: prev?.lastResponseAt,
          lastEvaluated: prev?.lastEvaluated,
          lastPayloadHash: prev?.lastPayloadHash,
          lastPayload: prev?.lastPayload,
        };
      }
    }

    for (const watcher of this.list().filter((w) => w.enabled)) await this.startWatcher(watcher.id);
  }

  async create(input: unknown, ctx?: WatcherCreateContext): Promise<WatcherDefinition> {
    const watcher = validateWatcherDefinition(input);
    if (!watcher.deliveryTargets?.length && ctx?.deliveryTargets?.length) {
      watcher.deliveryTargets = ctx.deliveryTargets;
    }
    assertHostAllowed(this.config, watcher.endpoint);
    assertWatcherLimits(this.config, this.list(), watcher);
    if (this.watchers.has(watcher.id)) throw new Error(`Watcher already exists: ${watcher.id}`);
    this.watchers.set(watcher.id, watcher);
    this.runtime[watcher.id] = { id: watcher.id, consecutiveFailures: 0, reconnectAttempts: 0 };
    if (watcher.enabled) await this.startWatcher(watcher.id);
    await this.persist();
    return watcher;
  }

  list(): WatcherDefinition[] {
    return [...this.watchers.values()];
  }
  status(id: string): WatcherRuntimeState | undefined {
    return this.runtime[id];
  }

  setNotifier(notifier: WatcherNotifier | undefined): void {
    this.notifier = notifier;
  }

  setWebhookRegistrationStatus(status: "ok" | "error", message?: string, path?: string): void {
    this.webhookRegistration = {
      path: path ?? this.webhookRegistration.path,
      status,
      message,
      updatedAt: new Date().toISOString(),
    };
  }

  async enable(id: string): Promise<void> {
    const w = this.require(id);
    w.enabled = true;
    await this.startWatcher(id);
    await this.persist();
  }
  async disable(id: string): Promise<void> {
    const w = this.require(id);
    w.enabled = false;
    await this.stopWatcher(id);
    await this.persist();
  }
  async remove(id: string): Promise<void> {
    await this.stopWatcher(id);
    this.watchers.delete(id);
    delete this.runtime[id];
    await this.persist();
  }

  private require(id: string): WatcherDefinition {
    const w = this.watchers.get(id);
    if (!w) throw new Error(`Watcher not found: ${id}`);
    return w;
  }

  private async startWatcher(id: string): Promise<void> {
    if (this.stops.has(id)) return;
    const watcher = this.require(id);
    const handler = (
      {
        "http-poll": httpPollStrategy,
        websocket: websocketStrategy,
        sse: sseStrategy,
        "http-long-poll": httpLongPollStrategy,
      } as const
    )[watcher.strategy];

    const handleFailure = async (err: unknown) => {
      const rt = this.runtime[id] ?? { id, consecutiveFailures: 0, reconnectAttempts: 0 };
      rt.reconnectAttempts ??= 0;

      const errMsg = String(err instanceof Error ? err.message : err);
      rt.lastDisconnectAt = new Date().toISOString();
      rt.lastDisconnectReason = errMsg;
      rt.lastError = errMsg;

      if (rt.lastConnectAt) {
        const connectedMs = Date.now() - new Date(rt.lastConnectAt).getTime();
        if (connectedMs >= RESET_BACKOFF_AFTER_MS) {
          rt.consecutiveFailures = 0;
        }
      }

      rt.consecutiveFailures += 1;
      this.runtime[id] = rt;

      if (this.retryTimers.has(id)) {
        await this.persist();
        return;
      }

      const delay = backoff(watcher.retry.baseMs, watcher.retry.maxMs, rt.consecutiveFailures);
      if (rt.consecutiveFailures <= watcher.retry.maxRetries && watcher.enabled) {
        rt.reconnectAttempts += 1;
        await this.stopWatcher(id);
        const timer = setTimeout(() => {
          this.retryTimers.delete(id);
          this.startWatcher(id).catch(() => undefined);
        }, delay);
        this.retryTimers.set(id, timer);
      }
      await this.persist();
    };

    const stop = await handler(
      watcher,
      async (payload) => {
        const rt = this.runtime[id] ?? { id, consecutiveFailures: 0, reconnectAttempts: 0 };
        const previousPayload = rt.lastPayload;
        const matched = evaluateConditions(
          watcher.conditions,
          watcher.match,
          payload,
          previousPayload,
        );
        rt.lastPayloadHash = hashPayload(payload);
        rt.lastPayload = payload;
        rt.lastResponseAt = new Date().toISOString();
        rt.lastEvaluated = rt.lastResponseAt;
        rt.consecutiveFailures = 0;
        rt.reconnectAttempts = 0;
        rt.lastError = undefined;
        this.runtime[id] = rt;
        if (matched) {
          const matchedAt = new Date().toISOString();
          const payloadBody = renderTemplate(watcher.fire.payloadTemplate, {
            watcher,
            event: { name: watcher.fire.eventName },
            payload,
            timestamp: matchedAt,
          });
          const webhookPath = watcher.fire.webhookPath ?? DEFAULT_SENTINEL_WEBHOOK_PATH;
          const body = createCallbackEnvelope({
            watcher,
            payload,
            payloadBody,
            matchedAt,
            webhookPath,
          });
          await this.dispatcher.dispatch(webhookPath, body);

          const deliveryMode = resolveNotificationPayloadMode(this.config, watcher);
          const isSentinelWebhook = webhookPath === DEFAULT_SENTINEL_WEBHOOK_PATH;
          if (
            deliveryMode !== "none" &&
            watcher.deliveryTargets?.length &&
            this.notifier &&
            !isSentinelWebhook
          ) {
            const attemptedAt = new Date().toISOString();
            const message = buildDeliveryNotificationMessage(watcher, body, deliveryMode);
            const failures: Array<{ target: DeliveryTarget; error: string }> = [];
            let successCount = 0;

            await Promise.all(
              watcher.deliveryTargets.map(async (target) => {
                try {
                  await this.notifier?.notify(target, message);
                  successCount += 1;
                } catch (err) {
                  failures.push({
                    target,
                    error: String((err as Error)?.message ?? err),
                  });
                }
              }),
            );

            rt.lastDelivery = {
              attemptedAt,
              successCount,
              failureCount: failures.length,
              failures: failures.length > 0 ? failures : undefined,
            };
          }

          if (watcher.fireOnce) {
            watcher.enabled = false;
            await this.stopWatcher(id);
          }
        }
        await this.persist();
      },
      handleFailure,
      {
        onConnect: () => {
          const rt = this.runtime[id] ?? { id, consecutiveFailures: 0, reconnectAttempts: 0 };
          rt.lastConnectAt = new Date().toISOString();
          this.runtime[id] = rt;
        },
      },
    );

    this.stops.set(id, stop);
  }

  private async stopWatcher(id: string): Promise<void> {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    const stop = this.stops.get(id);
    if (stop) await Promise.resolve(stop());
    this.stops.delete(id);
  }

  async audit(): Promise<Record<string, unknown>> {
    const bySkill = this.list().reduce<Record<string, number>>((acc, w) => {
      acc[w.skillId] = (acc[w.skillId] ?? 0) + 1;
      return acc;
    }, {});
    return {
      totals: {
        watchers: this.list().length,
        enabled: this.list().filter((w) => w.enabled).length,
        errored: Object.values(this.runtime).filter((r) => !!r.lastError).length,
      },
      bySkill,
      allowedHosts: this.config.allowedHosts,
      limits: this.config.limits,
      statePath: this.statePath,
      webhookRegistration: this.webhookRegistration,
    };
  }

  private async persist(): Promise<void> {
    await saveState(this.statePath, this.list(), this.runtime);
  }
}
