import { StrategyHandler } from './base.js';

export const httpLongPollStrategy: StrategyHandler = async (watcher, onPayload) => {
  let active = true;
  const loop = async () => {
    while (active) {
      const response = await fetch(watcher.endpoint, {
        method: watcher.method ?? 'GET',
        headers: watcher.headers,
        body: watcher.body,
        signal: AbortSignal.timeout(watcher.timeoutMs ?? 60000)
      });
      await onPayload(await response.json());
    }
  };
  loop().catch(() => undefined);
  return async () => { active = false; };
};
