export interface CompressOptions {
    keepRecentTurns: number;
    compressionRatio: number;
    minTurnsBeforeCompression: number;
    targetTokenBudget: number;
    anchorPreserve: boolean;
    minMessageChars: number;
}
export interface Turn {
    role: "user" | "assistant" | "system" | "tool";
    text: string;
}
export interface CompressStats {
    turnsTotal: number;
    turnsCompressed: number;
    charsBefore: number;
    charsAfter: number;
    anchorsKept: number;
    savingsPct: number;
}
export declare function extractAnchors(text: string, cap?: number): string[];
export declare function compressTurnText(text: string, budgetChars: number, anchorPreserve: boolean): {
    compressed: string;
    anchors: number;
};
export declare const estimateTokens: (chars: number) => number;
export declare function compressHistory(history: Turn[], opts: CompressOptions): {
    projected: Array<{
        role: string;
        text: string;
        compressed?: boolean;
        ti?: number;
    }>;
    stats: CompressStats;
};
