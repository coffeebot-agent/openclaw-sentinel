import { SentinelStateFile, WatcherDefinition, WatcherRuntimeState } from './types.js';
export declare function defaultStatePath(): string;
export declare function loadState(filePath: string): Promise<SentinelStateFile>;
export declare function saveState(filePath: string, watchers: WatcherDefinition[], runtime: Record<string, WatcherRuntimeState>): Promise<void>;
export declare function mergeState(existing: SentinelStateFile, incoming: SentinelStateFile): SentinelStateFile;
