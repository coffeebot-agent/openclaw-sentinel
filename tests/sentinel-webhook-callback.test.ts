import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

type MockRes = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

type HookHandler = (event: any, ctx: any) => void | Promise<void>;

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

function extractJsonBlock(text: string, marker: string) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const afterMarker = text.slice(markerIndex + marker.length);
  const trimmed = afterMarker.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed);
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "sentinel.callback",
    version: "2",
    intent: "test_event",
    actionable: true,
    watcher: {
      id: "test-watcher",
      skillId: "skills.test",
      eventName: "test_event",
      intent: "test_event",
      strategy: "http-poll",
      endpoint: "https://example.com/api",
      match: "all",
      conditions: [],
      fireOnce: false,
      tags: [],
    },
    trigger: {
      matchedAt: new Date().toISOString(),
      dedupeKey: "test-dedupe-" + Math.random().toString(36).slice(2, 10),
      priority: "normal",
    },
    context: {},
    payload: {},
    deliveryTargets: [],
    source: { plugin: "openclaw-sentinel", route: "/hooks/sentinel" },
    ...overrides,
  };
}

function createApiMocks() {
  const hooks = new Map<string, HookHandler>();
  const registerHttpRoute = vi.fn();
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const sendMessageTelegram = vi.fn(async () => undefined);

  return {
    hooks,
    registerHttpRoute,
    enqueueSystemEvent,
    requestHeartbeatNow,
    sendMessageTelegram,
    api: {
      registerTool: vi.fn(),
      registerHttpRoute,
      on: vi.fn((name: string, handler: HookHandler) => {
        hooks.set(name, handler);
      }),
      runtime: {
        system: { enqueueSystemEvent, requestHeartbeatNow },
        channel: {
          telegram: { sendMessageTelegram },
          discord: { sendMessageDiscord: vi.fn(async () => undefined) },
          slack: { sendMessageSlack: vi.fn(async () => undefined) },
          signal: { sendMessageSignal: vi.fn(async () => undefined) },
          imessage: { sendMessageIMessage: vi.fn(async () => undefined) },
          whatsapp: { sendMessageWhatsApp: vi.fn(async () => undefined) },
          line: { sendMessageLine: vi.fn(async () => undefined) },
        },
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as any,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sentinel webhook callback route", () => {
  it("enqueues callbacks to an isolated per-watcher hook session by default", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "btc-price",
            skillId: "skills.alerts",
            eventName: "price_alert",
            intent: "price_alert",
            strategy: "http-poll",
            endpoint: "https://example.com/btc",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
          trigger: {
            matchedAt: "2026-03-04T14:12:00.000Z",
            dedupeKey: "abc-123",
            priority: "normal",
          },
          payload: { price: 5050 },
          source: { route: "/hooks/sentinel", plugin: "openclaw-sentinel" },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options).toEqual({
      sessionKey: "agent:main:hooks:sentinel:watcher:btc-price",
      contextKey: "cron:sentinel-callback",
    });
    expect(text).toContain("SENTINEL_TRIGGER:");
    expect(text).toContain("SENTINEL_CALLBACK_JSON:");

    const callbackJson = extractJsonBlock(String(text), "SENTINEL_CALLBACK_JSON:\n");
    expect(callbackJson).toMatchObject({
      watcher: {
        id: "btc-price",
        skillId: "skills.alerts",
        eventName: "price_alert",
      },
      trigger: {
        dedupeKey: "abc-123",
      },
      source: { route: "/hooks/sentinel", plugin: "openclaw-sentinel" },
      payload: { price: 5050 },
    });

    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "cron:sentinel-callback",
      sessionKey: "agent:main:hooks:sentinel:watcher:btc-price",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "hook:sentinel" }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("builds structured callback prompt context with watcher and trigger metadata", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "ops-watch",
            skillId: "skills.ops",
            eventName: "service_degraded",
            intent: "incident_triage",
            strategy: "http-poll",
            endpoint: "https://status.example.com/health",
            match: "all",
            conditions: [{ path: "status", op: "eq", value: "degraded" }],
            fireOnce: true,
            tags: [],
          },
          trigger: {
            matchedAt: "2026-03-04T15:00:00.000Z",
            dedupeKey: "trigger-ctx-1",
            priority: "critical",
          },
          context: { service: "payments", region: "us-east-1" },
          payload: { status: "degraded", latencyMs: 820 },
          deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
          deliveryContext: {
            sessionKey: "agent:main:telegram:direct:5613673222",
            currentChat: { channel: "telegram", to: "5613673222" },
          },
          source: { plugin: "openclaw-sentinel", route: "/hooks/sentinel" },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [text] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(String(text)).toContain("sentinel_act");
    expect(String(text)).toContain("sentinel_escalate");
    expect(String(text)).toContain("the only way your response reaches the user");
    expect(String(text)).toContain("Do not emit control tokens");

    const callbackJson = extractJsonBlock(String(text), "SENTINEL_CALLBACK_JSON:\n");

    expect(callbackJson).toMatchObject({
      watcher: {
        id: "ops-watch",
        skillId: "skills.ops",
        eventName: "service_degraded",
        intent: "incident_triage",
        strategy: "http-poll",
        endpoint: "https://status.example.com/health",
        match: "all",
        conditions: [{ path: "status", op: "eq", value: "degraded" }],
        fireOnce: true,
      },
      trigger: {
        matchedAt: "2026-03-04T15:00:00.000Z",
        dedupeKey: "trigger-ctx-1",
        priority: "critical",
      },
      source: { plugin: "openclaw-sentinel", route: "/hooks/sentinel" },
      deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      context: { service: "payments", region: "us-east-1" },
      payload: { status: "degraded", latencyMs: 820 },
    });

    expect(res.statusCode).toBe(200);
  });

  it("supports grouped hook sessions via explicit hookSessionGroup", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "eth-price",
            skillId: "skills.alerts",
            eventName: "price_alert",
            intent: "price_alert",
            strategy: "http-poll",
            endpoint: "https://example.com/eth",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
          hookSessionGroup: "portfolio-risk",
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options).toEqual({
      sessionKey: "agent:main:hooks:sentinel:group:portfolio-risk",
      contextKey: "cron:sentinel-callback",
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not allow a fully shared global hook session even when hookSessionKey is configured", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({ hookSessionKey: "agent:main:main" });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "w-global-test",
            skillId: "skills.test",
            eventName: "evt",
            intent: "evt",
            strategy: "http-poll",
            endpoint: "https://example.com",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options.sessionKey).toBe("agent:main:main:watcher:w-global-test");
    expect(options.sessionKey).not.toBe("agent:main:main");
    expect(res.statusCode).toBe(200);
  });

  it("prefers hookSessionPrefix over legacy hookSessionKey when both are set", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({
      hookSessionKey: "agent:main:legacy",
      hookSessionPrefix: "agent:main:new",
    });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "w-priority",
            skillId: "skills.test",
            eventName: "evt",
            intent: "evt",
            strategy: "http-poll",
            endpoint: "https://example.com",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options.sessionKey).toBe("agent:main:new:watcher:w-priority");
    expect(options.sessionKey).not.toContain("legacy");
    expect(res.statusCode).toBe(200);
  });

  it("fulfills relay contract via after_tool_call when sentinel_act succeeds", async () => {
    vi.useFakeTimers();
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({
      hookResponseTimeoutMs: 60_000,
      hookResponseFallbackMode: "concise",
    });
    plugin.register(mocks.api);

    const afterToolCall = mocks.hooks.get("after_tool_call");
    expect(typeof afterToolCall).toBe("function");

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "btc-price",
            skillId: "skills.alerts",
            eventName: "price_alert",
            intent: "price_alert",
            strategy: "http-poll",
            endpoint: "https://example.com/btc",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
          trigger: {
            matchedAt: "2026-03-04T14:12:00.000Z",
            dedupeKey: "relay-1",
            priority: "normal",
          },
          deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const body = JSON.parse(res.body ?? "{}");
    expect(body.relay).toMatchObject({
      attempted: 1,
      delivered: 0,
      failed: 0,
      deduped: false,
      pending: true,
    });

    await afterToolCall?.(
      { toolName: "sentinel_act", durationMs: 50 },
      { sessionKey: "agent:main:hooks:sentinel:watcher:btc-price" },
    );

    // Timeout should not fire after fulfill
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(0);
  });

  it("uses callback deliveryContext as fallback relay target via timeout path", async () => {
    vi.useFakeTimers();
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({
      hookResponseTimeoutMs: 1000,
      hookResponseFallbackMode: "concise",
    });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];

    await route.handler(
      makeReq(
        "POST",
        JSON.stringify(
          makeEnvelope({
            watcher: {
              id: "from-context",
              skillId: "skills.test",
              eventName: "test_event",
              intent: "test_event",
              strategy: "http-poll",
              endpoint: "https://example.com",
              match: "all",
              conditions: [],
              fireOnce: false,
              tags: [],
            },
            trigger: {
              matchedAt: new Date().toISOString(),
              dedupeKey: "context-1",
              priority: "normal",
            },
            deliveryTargets: [],
            deliveryContext: {
              sessionKey: "agent:main:telegram:direct:5613673222",
              currentChat: { channel: "telegram", to: "5613673222" },
            },
          }),
        ),
      ) as any,
      makeRes() as any,
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(1);
    const [to] = mocks.sendMessageTelegram.mock.calls[0];
    expect(to).toBe("5613673222");
  });

  it("emits concise timeout fallback relay when assistant response is missing", async () => {
    vi.useFakeTimers();
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({
      hookResponseTimeoutMs: 1000,
      hookResponseFallbackMode: "concise",
    });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    await route.handler(
      makeReq(
        "POST",
        JSON.stringify(
          makeEnvelope({
            watcher: {
              id: "btc-price",
              skillId: "skills.alerts",
              eventName: "price_alert",
              intent: "price_alert",
              strategy: "http-poll",
              endpoint: "https://example.com/btc",
              match: "all",
              conditions: [],
              fireOnce: false,
              tags: [],
            },
            trigger: {
              matchedAt: new Date().toISOString(),
              dedupeKey: "timeout-1",
              priority: "normal",
            },
            deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
          }),
        ),
      ) as any,
      makeRes() as any,
    );

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(1);
    const [, fallbackMessage] = mocks.sendMessageTelegram.mock.calls[0];
    expect(String(fallbackMessage)).toContain("Sentinel callback: price_alert");
  });

  it("suppresses duplicate response contracts using dedupe key", async () => {
    vi.useFakeTimers();
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({
      hookResponseDedupeWindowMs: 60_000,
      hookResponseTimeoutMs: 60_000,
      hookResponseFallbackMode: "concise",
    });
    plugin.register(mocks.api);

    const afterToolCall = mocks.hooks.get("after_tool_call");
    const route = mocks.registerHttpRoute.mock.calls[0][0];

    const payload = makeEnvelope({
      watcher: {
        id: "btc-price",
        skillId: "skills.alerts",
        eventName: "price_alert",
        intent: "price_alert",
        strategy: "http-poll",
        endpoint: "https://example.com/btc",
        match: "all",
        conditions: [],
        fireOnce: false,
        tags: [],
      },
      trigger: {
        matchedAt: new Date().toISOString(),
        dedupeKey: "dupe-1",
        priority: "normal",
      },
      deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
    });

    await route.handler(makeReq("POST", JSON.stringify(payload)) as any, makeRes() as any);
    const res2 = makeRes();
    await route.handler(makeReq("POST", JSON.stringify(payload)) as any, res2 as any);

    await afterToolCall?.(
      { toolName: "sentinel_act", durationMs: 50 },
      { sessionKey: "agent:main:hooks:sentinel:watcher:btc-price" },
    );

    // Timeout should not fire after fulfill
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(0);
    expect(JSON.parse(res2.body ?? "{}").relay).toMatchObject({
      attempted: 1,
      deduped: true,
      pending: false,
    });
  });

  it("clips oversized payload content with truncation marker", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "huge",
            skillId: "skills.test",
            eventName: "payload_big",
            intent: "payload_big",
            strategy: "http-poll",
            endpoint: "https://example.com",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
          payload: { blob: "x".repeat(6000) },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [text] = mocks.enqueueSystemEvent.mock.calls[0];
    const callbackJson = extractJsonBlock(String(text), "SENTINEL_CALLBACK_JSON:\n");
    expect(callbackJson.payload).toMatchObject({
      __truncated: true,
      maxChars: 2500,
    });
    expect(String(callbackJson.payload.preview)).toContain("…");
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 for invalid json payloads", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", "not json");
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("returns 415 for non-json content types", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", JSON.stringify({ eventName: "x" }), {
      "content-type": "text/plain",
    });
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(415);
    expect(String(res.body)).toContain("Unsupported Content-Type");
  });

  it("returns 500 when loop callback wiring fails", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register({
      ...mocks.api,
      runtime: {
        ...mocks.api.runtime,
        system: {
          enqueueSystemEvent: vi.fn(() => {
            throw new Error("enqueue failed");
          }),
          requestHeartbeatNow: vi.fn(),
        },
      },
    });

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify(
        makeEnvelope({
          watcher: {
            id: "fail-test",
            skillId: "skills.test",
            eventName: "x",
            intent: "x",
            strategy: "http-poll",
            endpoint: "https://example.com",
            match: "all",
            conditions: [],
            fireOnce: false,
            tags: [],
          },
        }),
      ),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("enqueue failed");
  });

  it("rejects payloads without sentinel.callback type", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", JSON.stringify({ watcherId: "bad", eventName: "no_type" }));
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("Invalid sentinel callback");
  });
});
