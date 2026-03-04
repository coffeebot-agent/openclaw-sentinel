import { StrategyHandler } from "./base.js";

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

export const httpPollStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  const interval = watcher.intervalMs ?? 30000;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlightAbort: AbortController | undefined;

  const tick = async () => {
    if (!active) return;

    try {
      inFlightAbort = new AbortController();
      const response = await fetch(watcher.endpoint, {
        method: watcher.method ?? "GET",
        headers: watcher.headers,
        body: watcher.body,
        signal: AbortSignal.any([
          inFlightAbort.signal,
          AbortSignal.timeout(watcher.timeoutMs ?? 15000),
        ]),
        redirect: "error",
      });

      if (!response.ok) throw new Error(`http-poll non-2xx: ${response.status}`);

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        throw new Error(`http-poll expected JSON, got: ${contentType || "unknown"}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new Error(
          `http-poll invalid JSON response: ${String((err as Error)?.message ?? err)}`,
        );
      }

      await onPayload(payload);
    } catch (err) {
      if (!active && isAbortError(err)) return;
      await onError(err);
      return;
    } finally {
      inFlightAbort = undefined;
    }

    if (active) {
      timer = setTimeout(() => {
        void tick();
      }, interval);
    }
  };

  void tick();

  return async () => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    inFlightAbort?.abort();
    inFlightAbort = undefined;
  };
};
