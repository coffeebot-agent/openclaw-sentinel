import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TemplateValueSchema } from "./templateValueSchema.js";
import {
  DEFAULT_OPERATOR_GOAL_MAX_CHARS,
  DEFAULT_SENTINEL_WEBHOOK_PATH,
  MAX_OPERATOR_GOAL_MAX_CHARS,
  MIN_OPERATOR_GOAL_MAX_CHARS,
  WatcherDefinition,
} from "./types.js";

const TemplateValueRefSchema = Type.Ref(TemplateValueSchema);

const codeyKeyPattern = /(script|code|eval|handler|function|import|require)/i;
const codeyValuePattern = /(=>|\bfunction\b|\bimport\s+|\brequire\s*\(|\beval\s*\()/i;

const WATCHER_ID_PATTERN = "^[A-Za-z0-9_-]{1,128}$";

const ConditionSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    op: Type.Union([
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
    ]),
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const EvmCallSchema = Type.Object(
  {
    to: Type.String({ pattern: "^0x[0-9a-fA-F]{40}$" }),
    signature: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Array(Type.Unknown())),
    blockTag: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

function createWatcherSchema(maxOperatorGoalChars: number) {
  return Type.Object(
    {
      id: Type.String({ pattern: WATCHER_ID_PATTERN, maxLength: 128 }),
      skillId: Type.String({ minLength: 1 }),
      enabled: Type.Boolean(),
      strategy: Type.Union([
        Type.Literal("http-poll"),
        Type.Literal("websocket"),
        Type.Literal("sse"),
        Type.Literal("http-long-poll"),
        Type.Literal("evm-call"),
      ]),
      endpoint: Type.String({ minLength: 1 }),
      method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      intervalMs: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      match: Type.Union([Type.Literal("all"), Type.Literal("any")]),
      conditions: Type.Array(ConditionSchema, { minItems: 1 }),
      fire: Type.Object(
        {
          webhookPath: Type.Optional(Type.String({ pattern: "^/" })),
          eventName: Type.String({ minLength: 1 }),
          payloadTemplate: Type.Record(Type.String(), TemplateValueRefSchema),
          intent: Type.Optional(Type.String({ minLength: 1 })),
          contextTemplate: Type.Optional(Type.Record(Type.String(), TemplateValueRefSchema)),
          priority: Type.Optional(
            Type.Union([
              Type.Literal("low"),
              Type.Literal("normal"),
              Type.Literal("high"),
              Type.Literal("critical"),
            ]),
          ),
          deadlineTemplate: Type.Optional(Type.String({ minLength: 1 })),
          dedupeKeyTemplate: Type.Optional(Type.String({ minLength: 1 })),
          notificationPayloadMode: Type.Optional(
            Type.Union([
              Type.Literal("inherit"),
              Type.Literal("none"),
              Type.Literal("concise"),
              Type.Literal("debug"),
            ]),
          ),
          sessionGroup: Type.Optional(Type.String({ minLength: 1 })),
          operatorGoal: Type.Optional(
            Type.String({ minLength: 1, maxLength: maxOperatorGoalChars }),
          ),
          operatorGoalFile: Type.Optional(Type.String({ minLength: 1, pattern: "^(/|~)" })),
          model: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      retry: Type.Object(
        {
          maxRetries: Type.Integer({ minimum: 0, maximum: 20 }),
          baseMs: Type.Integer({ minimum: 50, maximum: 60000 }),
          maxMs: Type.Integer({ minimum: 100, maximum: 300000 }),
        },
        { additionalProperties: false },
      ),
      fireOnce: Type.Optional(Type.Boolean()),
      deliveryTargets: Type.Optional(
        Type.Array(
          Type.Object(
            {
              channel: Type.String({ minLength: 1 }),
              to: Type.String({ minLength: 1 }),
              accountId: Type.Optional(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      ),
      evmCall: Type.Optional(EvmCallSchema),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
    },
    {
      additionalProperties: false,
      $defs: {
        templateValue: TemplateValueSchema,
      },
    },
  );
}

const watcherSchemaByOperatorGoalLimit = new Map<number, ReturnType<typeof createWatcherSchema>>();

function resolveOperatorGoalMaxChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_OPERATOR_GOAL_MAX_CHARS;
  }

  const integer = Math.trunc(raw);
  return Math.max(MIN_OPERATOR_GOAL_MAX_CHARS, Math.min(MAX_OPERATOR_GOAL_MAX_CHARS, integer));
}

function getWatcherSchema(maxOperatorGoalChars: number) {
  const cached = watcherSchemaByOperatorGoalLimit.get(maxOperatorGoalChars);
  if (cached) return cached;

  const schema = createWatcherSchema(maxOperatorGoalChars);
  watcherSchemaByOperatorGoalLimit.set(maxOperatorGoalChars, schema);
  return schema;
}

export const WatcherSchema = getWatcherSchema(DEFAULT_OPERATOR_GOAL_MAX_CHARS);

const CODE_SCAN_EXEMPT_PATHS = new Set(["evmCall.signature"]);

function scanNoCodeLike(input: unknown, parentKey = ""): void {
  if (input === null || input === undefined) return;
  if (typeof input === "string") {
    if (!CODE_SCAN_EXEMPT_PATHS.has(parentKey) && codeyValuePattern.test(input)) {
      throw new Error(`Code-like value rejected at ${parentKey || "<root>"}`);
    }
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((v, i) => scanNoCodeLike(v, `${parentKey}[${i}]`));
    return;
  }
  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (codeyKeyPattern.test(key)) {
        throw new Error(`Code-like field rejected: ${parentKey ? `${parentKey}.` : ""}${key}`);
      }
      scanNoCodeLike(value, parentKey ? `${parentKey}.${key}` : key);
    }
  }
}

export function validateWatcherDefinition(
  input: unknown,
  options?: { maxOperatorGoalChars?: number },
): WatcherDefinition {
  scanNoCodeLike(input);

  const maxOperatorGoalChars = resolveOperatorGoalMaxChars(options?.maxOperatorGoalChars);
  const schema = getWatcherSchema(maxOperatorGoalChars);

  if (!Value.Check(schema, [TemplateValueSchema], input)) {
    const first = [...Value.Errors(schema, [TemplateValueSchema], input)][0];
    const where = first?.path || "(root)";
    const why = first?.message || "Invalid watcher definition";
    throw new Error(`Invalid watcher definition at ${where}: ${why}`);
  }

  const endpoint = (input as Record<string, unknown>).endpoint;
  try {
    if (typeof endpoint !== "string") throw new Error("endpoint must be a string");
    new URL(endpoint);
  } catch {
    throw new Error("Invalid watcher definition at /endpoint: Invalid URL");
  }

  const watcher = input as WatcherDefinition;

  if (watcher.strategy === "evm-call") {
    if (!watcher.evmCall) {
      throw new Error("Invalid watcher definition: evm-call strategy requires evmCall config");
    }
    if (watcher.method || watcher.body) {
      throw new Error(
        "Invalid watcher definition: evm-call strategy does not support method/body (use evmCall config)",
      );
    }
  } else if (watcher.evmCall) {
    throw new Error(
      `Invalid watcher definition: evmCall config is only valid with evm-call strategy, not ${watcher.strategy}`,
    );
  }

  return {
    ...watcher,
    fire: {
      ...watcher.fire,
      webhookPath: watcher.fire.webhookPath ?? DEFAULT_SENTINEL_WEBHOOK_PATH,
    },
  };
}
