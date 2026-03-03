import { SentinelConfig, WatcherDefinition } from './types.js';

export function assertWatcherLimits(config: SentinelConfig, watchers: WatcherDefinition[], incoming: WatcherDefinition): void {
  if (watchers.length >= config.limits.maxWatchersTotal) {
    throw new Error(`Watcher limit reached: ${config.limits.maxWatchersTotal}`);
  }
  const perSkill = watchers.filter((w) => w.skillId === incoming.skillId).length;
  if (perSkill >= config.limits.maxWatchersPerSkill) {
    throw new Error(`Per-skill watcher limit reached for ${incoming.skillId}: ${config.limits.maxWatchersPerSkill}`);
  }
  if (incoming.conditions.length > config.limits.maxConditionsPerWatcher) {
    throw new Error(`Too many conditions: ${incoming.conditions.length}`);
  }
  if ((incoming.intervalMs ?? config.limits.maxIntervalMsFloor) < config.limits.maxIntervalMsFloor) {
    throw new Error(`intervalMs too low; minimum is ${config.limits.maxIntervalMsFloor}`);
  }
}

export function assertHostAllowed(config: SentinelConfig, endpoint: string): void {
  const host = new URL(endpoint).host;
  if (!config.allowedHosts.includes(host)) {
    throw new Error(`Host not allowed: ${host}`);
  }
}
