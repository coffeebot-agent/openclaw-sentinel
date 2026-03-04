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

describe("sentinel webhook callback route", () => {
  it("enqueues instruction prefix + JSON envelope and requests heartbeat on POST", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();

    const plugin = createSentinelPlugin({ hookSessionKey: "agent:main:main" });
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        payload: { price: 5050 },
        watcherId: "btc-price",
        eventName: "price_alert",
        skillId: "skills.alerts",
        matchedAt: "2026-03-04T14:12:00.000Z",
        dedupeKey: "abc-123",
        deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = enqueueSystemEvent.mock.calls[0];
    expect(options).toEqual({ sessionKey: "agent:main:main" });
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
      deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
      source: { route: "/hooks/sentinel", plugin: "openclaw-sentinel" },
      payload: { price: 5050 },
    });

    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "hook:sentinel",
      sessionKey: "agent:main:main",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}").ok).toBe(true);
  });

  it("clips oversized payload content with truncation marker", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow: vi.fn() } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
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

    const [text] = enqueueSystemEvent.mock.calls[0];
    const envelopeJson = String(text).split("SENTINEL_ENVELOPE_JSON:\n")[1];
    const envelope = JSON.parse(envelopeJson);
    expect(envelope.payload).toMatchObject({
      __truncated: true,
      maxChars: 2500,
    });
    expect(String(envelope.payload.preview)).toContain("…");
    expect(res.statusCode).toBe(200);
  });

  it("supports backward-compatible minimal payload shapes", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow: vi.fn() } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        watcher: { id: "legacy-watch", skillId: "skills.legacy" },
        event: { name: "legacy_event", payload: { ok: true } },
        timestamp: "2026-03-04T14:00:00.000Z",
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    const [text] = enqueueSystemEvent.mock.calls[0];
    const envelopeJson = String(text).split("SENTINEL_ENVELOPE_JSON:\n")[1];
    const envelope = JSON.parse(envelopeJson);
    expect(envelope).toMatchObject({
      watcherId: "legacy-watch",
      eventName: "legacy_event",
      skillId: "skills.legacy",
      matchedAt: "2026-03-04T14:00:00.000Z",
      payload: { ok: true },
      source: { route: "/hooks/sentinel", plugin: "openclaw-sentinel" },
    });
    expect(typeof envelope.dedupeKey).toBe("string");
    expect(envelope.dedupeKey.length).toBeGreaterThan(0);
    expect(envelope.correlationId).toBe(envelope.dedupeKey);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 for invalid json payloads", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow: vi.fn() } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", "not json");
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when loop callback wiring fails", async () => {
    const registerHttpRoute = vi.fn();

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: {
        system: {
          enqueueSystemEvent: vi.fn(() => {
            throw new Error("enqueue failed");
          }),
          requestHeartbeatNow: vi.fn(),
        },
      },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", JSON.stringify({ eventName: "x" }));
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("enqueue failed");
  });
});
