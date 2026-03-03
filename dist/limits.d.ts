import { SentinelConfig, WatcherDefinition } from './types.js';
export declare function assertWatcherLimits(config: SentinelConfig, watchers: WatcherDefinition[], incoming: WatcherDefinition): void;
export declare function assertHostAllowed(config: SentinelConfig, endpoint: string): void;
