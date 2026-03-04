import { describe, expect, it, vi } from "vitest";
import { registerSentinelControl } from "../src/tool.js";

function createRegisteredTool(managerOverrides: Record<string, unknown> = {}) {
  const manager = {
    create: vi.fn(async () => ({ id: "created" })),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    status: vi.fn(() => ({ id: "watcher", consecutiveFailures: 0 })),
    list: vi.fn(() => []),
    ...managerOverrides,
  };

  let tool: any;
  registerSentinelControl((registeredTool: any) => {
    tool =
      typeof registeredTool === "function"
        ? registeredTool({
            messageChannel: "telegram",
            requesterSenderId: "123",
            sessionKey: "agent:main:telegram:direct:123",
          })
        : registeredTool;
  }, manager as any);

  if (!tool) throw new Error("sentinel_control tool was not registered");
  return { tool, manager };
}

function readFirstText(result: any): string | undefined {
  const content = Array.isArray(result?.content) ? result.content : [];
  const textEntry = content.find((entry: any) => entry?.type === "text");
  return textEntry?.text;
}

describe("sentinel_control tool result normalization", () => {
  it("returns non-empty text for remove when manager.remove returns void", async () => {
    const { tool, manager } = createRegisteredTool({
      remove: vi.fn(async () => undefined),
    });

    const result = await tool.execute("tc_remove_ok", {
      action: "remove",
      id: "watcher-ok",
    });

    expect(manager.remove).toHaveBeenCalledWith("watcher-ok");
    const text = readFirstText(result);
    expect(typeof text).toBe("string");
    expect(text && text.length).toBeGreaterThan(0);
  });

  it("returns non-empty text for remove not-found payloads", async () => {
    const { tool } = createRegisteredTool({
      remove: vi.fn(async () => ({ ok: false, id: "missing", reason: "not_found" })),
    });

    const result = await tool.execute("tc_remove_missing", {
      action: "remove",
      id: "missing",
    });

    const text = readFirstText(result);
    expect(typeof text).toBe("string");
    expect(text && text.length).toBeGreaterThan(0);
    expect(result?.details).toEqual({ ok: false, id: "missing", reason: "not_found" });
  });

  it("returns structured remove error result with non-empty text when manager.remove throws", async () => {
    const { tool } = createRegisteredTool({
      remove: vi.fn(async () => {
        throw new Error("persist failed");
      }),
    });

    const result = await tool.execute("tc_remove_err", {
      action: "remove",
      id: "watcher-err",
    });

    const text = readFirstText(result);
    expect(typeof text).toBe("string");
    expect(text && text.length).toBeGreaterThan(0);
    expect(result?.details).toMatchObject({
      ok: false,
      id: "watcher-err",
      error: "persist failed",
    });
  });

  it("returns non-empty text for other undefined payload actions", async () => {
    const { tool } = createRegisteredTool({
      enable: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
      status: vi.fn(() => undefined),
    });

    const enableResult = await tool.execute("tc_enable", {
      action: "enable",
      id: "watcher-enable",
    });
    const disableResult = await tool.execute("tc_disable", {
      action: "disable",
      id: "watcher-disable",
    });
    const statusResult = await tool.execute("tc_status_missing", {
      action: "status",
      id: "watcher-missing",
    });

    expect(readFirstText(enableResult)).toBeTruthy();
    expect(readFirstText(disableResult)).toBeTruthy();
    expect(readFirstText(statusResult)).toBeTruthy();
  });
});
