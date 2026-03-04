import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Condition } from "./types.js";
import { getPath } from "./utils.js";

const require = createRequire(import.meta.url);

type RegexCtor = new (pattern: string, flags?: string) => { test(input: string): boolean };
let cachedRegexCtor: RegexCtor | null = null;

function getSafeRegexCtor(): RegexCtor {
  if (cachedRegexCtor) return cachedRegexCtor;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const re2Mod = require("re2");
    const RE2Ctor = (re2Mod?.default ?? re2Mod) as RegexCtor;
    cachedRegexCtor = RE2Ctor;
    return cachedRegexCtor;
  } catch {
    // fallback below
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const re2Wasm = require("re2-wasm");
    const RE2Ctor = (re2Wasm?.RE2 ?? re2Wasm?.default ?? re2Wasm) as RegexCtor;
    cachedRegexCtor = RE2Ctor;
    return cachedRegexCtor;
  } catch {
    throw new Error("No safe regex engine available (re2/re2-wasm)");
  }
}

function safeRegexTest(pattern: string, input: string): boolean {
  if (pattern.length > 256) throw new Error("Regex pattern too long");
  if (input.length > 4096) throw new Error("Regex input too long");
  // basic catastrophic pattern guard
  if (
    /\([^)]*\|[^)]*\)[+*{]/.test(pattern) ||
    (/\([^)]*\|[^)]*\)/.test(pattern) && /[+*{]/.test(pattern))
  ) {
    throw new Error("Potentially unsafe regex pattern rejected");
  }
  try {
    const RE2Ctor = getSafeRegexCtor();
    const flags = "u";
    return new RE2Ctor(pattern, flags).test(input);
  } catch (err) {
    const msg = String((err as any)?.message ?? err);
    if (msg.toLowerCase().includes("safe regex engine")) throw err;
    throw new Error("Invalid or unsupported regex pattern");
  }
}

export function evaluateCondition(
  condition: Condition,
  payload: unknown,
  previousPayload: unknown,
): boolean {
  const current = getPath(payload, condition.path);
  const previous = getPath(previousPayload, condition.path);
  switch (condition.op) {
    case "eq":
      return current === condition.value;
    case "neq":
      return current !== condition.value;
    case "gt":
      return Number(current) > Number(condition.value);
    case "gte":
      return Number(current) >= Number(condition.value);
    case "lt":
      return Number(current) < Number(condition.value);
    case "lte":
      return Number(current) <= Number(condition.value);
    case "exists":
      return current !== undefined && current !== null;
    case "absent":
      return current === undefined || current === null;
    case "contains":
      return typeof current === "string"
        ? current.includes(String(condition.value ?? ""))
        : Array.isArray(current)
          ? current.includes(condition.value)
          : false;
    case "matches":
      return safeRegexTest(String(condition.value ?? ""), String(current ?? ""));
    case "changed":
      return JSON.stringify(current) !== JSON.stringify(previous);
    default:
      return false;
  }
}

export function evaluateConditions(
  conditions: Condition[],
  match: "all" | "any",
  payload: unknown,
  previousPayload: unknown,
): boolean {
  const results = conditions.map((c) => evaluateCondition(c, payload, previousPayload));
  return match === "all" ? results.every(Boolean) : results.some(Boolean);
}

export function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
