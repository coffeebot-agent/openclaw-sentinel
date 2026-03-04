import { describe, expect, it } from "vitest";
import { sentinelConfigSchema } from "../src/configSchema.js";

describe("sentinel config schema", () => {
  it("applies defaults when minimal config is provided", () => {
    const parsed = sentinelConfigSchema.safeParse?.({});
    expect(parsed?.success).toBe(true);
    expect(parsed?.data).toMatchObject({
      allowedHosts: [],
      localDispatchBase: "http://127.0.0.1:18789",
      hookSessionPrefix: "agent:main:hooks:sentinel",
      hookRelayDedupeWindowMs: 120000,
      hookResponseTimeoutMs: 30000,
      hookResponseFallbackMode: "concise",
      hookResponseDedupeWindowMs: 120000,
      notificationPayloadMode: "concise",
      limits: {
        maxWatchersTotal: 200,
        maxWatchersPerSkill: 20,
        maxConditionsPerWatcher: 25,
        maxIntervalMsFloor: 1000,
      },
    });
  });

  it("accepts explicit default group for grouped hook-session routing", () => {
    const parsed = sentinelConfigSchema.safeParse?.({
      hookSessionGroup: "ops",
    });
    expect(parsed?.success).toBe(true);
    expect(parsed && parsed.success ? parsed.data.hookSessionGroup : undefined).toBe("ops");
  });

  it("accepts debug notification payload mode", () => {
    const parsed = sentinelConfigSchema.safeParse?.({ notificationPayloadMode: "debug" });
    expect(parsed?.success).toBe(true);
    if (parsed?.success) {
      expect(parsed.data?.notificationPayloadMode).toBe("debug");
    }
  });

  it("supports hook-response timeout and fallback knobs", () => {
    const parsed = sentinelConfigSchema.safeParse?.({
      hookResponseTimeoutMs: 45000,
      hookResponseFallbackMode: "none",
      hookResponseDedupeWindowMs: 60000,
    });
    expect(parsed?.success).toBe(true);
    if (parsed?.success) {
      expect(parsed.data?.hookResponseTimeoutMs).toBe(45000);
      expect(parsed.data?.hookResponseFallbackMode).toBe("none");
      expect(parsed.data?.hookResponseDedupeWindowMs).toBe(60000);
    }
  });

  it("accepts none notification payload mode", () => {
    const parsed = sentinelConfigSchema.safeParse?.({ notificationPayloadMode: "none" });
    expect(parsed?.success).toBe(true);
    if (parsed?.success) {
      expect(parsed.data?.notificationPayloadMode).toBe("none");
    }
  });

  it("rejects invalid localDispatchBase URL", () => {
    const parsed = sentinelConfigSchema.safeParse?.({ localDispatchBase: "not-a-url" });
    expect(parsed?.success).toBe(false);
    const issue = parsed && !parsed.success ? parsed.error?.issues?.[0] : undefined;
    expect(issue?.path).toEqual(["localDispatchBase"]);
  });
});
