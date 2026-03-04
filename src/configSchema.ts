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

const HookResponseFallbackModeSchema = Type.Union([Type.Literal("none"), Type.Literal("concise")]);

const ConfigSchema = Type.Object(
  {
    allowedHosts: Type.Array(Type.String()),
    localDispatchBase: Type.String({ minLength: 1 }),
    dispatchAuthToken: Type.Optional(Type.String()),
    hookSessionKey: Type.Optional(Type.String({ minLength: 1 })),
    hookSessionPrefix: Type.Optional(Type.String({ minLength: 1 })),
    hookSessionGroup: Type.Optional(Type.String({ minLength: 1 })),
    hookRelayDedupeWindowMs: Type.Optional(Type.Integer({ minimum: 0 })),
    hookResponseTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    hookResponseFallbackMode: Type.Optional(HookResponseFallbackModeSchema),
    hookResponseDedupeWindowMs: Type.Optional(Type.Integer({ minimum: 0 })),
    stateFilePath: Type.Optional(Type.String()),
    notificationPayloadMode: Type.Optional(NotificationPayloadModeSchema),
    limits: Type.Optional(LimitsSchema),
  },
  { additionalProperties: false },
);

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findInvalidNumericPath(input: Record<string, unknown>): string | undefined {
  const numericPaths = [
    "hookRelayDedupeWindowMs",
    "hookResponseTimeoutMs",
    "hookResponseDedupeWindowMs",
  ] as const;

  for (const key of numericPaths) {
    const value = input[key];
    if (typeof value === "number" && !Number.isFinite(value)) {
      return `/${key}`;
    }
  }

  const limits = input.limits;
  if (limits && typeof limits === "object" && !Array.isArray(limits)) {
    const limitsRecord = limits as Record<string, unknown>;
    const limitKeys = [
      "maxWatchersTotal",
      "maxWatchersPerSkill",
      "maxConditionsPerWatcher",
      "maxIntervalMsFloor",
    ] as const;
    for (const key of limitKeys) {
      const value = limitsRecord[key];
      if (typeof value === "number" && !Number.isFinite(value)) {
        return `/limits/${key}`;
      }
    }
  }

  return undefined;
}

function withDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const limitsIn = (value.limits as Record<string, unknown> | undefined) ?? {};

  return {
    allowedHosts: Array.isArray(value.allowedHosts) ? value.allowedHosts : [],
    localDispatchBase:
      typeof value.localDispatchBase === "string" && value.localDispatchBase.length > 0
        ? value.localDispatchBase
        : "http://127.0.0.1:18789",
    dispatchAuthToken: trimToUndefined(value.dispatchAuthToken),
    hookSessionKey: typeof value.hookSessionKey === "string" ? value.hookSessionKey : undefined,
    hookSessionPrefix:
      typeof value.hookSessionPrefix === "string"
        ? value.hookSessionPrefix
        : "agent:main:hooks:sentinel",
    hookSessionGroup:
      typeof value.hookSessionGroup === "string" ? value.hookSessionGroup : undefined,
    hookRelayDedupeWindowMs:
      typeof value.hookRelayDedupeWindowMs === "number" &&
      Number.isFinite(value.hookRelayDedupeWindowMs)
        ? value.hookRelayDedupeWindowMs
        : 120000,
    hookResponseTimeoutMs:
      typeof value.hookResponseTimeoutMs === "number" &&
      Number.isFinite(value.hookResponseTimeoutMs)
        ? value.hookResponseTimeoutMs
        : 30000,
    hookResponseFallbackMode: value.hookResponseFallbackMode === "none" ? "none" : "concise",
    hookResponseDedupeWindowMs:
      typeof value.hookResponseDedupeWindowMs === "number" &&
      Number.isFinite(value.hookResponseDedupeWindowMs)
        ? value.hookResponseDedupeWindowMs
        : 120000,
    stateFilePath: typeof value.stateFilePath === "string" ? value.stateFilePath : undefined,
    notificationPayloadMode:
      value.notificationPayloadMode === "none"
        ? "none"
        : value.notificationPayloadMode === "debug"
          ? "debug"
          : "concise",
    limits: {
      maxWatchersTotal:
        typeof limitsIn.maxWatchersTotal === "number" && Number.isFinite(limitsIn.maxWatchersTotal)
          ? limitsIn.maxWatchersTotal
          : 200,
      maxWatchersPerSkill:
        typeof limitsIn.maxWatchersPerSkill === "number" &&
        Number.isFinite(limitsIn.maxWatchersPerSkill)
          ? limitsIn.maxWatchersPerSkill
          : 20,
      maxConditionsPerWatcher:
        typeof limitsIn.maxConditionsPerWatcher === "number" &&
        Number.isFinite(limitsIn.maxConditionsPerWatcher)
          ? limitsIn.maxConditionsPerWatcher
          : 25,
      maxIntervalMsFloor:
        typeof limitsIn.maxIntervalMsFloor === "number" &&
        Number.isFinite(limitsIn.maxIntervalMsFloor)
          ? limitsIn.maxIntervalMsFloor
          : 1000,
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

    const source = value as Record<string, unknown>;
    const invalidNumericPath = findInvalidNumericPath(source);
    if (invalidNumericPath) {
      return {
        success: false,
        error: {
          issues: [issue(invalidNumericPath, "Expected a finite number")],
        },
      };
    }

    const candidate = withDefaults(source);

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
        description:
          "Optional bearer token override for webhook dispatch auth. Sentinel auto-detects gateway auth token when available.",
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
        type: "integer",
        minimum: 0,
        description:
          "Suppress duplicate relay messages for the same dedupe key within this window (milliseconds)",
        default: 120000,
      },
      hookResponseTimeoutMs: {
        type: "integer",
        minimum: 0,
        description:
          "Milliseconds to wait for an assistant-authored hook response before optional fallback relay",
        default: 30000,
      },
      hookResponseFallbackMode: {
        type: "string",
        enum: ["none", "concise"],
        description:
          "Fallback behavior when no assistant response arrives before hookResponseTimeoutMs: none (silent timeout) or concise fail-safe relay",
        default: "concise",
      },
      hookResponseDedupeWindowMs: {
        type: "integer",
        minimum: 0,
        description:
          "Deduplicate hook response-delivery contracts by dedupe key within this window (milliseconds)",
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
            type: "integer",
            description: "Maximum total watchers across all skills",
            default: 200,
          },
          maxWatchersPerSkill: {
            type: "integer",
            description: "Maximum watchers per skill",
            default: 20,
          },
          maxConditionsPerWatcher: {
            type: "integer",
            description: "Maximum conditions per watcher definition",
            default: 25,
          },
          maxIntervalMsFloor: {
            type: "integer",
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
      help: "Optional override for webhook dispatch auth token. Sentinel auto-detects gateway auth token when available (or use SENTINEL_DISPATCH_TOKEN env var).",
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
    hookResponseTimeoutMs: {
      label: "Hook Response Timeout (ms)",
      help: "How long to wait for assistant-authored hook output before optional fallback relay",
      advanced: true,
    },
    hookResponseFallbackMode: {
      label: "Hook Response Fallback Mode",
      help: "If timeout occurs, choose none (silent) or concise fail-safe relay",
      advanced: true,
    },
    hookResponseDedupeWindowMs: {
      label: "Hook Response Dedupe Window (ms)",
      help: "Deduplicate hook-response delivery contracts by dedupe key within this window",
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
