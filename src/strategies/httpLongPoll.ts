import { StrategyHandler } from "./base.js";

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

export const httpLongPollStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  let active = true;
  let inFlightAbort: AbortController | undefined;

  const loop = async () => {
    while (active) {
      try {
        inFlightAbort = new AbortController();
        const response = await fetch(watcher.endpoint, {
          method: watcher.method ?? "GET",
          headers: watcher.headers,
          body: watcher.body,
          signal: AbortSignal.any([
            inFlightAbort.signal,
            AbortSignal.timeout(watcher.timeoutMs ?? 60000),
          ]),
          redirect: "error",
        });

        if (!response.ok) throw new Error(`http-long-poll non-2xx: ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("json")) {
          throw new Error(`http-long-poll expected JSON, got: ${contentType || "unknown"}`);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (err) {
          throw new Error(
            `http-long-poll invalid JSON response: ${String((err as Error)?.message ?? err)}`,
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
    }
  };

  void loop();

  return async () => {
    active = false;
    inFlightAbort?.abort();
    inFlightAbort = undefined;
  };
};
