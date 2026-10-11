// entry-register.ts — wraps the tool-plugin entry so its register() also
// attaches the context-squeeze before_prompt_build hook, while keeping the
// metadata symbol intact (validate/build require it).
import type { CompressOptions, Turn } from "./compress.js";
import { compressHistory, estimateTokens } from "./compress.js";

type AnyApi = {
  on(event: string, handler: (event: unknown, ctx: { trigger?: string }) => Promise<unknown> | unknown): void;
  logger: { info: (s: string) => void; debug?: (s: string) => void };
  pluginConfig?: Record<string, unknown>;
};

type Entry = {
  id: string;
  name: string;
  description: string;
  register: (api: AnyApi) => void;
  [k: symbol]: unknown;
};

function mkOpts(cfg: Record<string, unknown>, ratioOverride?: number, budgetOverride?: number): CompressOptions {
  return {
    keepRecentTurns: num(cfg.keepRecentTurns, 6),
    compressionRatio: clamp(num(ratioOverride ?? cfg.compressionRatio, 0.3), 0.05, 0.95),
    minTurnsBeforeCompression: num(cfg.minTurnsBeforeCompression, 10),
    targetTokenBudget: num(budgetOverride ?? cfg.targetTokenBudget, 0),
    anchorPreserve: cfg.anchorPreserve !== false,
    minMessageChars: num(cfg.minMessageChars, 400),
  };
}

function normalizeRole(role: unknown): Turn["role"] {
  const r = String(role ?? "").toLowerCase();
  if (r.startsWith("assistant")) return "assistant";
  if (r.startsWith("tool") || r === "function") return "tool";
  if (r.startsWith("system")) return "system";
  return "user";
}

function runCompressionForMessages(messages: unknown[], opts: CompressOptions, logger: AnyApi["logger"]) {
  const history: Turn[] = [];
  for (const m of messages) {
    const rec = m as { role?: string; content?: unknown };
    let text = "";
    if (typeof rec.content === "string") text = rec.content;
    else if (Array.isArray(rec.content)) {
      text = rec.content
        .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? ""))
        .join("\n");
    } else if (rec.content != null) text = JSON.stringify(rec.content);
    history.push({ role: normalizeRole(rec.role), text });
  }

  const { projected, stats } = compressHistory(history, opts);
  if (stats.savingsPct < 8) return null;

  const lines: string[] = [
    `[context-squeeze] ${stats.turnsCompressed}/${stats.turnsTotal} earlier turns compressed ` +
      `(${stats.savingsPct}% fewer chars ≈ ${estimateTokens(stats.charsBefore - stats.charsAfter)} tokens saved). ` +
      `Anchors preserve exact paths/commands/numbers verbatim. Original transcripts remain lossless on disk.`,
    "",
  ];
  for (const t of projected) {
    if (t.compressed) lines.push(t.text);
  }

  logger.debug?.(
    `context-squeeze: ${stats.turnsCompressed} cold turns compressed, ` +
      `${stats.charsBefore}→${stats.charsAfter} chars (${stats.savingsPct}%), ${stats.anchorsKept} anchors kept`
  );
  return lines.join("\n");
}

export function withContextSqueezeHook(entry: Entry): Entry {
  const userRegister = entry.register;
  entry.register = (api: AnyApi) => {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const opts = mkOpts(cfg);

    api.logger.info(
      `context-squeeze hook ready: hot=${opts.keepRecentTurns} turns, ratio=${opts.compressionRatio}, ` +
        `budget=${opts.targetTokenBudget || "ratio"}, anchors=${opts.anchorPreserve}`
    );

    api.on("before_prompt_build", (event, ctx) => {
      if (ctx && ctx.trigger !== "user") return; // skip heartbeat/cron/heartbeat-ish turns
      if (!opts.anchorPreserve && opts.compressionRatio >= 1) return;
      const messages = (event as { messages?: unknown[] }).messages;
      if (!Array.isArray(messages) || messages.length < 1) return;
      const minTurns = Math.max(2, opts.minTurnsBeforeCompression);
      if (messages.length < minTurns) return;

      const prepend = runCompressionForMessages(messages, opts, api.logger);
      if (!prepend) return;

      const debugStatsFile = typeof cfg.debugStatsFile === "string" ? cfg.debugStatsFile : "";
      if (debugStatsFile) {
        void (async () => {
          try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const stats = { ts: new Date().toISOString(), prependChars: prepend.length };
            fs.mkdirSync(path.dirname(debugStatsFile), { recursive: true });
            fs.appendFileSync(debugStatsFile, JSON.stringify(stats) + "\n");
          } catch {
            /* best-effort debug logging */
          }
        })();
      }

      return { prependContext: prepend };
    });

    // Then let defineToolPlugin's original register add the tool(s).
    userRegister(api);
  };
  return entry;
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
