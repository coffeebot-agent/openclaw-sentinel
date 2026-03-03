import { WatcherManager } from './watcherManager.js';
import { SentinelConfig } from './types.js';
export declare function createSentinelPlugin(overrides?: Partial<SentinelConfig>): {
    manager: WatcherManager;
    init(): Promise<void>;
    register(api: {
        registerTool: (name: string, handler: (input: unknown) => Promise<unknown>) => void;
    }): void;
};
export * from './types.js';
