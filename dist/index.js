// index.ts — Context Squeeze plugin entry.
//
// Tool-plugin packaging (passes `openclaw plugins validate/build`) that both:
//   1. registers a `before_prompt_build` hook projecting session history into
//      hot (verbatim recent) + cold (anchor-preserving compressed) zones,
//      injected via `prependContext` (see entry-register.ts); and
//   2. exposes a `context-squeeze-stats` tool: a dry-run of the compressor so
//      the owner can inspect exactly what would be kept, without touching a
//      real session.
//
// The hook is a per-request projection — on-disk transcripts stay lossless.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { compressHistory, estimateTokens } from "./compress.js";
import { withContextSqueezeHook } from "./entry-register.js";
const baseEntry = defineToolPlugin({
    id: "context-squeeze",
    name: "Context Squeeze",
    description: "Hot/cold context compression with lossless anchors before LLM dispatch. Deterministic, no AI calls, per-request projection — on-disk transcripts stay lossless.",
    configSchema: {
        type: "object",
        properties: {
            keepRecentTurns: { type: "integer", default: 6 },
            compressionRatio: { type: "number", default: 0.3 },
            minTurnsBeforeCompression: { type: "integer", default: 10 },
            targetTokenBudget: { type: "integer", default: 0 },
            anchorPreserve: { type: "boolean", default: true },
            minMessageChars: { type: "integer", default: 400 },
            debugStatsFile: { type: "string", default: "" },
        },
        additionalProperties: false,
    },
    tools: (tool) => [
        tool({
            name: "context-squeeze-stats",
            description: "Dry-run the context-squeeze compressor on a sample transcript. Returns cold-zone stats, kept anchors, projected size. Modifies nothing.",
            parameters: Type.Object({
                sample: Type.String({
                    description: "Transcript text; separate turns with lines like 'user: ...' / 'assistant: ...' (or blank lines).",
                }),
                compressionRatio: Type.Optional(Type.Number({ description: "Override ratio (0.05–0.95; default = plugin config)." })),
                targetTokenBudget: Type.Optional(Type.Number({ description: "Override token budget (0 = ratio mode)." })),
            }),
            execute: async ({ sample, compressionRatio, targetTokenBudget }, config) => {
                const c = (config ?? {});
                const opts = {
                    keepRecentTurns: num(c.keepRecentTurns, 6),
                    compressionRatio: clamp(num(compressionRatio ?? c.compressionRatio, 0.3), 0.05, 0.95),
                    minTurnsBeforeCompression: num(c.minTurnsBeforeCompression, 10),
                    targetTokenBudget: num(targetTokenBudget ?? c.targetTokenBudget, 0),
                    anchorPreserve: c.anchorPreserve !== false,
                    minMessageChars: num(c.minMessageChars, 400),
                };
                const turns = parseSample(sample);
                if (turns.length < 2) {
                    return textResult("Need at least 2 turns (lines like 'user: ...'). A single turn is never compressed — that's the honest answer, not an error.", { ok: false });
                }
                const { projected, stats } = compressHistory(turns, opts);
                const lines = [
                    `turns: ${stats.turnsTotal} (hot verbatim: ${turns.length - stats.turnsCompressed}, cold compressed: ${stats.turnsCompressed})`,
                    `chars: ${stats.charsBefore} → ${stats.charsAfter} (${stats.savingsPct}% saved ≈ ${estimateTokens(stats.charsBefore - stats.charsAfter)} tokens)`,
                    `anchors kept: ${stats.anchorsKept}`,
                    "",
                    "— projection preview —",
                ];
                for (const t of projected) {
                    lines.push((t.compressed ? "[COLD] " : "[HOT ] ") + t.text.split("\n")[0].slice(0, 160));
                }
                return textResult(lines.join("\n"), { ok: true, stats });
            },
        }),
    ],
});
export default withContextSqueezeHook(baseEntry);
function parseSample(sample) {
    const turns = [];
    for (const rawline of sample.split(/\n\n+|\n(?=(?:user|assistant|tool|system):)/i)) {
        const line = rawline.trim();
        if (!line)
            continue;
        const m = line.match(/^(user|assistant|tool|system)\s*:\s*/i);
        const role = (m ? m[1] : "user").toLowerCase();
        const text = m ? line.slice(m[0].length) : line;
        turns.push({ role, text });
    }
    return turns;
}
function num(v, dflt) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
