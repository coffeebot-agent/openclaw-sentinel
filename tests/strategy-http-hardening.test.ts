import { describe, expect, it, vi } from "vitest";
import { httpLongPollStrategy } from "../src/strategies/httpLongPoll.js";
import { httpPollStrategy } from "../src/strategies/httpPoll.js";

const baseWatcher = {
  id: "w1",
  skillId: "skills.test",
  enabled: true,
  strategy: "http-poll" as const,
  endpoint: "https://api.github.com/events",
  match: "all" as const,
  conditions: [{ path: "type", op: "exists" as const }],
  fire: {
    webhookPath: "/hooks/agent",
    eventName: "evt",
    payloadTemplate: { event: "${event.name}" },
  },
  retry: { maxRetries: 1, baseMs: 50, maxMs: 500 },
};

describe("http strategy hardening", () => {
  it("uses redirect:error and returns descriptive JSON parse errors for http-poll", async () => {
    const onPayload = vi.fn(async () => undefined);
    const onError = vi.fn(async () => undefined);

    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      expect(opts.redirect).toBe("error");
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => {
          throw new Error("Unexpected token <");
        },
      } as any;
    });

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = fetchMock;

    try {
      await httpPollStrategy(baseWatcher as any, onPayload, onError);
      await new Promise((r) => setTimeout(r, 0));

      expect(onPayload).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      const [err] = onError.mock.calls[0];
      expect(String((err as Error).message)).toContain("http-poll invalid JSON response");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("uses redirect:error and returns descriptive JSON parse errors for http-long-poll", async () => {
    const onPayload = vi.fn(async () => undefined);
    const onError = vi.fn(async () => undefined);

    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      expect(opts.redirect).toBe("error");
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => {
          throw new Error("Unexpected token n");
        },
      } as any;
    });

    const oldFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = fetchMock;

    try {
      await httpLongPollStrategy(
        { ...baseWatcher, strategy: "http-long-poll" } as any,
        onPayload,
        onError,
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(onPayload).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      const [err] = onError.mock.calls[0];
      expect(String((err as Error).message)).toContain("http-long-poll invalid JSON response");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("aborts in-flight long-poll requests when watcher is stopped", async () => {
    const onPayload = vi.fn(async () => undefined);
    const onError = vi.fn(async () => undefined);

    let aborted = false;
    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
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
      const stop = await httpLongPollStrategy(
        { ...baseWatcher, strategy: "http-long-poll" } as any,
        onPayload,
        onError,
      );

      await new Promise((r) => setTimeout(r, 0));
      await stop();
      await new Promise((r) => setTimeout(r, 0));

      expect(aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
