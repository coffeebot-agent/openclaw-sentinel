import { createHash } from "node:crypto";
import { SentinelCallbackEnvelope, WatcherDefinition } from "./types.js";

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

function truncatePayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized.length <= MAX_PAYLOAD_JSON_CHARS) return payload;
  return {
    truncated: true,
    maxChars: MAX_PAYLOAD_JSON_CHARS,
    preview: serialized.slice(0, MAX_PAYLOAD_JSON_CHARS),
  };
}

export function createCallbackEnvelope(args: {
  watcher: WatcherDefinition;
  payload: unknown;
  payloadBody: Record<string, unknown>;
  matchedAt: string;
  webhookPath: string;
}): SentinelCallbackEnvelope {
  const { watcher, payload, payloadBody, matchedAt, webhookPath } = args;
  const dedupeSeed = `${watcher.id}|${watcher.fire.eventName}|${matchedAt}`;
  const dedupeKey = createHash("sha256").update(dedupeSeed).digest("hex");

  return {
    type: "sentinel.callback",
    version: "1",
    intent: toIntent(watcher.fire.eventName),
    actionable: true,
    watcher: {
      id: watcher.id,
      skillId: watcher.skillId,
      eventName: watcher.fire.eventName,
    },
    trigger: {
      matchedAt,
      dedupeKey,
      priority: "normal",
    },
    context: payloadBody,
    payload: truncatePayload(payload),
    source: {
      plugin: "openclaw-sentinel",
      route: webhookPath,
    },
  };
}
