import { evaluateConditions, hashPayload } from './evaluator.js';
import { assertHostAllowed, assertWatcherLimits } from './limits.js';
import { defaultStatePath, loadState, saveState } from './stateStore.js';
import { renderTemplate } from './template.js';
import { validateWatcherDefinition } from './validator.js';
import { httpPollStrategy } from './strategies/httpPoll.js';
import { httpLongPollStrategy } from './strategies/httpLongPoll.js';
import { sseStrategy } from './strategies/sse.js';
import { websocketStrategy } from './strategies/websocket.js';
import { GatewayWebhookDispatcher, SentinelConfig, WatcherDefinition, WatcherRuntimeState } from './types.js';

const backoff = (base: number, max: number, failures: number) => Math.min(max, base * (2 ** failures));

export class WatcherManager {
  private watchers = new Map<string, WatcherDefinition>();
  private runtime: Record<string, WatcherRuntimeState> = {};
  private stops = new Map<string, () => void | Promise<void>>();
  private statePath: string;

  constructor(private config: SentinelConfig, private dispatcher: GatewayWebhookDispatcher) {
    this.statePath = config.stateFilePath ?? defaultStatePath();
  }

  async init(): Promise<void> {
    const state = await loadState(this.statePath);
    state.watchers.forEach((w) => this.watchers.set(w.id, w));
    this.runtime = state.runtime;
    for (const watcher of state.watchers.filter((w) => w.enabled)) await this.startWatcher(watcher.id);
  }

  async create(input: unknown): Promise<WatcherDefinition> {
    const watcher = validateWatcherDefinition(input);
    assertHostAllowed(this.config, watcher.endpoint);
    assertWatcherLimits(this.config, this.list(), watcher);
    if (this.watchers.has(watcher.id)) throw new Error(`Watcher already exists: ${watcher.id}`);
    this.watchers.set(watcher.id, watcher);
    this.runtime[watcher.id] = { id: watcher.id, consecutiveFailures: 0 };
    if (watcher.enabled) await this.startWatcher(watcher.id);
    await this.persist();
    return watcher;
  }

  list(): WatcherDefinition[] { return [...this.watchers.values()]; }
  status(id: string): WatcherRuntimeState | undefined { return this.runtime[id]; }

  async enable(id: string): Promise<void> { const w = this.require(id); w.enabled = true; await this.startWatcher(id); await this.persist(); }
  async disable(id: string): Promise<void> { const w = this.require(id); w.enabled = false; await this.stopWatcher(id); await this.persist(); }
  async remove(id: string): Promise<void> { await this.stopWatcher(id); this.watchers.delete(id); delete this.runtime[id]; await this.persist(); }

  private require(id: string): WatcherDefinition { const w = this.watchers.get(id); if (!w) throw new Error(`Watcher not found: ${id}`); return w; }

  private async startWatcher(id: string): Promise<void> {
    if (this.stops.has(id)) return;
    const watcher = this.require(id);
    const handler = ({ 'http-poll': httpPollStrategy, websocket: websocketStrategy, sse: sseStrategy, 'http-long-poll': httpLongPollStrategy } as const)[watcher.strategy];
    const stop = await handler(watcher, async (payload) => {
      const rt = this.runtime[id] ?? { id, consecutiveFailures: 0 };
      const previousPayload = rt.lastPayload;
      const matched = evaluateConditions(watcher.conditions, watcher.match, payload, previousPayload);
      rt.lastPayloadHash = hashPayload(payload);
      rt.lastPayload = payload;
      rt.lastResponseAt = new Date().toISOString();
      rt.lastEvaluated = rt.lastResponseAt;
      rt.consecutiveFailures = 0;
      this.runtime[id] = rt;
      if (matched) {
        const body = renderTemplate(watcher.fire.payloadTemplate, {
          watcher,
          event: { name: watcher.fire.eventName },
          payload,
          timestamp: new Date().toISOString()
        });
        await this.dispatcher.dispatch(watcher.fire.webhookPath, body);
      }
      await this.persist();
    }).catch(async (err) => {
      const rt = this.runtime[id] ?? { id, consecutiveFailures: 0 };
      rt.consecutiveFailures += 1;
      rt.lastError = String(err?.message ?? err);
      this.runtime[id] = rt;
      const delay = backoff(watcher.retry.baseMs, watcher.retry.maxMs, rt.consecutiveFailures);
      if (rt.consecutiveFailures <= watcher.retry.maxRetries && watcher.enabled) {
        setTimeout(() => this.startWatcher(id).catch(() => undefined), delay);
      }
      await this.persist();
      return async () => undefined;
    });

    this.stops.set(id, stop);
  }

  private async stopWatcher(id: string): Promise<void> {
    const stop = this.stops.get(id);
    if (stop) await Promise.resolve(stop());
    this.stops.delete(id);
  }

  async audit(): Promise<Record<string, unknown>> {
    const bySkill = this.list().reduce<Record<string, number>>((acc, w) => { acc[w.skillId] = (acc[w.skillId] ?? 0) + 1; return acc; }, {});
    return {
      totals: {
        watchers: this.list().length,
        enabled: this.list().filter((w) => w.enabled).length,
        errored: Object.values(this.runtime).filter((r) => !!r.lastError).length
      },
      bySkill,
      allowedHosts: this.config.allowedHosts,
      limits: this.config.limits,
      statePath: this.statePath
    };
  }

  private async persist(): Promise<void> {
    await saveState(this.statePath, this.list(), this.runtime);
  }
}
