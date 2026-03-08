import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

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

type MockRes = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

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

async function waitFor(condition: () => boolean, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function createTestPlugin(overrides?: Record<string, unknown>) {
  const registerHttpRoute = vi.fn();
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const hookHandlers: Record<string, Function> = {};

  const plugin = createSentinelPlugin({
    allowedHosts: ["api.example.com"],
    localDispatchBase: "http://127.0.0.1:18789",
    dispatchAuthToken: "test-token",
    hookSessionPrefix: "agent:main:hooks:sentinel",
    stateFilePath: path.join(
      os.tmpdir(),
      `sentinel-model-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    ),
    limits: {
      maxWatchersTotal: 10,
      maxWatchersPerSkill: 10,
      maxConditionsPerWatcher: 10,
      maxIntervalMsFloor: 1,
    },
    ...overrides,
  });

  plugin.register({
    registerTool: vi.fn(),
    registerHttpRoute,
    on: (hookName: string, handler: Function) => {
      hookHandlers[hookName] = handler;
    },
    runtime: { system: { enqueueSystemEvent, requestHeartbeatNow } },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as any);

  return {
    plugin,
    hookHandlers,
    registerHttpRoute,
    enqueueSystemEvent,
    requestHeartbeatNow,
  };
}

describe("hook model selection", () => {
  it("registers a before_model_resolve hook", () => {
    const { hookHandlers } = createTestPlugin();
    expect(hookHandlers.before_model_resolve).toBeDefined();
    expect(typeof hookHandlers.before_model_resolve).toBe("function");
  });

  it("returns undefined for non-sentinel sessions", () => {
    const { hookHandlers } = createTestPlugin();
    const result = hookHandlers.before_model_resolve(
      { prompt: "hello" },
      { sessionKey: "agent:main:main" },
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when no model config is set", () => {
    const { hookHandlers } = createTestPlugin();
    const result = hookHandlers.before_model_resolve(
      { prompt: "test" },
      { sessionKey: "agent:main:hooks:sentinel:watcher:test-watcher" },
    );
    expect(result).toBeUndefined();
  });

  it("returns defaultHookModel for sentinel sessions when configured", () => {
    const { hookHandlers } = createTestPlugin({
      defaultHookModel: "anthropic/claude-sonnet-4-20250514",
    });
    const result = hookHandlers.before_model_resolve(
      { prompt: "test" },
      { sessionKey: "agent:main:hooks:sentinel:watcher:unknown-watcher" },
    );
    expect(result).toEqual({ modelOverride: "anthropic/claude-sonnet-4-20250514" });
  });

  it("returns defaultHookModel for group sessions", () => {
    const { hookHandlers } = createTestPlugin({
      defaultHookModel: "anthropic/claude-sonnet-4-20250514",
    });
    const result = hookHandlers.before_model_resolve(
      { prompt: "test" },
      { sessionKey: "agent:main:hooks:sentinel:group:ops-group" },
    );
    expect(result).toEqual({ modelOverride: "anthropic/claude-sonnet-4-20250514" });
  });

  it("per-watcher fire.model overrides defaultHookModel", async () => {
    const endpoint = "https://api.example.com/test";

    const { plugin, hookHandlers } = createTestPlugin({
      defaultHookModel: "anthropic/claude-sonnet-4-20250514",
    });

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ status: "ok" }),
    })) as any;

    try {
      await plugin.init();
      await plugin.manager.create({
        id: "model-test-watcher",
        skillId: "skills.test",
        enabled: false,
        strategy: "http-poll",
        endpoint,
        intervalMs: 60000,
        match: "all",
        conditions: [{ path: "status", op: "eq", value: "alert" }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "test_event",
          payloadTemplate: { event: "${event.name}" },
          model: "anthropic/claude-opus-4-0",
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      });

      const result = hookHandlers.before_model_resolve(
        { prompt: "test" },
        { sessionKey: "agent:main:hooks:sentinel:watcher:model-test-watcher" },
      );
      expect(result).toEqual({ modelOverride: "anthropic/claude-opus-4-0" });
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.disable("model-test-watcher").catch(() => undefined);
      await plugin.manager.remove("model-test-watcher").catch(() => undefined);
    }
  });

  it("falls back to defaultHookModel when watcher has no fire.model", async () => {
    const endpoint = "https://api.example.com/test";

    const { plugin, hookHandlers } = createTestPlugin({
      defaultHookModel: "anthropic/claude-sonnet-4-20250514",
    });

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ status: "ok" }),
    })) as any;

    try {
      await plugin.init();
      await plugin.manager.create({
        id: "no-model-watcher",
        skillId: "skills.test",
        enabled: false,
        strategy: "http-poll",
        endpoint,
        intervalMs: 60000,
        match: "all",
        conditions: [{ path: "status", op: "eq", value: "alert" }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "test_event",
          payloadTemplate: { event: "${event.name}" },
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      });

      const result = hookHandlers.before_model_resolve(
        { prompt: "test" },
        { sessionKey: "agent:main:hooks:sentinel:watcher:no-model-watcher" },
      );
      expect(result).toEqual({ modelOverride: "anthropic/claude-sonnet-4-20250514" });
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.disable("no-model-watcher").catch(() => undefined);
      await plugin.manager.remove("no-model-watcher").catch(() => undefined);
    }
  });

  it("returns undefined when watcher has no fire.model and no defaultHookModel", async () => {
    const endpoint = "https://api.example.com/test";

    const { plugin, hookHandlers } = createTestPlugin();

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ status: "ok" }),
    })) as any;

    try {
      await plugin.init();
      await plugin.manager.create({
        id: "plain-watcher",
        skillId: "skills.test",
        enabled: false,
        strategy: "http-poll",
        endpoint,
        intervalMs: 60000,
        match: "all",
        conditions: [{ path: "status", op: "eq", value: "alert" }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "test_event",
          payloadTemplate: { event: "${event.name}" },
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      });

      const result = hookHandlers.before_model_resolve(
        { prompt: "test" },
        { sessionKey: "agent:main:hooks:sentinel:watcher:plain-watcher" },
      );
      expect(result).toBeUndefined();
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.disable("plain-watcher").catch(() => undefined);
      await plugin.manager.remove("plain-watcher").catch(() => undefined);
    }
  });

  it("includes hookModel in callback envelope when fire.model is set", async () => {
    const endpoint = "https://api.example.com/data";

    const { plugin, registerHttpRoute, enqueueSystemEvent } = createTestPlugin();

    await plugin.init();

    const oldFetch = globalThis.fetch;
    let dispatchBody: Record<string, unknown> | undefined;

    const route = registerHttpRoute.mock.calls[0]?.[0];

    globalThis.fetch = vi.fn(async (url: unknown, options?: any) => {
      const href = String(url);

      if (href.startsWith(endpoint)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ price: 51000, threshold: 50000 }),
        } as any;
      }

      if (href === "http://127.0.0.1:18789/hooks/sentinel") {
        dispatchBody = JSON.parse(String(options?.body ?? "{}"));

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
        id: "envelope-model-test",
        skillId: "skills.test",
        enabled: true,
        strategy: "http-poll",
        endpoint,
        intervalMs: 5,
        match: "all",
        conditions: [{ path: "__always__", op: "eq", value: undefined }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "price_alert",
          payloadTemplate: { price: "${payload.price}" },
          model: "anthropic/claude-sonnet-4-20250514",
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
        fireOnce: true,
      });

      await waitFor(() => enqueueSystemEvent.mock.calls.length > 0);

      expect(dispatchBody).toBeDefined();
      expect(dispatchBody!.hookModel).toBe("anthropic/claude-sonnet-4-20250514");
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.disable("envelope-model-test").catch(() => undefined);
    }
  });

  it("does not include hookModel in envelope when fire.model is not set", async () => {
    const endpoint = "https://api.example.com/data2";

    const { plugin, registerHttpRoute, enqueueSystemEvent } = createTestPlugin();

    await plugin.init();

    const oldFetch = globalThis.fetch;
    let dispatchBody: Record<string, unknown> | undefined;

    const route = registerHttpRoute.mock.calls[0]?.[0];

    globalThis.fetch = vi.fn(async (url: unknown, options?: any) => {
      const href = String(url);

      if (href.startsWith(endpoint)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ value: 42 }),
        } as any;
      }

      if (href === "http://127.0.0.1:18789/hooks/sentinel") {
        dispatchBody = JSON.parse(String(options?.body ?? "{}"));

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
        id: "envelope-no-model",
        skillId: "skills.test",
        enabled: true,
        strategy: "http-poll",
        endpoint,
        intervalMs: 5,
        match: "all",
        conditions: [{ path: "__always__", op: "eq", value: undefined }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "value_check",
          payloadTemplate: { val: "${payload.value}" },
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
        fireOnce: true,
      });

      await waitFor(() => enqueueSystemEvent.mock.calls.length > 0);

      expect(dispatchBody).toBeDefined();
      expect(dispatchBody!.hookModel).toBeUndefined();
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.disable("envelope-no-model").catch(() => undefined);
    }
  });
});

describe("hook model config schema validation", () => {
  it("accepts defaultHookModel in config", () => {
    const { hookHandlers } = createTestPlugin({
      defaultHookModel: "anthropic/claude-sonnet-4-20250514",
    });
    expect(hookHandlers.before_model_resolve).toBeDefined();
  });

  it("ignores empty string defaultHookModel", () => {
    const { hookHandlers } = createTestPlugin({
      defaultHookModel: "  ",
    });
    const result = hookHandlers.before_model_resolve(
      { prompt: "test" },
      { sessionKey: "agent:main:hooks:sentinel:watcher:any" },
    );
    expect(result).toBeUndefined();
  });
});

describe("fire.model in watcher definition", () => {
  it("validates watcher with fire.model", async () => {
    const { plugin } = createTestPlugin();

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })) as any;

    try {
      await plugin.init();
      const watcher = await plugin.manager.create({
        id: "valid-model-watcher",
        skillId: "skills.test",
        enabled: false,
        strategy: "http-poll",
        endpoint: "https://api.example.com/test",
        intervalMs: 60000,
        match: "all",
        conditions: [{ path: "ok", op: "eq", value: true }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "test",
          payloadTemplate: {},
          model: "anthropic/claude-sonnet-4-20250514",
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      });

      expect(watcher.fire.model).toBe("anthropic/claude-sonnet-4-20250514");
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.remove("valid-model-watcher").catch(() => undefined);
    }
  });

  it("persists fire.model through watcher list", async () => {
    const { plugin } = createTestPlugin();

    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })) as any;

    try {
      await plugin.init();
      await plugin.manager.create({
        id: "persisted-model",
        skillId: "skills.test",
        enabled: false,
        strategy: "http-poll",
        endpoint: "https://api.example.com/test",
        intervalMs: 60000,
        match: "all",
        conditions: [{ path: "ok", op: "eq", value: true }],
        fire: {
          webhookPath: "/hooks/sentinel",
          eventName: "test",
          payloadTemplate: {},
          model: "google/gemini-2.5-flash",
        },
        retry: { maxRetries: 0, baseMs: 50, maxMs: 100 },
      });

      const listed = plugin.manager.list();
      const found = listed.find((w) => w.id === "persisted-model");
      expect(found?.fire.model).toBe("google/gemini-2.5-flash");
    } finally {
      globalThis.fetch = oldFetch;
      await plugin.manager.remove("persisted-model").catch(() => undefined);
    }
  });
});
