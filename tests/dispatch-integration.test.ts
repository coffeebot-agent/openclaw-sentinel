import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createSentinelPlugin } from "../src/index.js";

function makeStatePath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.json`);
}

async function createAndRunWatcher(plugin: ReturnType<typeof createSentinelPlugin>, id: string) {
  await plugin.init();
  await plugin.manager.create({
    id,
    skillId: "skills.x",
    enabled: true,
    strategy: "http-poll",
    endpoint: "https://api.github.com/events",
    intervalMs: 1,
    match: "all",
    conditions: [{ path: "type", op: "eq", value: "PushEvent" }],
    fire: {
      webhookPath: "/hooks/agent",
      eventName: "evt",
      payloadTemplate: { event: "${event.name}" },
    },
    retry: { maxRetries: 0, baseMs: 100, maxMs: 100 },
  });

  await new Promise((r) => setTimeout(r, 25));
  await plugin.manager.disable(id);
}

describe("dispatch integration", () => {
  it("posts to localDispatchBase+webhookPath with explicit bearer token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ type: "PushEvent" }),
        } as any;
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      } as any;
    });

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = fetchMock;

    try {
      const plugin = createSentinelPlugin({
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        dispatchAuthToken: "test-token",
        stateFilePath: makeStatePath("sentinel-dispatch-test"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      });

      await createAndRunWatcher(plugin, "w-explicit");

      const dispatchCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).startsWith("http://127.0.0.1:18789/hooks/agent"),
      );
      expect(dispatchCalls.length).toBeGreaterThan(0);
      const opts = dispatchCalls[0][1] as any;
      expect(opts.headers.authorization).toBe("Bearer test-token");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("auto-detects dispatchAuthToken from gateway config when plugin token is unset", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ type: "PushEvent" }),
        } as any;
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      } as any;
    });

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = fetchMock;

    try {
      const plugin = createSentinelPlugin({
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: makeStatePath("sentinel-dispatch-autosniff"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      });

      plugin.register({
        registerTool: vi.fn(),
        registerHttpRoute: vi.fn(),
        config: { auth: { token: "sniffed-token" } },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await createAndRunWatcher(plugin, "w-autosniff");

      const dispatchCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).startsWith("http://127.0.0.1:18789/hooks/agent"),
      );
      expect(dispatchCalls.length).toBeGreaterThan(0);
      const opts = dispatchCalls[0][1] as any;
      expect(opts.headers.authorization).toBe("Bearer sniffed-token");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("records dispatch failures and emits auth guidance on 401", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.github.com")) {
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({ type: "PushEvent" }),
        } as any;
      }
      return {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
        headers: { get: () => "application/json" },
      } as any;
    });

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = fetchMock;

    const warn = vi.fn();

    try {
      const plugin = createSentinelPlugin({
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: makeStatePath("sentinel-dispatch-failure"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      });

      plugin.register({
        registerTool: vi.fn(),
        registerHttpRoute: vi.fn(),
        logger: { info: vi.fn(), warn, error: vi.fn() },
      } as any);

      await createAndRunWatcher(plugin, "w-failure");

      const status = plugin.manager.status("w-failure");
      expect(status?.lastDispatchError).toContain("status 401");
      expect(status?.lastDispatchErrorAt).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dispatchAuthToken may be missing or invalid"),
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
