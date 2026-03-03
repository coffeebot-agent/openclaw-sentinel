import crypto from 'node:crypto';
import { Condition } from './types.js';

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: any, part) => acc?.[part], obj as any);
}

function safeRegexTest(pattern: string, input: string): boolean {
  if (pattern.length > 256) throw new Error('Regex pattern too long');
  if (input.length > 4096) throw new Error('Regex input too long');
  // basic catastrophic pattern guard
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern) || (/\([^)]*\|[^)]*\)/.test(pattern) && /[+*{]/.test(pattern))) {
    throw new Error('Potentially unsafe regex pattern rejected');
  }
  try {
    return new RegExp(pattern, 'u').test(input);
  } catch {
    throw new Error('Invalid regex pattern');
  }
}

export function evaluateCondition(condition: Condition, payload: unknown, previousPayload: unknown): boolean {
  const current = getPath(payload, condition.path);
  const previous = getPath(previousPayload, condition.path);
  switch (condition.op) {
    case 'eq': return current === condition.value;
    case 'neq': return current !== condition.value;
    case 'gt': return Number(current) > Number(condition.value);
    case 'gte': return Number(current) >= Number(condition.value);
    case 'lt': return Number(current) < Number(condition.value);
    case 'lte': return Number(current) <= Number(condition.value);
    case 'exists': return current !== undefined && current !== null;
    case 'absent': return current === undefined || current === null;
    case 'contains': return typeof current === 'string' ? current.includes(String(condition.value ?? '')) : Array.isArray(current) ? current.includes(condition.value) : false;
    case 'matches': return safeRegexTest(String(condition.value ?? ''), String(current ?? ''));
    case 'changed': return JSON.stringify(current) !== JSON.stringify(previous);
    default: return false;
  }
}

export function evaluateConditions(conditions: Condition[], match: 'all'|'any', payload: unknown, previousPayload: unknown): boolean {
  const results = conditions.map((c) => evaluateCondition(c, payload, previousPayload));
  return match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function hashPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
