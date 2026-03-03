import { describe, expect, it } from 'vitest';
import { mergeState } from '../src/stateStore.js';

describe('state restore/merge', () => {
  it('merges runtime and watcher records by id', () => {
    const a = { watchers: [{ id: 'w1' }], runtime: { w1: { id: 'w1', consecutiveFailures: 1 } }, updatedAt: '' } as any;
    const b = { watchers: [{ id: 'w2' }, { id: 'w1', enabled: false }], runtime: { w2: { id: 'w2', consecutiveFailures: 0 } }, updatedAt: '' } as any;
    const merged = mergeState(a, b);
    expect(merged.watchers.find((w: any) => w.id === 'w1')?.enabled).toBe(false);
    expect(merged.runtime.w2.id).toBe('w2');
  });
});
