import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

describe("plugin init webhook registration", () => {
  it("registers default sentinel webhook route idempotently", async () => {
    const registerHttpRoute = vi.fn();

    const pluginA = createSentinelPlugin();
    pluginA.register({ registerTool: vi.fn(), registerHttpRoute });

    const pluginB = createSentinelPlugin();
    pluginB.register({ registerTool: vi.fn(), registerHttpRoute });

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0][0].path).toBe("/hooks/sentinel");

    const audit = await pluginB.manager.audit();
    expect((audit as any).webhookRegistration.status).toBe("ok");
  });

  it("surfaces registration failure in audit diagnostics", async () => {
    const registerHttpRoute = vi.fn(() => {
      throw new Error("route collision");
    });

    const plugin = createSentinelPlugin();
    plugin.register({ registerTool: vi.fn(), registerHttpRoute, logger: { error: vi.fn() } });

    const audit = await plugin.manager.audit();
    expect((audit as any).webhookRegistration.status).toBe("error");
    expect(String((audit as any).webhookRegistration.message)).toContain("route collision");
  });

  it("warns when legacy root-level sentinel config is detected", async () => {
    const registerHttpRoute = vi.fn();
    const warn = vi.fn();

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      config: {
        sentinel: {
          allowedHosts: ["legacy.example.com"],
          localDispatchBase: "http://127.0.0.1:18789",
        },
      },
      logger: { warn, info: vi.fn(), error: vi.fn() },
    });

    const audit = await plugin.manager.audit();
    expect((audit as any).allowedHosts).toEqual(["legacy.example.com"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('root-level config key "sentinel"'));
  });

  it("prefers plugin-scoped config over legacy root-level sentinel config", async () => {
    const registerHttpRoute = vi.fn();

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      pluginConfig: {
        allowedHosts: ["plugin.example.com"],
      },
      config: {
        sentinel: {
          allowedHosts: ["legacy.example.com"],
        },
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    });

    const audit = await plugin.manager.audit();
    expect((audit as any).allowedHosts).toEqual(["plugin.example.com"]);
  });
});
