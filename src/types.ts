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

export interface FireConfig {
  webhookPath?: string;
  eventName: string;
  payloadTemplate: Record<string, string | number | boolean | null>;
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
  lastPayloadHash?: string;
  lastPayload?: unknown;
  lastEvaluated?: string;
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
  hookSessionKey?: string;
  stateFilePath?: string;
  limits: SentinelLimits;
}

export interface GatewayWebhookDispatcher {
  dispatch(path: string, body: Record<string, unknown>): Promise<void>;
}
