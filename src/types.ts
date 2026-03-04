export type Strategy = "http-poll" | "websocket" | "sse" | "http-long-poll";
export type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "absent"
  | "contains"
  | "matches"
  | "changed";

export interface Condition {
  path: string;
  op: Operator;
  value?: unknown;
}

export const DEFAULT_SENTINEL_WEBHOOK_PATH = "/hooks/sentinel";

export type PriorityLevel = "low" | "normal" | "high" | "critical";
export type NotificationPayloadMode = "none" | "concise" | "debug";
export type NotificationPayloadModeOverride = "inherit" | NotificationPayloadMode;

export type HookResponseFallbackMode = "none" | "concise";

export const SENTINEL_ORIGIN_SESSION_KEY_METADATA = "openclaw.sentinel.origin.sessionKey";
export const SENTINEL_ORIGIN_CHANNEL_METADATA = "openclaw.sentinel.origin.channel";
export const SENTINEL_ORIGIN_TARGET_METADATA = "openclaw.sentinel.origin.to";
export const SENTINEL_ORIGIN_ACCOUNT_METADATA = "openclaw.sentinel.origin.accountId";

export interface FireConfig {
  webhookPath?: string;
  eventName: string;
  payloadTemplate: Record<string, import("./template.js").TemplateValue>;
  intent?: string;
  contextTemplate?: Record<string, import("./template.js").TemplateValue>;
  priority?: PriorityLevel;
  deadlineTemplate?: string;
  dedupeKeyTemplate?: string;
  notificationPayloadMode?: NotificationPayloadModeOverride;
  sessionGroup?: string;
}

export interface RetryPolicy {
  maxRetries: number;
  baseMs: number;
  maxMs: number;
}

export interface DeliveryTarget {
  channel: string;
  to: string;
  accountId?: string;
}

export interface WatcherDefinition {
  id: string;
  skillId: string;
  enabled: boolean;
  strategy: Strategy;
  endpoint: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  intervalMs?: number;
  timeoutMs?: number;
  match: "all" | "any";
  conditions: Condition[];
  fire: FireConfig;
  retry: RetryPolicy;
  fireOnce?: boolean;
  deliveryTargets?: DeliveryTarget[];
  metadata?: Record<string, string>;
}

export interface WatcherRuntimeState {
  id: string;
  lastError?: string;
  lastResponseAt?: string;
  consecutiveFailures: number;
  reconnectAttempts: number;
  lastPayloadHash?: string;
  lastPayload?: unknown;
  lastEvaluated?: string;
  lastConnectAt?: string;
  lastDisconnectAt?: string;
  lastDisconnectReason?: string;
  lastDelivery?: {
    attemptedAt: string;
    successCount: number;
    failureCount: number;
    failures?: Array<{ target: DeliveryTarget; error: string }>;
  };
}

export interface SentinelStateFile {
  watchers: WatcherDefinition[];
  runtime: Record<string, WatcherRuntimeState>;
  updatedAt: string;
}

export interface SentinelLimits {
  maxWatchersTotal: number;
  maxWatchersPerSkill: number;
  maxConditionsPerWatcher: number;
  maxIntervalMsFloor: number;
}

export interface SentinelConfig {
  allowedHosts: string[];
  localDispatchBase: string;
  dispatchAuthToken?: string;
  /** @deprecated Backward-compatible alias for hookSessionPrefix. */
  hookSessionKey?: string;
  hookSessionPrefix?: string;
  hookSessionGroup?: string;
  hookRelayDedupeWindowMs?: number;
  hookResponseTimeoutMs?: number;
  hookResponseFallbackMode?: HookResponseFallbackMode;
  hookResponseDedupeWindowMs?: number;
  stateFilePath?: string;
  notificationPayloadMode?: NotificationPayloadMode;
  limits: SentinelLimits;
}

export interface GatewayWebhookDispatcher {
  dispatch(path: string, body: Record<string, unknown>): Promise<void>;
}
