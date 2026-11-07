export type TurnRole = "user" | "assistant" | "system" | "tool" | "other";
export interface CompressOptions {
    keepRecentTurns: number;
    compressionRatio: number;
    minTurnsBeforeCompression: number;
    targetTokenBudget: number;
    /** Host-provided prompt budget for this run, in tokens. */
    hostTokenBudget?: number;
    anchorPreserve: boolean;
    minMessageChars: number;
}
export interface Turn {
    role: TurnRole;
    text: string;
    /** Overrides the default user/assistant eligibility. */
    compressible?: boolean;
}
export interface CompressStats {
    turnsTotal: number;
    turnsCompressed: number;
    turnsDropped: number;
    charsBefore: number;
    charsAfter: number;
    anchorsKept: number;
    anchorsClipped: number;
    savingsPct: number;
    budgetChars: number | null;
    overBudget: boolean;
}
export interface ProjectedTurn {
    role: TurnRole;
    text: string;
    compressed: boolean;
    originalIndex: number;
    anchors: number;
}
export declare function extractAnchors(text: string, cap?: number): string[];
export interface CompressedText {
    compressed: string;
    anchors: number;
    anchorsClipped: number;
}
export declare function compressTurnText(text: string, budgetChars: number, anchorPreserve: boolean): CompressedText;
export declare const estimateTokens: (chars: number) => number;
export declare function compressHistory(history: Turn[], opts: CompressOptions): {
    projected: ProjectedTurn[];
    stats: CompressStats;
};
