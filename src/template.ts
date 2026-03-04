import { getPath } from "./utils.js";

const placeholderPattern =
  /^\$\{(watcher\.(id|skillId)|event\.(name)|payload\.[a-zA-Z0-9_.-]+|timestamp)\}$/;

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: TemplateValue }
  | TemplateValue[];

function renderValue(value: TemplateValue, context: Record<string, unknown>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.startsWith("${")) return value;
    if (!placeholderPattern.test(value)) {
      throw new Error(`Template placeholder not allowed: ${value}`);
    }
    const path = value.slice(2, -1);
    const resolved = getPath(context, path);
    if (resolved === undefined) throw new Error(`Template placeholder unresolved: ${value}`);
    return resolved;
  }

  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = renderValue(child, context);
  }
  return out;
}

export function renderTemplate(
  template: Record<string, TemplateValue>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return renderValue(template, context) as Record<string, unknown>;
}
