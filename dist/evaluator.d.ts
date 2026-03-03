import { Condition } from './types.js';
export declare function evaluateCondition(condition: Condition, payload: unknown, previousPayload: unknown): boolean;
export declare function evaluateConditions(conditions: Condition[], match: 'all' | 'any', payload: unknown, previousPayload: unknown): boolean;
export declare function hashPayload(payload: unknown): string;
