import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";
import { SENTINEL_CALLBACK_ENVELOPE_KEY } from "../src/types.js";

type MockRes = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function makeReq(method: string, body?: string) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
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

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
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
    logger: { info: vi.fn(), error: vi.fn() },
  } as any);

  await plugin.init();
  const route = registerHttpRoute.mock.calls[0][0];

  let dispatchBody: Record<string, unknown> | undefined;
  let dispatchHeaders: Record<string, string> | undefined;

  const oldFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string, options?: any) => {
    if (url === endpoint) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => args.endpointPayload,
      } as any;
    }

    if (url === `${localDispatchBase}/hooks/sentinel`) {
      dispatchBody = JSON.parse(String(options?.body ?? "{}"));
      dispatchHeaders = options?.headers ?? {};

      const req = makeReq("POST", String(options?.body ?? "{}"));
      const res = makeRes();
      await route.handler(req as any, res as any);

      return {
        ok: true,
        status: res.statusCode ?? 500,
        headers: { get: () => "application/json" },
        json: async () => JSON.parse(res.body ?? "{}"),
      } as any;
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
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
      },
      retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      fireOnce: true,
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
  it("creates callback envelope and relays enriched context into the LLM event payload", async () => {
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
    expect(dispatchBody[SENTINEL_CALLBACK_ENVELOPE_KEY]).toBeTruthy();

    const envelope = dispatchBody[SENTINEL_CALLBACK_ENVELOPE_KEY] as Record<string, any>;
    expect(envelope.type).toBe("sentinel.callback");
    expect(envelope.watcher.id).toBe("btc-price-50k");
    expect(envelope.watcher.eventName).toBe("price_alert");
    expect(envelope.context.currentPrice).toBe(51234.56);
    expect(envelope.context.threshold).toBe(50000);

    const relayedPrompt = String(enqueueSystemEvent.mock.calls[0][0] ?? "");
    expect(relayedPrompt).toContain("Sentinel Callback: price_alert");
    expect(relayedPrompt).toContain("SENTINEL_CALLBACK_CONTEXT_JSON:");
    expect(relayedPrompt).toContain('"currentPrice": 51234.56');
    expect(relayedPrompt).toContain("Watcher: btc-price-50k");

    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "hook:sentinel",
      sessionKey: "agent:main:main",
    });
  });

  it("suppresses control tokens and falls back to structured envelope summary", async () => {
    const endpointPayload = loadFixture("service-health-source.json");

    const { enqueueSystemEvent } = await runE2EPipeline({
      endpointPayload,
      eventName: "service_health",
      watcherId: "gateway-health",
      payloadTemplate: {
        watcherId: "${watcher.id}",
        eventName: "${event.name}",
        status: "${payload.status}",
        message: "NO_REPLY",
      },
    });

    const relayedPrompt = String(enqueueSystemEvent.mock.calls[0][0] ?? "");
    expect(relayedPrompt).not.toContain("NO_REPLY");
    expect(relayedPrompt).toContain("Sentinel Callback: service_health");
    expect(relayedPrompt).toContain("SENTINEL_CALLBACK_CONTEXT_JSON:");
  });

  it("strips control tokens while preserving human text when present", async () => {
    const endpointPayload = loadFixture("service-health-source.json");

    const { enqueueSystemEvent } = await runE2EPipeline({
      endpointPayload,
      eventName: "service_health",
      watcherId: "gateway-health-token-strip",
      payloadTemplate: {
        watcherId: "${watcher.id}",
        eventName: "${event.name}",
        message: "NO_REPLY investigate gateway health degradation",
      },
    });

    const relayedPrompt = String(enqueueSystemEvent.mock.calls[0][0] ?? "");
    expect(relayedPrompt).not.toContain("NO_REPLY");
    expect(relayedPrompt).toContain("investigate gateway health degradation");
    expect(relayedPrompt).not.toContain("SENTINEL_CALLBACK_CONTEXT_JSON");
  });
});
