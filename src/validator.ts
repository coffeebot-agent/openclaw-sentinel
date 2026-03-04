import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DEFAULT_SENTINEL_WEBHOOK_PATH, WatcherDefinition } from "./types.js";

const codeyKeyPattern = /(script|code|eval|handler|function|import|require)/i;
const codeyValuePattern = /(=>|\bfunction\b|\bimport\s+|\brequire\s*\(|\beval\s*\()/i;

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

const WatcherSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    skillId: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    strategy: Type.Union([
      Type.Literal("http-poll"),
      Type.Literal("websocket"),
      Type.Literal("sse"),
      Type.Literal("http-long-poll"),
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
        payloadTemplate: Type.Record(
          Type.String(),
          Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        ),
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
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

function scanNoCodeLike(input: unknown, parentKey = ""): void {
  if (input === null || input === undefined) return;
  if (typeof input === "string") {
    if (codeyValuePattern.test(input)) {
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

export function validateWatcherDefinition(input: unknown): WatcherDefinition {
  scanNoCodeLike(input);

  if (!Value.Check(WatcherSchema, input)) {
    const first = [...Value.Errors(WatcherSchema, input)][0];
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
  return {
    ...watcher,
    fire: {
      ...watcher.fire,
      webhookPath: watcher.fire.webhookPath ?? DEFAULT_SENTINEL_WEBHOOK_PATH,
    },
  };
}
