import { WatcherManager } from './watcherManager.js';
export declare function registerSentinelControl(registerTool: (name: string, handler: (input: unknown) => Promise<unknown>) => void, manager: WatcherManager): void;
