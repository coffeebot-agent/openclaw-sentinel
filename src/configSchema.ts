import { z } from "zod";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

const limitsSchema = z.object({
  maxWatchersTotal: z.number().int().positive().default(200),
  maxWatchersPerSkill: z.number().int().positive().default(20),
  maxConditionsPerWatcher: z.number().int().positive().default(25),
  maxIntervalMsFloor: z.number().int().positive().default(1000),
});

const configZodSchema = z.object({
  allowedHosts: z.array(z.string()).default([]),
  localDispatchBase: z.string().url().default("http://127.0.0.1:18789"),
  dispatchAuthToken: z.string().optional(),
  stateFilePath: z.string().optional(),
  limits: limitsSchema.default({}),
});

export const sentinelConfigSchema: OpenClawPluginConfigSchema = {
  safeParse: (value: unknown) => {
    if (value === undefined) return { success: true, data: undefined };
    return configZodSchema.safeParse(value);
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowedHosts: {
        type: "array",
        items: { type: "string" },
        description:
          "Hostnames the watchers are permitted to connect to. Must be explicitly configured — no hosts are allowed by default.",
        default: [],
      },
      localDispatchBase: {
        type: "string",
        format: "uri",
        description: "Base URL for internal webhook dispatch",
        default: "http://127.0.0.1:18789",
      },
      dispatchAuthToken: {
        type: "string",
        description: "Bearer token for authenticating webhook dispatch requests",
      },
      stateFilePath: {
        type: "string",
        description: "Custom path for the sentinel state persistence file",
      },
      limits: {
        type: "object",
        additionalProperties: false,
        description: "Resource limits for watcher creation",
        properties: {
          maxWatchersTotal: {
            type: "number",
            description: "Maximum total watchers across all skills",
            default: 200,
          },
          maxWatchersPerSkill: {
            type: "number",
            description: "Maximum watchers per skill",
            default: 20,
          },
          maxConditionsPerWatcher: {
            type: "number",
            description: "Maximum conditions per watcher definition",
            default: 25,
          },
          maxIntervalMsFloor: {
            type: "number",
            description: "Minimum allowed polling interval in milliseconds",
            default: 1000,
          },
        },
      },
    },
  },
  uiHints: {
    allowedHosts: {
      label: "Allowed Hosts",
      help: "Hostnames the watchers are permitted to connect to",
    },
    localDispatchBase: {
      label: "Dispatch Base URL",
      help: "Base URL for internal webhook dispatch (default: http://127.0.0.1:18789)",
    },
    dispatchAuthToken: {
      label: "Dispatch Auth Token",
      help: "Bearer token for webhook dispatch authentication (or use SENTINEL_DISPATCH_TOKEN env var)",
      sensitive: true,
      placeholder: "sk-...",
    },
    stateFilePath: {
      label: "State File Path",
      help: "Custom path for sentinel state persistence file",
      advanced: true,
    },
    "limits.maxWatchersTotal": {
      label: "Max Watchers",
      help: "Maximum total watchers across all skills",
      advanced: true,
    },
    "limits.maxWatchersPerSkill": {
      label: "Max Per Skill",
      help: "Maximum watchers a single skill can create",
      advanced: true,
    },
    "limits.maxConditionsPerWatcher": {
      label: "Max Conditions",
      help: "Maximum conditions per watcher definition",
      advanced: true,
    },
    "limits.maxIntervalMsFloor": {
      label: "Min Poll Interval (ms)",
      help: "Minimum allowed polling interval in milliseconds",
      advanced: true,
    },
  },
};
