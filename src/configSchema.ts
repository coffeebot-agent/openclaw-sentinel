import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

const LimitsSchema = Type.Object(
  {
    maxWatchersTotal: Type.Integer({ minimum: 1 }),
    maxWatchersPerSkill: Type.Integer({ minimum: 1 }),
    maxConditionsPerWatcher: Type.Integer({ minimum: 1 }),
    maxIntervalMsFloor: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const NotificationPayloadModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("concise"),
  Type.Literal("debug"),
]);

const ConfigSchema = Type.Object(
  {
    allowedHosts: Type.Array(Type.String()),
    localDispatchBase: Type.String({ minLength: 1 }),
    dispatchAuthToken: Type.Optional(Type.String()),
    hookSessionKey: Type.Optional(Type.String({ minLength: 1 })),
    hookSessionPrefix: Type.Optional(Type.String({ minLength: 1 })),
    hookSessionGroup: Type.Optional(Type.String({ minLength: 1 })),
    hookRelayDedupeWindowMs: Type.Optional(Type.Integer({ minimum: 0 })),
    stateFilePath: Type.Optional(Type.String()),
    notificationPayloadMode: Type.Optional(NotificationPayloadModeSchema),
    limits: Type.Optional(LimitsSchema),
  },
  { additionalProperties: false },
);

function withDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const limitsIn = (value.limits as Record<string, unknown> | undefined) ?? {};

  return {
    allowedHosts: Array.isArray(value.allowedHosts) ? value.allowedHosts : [],
    localDispatchBase:
      typeof value.localDispatchBase === "string" && value.localDispatchBase.length > 0
        ? value.localDispatchBase
        : "http://127.0.0.1:18789",
    dispatchAuthToken:
      typeof value.dispatchAuthToken === "string" ? value.dispatchAuthToken : undefined,
    hookSessionKey: typeof value.hookSessionKey === "string" ? value.hookSessionKey : undefined,
    hookSessionPrefix:
      typeof value.hookSessionPrefix === "string"
        ? value.hookSessionPrefix
        : "agent:main:hooks:sentinel",
    hookSessionGroup:
      typeof value.hookSessionGroup === "string" ? value.hookSessionGroup : undefined,
    hookRelayDedupeWindowMs:
      typeof value.hookRelayDedupeWindowMs === "number" ? value.hookRelayDedupeWindowMs : 120000,
    stateFilePath: typeof value.stateFilePath === "string" ? value.stateFilePath : undefined,
    notificationPayloadMode:
      value.notificationPayloadMode === "none"
        ? "none"
        : value.notificationPayloadMode === "debug"
          ? "debug"
          : "concise",
    limits: {
      maxWatchersTotal:
        typeof limitsIn.maxWatchersTotal === "number" ? limitsIn.maxWatchersTotal : 200,
      maxWatchersPerSkill:
        typeof limitsIn.maxWatchersPerSkill === "number" ? limitsIn.maxWatchersPerSkill : 20,
      maxConditionsPerWatcher:
        typeof limitsIn.maxConditionsPerWatcher === "number"
          ? limitsIn.maxConditionsPerWatcher
          : 25,
      maxIntervalMsFloor:
        typeof limitsIn.maxIntervalMsFloor === "number" ? limitsIn.maxIntervalMsFloor : 1000,
    },
  };
}

function issue(path: string, message: string) {
  const segments = path.replace(/^\//, "").split("/").filter(Boolean);
  return {
    path: segments,
    message,
  };
}

export const sentinelConfigSchema: OpenClawPluginConfigSchema = {
  safeParse: (value: unknown) => {
    if (value === undefined) return { success: true, data: undefined };

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: { issues: [issue("/", "Config must be an object")] },
      };
    }

    const candidate = withDefaults(value as Record<string, unknown>);

    if (!Value.Check(ConfigSchema, candidate)) {
      const first = [...Value.Errors(ConfigSchema, candidate)][0];
      return {
        success: false,
        error: {
          issues: [issue(String(first?.path || "/"), String(first?.message || "Invalid config"))],
        },
      };
    }

    // explicit URL validation (TypeBox format validators are not enabled by default)
    try {
      new URL(candidate.localDispatchBase as string);
    } catch {
      return {
        success: false,
        error: {
          issues: [issue("/localDispatchBase", "Invalid URL")],
        },
      };
    }

    return { success: true, data: candidate };
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
        description: "Base URL for internal webhook dispatch",
        default: "http://127.0.0.1:18789",
      },
      dispatchAuthToken: {
        type: "string",
        description: "Bearer token for authenticating webhook dispatch requests",
      },
      hookSessionKey: {
        type: "string",
        description:
          "Deprecated alias for hookSessionPrefix. Sentinel always appends watcher/group segments to prevent a shared global callback session.",
      },
      hookSessionPrefix: {
        type: "string",
        description:
          "Base session key prefix used for isolated /hooks/sentinel callback sessions (default: agent:main:hooks:sentinel)",
        default: "agent:main:hooks:sentinel",
      },
      hookSessionGroup: {
        type: "string",
        description:
          "Optional default session group key. When set, callbacks without explicit hookSessionGroup are routed to this group session.",
      },
      hookRelayDedupeWindowMs: {
        type: "number",
        minimum: 0,
        description:
          "Suppress duplicate relay messages for the same dedupe key within this window (milliseconds)",
        default: 120000,
      },
      stateFilePath: {
        type: "string",
        description: "Custom path for the sentinel state persistence file",
      },
      notificationPayloadMode: {
        type: "string",
        enum: ["none", "concise", "debug"],
        description:
          "Controls delivery-target notifications: none (suppress message fan-out), concise relay text (default), or relay text with debug envelope payload",
        default: "concise",
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
    hookSessionKey: {
      label: "Hook Session Key (Deprecated)",
      help: "Deprecated alias for hookSessionPrefix. Sentinel appends watcher/group segments automatically.",
      advanced: true,
    },
    hookSessionPrefix: {
      label: "Hook Session Prefix",
      help: "Base prefix for isolated callback sessions (default: agent:main:hooks:sentinel)",
      advanced: true,
    },
    hookSessionGroup: {
      label: "Default Hook Session Group",
      help: "Optional default group key for callback sessions. Watchers with the same group share one isolated session.",
      advanced: true,
    },
    hookRelayDedupeWindowMs: {
      label: "Hook Relay Dedupe Window (ms)",
      help: "Suppress duplicate relay messages with the same dedupe key for this many milliseconds",
      advanced: true,
    },
    stateFilePath: {
      label: "State File Path",
      help: "Custom path for sentinel state persistence file",
      advanced: true,
    },
    notificationPayloadMode: {
      label: "Notification Payload Mode",
      help: "Choose none (suppress delivery-target messages), concise relay text (default), or include debug envelope payload",
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
