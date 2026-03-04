import { StrategyHandler } from "./base.js";

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

export const sseStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  let active = true;
  let inFlightAbort: AbortController | undefined;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      sleepTimer = setTimeout(() => {
        sleepTimer = undefined;
        resolve();
      }, ms);
    });

  const loop = async () => {
    while (active) {
      try {
        inFlightAbort = new AbortController();
        const response = await fetch(watcher.endpoint, {
          headers: { Accept: "text/event-stream", ...(watcher.headers ?? {}) },
          signal: AbortSignal.any([
            inFlightAbort.signal,
            AbortSignal.timeout(watcher.timeoutMs ?? 60000),
          ]),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`sse non-2xx: ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) {
          throw new Error(`sse expected text/event-stream, got: ${contentType || "unknown"}`);
        }

        const text = await response.text();
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            await onPayload(JSON.parse(raw));
          } catch {
            await onPayload({ message: raw });
          }
        }

        if (active) {
          await wait(watcher.intervalMs ?? 1000);
        }
      } catch (err) {
        if (!active && isAbortError(err)) return;
        await onError(err);
        return;
      } finally {
        inFlightAbort = undefined;
      }
    }
  };

  void loop();

  return async () => {
    active = false;
    inFlightAbort?.abort();
    inFlightAbort = undefined;
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = undefined;
    }
  };
};
