import { describe, expect, it } from 'vitest';
import { evaluateConditions } from '../src/evaluator.js';

describe('evaluator', () => {
  it('supports any/all', () => {
    const payload = { price: 11, symbol: 'BTC', tags: ['hot'] };
    const conditions = [
      { path: 'price', op: 'gt', value: 10 },
      { path: 'symbol', op: 'eq', value: 'BTC' }
    ] as const;
    expect(evaluateConditions([...conditions], 'all', payload, {})).toBe(true);
    expect(evaluateConditions([{ path: 'price', op: 'lt', value: 1 }, ...conditions], 'any', payload, {})).toBe(true);
  });
});
