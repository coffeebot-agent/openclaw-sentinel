import { describe, expect, it } from "vitest";
import { validateWatcherDefinition } from "../src/validator.js";
import { DEFAULT_SENTINEL_WEBHOOK_PATH } from "../src/types.js";

const base = {
  id: "w1",
  skillId: "skill.a",
  enabled: true,
  strategy: "http-poll",
  endpoint: "https://api.github.com/events",
  match: "all",
  conditions: [{ path: "a", op: "exists" }],
  fire: {
    webhookPath: "/internal/sentinel",
    eventName: "x",
    payloadTemplate: { a: "${payload.a}" },
  },
  retry: { maxRetries: 3, baseMs: 100, maxMs: 2000 },
};

describe("validator", () => {
  it("accepts valid watcher", () => {
    expect(validateWatcherDefinition(base).id).toBe("w1");
  });
  it("applies default webhook path when omitted", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        webhookPath: undefined,
      },
    });
    expect(watcher.fire.webhookPath).toBe(DEFAULT_SENTINEL_WEBHOOK_PATH);
  });
  it("preserves explicit webhook path override", () => {
    const watcher = validateWatcherDefinition(base);
    expect(watcher.fire.webhookPath).toBe("/internal/sentinel");
  });
  it("accepts generic callback fields", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        intent: "incident_triage",
        contextTemplate: {
          summary: "${payload.a}",
          details: { previous: "${watcher.id}", next: ["${event.name}"] },
        },
        priority: "high",
        deadlineTemplate: "${timestamp}",
        notificationPayloadMode: "debug",
      },
    });
    expect(watcher.fire.intent).toBe("incident_triage");
    expect(watcher.fire.priority).toBe("high");
    expect(watcher.fire.notificationPayloadMode).toBe("debug");
  });

  it("accepts none notification payload mode override", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        notificationPayloadMode: "none",
      },
    });
    expect(watcher.fire.notificationPayloadMode).toBe("none");
  });

  it("rejects watcher ids with invalid characters", () => {
    expect(() => validateWatcherDefinition({ ...base, id: "../../etc/passwd" })).toThrow(
      /Invalid watcher definition/,
    );
  });

  it("rejects watcher ids that exceed 128 characters", () => {
    expect(() => validateWatcherDefinition({ ...base, id: "a".repeat(129) })).toThrow(
      /Invalid watcher definition/,
    );
  });

  it("rejects unknown fields", () => {
    expect(() => validateWatcherDefinition({ ...base, rogue: true })).toThrow();
  });
  it("rejects code-like fields", () => {
    expect(() =>
      validateWatcherDefinition({ ...base, metadata: { handler: "function(){return 1;}" } }),
    ).toThrow();
  });
});
