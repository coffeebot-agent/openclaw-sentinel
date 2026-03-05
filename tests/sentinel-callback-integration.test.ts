import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";
import {
  SENTINEL_ORIGIN_ACCOUNT_METADATA,
  SENTINEL_ORIGIN_CHANNEL_METADATA,
  SENTINEL_ORIGIN_SESSION_KEY_METADATA,
  SENTINEL_ORIGIN_TARGET_METADATA,
} from "../src/types.js";

type MockRes = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function makeReq(method: string, body?: string, headers?: Record<string, string>) {
  const req = new PassThrough() as PassThrough & {
    method: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.headers = headers ?? {};
  if (body !== undefined) req.end(body);
  else req.end();
  return req;
}

function makeRes(): MockRes {
  return {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function loadFixture(name: string): Record<string, unknown> {
  const fixturePath = new URL(`./fixtures/sentinel/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

async function waitFor(condition: () => boolean, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function runE2EPipeline(args: {
  endpointPayload: Record<string, unknown>;
  payloadTemplate: Record<string, string | number | boolean | null>;
  eventName: string;
  watcherId: string;
  intent?: string;
  priority?: "low" | "normal" | "high" | "critical";
  deliveryTargets?: Array<{ channel: string; to: string; accountId?: string }>;
  metadata?: Record<string, string>;
}): Promise<{
  dispatchBody: Record<string, unknown>;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  requestHeartbeatNow: ReturnType<typeof vi.fn>;
  dispatchHeaders: Record<string, string>;
}> {
  const registerHttpRoute = vi.fn();
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const localDispatchBase = "http://127.0.0.1:18789";
  const endpoint = "https://api.github.com/events";

  const plugin = createSentinelPlugin({
    allowedHosts: ["api.github.com"],
    localDispatchBase,
    dispatchAuthToken: "sentinel-test-token",
    hookSessionKey: "agent:main:main",
    stateFilePath: path.join(
      os.tmpdir(),
      `sentinel-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    ),
    limits: {
      maxWatchersTotal: 10,
      maxWatchersPerSkill: 10,
      maxConditionsPerWatcher: 10,
      maxIntervalMsFloor: 1,
    },
  });

  plugin.register({
    registerTool: vi.fn(),
    registerHttpRoute,
    runtime: { system: { enqueueSystemEvent, requestHeartbeatNow } },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as any);

  await plugin.init();
  const route = registerHttpRoute.mock.calls[0][0];

  let dispatchBody: Record<string, unknown> | undefined;
  let dispatchHeaders: Record<string, string> | undefined;

  const oldFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: unknown, options?: any) => {
    const href = String(url);

    if (href.startsWith(endpoint)) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => args.endpointPayload,
      } as any;
    }

    if (href === `${localDispatchBase}/hooks/sentinel`) {
      dispatchBody = JSON.parse(String(options?.body ?? "{}"));
      dispatchHeaders = options?.headers ?? {};

      const req = makeReq("POST", String(options?.body ?? "{}"), {
        "content-type": "application/json",
      });
      const res = makeRes();
      await route.handler(req as any, res as any);

      return {
        ok: true,
        status: res.statusCode ?? 500,
        headers: { get: () => "application/json" },
        json: async () => JSON.parse(res.body ?? "{}"),
      } as any;
    }

    throw new Error(`Unexpected fetch URL in test: ${href}`);
  }) as any;

  try {
    await plugin.manager.create({
      id: args.watcherId,
      skillId: "skills.sentinel.e2e",
      enabled: true,
      strategy: "http-poll",
      endpoint,
      intervalMs: 5,
      match: "all",
      conditions: [{ path: "__always__", op: "eq", value: undefined }],
      fire: {
        webhookPath: "/hooks/sentinel",
        eventName: args.eventName,
        payloadTemplate: args.payloadTemplate,
        ...(args.intent ? { intent: args.intent } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
      },
      retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      fireOnce: true,
      ...(args.deliveryTargets ? { deliveryTargets: args.deliveryTargets } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });

    await waitFor(() => enqueueSystemEvent.mock.calls.length > 0);
  } finally {
    globalThis.fetch = oldFetch;
    await plugin.manager.disable(args.watcherId).catch(() => undefined);
  }

  if (!dispatchBody || !dispatchHeaders) {
    throw new Error("Expected dispatch call to /hooks/sentinel");
  }

  return {
    dispatchBody,
    enqueueSystemEvent,
    requestHeartbeatNow,
    dispatchHeaders,
  };
}

describe("sentinel callback e2e", () => {
  it("dispatches callback envelope and relays structured context into the LLM event payload", async () => {
    const endpointPayload = loadFixture("price-alert-source.json");

    const { dispatchBody, enqueueSystemEvent, requestHeartbeatNow, dispatchHeaders } =
      await runE2EPipeline({
        endpointPayload,
        eventName: "price_alert",
        watcherId: "btc-price-50k",
        payloadTemplate: {
          watcherId: "${watcher.id}",
          eventName: "${event.name}",
          firedAt: "${timestamp}",
          currentPrice: "${payload.price}",
          threshold: "${payload.threshold}",
          direction: "${payload.direction}",
        },
      });

    expect(dispatchHeaders.authorization).toBe("Bearer sentinel-test-token");
    expect(dispatchBody).toMatchObject({
      type: "sentinel.callback",
      intent: "price_alert",
      watcher: {
        id: "btc-price-50k",
        eventName: "price_alert",
      },
      trigger: {
        priority: "normal",
      },
      context: {
        currentPrice: 51234.56,
        threshold: 50000,
      },
      source: {
        route: "/hooks/sentinel",
        plugin: "openclaw-sentinel",
      },
    });

    const relayedPrompt = String(enqueueSystemEvent.mock.calls[0][0] ?? "");
    expect(relayedPrompt).toContain("SENTINEL_TRIGGER:");
    expect(relayedPrompt).toContain("SENTINEL_CALLBACK_JSON:");
    expect(relayedPrompt).toContain('"id": "btc-price-50k"');
    expect(relayedPrompt).toContain('"currentPrice": 51234.56');

    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "cron:sentinel-callback",
      sessionKey: "agent:main:main:watcher:btc-price-50k",
    });
  });

  it("propagates origin metadata into delivery context and carries deliveryTargets", async () => {
    const endpointPayload = loadFixture("service-health-source.json");

    const { dispatchBody } = await runE2EPipeline({
      endpointPayload,
      eventName: "service_health",
      watcherId: "gateway-health",
      payloadTemplate: {
        watcherId: "${watcher.id}",
        eventName: "${event.name}",
        status: "${payload.status}",
      },
      deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      metadata: {
        [SENTINEL_ORIGIN_SESSION_KEY_METADATA]: "agent:main:telegram:direct:5613673222",
        [SENTINEL_ORIGIN_CHANNEL_METADATA]: "telegram",
        [SENTINEL_ORIGIN_TARGET_METADATA]: "5613673222",
        [SENTINEL_ORIGIN_ACCOUNT_METADATA]: "acct-1",
      },
    });

    expect(dispatchBody.deliveryTargets).toEqual([{ channel: "telegram", to: "5613673222" }]);
    expect(dispatchBody.deliveryContext).toMatchObject({
      sessionKey: "agent:main:telegram:direct:5613673222",
      messageChannel: "telegram",
      requesterSenderId: "5613673222",
      agentAccountId: "acct-1",
      currentChat: {
        channel: "telegram",
        to: "5613673222",
        accountId: "acct-1",
      },
    });
  });

  it("honors explicit intent and priority when building callback envelope", async () => {
    const endpointPayload = loadFixture("service-health-source.json");

    const { dispatchBody, enqueueSystemEvent } = await runE2EPipeline({
      endpointPayload,
      eventName: "service_health",
      watcherId: "gateway-health-priority",
      intent: "incident_triage",
      priority: "critical",
      payloadTemplate: {
        watcherId: "${watcher.id}",
        eventName: "${event.name}",
        status: "${payload.status}",
      },
    });

    expect(dispatchBody.intent).toBe("incident_triage");
    expect(dispatchBody.watcher).toMatchObject({
      id: "gateway-health-priority",
      eventName: "service_health",
      intent: "incident_triage",
    });
    expect(dispatchBody.trigger).toMatchObject({ priority: "critical" });

    const relayedPrompt = String(enqueueSystemEvent.mock.calls[0][0] ?? "");
    expect(relayedPrompt).toContain("Do not emit control tokens");
    expect(relayedPrompt).toContain("incident_triage");
  });
});
