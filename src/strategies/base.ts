import { WatcherDefinition } from '../types.js';

export type StrategyHandler = (watcher: WatcherDefinition, onPayload: (payload: unknown) => Promise<void>) => Promise<() => void>;
