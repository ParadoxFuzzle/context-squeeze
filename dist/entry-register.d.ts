type AnyApi = {
    on(event: string, handler: (event: unknown, ctx: {
        trigger?: string;
    }) => Promise<unknown> | unknown): void;
    logger: {
        info: (s: string) => void;
        debug?: (s: string) => void;
    };
    pluginConfig?: Record<string, unknown>;
};
type Entry = {
    id: string;
    name: string;
    description: string;
    register: (api: AnyApi) => void;
    [k: symbol]: unknown;
};
export declare function withContextSqueezeHook(entry: Entry): Entry;
export {};
