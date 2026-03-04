import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { SentinelToolSchema } from "../src/toolSchema.js";
import { ParamsSchema } from "../src/tool.js";

const validCreate = {
  action: "create",
  watcher: {
    id: "w1",
    skillId: "skills.test",
    enabled: true,
    strategy: "http-poll",
    endpoint: "https://api.github.com/events",
    intervalMs: 1000,
    match: "all",
    conditions: [{ path: "type", op: "eq", value: "PushEvent" }],
    fire: {
      webhookPath: "/hooks/agent",
      eventName: "evt",
      payloadTemplate: { event: "${event.name}" },
    },
    retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
  },
};

describe("tool schema/runtime alignment", () => {
  it("accepts valid create payload in both TypeBox and zod", () => {
    expect(Value.Check(SentinelToolSchema, validCreate)).toBe(true);
    expect(ParamsSchema.safeParse(validCreate).success).toBe(true);
  });

  it("rejects invalid action in both TypeBox and zod", () => {
    const bad = { action: "noop" };
    expect(Value.Check(SentinelToolSchema, bad)).toBe(false);
    expect(ParamsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown top-level fields in both TypeBox and zod", () => {
    const bad = { ...validCreate, unexpected: true } as any;
    expect(Value.Check(SentinelToolSchema, bad)).toBe(false);
    expect(ParamsSchema.safeParse(bad).success).toBe(false);
  });
});
