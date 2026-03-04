import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelControl } from "./tool.js";
import { DEFAULT_SENTINEL_WEBHOOK_PATH, SentinelConfig } from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_SENTINEL_WEBHOOK_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

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
          handler(req, res) {
            if (req.method !== "POST") {
              res.writeHead(405, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, route: path }));
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
