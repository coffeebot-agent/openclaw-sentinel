import { registerSentinelControl } from './tool.js';
import { WatcherManager } from './watcherManager.js';
import { SentinelConfig } from './types.js';

export function createSentinelPlugin(overrides?: Partial<SentinelConfig>) {
  const config: SentinelConfig = {
    allowedHosts: ['api.github.com', 'api.coingecko.com', 'example.com'],
    localDispatchBase: 'http://127.0.0.1:4389',
    limits: {
      maxWatchersTotal: 200,
      maxWatchersPerSkill: 20,
      maxConditionsPerWatcher: 25,
      maxIntervalMsFloor: 1000
    },
    ...overrides
  };

  const manager = new WatcherManager(config, {
    async dispatch(path, body) {
      await fetch(`${config.localDispatchBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }
  });

  return {
    manager,
    async init() { await manager.init(); },
    register(api: { registerTool: (name: string, handler: (input: unknown) => Promise<unknown>) => void }) {
      registerSentinelControl(api.registerTool, manager);
    }
  };
}

export * from './types.js';
