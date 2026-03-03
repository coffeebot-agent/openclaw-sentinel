import { GatewayWebhookDispatcher, SentinelConfig, WatcherDefinition, WatcherRuntimeState } from './types.js';
export declare class WatcherManager {
    private config;
    private dispatcher;
    private watchers;
    private runtime;
    private stops;
    private statePath;
    constructor(config: SentinelConfig, dispatcher: GatewayWebhookDispatcher);
    init(): Promise<void>;
    create(input: unknown): Promise<WatcherDefinition>;
    list(): WatcherDefinition[];
    status(id: string): WatcherRuntimeState | undefined;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    private require;
    private startWatcher;
    private stopWatcher;
    audit(): Promise<Record<string, unknown>>;
    private persist;
}
