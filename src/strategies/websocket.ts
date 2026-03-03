import WebSocket from 'ws';
import { StrategyHandler } from './base.js';

export const websocketStrategy: StrategyHandler = async (watcher, onPayload) => {
  const ws = new WebSocket(watcher.endpoint, { headers: watcher.headers });
  ws.on('message', async (data) => {
    const text = data.toString();
    try { await onPayload(JSON.parse(text)); } catch { await onPayload({ message: text }); }
  });
  return async () => ws.close();
};
