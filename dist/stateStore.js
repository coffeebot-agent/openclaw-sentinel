import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export function defaultStatePath() {
    return path.join(os.homedir(), '.openclaw', 'sentinel-state.json');
}
export async function loadState(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            watchers: parsed.watchers ?? [],
            runtime: parsed.runtime ?? {},
            updatedAt: parsed.updatedAt ?? new Date().toISOString()
        };
    }
    catch {
        return { watchers: [], runtime: {}, updatedAt: new Date().toISOString() };
    }
}
export async function saveState(filePath, watchers, runtime) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ watchers, runtime, updatedAt: new Date().toISOString() }, null, 2));
}
export function mergeState(existing, incoming) {
    const watcherMap = new Map(existing.watchers.map((w) => [w.id, w]));
    for (const watcher of incoming.watchers)
        watcherMap.set(watcher.id, watcher);
    return {
        watchers: [...watcherMap.values()],
        runtime: { ...existing.runtime, ...incoming.runtime },
        updatedAt: new Date().toISOString()
    };
}
