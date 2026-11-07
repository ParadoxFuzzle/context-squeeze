// index.ts — Context Squeeze OpenClaw plugin entry.
//
// Registers a real context engine (plugins.slots.contextEngine) that projects
// old history into a smaller message array before each model call, plus a
// dry-run tool for inspecting the compressor.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { compressHistory, estimateTokens, type Turn } from "./compress.js";
import { configSchema, resolveConfig } from "./config.js";
import { createContextSqueezeEngine } from "./context-engine.js";

const StatsParams = Type.Object({
  sample: Type.String({
    description:
      "Transcript text; separate turns with lines like 'user: ...' / 'assistant: ...' (or blank lines).",
  }),
  compressionRatio: Type.Optional(
    Type.Number({ minimum: 0.05, maximum: 0.95, description: "Override ratio; default = plugin config." })
  ),
  targetTokenBudget: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 2_000_000, description: "Override token budget; 0 = ratio mode." })
  ),
});
type StatsParams = Static<typeof StatsParams>;

export default definePluginEntry({
  id: "context-squeeze",
  name: "Context Squeeze",
  description:
    "Token-reducing context engine: keeps recent messages verbatim and compresses older prose with best-effort anchors. Deterministic, no AI calls.",
  configSchema,
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    api.logger.info(
      `context-squeeze context engine ready: hot=${config.keepRecentTurns} messages, ` +
        `ratio=${config.compressionRatio}, budget=${config.targetTokenBudget || "host"}, ` +
        `anchors=${config.anchorPreserve}`
    );

    api.registerContextEngine("context-squeeze", () =>
      createContextSqueezeEngine(config, api.logger)
    );

    api.registerTool(
      {
        name: "context-squeeze-stats",
        label: "Context Squeeze Stats",
        description:
          "Dry-run the context-squeeze compressor on a sample transcript. Returns cold-zone stats, kept anchors, and projected size. Modifies nothing.",
        parameters: StatsParams,
        async execute(_toolCallId, rawParams) {
          const params = rawParams as StatsParams;
          const opts = resolveConfig(api.pluginConfig, {
            compressionRatio: params.compressionRatio,
            targetTokenBudget: params.targetTokenBudget,
          });
          const turns = parseSample(params.sample);
          if (turns.length < 2) {
            return textResult(
              "Need at least 2 turns (lines like 'user: ...'). A single turn is never compressed.",
              { ok: false }
            );
          }

          const { projected, stats } = compressHistory(turns, opts);
          const lines = [
            `turns: ${stats.turnsTotal} (hot verbatim: ${stats.turnsTotal - stats.turnsCompressed - stats.turnsDropped}, compressed: ${stats.turnsCompressed}, dropped: ${stats.turnsDropped})`,
            `chars: ${stats.charsBefore} → ${stats.charsAfter} (${stats.savingsPct}% saved ≈ ${estimateTokens(stats.charsBefore - stats.charsAfter)} tokens)`,
            `anchors: ${stats.anchorsKept} kept, ${stats.anchorsClipped} clipped`,
            `budget: ${stats.budgetChars === null ? "ratio mode" : `${stats.budgetChars} chars`}${stats.overBudget ? " (still over)" : ""}`,
            "",
            "— projection preview —",
          ];
          for (const turn of projected) {
            const state = turn.compressed ? "[COLD]" : "[HOT ]";
            lines.push(`${state} ${turn.text.split("\n")[0].slice(0, 160)}`);
          }
          return textResult(lines.join("\n"), { ok: true, stats });
        },
      },
      { name: "context-squeeze-stats", workspaceAccess: false }
    );
  },
});

function parseSample(sample: string): Turn[] {
  const turns: Turn[] = [];
  for (const rawLine of sample.split(/\n\n+|\n(?=(?:user|assistant|tool|system):)/i)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(user|assistant|tool|system)\s*:\s*/i);
    const role = (match ? match[1] : "user").toLowerCase() as Turn["role"];
    const text = match ? line.slice(match[0].length) : line;
    turns.push({ role, text });
  }
  return turns;
}
