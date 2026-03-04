import { jsonResult } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DeliveryTarget } from "./types.js";
import { WatcherManager } from "./watcherManager.js";
import { SentinelToolSchema } from "./toolSchema.js";

export type SentinelToolParams = Static<typeof SentinelToolSchema>;

function validateParams(params: unknown): SentinelToolParams {
  const candidate = (params ?? {}) as Record<string, unknown>;
  if (!Value.Check(SentinelToolSchema, candidate)) {
    const first = [...Value.Errors(SentinelToolSchema, candidate)][0];
    const where = first?.path || "(root)";
    const why = first?.message || "Invalid parameters";
    throw new Error(`Invalid sentinel_control parameters at ${where}: ${why}`);
  }
  return candidate as SentinelToolParams;
}

type SentinelToolContext = {
  messageChannel?: string;
  requesterSenderId?: string;
  agentAccountId?: string;
  sessionKey?: string;
};

type RegisterToolFn = (tool: AnyAgentTool | ((ctx: SentinelToolContext) => AnyAgentTool)) => void;

function inferDefaultDeliveryTargets(ctx: SentinelToolContext): DeliveryTarget[] {
  const channel = ctx.messageChannel?.trim();
  if (!channel) return [];

  const fromSender = ctx.requesterSenderId?.trim();
  if (fromSender) {
    return [{ channel, to: fromSender, accountId: ctx.agentAccountId }];
  }

  const sessionPeer = ctx.sessionKey?.split(":").at(-1)?.trim();
  if (sessionPeer) {
    return [{ channel, to: sessionPeer, accountId: ctx.agentAccountId }];
  }

  return [];
}

export function registerSentinelControl(
  registerTool: RegisterToolFn,
  manager: WatcherManager,
): void {
  registerTool((ctx) => ({
    name: "sentinel_control",
    label: "sentinel_control",
    description: "Create/manage sentinel watchers",
    parameters: SentinelToolSchema,
    async execute(_toolCallId, params: SentinelToolParams) {
      const payload = validateParams(params);
      switch (payload.action) {
        case "create":
          return jsonResult(
            await manager.create(payload.watcher, {
              deliveryTargets: inferDefaultDeliveryTargets(ctx),
            }),
          );
        case "enable":
          return jsonResult(await manager.enable(payload.id ?? ""));
        case "disable":
          return jsonResult(await manager.disable(payload.id ?? ""));
        case "remove":
          return jsonResult(await manager.remove(payload.id ?? ""));
        case "status":
          return jsonResult(manager.status(payload.id ?? ""));
        case "list":
          return jsonResult(manager.list());
      }
    },
  }));
}
