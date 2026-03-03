import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { WatcherManager } from "../src/watcherManager.js";
import { validateWatcherDefinition } from "../src/validator.js";

describe("fireOnce", () => {
  it("validator accepts fireOnce option", () => {
    const watcher = validateWatcherDefinition({
      id: "w-fire-once",
      skillId: "skills.test",
      enabled: true,
      strategy: "http-poll",
      endpoint: "https://api.github.com/events",
      intervalMs: 1000,
      match: "all",
      conditions: [{ path: "type", op: "eq", value: "PushEvent" }],
      fire: {
        webhookPath: "/hooks/agent",
        eventName: "evt",
        payloadTemplate: { event: "${event.name}" },
      },
      retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
      fireOnce: true,
    });
    expect(watcher.fireOnce).toBe(true);
  });

  it("auto-disables after first matched trigger when fireOnce=true", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("https://api.github.com")) {
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

    const dispatchSpy = vi.fn(async () => {});

    try {
      const manager = new WatcherManager(
        {
          allowedHosts: ["api.github.com"],
          localDispatchBase: "http://127.0.0.1:18789",
          stateFilePath: path.join(
            os.tmpdir(),
            `sentinel-fire-once-${Date.now()}-${Math.random()}.json`,
          ),
          limits: {
            maxWatchersTotal: 10,
            maxWatchersPerSkill: 10,
            maxConditionsPerWatcher: 10,
            maxIntervalMsFloor: 1,
          },
        },
        { dispatch: dispatchSpy },
      );

      await manager.init();
      await manager.create({
        id: "w1",
        skillId: "skills.test",
        enabled: true,
        strategy: "http-poll",
        endpoint: "https://api.github.com/events",
        intervalMs: 1,
        timeoutMs: 1000,
        match: "all",
        conditions: [{ path: "type", op: "eq", value: "PushEvent" }],
        fire: {
          webhookPath: "/hooks/agent",
          eventName: "evt",
          payloadTemplate: { event: "${event.name}" },
        },
        retry: { maxRetries: 0, baseMs: 100, maxMs: 100 },
        fireOnce: true,
      });

      await new Promise((r) => setTimeout(r, 30));

      const watcher = manager.list().find((w) => w.id === "w1");
      expect(watcher?.enabled).toBe(false);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
