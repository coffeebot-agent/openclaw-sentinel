import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

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

function createApiMocks() {
  const registerHttpRoute = vi.fn();
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const sendMessageTelegram = vi.fn(async () => undefined);

  return {
    registerHttpRoute,
    enqueueSystemEvent,
    requestHeartbeatNow,
    sendMessageTelegram,
    api: {
      registerTool: vi.fn(),
      registerHttpRoute,
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
      logger: { info: vi.fn(), error: vi.fn() },
    } as any,
  };
}

describe("sentinel webhook callback route", () => {
  it("enqueues callbacks to an isolated per-watcher hook session by default", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        payload: { price: 5050 },
        watcherId: "btc-price",
        eventName: "price_alert",
        skillId: "skills.alerts",
        matchedAt: "2026-03-04T14:12:00.000Z",
        dedupeKey: "abc-123",
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options).toEqual({ sessionKey: "agent:main:hooks:sentinel:watcher:btc-price" });
    expect(text).toContain("SENTINEL_TRIGGER:");
    expect(text).toContain("SENTINEL_ENVELOPE_JSON:");

    const envelopeJson = String(text).split("SENTINEL_ENVELOPE_JSON:\n")[1];
    const envelope = JSON.parse(envelopeJson);
    expect(envelope).toMatchObject({
      watcherId: "btc-price",
      eventName: "price_alert",
      skillId: "skills.alerts",
      matchedAt: "2026-03-04T14:12:00.000Z",
      dedupeKey: "abc-123",
      correlationId: "abc-123",
      source: { route: "/hooks/sentinel", plugin: "openclaw-sentinel" },
      payload: { price: 5050 },
    });

    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "hook:sentinel",
      sessionKey: "agent:main:hooks:sentinel:watcher:btc-price",
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
      JSON.stringify({
        watcherId: "eth-price",
        eventName: "price_alert",
        hookSessionGroup: "portfolio-risk",
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options).toEqual({ sessionKey: "agent:main:hooks:sentinel:group:portfolio-risk" });
    expect(res.statusCode).toBe(200);
  });

  it("does not allow a fully shared global hook session even when hookSessionKey is configured", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({ hookSessionKey: "agent:main:main" });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", JSON.stringify({ watcherId: "w-global-test", eventName: "evt" }));
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, options] = mocks.enqueueSystemEvent.mock.calls[0];
    expect(options.sessionKey).toBe("agent:main:main:watcher:w-global-test");
    expect(options.sessionKey).not.toBe("agent:main:main");
    expect(res.statusCode).toBe(200);
  });

  it("relays a concise message to delivery targets", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        watcherId: "btc-price",
        eventName: "price_alert",
        matchedAt: "2026-03-04T14:12:00.000Z",
        dedupeKey: "relay-1",
        deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(1);
    const [, message] = mocks.sendMessageTelegram.mock.calls[0];
    expect(typeof message).toBe("string");
    expect(String(message).trim().length).toBeGreaterThan(0);
    expect(String(message)).toContain("Sentinel alert: price_alert");
    expect(String(message).trim().startsWith("{")).toBe(false);

    const body = JSON.parse(res.body ?? "{}");
    expect(body.relay).toMatchObject({ attempted: 1, delivered: 1, failed: 0, deduped: false });
  });

  it("never emits malformed or empty relay text content", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [, message] = mocks.sendMessageTelegram.mock.calls[0];
    expect(typeof message).toBe("string");
    expect(String(message).trim().length).toBeGreaterThan(0);
    expect(String(message)).toContain("Sentinel alert");
    expect(res.statusCode).toBe(200);
  });

  it("suppresses duplicate relay spam using dedupe key", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin({ hookRelayDedupeWindowMs: 60_000 });
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];

    const payload = {
      watcherId: "btc-price",
      eventName: "price_alert",
      dedupeKey: "dupe-1",
      deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
    };

    await route.handler(makeReq("POST", JSON.stringify(payload)) as any, makeRes() as any);
    const res2 = makeRes();
    await route.handler(makeReq("POST", JSON.stringify(payload)) as any, res2 as any);

    expect(mocks.sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res2.body ?? "{}").relay).toMatchObject({
      attempted: 1,
      delivered: 0,
      deduped: true,
    });
  });

  it("clips oversized payload content with truncation marker", async () => {
    const mocks = createApiMocks();

    const plugin = createSentinelPlugin();
    plugin.register(mocks.api);

    const route = mocks.registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        watcherId: "huge",
        eventName: "payload_big",
        payload: { blob: "x".repeat(6000) },
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [text] = mocks.enqueueSystemEvent.mock.calls[0];
    const envelopeJson = String(text).split("SENTINEL_ENVELOPE_JSON:\n")[1];
    const envelope = JSON.parse(envelopeJson);
    expect(envelope.payload).toMatchObject({
      __truncated: true,
      maxChars: 2500,
    });
    expect(String(envelope.payload.preview)).toContain("…");
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
    const req = makeReq("POST", JSON.stringify({ eventName: "x" }));
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("enqueue failed");
  });
});
