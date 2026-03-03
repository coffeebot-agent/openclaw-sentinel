import { StrategyHandler } from './base.js';

export const httpPollStrategy: StrategyHandler = async (watcher, onPayload) => {
  const interval = watcher.intervalMs ?? 30000;
  const timer = setInterval(async () => {
    const response = await fetch(watcher.endpoint, {
      method: watcher.method ?? 'GET',
      headers: watcher.headers,
      body: watcher.body,
      signal: AbortSignal.timeout(watcher.timeoutMs ?? 15000)
    });
    const payload = await response.json();
    await onPayload(payload);
  }, interval);

  return async () => clearInterval(timer);
};
