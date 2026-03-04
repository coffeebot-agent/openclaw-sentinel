import { Type } from "@sinclair/typebox";

const ConditionSchema = Type.Object({
  path: Type.String({ description: "JSONPath expression to evaluate against the response" }),
  op: Type.Union(
    [
      Type.Literal("eq"),
      Type.Literal("neq"),
      Type.Literal("gt"),
      Type.Literal("gte"),
      Type.Literal("lt"),
      Type.Literal("lte"),
      Type.Literal("exists"),
      Type.Literal("absent"),
      Type.Literal("contains"),
      Type.Literal("matches"),
      Type.Literal("changed"),
    ],
    { description: "Comparison operator" },
  ),
  value: Type.Optional(
    Type.Unknown({
      description: "Value to compare against (not needed for exists/absent/changed)",
    }),
  ),
});

const FireConfigSchema = Type.Object({
  webhookPath: Type.String({
    description: "Path appended to localDispatchBase for webhook delivery",
  }),
  eventName: Type.String({ description: "Event name included in the dispatched payload" }),
  payloadTemplate: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    {
      description:
        "Key-value template for the webhook payload. Supports ${...} interpolation from matched response data.",
    },
  ),
});

const RetryPolicySchema = Type.Object({
  maxRetries: Type.Number({ description: "Maximum number of retry attempts" }),
  baseMs: Type.Number({ description: "Base delay in milliseconds for exponential backoff" }),
  maxMs: Type.Number({ description: "Maximum delay cap in milliseconds" }),
});

const DeliveryTargetSchema = Type.Object(
  {
    channel: Type.String({ description: "Channel/provider id (e.g. telegram, discord)" }),
    to: Type.String({ description: "Destination id within the channel" }),
    accountId: Type.Optional(
      Type.String({ description: "Optional account id for multi-account channels" }),
    ),
  },
  { additionalProperties: false },
);

const WatcherSchema = Type.Object(
  {
    id: Type.String({ description: "Unique watcher identifier" }),
    skillId: Type.String({ description: "ID of the skill that owns this watcher" }),
    enabled: Type.Boolean({ description: "Whether the watcher is actively polling" }),
    strategy: Type.Union(
      [
        Type.Literal("http-poll"),
        Type.Literal("websocket"),
        Type.Literal("sse"),
        Type.Literal("http-long-poll"),
      ],
      { description: "Connection strategy" },
    ),
    endpoint: Type.String({ description: "URL to monitor" }),
    method: Type.Optional(
      Type.Union([Type.Literal("GET"), Type.Literal("POST")], {
        description: "HTTP method (default GET)",
      }),
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "HTTP headers to include in requests",
      }),
    ),
    body: Type.Optional(Type.String({ description: "Request body for POST requests" })),
    intervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds" })),
    match: Type.Union([Type.Literal("all"), Type.Literal("any")], {
      description: "Whether all or any conditions must match to trigger",
    }),
    conditions: Type.Array(ConditionSchema, {
      description: "Conditions evaluated against each response",
    }),
    fire: FireConfigSchema,
    retry: RetryPolicySchema,
    fireOnce: Type.Optional(
      Type.Boolean({ description: "If true, the watcher disables itself after firing once" }),
    ),
    deliveryTargets: Type.Optional(
      Type.Array(DeliveryTargetSchema, {
        description:
          "Optional notification delivery targets. Defaults to the current chat/session context when omitted.",
      }),
    ),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.String(), { description: "Arbitrary key-value metadata" }),
    ),
  },
  { description: "Full watcher definition" },
);

export const SentinelToolSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("enable"),
        Type.Literal("disable"),
        Type.Literal("remove"),
        Type.Literal("status"),
        Type.Literal("list"),
      ],
      { description: "The action to perform" },
    ),
    id: Type.Optional(
      Type.String({ description: "Watcher ID (required for enable/disable/remove/status)" }),
    ),
    watcher: Type.Optional(WatcherSchema),
  },
  { additionalProperties: false },
);
