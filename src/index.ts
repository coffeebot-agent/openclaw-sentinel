import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSentinelControl } from "./tool.js";
import { WatcherManager } from "./watcherManager.js";
import { SentinelConfig } from "./types.js";
import { sentinelConfigSchema } from "./configSchema.js";

export function createSentinelPlugin(overrides?: Partial<SentinelConfig>) {
  const config: SentinelConfig = {
    allowedHosts: [],
    localDispatchBase: "http://127.0.0.1:18789",
    dispatchAuthToken: process.env.SENTINEL_DISPATCH_TOKEN,
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
      if (config.dispatchAuthToken) headers["authorization"] = `Bearer ${config.dispatchAuthToken}`;
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
