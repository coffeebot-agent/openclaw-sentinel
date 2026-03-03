import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SentinelStateFile, WatcherDefinition, WatcherRuntimeState } from './types.js';

export function defaultStatePath(): string {
  return path.join(os.homedir(), '.openclaw', 'sentinel-state.json');
}

export async function loadState(filePath: string): Promise<SentinelStateFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SentinelStateFile;
    return {
      watchers: parsed.watchers ?? [],
      runtime: parsed.runtime ?? {},
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return { watchers: [], runtime: {}, updatedAt: new Date().toISOString() };
  }
}

export async function saveState(filePath: string, watchers: WatcherDefinition[], runtime: Record<string, WatcherRuntimeState>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ watchers, runtime, updatedAt: new Date().toISOString() }, null, 2));
}

export function mergeState(existing: SentinelStateFile, incoming: SentinelStateFile): SentinelStateFile {
  const watcherMap = new Map(existing.watchers.map((w) => [w.id, w]));
  for (const watcher of incoming.watchers) watcherMap.set(watcher.id, watcher);
  return {
    watchers: [...watcherMap.values()],
    runtime: { ...existing.runtime, ...incoming.runtime },
    updatedAt: new Date().toISOString()
  };
}
