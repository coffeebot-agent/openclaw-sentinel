import { createHash } from "node:crypto";
import {
  PriorityLevel,
  SENTINEL_ORIGIN_ACCOUNT_METADATA,
  SENTINEL_ORIGIN_CHANNEL_METADATA,
  SENTINEL_ORIGIN_SESSION_KEY_METADATA,
  SENTINEL_ORIGIN_TARGET_METADATA,
  WatcherDefinition,
} from "./types.js";
import { renderTemplate } from "./template.js";
import { getPath } from "./utils.js";

const MAX_PAYLOAD_JSON_CHARS = 4000;

function toIntent(eventName: string): string {
  return (
    eventName
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_") || "sentinel_event"
  );
}

function summarizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { summary: String(payload) };
  }
  const obj = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).slice(0, 12)) out[key] = obj[key];
  return out;
}

function truncatePayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (!serialized) return payload;
  if (serialized.length <= MAX_PAYLOAD_JSON_CHARS) return payload;
  return {
    truncated: true,
    maxChars: MAX_PAYLOAD_JSON_CHARS,
    preview: serialized.slice(0, MAX_PAYLOAD_JSON_CHARS),
  };
}

function buildDeliveryContextFromMetadata(
  watcher: WatcherDefinition,
): Record<string, unknown> | undefined {
  const metadata = watcher.metadata;
  if (!metadata) return undefined;

  const sessionKey = metadata[SENTINEL_ORIGIN_SESSION_KEY_METADATA]?.trim();
  const channel = metadata[SENTINEL_ORIGIN_CHANNEL_METADATA]?.trim();
  const to = metadata[SENTINEL_ORIGIN_TARGET_METADATA]?.trim();
  const accountId = metadata[SENTINEL_ORIGIN_ACCOUNT_METADATA]?.trim();

  const context: Record<string, unknown> = {};
  if (sessionKey) context.sessionKey = sessionKey;
  if (channel) context.messageChannel = channel;
  if (to) context.requesterSenderId = to;
  if (accountId) context.agentAccountId = accountId;

  if (channel && to) {
    context.currentChat = {
      channel,
      to,
      ...(accountId ? { accountId } : {}),
    };
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

function getTemplateString(
  value: string | undefined,
  context: Record<string, unknown>,
): string | undefined {
  if (!value) return undefined;
  if (!value.includes("${")) return value;

  if (/^\$\{[^}]+\}$/.test(value)) {
    const rendered = renderTemplate({ value }, context);
    const resolved = rendered.value;
    if (resolved === undefined || resolved === null) return undefined;
    return String(resolved);
  }

  return value.replaceAll(/\$\{([^}]+)\}/g, (_full, path) => {
    if (!/^(watcher\.(id|skillId)|event\.(name)|payload\.[a-zA-Z0-9_.-]+|timestamp)$/.test(path)) {
      throw new Error(`Template placeholder not allowed: $\{${path}\}`);
    }
    const resolved = getPath(context, path);
    if (resolved === undefined || resolved === null) {
      throw new Error(`Template placeholder unresolved: $\{${path}\}`);
    }
    return String(resolved);
  });
}

export function createCallbackEnvelope(args: {
  watcher: WatcherDefinition;
  payload: unknown;
  payloadBody: Record<string, unknown>;
  matchedAt: string;
  webhookPath: string;
}): Record<string, unknown> {
  const { watcher, payload, payloadBody, matchedAt, webhookPath } = args;
  const context = {
    watcher,
    event: { name: watcher.fire.eventName },
    payload,
    timestamp: matchedAt,
  };

  const intent = watcher.fire.intent ?? toIntent(watcher.fire.eventName);
  const renderedContext = watcher.fire.contextTemplate
    ? renderTemplate(watcher.fire.contextTemplate, context)
    : payloadBody;

  const priority: PriorityLevel = watcher.fire.priority ?? "normal";
  const deadline = getTemplateString(watcher.fire.deadlineTemplate, context);

  const dedupeSeed =
    getTemplateString(watcher.fire.dedupeKeyTemplate, context) ??
    `${watcher.id}|${watcher.fire.eventName}|${matchedAt}`;
  const dedupeKey = createHash("sha256").update(dedupeSeed).digest("hex");

  const deliveryContext = buildDeliveryContextFromMetadata(watcher);

  return {
    type: "sentinel.callback",
    version: "1",
    intent,
    actionable: true,
    watcher: {
      id: watcher.id,
      skillId: watcher.skillId,
      eventName: watcher.fire.eventName,
    },
    trigger: {
      matchedAt,
      dedupeKey,
      priority,
      ...(deadline ? { deadline } : {}),
    },
    ...(watcher.fire.sessionGroup ? { hookSessionGroup: watcher.fire.sessionGroup } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    context: renderedContext ?? summarizePayload(payload),
    payload: truncatePayload(payload),
    deliveryTargets: watcher.deliveryTargets ?? [],
    source: {
      plugin: "openclaw-sentinel",
      route: webhookPath,
    },
  };
}
