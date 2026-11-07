import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type CompressStats } from "./compress.js";
import type { ContextSqueezeConfig } from "./config.js";
type ContextEngineFactory = Parameters<OpenClawPluginApi["registerContextEngine"]>[1];
type ContextEngine = Awaited<ReturnType<ContextEngineFactory>>;
export interface EngineLogger {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
}
export interface DebugStats extends CompressStats {
    ts: string;
    sessionId: string | null;
    projectedMessages: number;
    estimatedTokens: number;
}
export declare function createContextSqueezeEngine(config: ContextSqueezeConfig, logger?: EngineLogger): ContextEngine;
export declare function writeDebugStats(file: string, stats: DebugStats, logger?: EngineLogger): Promise<void>;
export {};
