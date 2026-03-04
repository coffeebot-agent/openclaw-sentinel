import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { registerSentinelControl } from "../src/tool.js";
import { WatcherManager } from "../src/watcherManager.js";

function stateFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random()}.json`);
}

function watcherInput() {
  return {
    id: "w-delivery",
    skillId: "skills.delivery",
    enabled: false,
    strategy: "http-poll" as const,
    endpoint: "https://api.github.com/events",
    intervalMs: 1000,
    match: "all" as const,
    conditions: [{ path: "ok", op: "eq", value: true }],
    fire: {
      webhookPath: "/hooks/agent",
      eventName: "evt",
      payloadTemplate: { ok: true, message: "sentinel" },
    },
    retry: { maxRetries: 0, baseMs: 100, maxMs: 100 },
  };
}

describe("delivery targets", () => {
  it("infers default delivery target from tool context when omitted", async () => {
    const manager = new WatcherManager(
      {
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: stateFile("sentinel-default-target"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      },
      { dispatch: vi.fn(async () => {}) },
    );
    await manager.init();

    let toolFactory: any;
    registerSentinelControl((tool: any) => {
      toolFactory = tool;
    }, manager);

    const tool = toolFactory({
      messageChannel: "telegram",
      requesterSenderId: "5613673222",
      agentAccountId: "acct-1",
      sessionKey: "agent:main:telegram:direct:5613673222",
    });

    await tool.execute("tc1", {
      action: "create",
      watcher: watcherInput(),
    });

    expect(manager.list()[0]?.deliveryTargets).toEqual([
      { channel: "telegram", to: "5613673222", accountId: "acct-1" },
    ]);
    expect(manager.list()[0]?.metadata).toMatchObject({
      "openclaw.sentinel.origin.sessionKey": "agent:main:telegram:direct:5613673222",
      "openclaw.sentinel.origin.channel": "telegram",
      "openclaw.sentinel.origin.to": "5613673222",
      "openclaw.sentinel.origin.accountId": "acct-1",
    });
  });

  it("uses explicit deliveryTargets override with multiple targets", async () => {
    const manager = new WatcherManager(
      {
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: stateFile("sentinel-explicit-target"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      },
      { dispatch: vi.fn(async () => {}) },
    );
    await manager.init();

    let toolFactory: any;
    registerSentinelControl((tool: any) => {
      toolFactory = tool;
    }, manager);

    const tool = toolFactory({
      messageChannel: "telegram",
      requesterSenderId: "ignored-by-override",
    });

    await tool.execute("tc2", {
      action: "create",
      watcher: {
        ...watcherInput(),
        id: "w-explicit",
        deliveryTargets: [
          { channel: "telegram", to: "111" },
          { channel: "discord", to: "chan-222", accountId: "acct-2" },
        ],
      },
    });

    expect(manager.list().find((w) => w.id === "w-explicit")?.deliveryTargets).toEqual([
      { channel: "telegram", to: "111" },
      { channel: "discord", to: "chan-222", accountId: "acct-2" },
    ]);
  });

  it("fans out fire notifications and records partial failures", async () => {
    const dispatchSpy = vi.fn(async () => {});
    const notifySpy = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("target unavailable"));

    const manager = new WatcherManager(
      {
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: stateFile("sentinel-fanout"),
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      },
      { dispatch: dispatchSpy },
      {
        notify: async (target, message) => {
          await notifySpy(target, message);
        },
      },
    );

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    }));

    try {
      await manager.init();
      await manager.create({
        ...watcherInput(),
        id: "w-fanout",
        enabled: true,
        intervalMs: 1,
        conditions: [{ path: "ok", op: "eq", value: true }],
        fireOnce: true,
        deliveryTargets: [
          { channel: "telegram", to: "111" },
          { channel: "telegram", to: "222" },
        ],
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledTimes(2);
      const message = String(notifySpy.mock.calls[0]?.[1] ?? "");
      expect(message).toContain('Sentinel watcher "w-fanout" fired event "evt"');
      expect(message).not.toContain('"type": "sentinel.callback"');
      const status = manager.status("w-fanout");
      expect(status?.lastDelivery?.successCount).toBe(1);
      expect(status?.lastDelivery?.failureCount).toBe(1);
      expect(status?.lastDelivery?.failures?.[0]?.target.to).toBe("222");
      expect(String(status?.lastDelivery?.failures?.[0]?.error)).toContain("target unavailable");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  async function fireAndCaptureDelivery(options?: {
    globalMode?: "none" | "concise" | "debug";
    watcherMode?: "inherit" | "none" | "concise" | "debug";
  }) {
    const notifySpy = vi.fn(async () => {});
    const dispatchSpy = vi.fn(async () => {});
    const manager = new WatcherManager(
      {
        allowedHosts: ["api.github.com"],
        localDispatchBase: "http://127.0.0.1:18789",
        stateFilePath: stateFile("sentinel-mode-capture"),
        notificationPayloadMode: options?.globalMode,
        limits: {
          maxWatchersTotal: 10,
          maxWatchersPerSkill: 10,
          maxConditionsPerWatcher: 10,
          maxIntervalMsFloor: 1,
        },
      },
      { dispatch: dispatchSpy },
      {
        notify: async (target, message) => {
          await notifySpy(target, message);
        },
      },
    );

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, source: "test" }),
    }));

    try {
      await manager.init();
      await manager.create({
        ...watcherInput(),
        id: `w-mode-${Math.random().toString(16).slice(2)}`,
        enabled: true,
        intervalMs: 1,
        conditions: [{ path: "ok", op: "eq", value: true }],
        fireOnce: true,
        fire: {
          ...watcherInput().fire,
          ...(options?.watcherMode ? { notificationPayloadMode: options.watcherMode } : {}),
        },
        deliveryTargets: [{ channel: "telegram", to: "111" }],
      });

      await new Promise((r) => setTimeout(r, 20));
      return {
        dispatchCalls: dispatchSpy.mock.calls.length,
        notifyCalls: notifySpy.mock.calls.length,
        message: String(notifySpy.mock.calls[0]?.[1] ?? ""),
      };
    } finally {
      globalThis.fetch = oldFetch;
    }
  }

  it("includes debug envelope when global mode is debug", async () => {
    const result = await fireAndCaptureDelivery({ globalMode: "debug" });
    expect(result.dispatchCalls).toBe(1);
    expect(result.notifyCalls).toBe(1);
    expect(result.message).toContain("SENTINEL_DEBUG_ENVELOPE_JSON:");
    expect(result.message).toContain('"type": "sentinel.callback"');
  });

  it("suppresses delivery notification message when global mode is none", async () => {
    const result = await fireAndCaptureDelivery({ globalMode: "none" });
    expect(result.dispatchCalls).toBe(1);
    expect(result.notifyCalls).toBe(0);
  });

  it("applies per-watcher override over global mode", async () => {
    const forcedConcise = await fireAndCaptureDelivery({
      globalMode: "debug",
      watcherMode: "concise",
    });
    expect(forcedConcise.dispatchCalls).toBe(1);
    expect(forcedConcise.notifyCalls).toBe(1);
    expect(forcedConcise.message).not.toContain("SENTINEL_DEBUG_ENVELOPE_JSON:");
    expect(forcedConcise.message).not.toContain('"type": "sentinel.callback"');

    const forcedDebug = await fireAndCaptureDelivery({
      globalMode: "concise",
      watcherMode: "debug",
    });
    expect(forcedDebug.dispatchCalls).toBe(1);
    expect(forcedDebug.notifyCalls).toBe(1);
    expect(forcedDebug.message).toContain("SENTINEL_DEBUG_ENVELOPE_JSON:");
    expect(forcedDebug.message).toContain('"type": "sentinel.callback"');
  });

  it("supports per-watcher none override over concise/debug globals", async () => {
    const overriddenDebug = await fireAndCaptureDelivery({
      globalMode: "debug",
      watcherMode: "none",
    });
    expect(overriddenDebug.dispatchCalls).toBe(1);
    expect(overriddenDebug.notifyCalls).toBe(0);

    const overriddenConcise = await fireAndCaptureDelivery({
      globalMode: "concise",
      watcherMode: "none",
    });
    expect(overriddenConcise.dispatchCalls).toBe(1);
    expect(overriddenConcise.notifyCalls).toBe(0);
  });
});
