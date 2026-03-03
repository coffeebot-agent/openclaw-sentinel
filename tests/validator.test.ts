import { describe, expect, it } from 'vitest';
import { validateWatcherDefinition } from '../src/validator.js';

const base = {
  id: 'w1', skillId: 'skill.a', enabled: true, strategy: 'http-poll', endpoint: 'https://api.github.com/events',
  match: 'all',
  conditions: [{ path: 'a', op: 'exists' }],
  fire: { webhookPath: '/internal/sentinel', eventName: 'x', payloadTemplate: { a: '${payload.a}' } },
  retry: { maxRetries: 3, baseMs: 100, maxMs: 2000 }
};

describe('validator', () => {
  it('accepts valid watcher', () => {
    expect(validateWatcherDefinition(base).id).toBe('w1');
  });
  it('rejects unknown fields', () => {
    expect(() => validateWatcherDefinition({ ...base, rogue: true })).toThrow();
  });
  it('rejects code-like fields', () => {
    expect(() => validateWatcherDefinition({ ...base, metadata: { handler: 'function(){return 1;}' } })).toThrow();
  });
});
