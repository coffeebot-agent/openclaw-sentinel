import { describe, expect, it } from 'vitest';
import { assertHostAllowed, assertWatcherLimits } from '../src/limits.js';

const cfg = {
  allowedHosts: ['api.github.com'],
  localDispatchBase: 'http://127.0.0.1:4389',
  limits: { maxWatchersTotal: 1, maxWatchersPerSkill: 1, maxConditionsPerWatcher: 2, maxIntervalMsFloor: 1000 }
};

describe('limits', () => {
  it('enforces hosts', () => {
    expect(() => assertHostAllowed(cfg as any, 'https://api.github.com/x')).not.toThrow();
    expect(() => assertHostAllowed(cfg as any, 'https://evil.com/x')).toThrow();
  });
  it('enforces counts', () => {
    const watcher = { skillId: 's', conditions: [{}, {}], intervalMs: 1000 } as any;
    expect(() => assertWatcherLimits(cfg as any, [], watcher)).not.toThrow();
    expect(() => assertWatcherLimits(cfg as any, [{ skillId: 's' }] as any, watcher)).toThrow();
  });
});
