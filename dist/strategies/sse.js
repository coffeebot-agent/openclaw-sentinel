export const sseStrategy = async (watcher, onPayload) => {
    let active = true;
    const loop = async () => {
        while (active) {
            const response = await fetch(watcher.endpoint, { headers: { Accept: 'text/event-stream', ...(watcher.headers ?? {}) } });
            const text = await response.text();
            for (const line of text.split('\n')) {
                if (line.startsWith('data:')) {
                    const raw = line.slice(5).trim();
                    if (!raw)
                        continue;
                    try {
                        await onPayload(JSON.parse(raw));
                    }
                    catch {
                        await onPayload({ message: raw });
                    }
                }
            }
            await new Promise((r) => setTimeout(r, watcher.intervalMs ?? 1000));
        }
    };
    loop().catch(() => undefined);
    return async () => { active = false; };
};
