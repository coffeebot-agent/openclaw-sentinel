// Runtime E2E: starts a real OpenClaw gateway profile, installs this plugin tarball,
// and verifies /hooks/sentinel callback behavior through the live runtime model loop.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type CallbackResponse = {
  ok: boolean;
  route: string;
  sessionKey: string;
  enqueued: boolean;
  relay: {
    dedupeKey: string;
    attempted: number;
    delivered: number;
    failed: number;
    deduped: boolean;
    pending: boolean;
    timeoutMs: number;
    fallbackMode: string;
  };
};

type MockRequestRecord = {
  url: string;
  body: Record<string, unknown>;
  assistantText: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runCommand(args: string[], cwd = REPO_ROOT): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      env: {
        ...process.env,
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolveResult({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function requireSuccess(result: CommandResult, commandLabel: string) {
  if (result.code === 0) return;
  throw new Error(
    `${commandLabel} failed (exit=${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function runOpenClaw(profile: string, args: string[]) {
  const result = await runCommand([
    "exec",
    "openclaw",
    "--profile",
    profile,
    "--log-level",
    "error",
    ...args,
  ]);
  requireSuccess(result, `openclaw ${args.join(" ")}`);
  return result;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      resolveListen();
    });
  });
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate free port");
  }
  return address.port;
}

async function waitFor<T>(
  description: string,
  predicate: () => T | undefined,
  timeoutMs = 45_000,
  intervalMs = 100,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function extractTarballPath(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tarballLine = [...lines].reverse().find((line) => line.endsWith(".tgz"));
  if (!tarballLine) {
    throw new Error(`Unable to find tarball path in pnpm pack output:\n${output}`);
  }
  return tarballLine;
}

class MockOpenAiCompatServer {
  private queue: string[] = [];
  readonly requests: MockRequestRecord[] = [];
  private readonly server = createServer(this.handleRequest.bind(this));
  port = 0;

  enqueueAssistantText(text: string) {
    this.queue.push(text);
  }

  async start() {
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock model server failed to bind");
    }
    this.port = address.port;
  }

  async stop() {
    await new Promise<void>((resolveClose, rejectClose) => {
      this.server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private handleChatCompletionSse(res: ServerResponse, model: string, assistantText: string): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const base = {
      id: "chatcmpl-sentinel-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
    };

    const dataChunk = {
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant", content: assistantText }, finish_reason: null },
      ],
    };
    const doneChunk = {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };

    res.write(`data: ${JSON.stringify(dataChunk)}\n\n`);
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    const assistantText = this.queue.shift() ?? "default assistant text";

    this.requests.push({
      url: req.url ?? "",
      body,
      assistantText,
    });

    const model = (body.model as string | undefined) ?? "mock-callback";
    if ((req.url ?? "").includes("/chat/completions")) {
      this.handleChatCompletionSse(res, model, assistantText);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unsupported endpoint" }));
  }
}

function buildSentinelCallbackPayload(args: {
  watcherId: string;
  firedAt: string;
  currentPrice: number;
  direction: "above" | "below";
}) {
  return {
    type: "sentinel.callback",
    version: "2",
    intent: "price_alert",
    actionable: true,
    watcher: {
      id: args.watcherId,
      skillId: "skills.sentinel.e2e",
      eventName: "price_alert",
      intent: "price_alert",
      strategy: "http-poll",
      endpoint: "https://api.example.com/price",
      match: "all",
      conditions: [{ path: "price", op: "gt", value: 50000 }],
      fireOnce: false,
      tags: [],
    },
    trigger: {
      matchedAt: args.firedAt,
      dedupeKey: `price-${args.watcherId}-${Date.now()}`,
      priority: "high",
    },
    context: {
      currentPrice: args.currentPrice,
      threshold: 50_000,
      direction: args.direction,
    },
    payload: {
      price: args.currentPrice,
      direction: args.direction,
    },
    source: {
      plugin: "openclaw-sentinel",
      route: "/hooks/sentinel",
    },
    deliveryTargets: [{ channel: "telegram", to: "5613673222" }],
    deliveryContext: {
      sessionKey: "agent:main:telegram:direct:5613673222",
      messageChannel: "telegram",
      requesterSenderId: "5613673222",
    },
  };
}

describe("sentinel runtime callback e2e", () => {
  const gatewayLogs: string[] = [];

  let profile = "";
  let profileDir = "";
  let tempDir = "";
  let gatewayPort = 0;

  let mockModelServer: MockOpenAiCompatServer | null = null;
  let gatewayProcess: ChildProcessWithoutNullStreams | null = null;

  async function waitForGatewayReady() {
    const listenMarker = `listening on ws://127.0.0.1:${gatewayPort}`;

    await waitFor(
      "gateway listen log line",
      () => {
        const joined = gatewayLogs.join("\n");
        if (joined.includes(listenMarker)) return true;
        return undefined;
      },
      60_000,
      100,
    );
  }

  function requireModelServer(): MockOpenAiCompatServer {
    if (!mockModelServer) {
      throw new Error("mock model server is not initialized");
    }
    return mockModelServer;
  }

  async function postCallback(payload: Record<string, unknown>): Promise<CallbackResponse> {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/hooks/sentinel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`Unexpected callback status=${response.status}. body=${text}`);
    }

    return JSON.parse(text) as CallbackResponse;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sentinel-runtime-e2e-"));
    profile = `sentinel-e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    profileDir = join(homedir(), `.openclaw-${profile}`);
    gatewayPort = await getFreePort();

    mockModelServer = new MockOpenAiCompatServer();
    await mockModelServer.start();

    const packResult = await runCommand(["pack", "--pack-destination", tempDir, "--silent"]);
    requireSuccess(packResult, "pnpm pack");
    const tarballPath = extractTarballPath(packResult.stdout + "\n" + packResult.stderr);

    await runOpenClaw(profile, ["plugins", "install", tarballPath]);
    await runOpenClaw(profile, ["config", "set", "gateway.mode", '"local"']);
    await runOpenClaw(profile, ["config", "set", "gateway.auth.mode", '"none"']);
    await runOpenClaw(profile, ["config", "set", "gateway.port", String(gatewayPort)]);
    await runOpenClaw(profile, [
      "config",
      "set",
      "agents.defaults.model.primary",
      '"e2e/mock-callback"',
    ]);

    const modelConfig = {
      mode: "merge",
      providers: {
        e2e: {
          baseUrl: `http://127.0.0.1:${requireModelServer().port}/v1`,
          apiKey: "dummy",
          api: "openai-completions",
          models: [
            {
              id: "mock-callback",
              name: "mock-callback",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    };

    await runOpenClaw(profile, ["config", "set", "models", JSON.stringify(modelConfig)]);
    await runOpenClaw(profile, ["config", "set", "plugins.allow", '["openclaw-sentinel"]']);

    const pluginRuntimeConfig = {
      hookResponseTimeoutMs: 3_000,
      hookResponseDedupeWindowMs: 0,
      hookResponseFallbackMode: "concise",
    };

    await runOpenClaw(profile, [
      "config",
      "set",
      "plugins.entries.openclaw-sentinel.config",
      JSON.stringify(pluginRuntimeConfig),
    ]);

    gatewayProcess = spawn(
      "pnpm",
      [
        "exec",
        "openclaw",
        "--profile",
        profile,
        "--log-level",
        "debug",
        "gateway",
        "run",
        "--port",
        String(gatewayPort),
        "--auth",
        "none",
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CI: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    gatewayProcess.stdout.on("data", (chunk: Buffer) => {
      gatewayLogs.push(chunk.toString("utf8"));
    });
    gatewayProcess.stderr.on("data", (chunk: Buffer) => {
      gatewayLogs.push(chunk.toString("utf8"));
    });

    await waitForGatewayReady();

    await waitFor(
      "sentinel hook route registration",
      () => {
        const joined = gatewayLogs.join("\n");
        if (joined.includes("Registered default webhook route /hooks/sentinel")) return true;
        return undefined;
      },
      30_000,
      100,
    );
  }, 180_000);

  afterAll(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await Promise.race([
        once(gatewayProcess, "exit"),
        sleep(5_000).then(() => {
          if (gatewayProcess && gatewayProcess.exitCode === null) {
            gatewayProcess.kill("SIGKILL");
          }
        }),
      ]);
    }

    if (mockModelServer) {
      await mockModelServer.stop();
    }

    await rm(profileDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs /hooks/sentinel through live OpenClaw runtime and includes callback context in model prompt", async () => {
    const modelServer = requireModelServer();
    const initialCount = modelServer.requests.length;
    modelServer.enqueueAssistantText("Assistant callback ok");

    const callbackResponse = await postCallback(
      buildSentinelCallbackPayload({
        watcherId: "btc-price-50k",
        firedAt: "2026-03-05T01:41:20.000Z",
        currentPrice: 51_234.56,
        direction: "above",
      }),
    );

    expect(callbackResponse.ok).toBe(true);
    expect(callbackResponse.relay.pending).toBe(true);
    expect(callbackResponse.sessionKey).toBe("agent:main:hooks:sentinel:watcher:btc-price-50k");

    const requestRecord = await waitFor(
      "runtime model request for first callback",
      () => {
        if (modelServer.requests.length <= initialCount) return undefined;
        return modelServer.requests.at(-1);
      },
      20_000,
      100,
    );

    const payloadText = JSON.stringify(requestRecord.body);
    expect(payloadText).toContain("SENTINEL_CALLBACK_JSON");
    expect(payloadText).toContain("btc-price-50k");
    expect(payloadText).toContain("price_alert");
    expect(payloadText).toContain("deliveryTargets");
    expect(payloadText).toContain("currentPrice");

    // Mock model does not call sentinel_act, so timeout fallback should fire
    await waitFor(
      "timeout fallback relay",
      () => {
        const line = gatewayLogs.find((entry) =>
          entry.includes(`Sent timeout fallback for dedupe=${callbackResponse.relay.dedupeKey}`),
        );
        return line;
      },
      20_000,
      100,
    );
  }, 120_000);

  it("fires timeout fallback when LLM does not call sentinel_act in live runtime", async () => {
    const modelServer = requireModelServer();
    const initialCount = modelServer.requests.length;
    modelServer.enqueueAssistantText("NO_REPLY");

    const callbackResponse = await postCallback(
      buildSentinelCallbackPayload({
        watcherId: "btc-price-50k",
        firedAt: "2026-03-05T01:42:20.000Z",
        currentPrice: 49_900.12,
        direction: "below",
      }),
    );

    expect(callbackResponse.ok).toBe(true);
    expect(callbackResponse.relay.pending).toBe(true);

    await waitFor(
      "runtime model request for callback",
      () => {
        if (modelServer.requests.length <= initialCount) return undefined;
        return modelServer.requests.at(-1);
      },
      20_000,
      100,
    );

    // No sentinel_act called, so timeout fallback fires
    await waitFor(
      "timeout fallback relay",
      () => {
        const line = gatewayLogs.find((entry) =>
          entry.includes(`Sent timeout fallback for dedupe=${callbackResponse.relay.dedupeKey}`),
        );
        return line;
      },
      20_000,
      100,
    );
  }, 120_000);
});
