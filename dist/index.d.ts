declare const _default: {
    [k: symbol]: unknown;
    id: string;
    name: string;
    description: string;
    register: (api: {
        on(event: string, handler: (event: unknown, ctx: {
            trigger?: string;
        }) => Promise<unknown> | unknown): void;
        logger: {
            info: (s: string) => void;
            debug?: (s: string) => void;
        };
        pluginConfig?: Record<string, unknown>;
    }) => void;
};
export default _default;
