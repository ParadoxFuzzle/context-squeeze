import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import type { CompressOptions } from "./compress.js";
export interface ContextSqueezeConfig extends CompressOptions {
    debugStatsFile: string;
}
export declare const DEFAULT_CONFIG: ContextSqueezeConfig;
export declare const CONFIG_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly keepRecentTurns: {
            readonly type: "integer";
            readonly minimum: 1;
            readonly maximum: 200;
            readonly default: 6;
            readonly description: "Number of most recent messages kept verbatim.";
        };
        readonly compressionRatio: {
            readonly type: "number";
            readonly minimum: 0.05;
            readonly maximum: 0.95;
            readonly default: 0.3;
            readonly description: "Target size of compressed cold messages as a fraction of their original size.";
        };
        readonly minTurnsBeforeCompression: {
            readonly type: "integer";
            readonly minimum: 2;
            readonly maximum: 1000;
            readonly default: 10;
            readonly description: "Do not compress histories shorter than this many messages.";
        };
        readonly targetTokenBudget: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: 2000000;
            readonly default: 0;
            readonly description: "Additional hard prompt budget in tokens. 0 uses the host budget only.";
        };
        readonly anchorPreserve: {
            readonly type: "boolean";
            readonly default: true;
            readonly description: "Preserve paths, commands, addresses, ticket ids, and similar facts as anchors.";
        };
        readonly minMessageChars: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: 8000;
            readonly default: 400;
            readonly description: "Cold messages shorter than this stay verbatim.";
        };
        readonly debugStatsFile: {
            readonly type: "string";
            readonly default: "";
            readonly description: "Optional absolute path for append-only JSONL compression stats.";
        };
    };
    readonly additionalProperties: false;
};
export declare function resolveConfig(raw: Record<string, unknown> | undefined, overrides?: Partial<Pick<CompressOptions, "compressionRatio" | "targetTokenBudget">>): ContextSqueezeConfig;
export declare const configSchema: OpenClawPluginConfigSchema;
