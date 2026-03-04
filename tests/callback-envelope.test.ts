import { describe, expect, it } from "vitest";
import { createCallbackEnvelope } from "../src/callbackEnvelope.js";
import {
  SENTINEL_ORIGIN_CHANNEL_METADATA,
  SENTINEL_ORIGIN_SESSION_KEY_METADATA,
  SENTINEL_ORIGIN_TARGET_METADATA,
} from "../src/types.js";

const baseWatcher = {
  id: "w1",
  skillId: "skills.alerts",
  enabled: true,
  strategy: "http-poll",
  endpoint: "https://example.com/api",
  match: "all",
  conditions: [{ path: "status", op: "eq", value: "degraded" }],
  fire: {
    webhookPath: "/hooks/sentinel",
    eventName: "service_degraded",
    payloadTemplate: { service: "${payload.service}", status: "${payload.status}" },
  },
  retry: { maxRetries: 1, baseMs: 100, maxMs: 2000 },
} as const;

describe("callback envelope", () => {
  it("uses explicit intent/context/priority templates", () => {
    const watcher = {
      ...baseWatcher,
      fire: {
        ...baseWatcher.fire,
        intent: "incident_triage",
        contextTemplate: {
          service: "${payload.service}",
          severity: "${payload.severity}",
        },
        priority: "high",
        deadlineTemplate: "${payload.deadline}",
        dedupeKeyTemplate: "${watcher.id}-${payload.service}-${payload.status}",
      },
    } as any;

    const envelope = createCallbackEnvelope({
      watcher,
      payload: {
        service: "payments-api",
        status: "degraded",
        severity: "sev2",
        deadline: "2026-03-04T16:00:00Z",
      },
      payloadBody: { service: "payments-api", status: "degraded" },
      matchedAt: "2026-03-04T15:00:00.000Z",
      webhookPath: "/hooks/sentinel",
    });

    expect(envelope.intent).toBe("incident_triage");
    expect(envelope.context).toEqual({ service: "payments-api", severity: "sev2" });
    expect((envelope.trigger as any).priority).toBe("high");
    expect((envelope.trigger as any).deadline).toBe("2026-03-04T16:00:00Z");
    expect((envelope.trigger as any).dedupeKey).toHaveLength(64);
  });

  it("falls back to derived intent and payloadTemplate context", () => {
    const envelope = createCallbackEnvelope({
      watcher: baseWatcher as any,
      payload: { service: "auth", status: "degraded" },
      payloadBody: { service: "auth", status: "degraded" },
      matchedAt: "2026-03-04T15:00:00.000Z",
      webhookPath: "/hooks/sentinel",
    });

    expect(envelope.intent).toBe("service_degraded");
    expect(envelope.context).toEqual({ service: "auth", status: "degraded" });
    expect((envelope.trigger as any).priority).toBe("normal");
  });

  it("propagates watcher fire.sessionGroup to callback envelope", () => {
    const watcher = {
      ...baseWatcher,
      fire: {
        ...baseWatcher.fire,
        sessionGroup: "risk-desk",
      },
    } as any;

    const envelope = createCallbackEnvelope({
      watcher,
      payload: { service: "auth", status: "degraded" },
      payloadBody: { service: "auth", status: "degraded" },
      matchedAt: "2026-03-04T15:00:00.000Z",
      webhookPath: "/hooks/sentinel",
    });

    expect((envelope as any).hookSessionGroup).toBe("risk-desk");
  });

  it("includes original delivery context when watcher metadata carries chat/session origin", () => {
    const watcher = {
      ...baseWatcher,
      metadata: {
        [SENTINEL_ORIGIN_SESSION_KEY_METADATA]: "agent:main:telegram:direct:5613673222",
        [SENTINEL_ORIGIN_CHANNEL_METADATA]: "telegram",
        [SENTINEL_ORIGIN_TARGET_METADATA]: "5613673222",
      },
    } as any;

    const envelope = createCallbackEnvelope({
      watcher,
      payload: { service: "auth", status: "degraded" },
      payloadBody: { service: "auth", status: "degraded" },
      matchedAt: "2026-03-04T15:00:00.000Z",
      webhookPath: "/hooks/sentinel",
    });

    expect((envelope as any).deliveryContext).toMatchObject({
      sessionKey: "agent:main:telegram:direct:5613673222",
      messageChannel: "telegram",
      requesterSenderId: "5613673222",
      currentChat: { channel: "telegram", to: "5613673222" },
    });
  });

  it("bounds oversized payload bodies", () => {
    const envelope = createCallbackEnvelope({
      watcher: baseWatcher as any,
      payload: { blob: "x".repeat(5000) },
      payloadBody: { service: "x", status: "y" },
      matchedAt: "2026-03-04T15:00:00.000Z",
      webhookPath: "/hooks/sentinel",
    });

    expect((envelope.payload as any).truncated).toBe(true);
    expect(String((envelope.payload as any).preview).length).toBeLessThanOrEqual(4000);
  });
});
