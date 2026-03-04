import { jsonResult } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DeliveryTarget } from "./types.js";
import { WatcherManager } from "./watcherManager.js";
import { SentinelToolSchema, SentinelToolValidationSchema } from "./toolSchema.js";
import { TemplateValueSchema } from "./templateValueSchema.js";

export type SentinelToolParams = Static<typeof SentinelToolValidationSchema>;

function validateParams(params: unknown): SentinelToolParams {
  const candidate = (params ?? {}) as Record<string, unknown>;
  if (!Value.Check(SentinelToolValidationSchema, [TemplateValueSchema], candidate)) {
    const first = [
      ...Value.Errors(SentinelToolValidationSchema, [TemplateValueSchema], candidate),
    ][0];
    const where = first?.path || "(root)";
    const why = first?.message || "Invalid parameters";
    throw new Error(`Invalid sentinel_control parameters at ${where}: ${why}`);
  }
  return candidate as SentinelToolParams;
}

function stringifyPayload(payload: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (typeof serialized !== "string" || serialized.length === 0) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
}

function normalizeToolResultText(
  payload: unknown,
  fallbackText?: string,
): ReturnType<typeof jsonResult> {
  const preferredText = fallbackText?.trim();
  const safeText =
    preferredText && preferredText.length > 0 ? preferredText : (stringifyPayload(payload) ?? "ok");

  const result = jsonResult(payload) as ReturnType<typeof jsonResult>;
  const currentContent = Array.isArray((result as any).content)
    ? ([...(result as any).content] as any[])
    : [];

  let sawTextBlock = false;
  const normalized = currentContent.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.type !== "text") return entry;
    sawTextBlock = true;
    if (typeof entry.text === "string" && entry.text.length > 0) return entry;
    return { ...entry, text: safeText };
  });

  if (!sawTextBlock) {
    normalized.unshift({ type: "text", text: safeText });
  }

  return {
    ...result,
    content: normalized,
  } as ReturnType<typeof jsonResult>;
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
        case "add":
          return normalizeToolResultText(
            await manager.create(payload.watcher, {
              deliveryTargets: inferDefaultDeliveryTargets(ctx),
            }),
            "Watcher created",
          );
        case "enable":
          await manager.enable(payload.id);
          return normalizeToolResultText(undefined, `Enabled watcher: ${payload.id}`);
        case "disable":
          await manager.disable(payload.id);
          return normalizeToolResultText(undefined, `Disabled watcher: ${payload.id}`);
        case "remove":
        case "delete":
          try {
            return normalizeToolResultText(
              await manager.remove(payload.id),
              `Removed watcher: ${payload.id}`,
            );
          } catch (err) {
            const message = String((err as Error | undefined)?.message ?? err);
            return normalizeToolResultText(
              { ok: false, id: payload.id, error: message },
              `Failed to remove watcher: ${payload.id}`,
            );
          }
        case "status":
        case "get":
          return normalizeToolResultText(
            manager.status(payload.id),
            `Watcher not found: ${payload.id}`,
          );
        case "list":
          return normalizeToolResultText(manager.list(), "[]");
      }
    },
  }));
}
