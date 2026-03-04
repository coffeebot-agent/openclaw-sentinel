import WebSocket from "ws";
import { StrategyHandler } from "./base.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export const websocketStrategy: StrategyHandler = async (
  watcher,
  onPayload,
  onError,
  callbacks,
) => {
  let active = true;
  let ws: WebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;

  const clearConnectTimer = () => {
    if (!connectTimer) return;
    clearTimeout(connectTimer);
    connectTimer = undefined;
  };

  const connectTimeoutMs = Math.max(1, watcher.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

  const connect = () => {
    let pendingError: Error | null = null;
    let failureReported = false;

    const reportFailure = (reason: Error) => {
      if (!active || failureReported) return;
      failureReported = true;
      clearConnectTimer();
      void onError(reason);
    };

    ws = new WebSocket(watcher.endpoint, {
      headers: watcher.headers,
      handshakeTimeout: connectTimeoutMs,
    });

    connectTimer = setTimeout(() => {
      if (!active || !ws) return;
      if (ws.readyState === WebSocket.CONNECTING) {
        pendingError = new Error(`websocket connect timeout after ${connectTimeoutMs}ms`);
        ws.terminate();
      }
    }, connectTimeoutMs);

    ws.on("open", () => {
      if (!active) return;
      clearConnectTimer();
      callbacks?.onConnect?.();
    });

    ws.on("message", async (data) => {
      if (!active) return;
      const text = data.toString();
      try {
        await onPayload(JSON.parse(text));
      } catch {
        await onPayload({ message: text });
      }
    });

    ws.on("error", (err) => {
      if (!active) return;
      pendingError = err instanceof Error ? err : new Error(String(err));
    });

    ws.on("close", (code) => {
      if (!active) return;
      const reason = pendingError?.message ?? `websocket closed: ${code}`;
      reportFailure(new Error(reason));
    });
  };

  connect();

  return async () => {
    active = false;
    clearConnectTimer();
    if (!ws) return;

    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
};
