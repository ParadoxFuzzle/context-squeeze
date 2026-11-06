// entry-register.ts — wraps the tool-plugin entry so its register() also
// attaches the context-squeeze before_prompt_build hook, while keeping the
// metadata symbol intact (validate/build require it).
import type { CompressOptions, Turn } from "./compress.js";
import { compressHistory, estimateTokens } from "./compress.js";
import * as os from "node:os";
import * as pathMod from "node:path";

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
    keepRecentTurns: clampInt(num(cfg.keepRecentTurns, 6), 1, 200),
    compressionRatio: clamp(num(ratioOverride ?? cfg.compressionRatio, 0.3), 0.05, 0.95),
    minTurnsBeforeCompression: clampInt(num(cfg.minTurnsBeforeCompression, 10), 2, 1000),
    targetTokenBudget: clampInt(num(budgetOverride ?? cfg.targetTokenBudget, 0), 0, 2_000_000),
    anchorPreserve: cfg.anchorPreserve !== false,
    minMessageChars: clampInt(num(cfg.minMessageChars, 400), 0, 8000),
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

      const debugStatsFile = typeof cfg.debugStatsFile === "string" ? cfg.debugStatsFile.trim() : "";
      if (debugStatsFile) {
        void (async () => {
          try {
            const fs = await import("node:fs");
            const target = expandHome(debugStatsFile);
            // Absolute paths only: a relative path would depend on the gateway's
            // cwd, and every turn appends a line (unbounded growth).
            if (!pathMod.isAbsolute(target)) return;
            if (fs.existsSync(target) && fs.statSync(target).size > 5 * 1024 * 1024) {
              fs.truncateSync(target, 0);
            }
            const stats = { ts: new Date().toISOString(), prependChars: prepend.length };
            fs.mkdirSync(pathMod.dirname(target), { recursive: true });
            fs.appendFileSync(target, JSON.stringify(stats) + "\n");
          } catch {
            /* best-effort debug logging */
          }
        })();
      }

      return { prependContext: prepend };
    });

    // Then let defineToolPlugin's original register add the tool(s). Bind the
    // entry: a bare call drops `this`, which the SDK's register() relies on.
    userRegister.call(entry, api);
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
function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return pathMod.join(os.homedir(), p.slice(2));
  return p;
}
