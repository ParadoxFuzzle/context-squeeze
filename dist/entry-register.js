import { compressHistory, estimateTokens } from "./compress.js";
import * as os from "node:os";
import * as pathMod from "node:path";
function mkOpts(cfg, ratioOverride, budgetOverride) {
    return {
        keepRecentTurns: clampInt(num(cfg.keepRecentTurns, 6), 1, 200),
        compressionRatio: clamp(num(ratioOverride ?? cfg.compressionRatio, 0.3), 0.05, 0.95),
        minTurnsBeforeCompression: clampInt(num(cfg.minTurnsBeforeCompression, 10), 2, 1000),
        targetTokenBudget: clampInt(num(budgetOverride ?? cfg.targetTokenBudget, 0), 0, 2_000_000),
        anchorPreserve: cfg.anchorPreserve !== false,
        minMessageChars: clampInt(num(cfg.minMessageChars, 400), 0, 8000),
    };
}
function normalizeRole(role) {
    const r = String(role ?? "").toLowerCase();
    if (r.startsWith("assistant"))
        return "assistant";
    if (r.startsWith("tool") || r === "function")
        return "tool";
    if (r.startsWith("system"))
        return "system";
    return "user";
}
function runCompressionForMessages(messages, opts, logger) {
    const history = [];
    for (const m of messages) {
        const rec = m;
        let text = "";
        if (typeof rec.content === "string")
            text = rec.content;
        else if (Array.isArray(rec.content)) {
            text = rec.content
                .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
                .join("\n");
        }
        else if (rec.content != null)
            text = JSON.stringify(rec.content);
        history.push({ role: normalizeRole(rec.role), text });
    }
    const { projected, stats } = compressHistory(history, opts);
    if (stats.savingsPct < 8)
        return null;
    const lines = [
        `[context-squeeze] ${stats.turnsCompressed}/${stats.turnsTotal} earlier turns compressed ` +
            `(${stats.savingsPct}% fewer chars ≈ ${estimateTokens(stats.charsBefore - stats.charsAfter)} tokens saved). ` +
            `Anchors preserve exact paths/commands/numbers verbatim. Original transcripts remain lossless on disk.`,
        "",
    ];
    for (const t of projected) {
        if (t.compressed)
            lines.push(t.text);
    }
    logger.debug?.(`context-squeeze: ${stats.turnsCompressed} cold turns compressed, ` +
        `${stats.charsBefore}→${stats.charsAfter} chars (${stats.savingsPct}%), ${stats.anchorsKept} anchors kept`);
    return lines.join("\n");
}
export function withContextSqueezeHook(entry) {
    const userRegister = entry.register;
    entry.register = (api) => {
        const cfg = (api.pluginConfig ?? {});
        const opts = mkOpts(cfg);
        api.logger.info(`context-squeeze hook ready: hot=${opts.keepRecentTurns} turns, ratio=${opts.compressionRatio}, ` +
            `budget=${opts.targetTokenBudget || "ratio"}, anchors=${opts.anchorPreserve}`);
        api.on("before_prompt_build", (event, ctx) => {
            if (ctx && ctx.trigger !== "user")
                return; // skip heartbeat/cron/heartbeat-ish turns
            if (!opts.anchorPreserve && opts.compressionRatio >= 1)
                return;
            const messages = event.messages;
            if (!Array.isArray(messages) || messages.length < 1)
                return;
            const minTurns = Math.max(2, opts.minTurnsBeforeCompression);
            if (messages.length < minTurns)
                return;
            const prepend = runCompressionForMessages(messages, opts, api.logger);
            if (!prepend)
                return;
            const debugStatsFile = typeof cfg.debugStatsFile === "string" ? cfg.debugStatsFile.trim() : "";
            if (debugStatsFile) {
                void (async () => {
                    try {
                        const fs = await import("node:fs");
                        const target = expandHome(debugStatsFile);
                        // Absolute paths only: a relative path would depend on the gateway's
                        // cwd, and every turn appends a line (unbounded growth).
                        if (!pathMod.isAbsolute(target))
                            return;
                        if (fs.existsSync(target) && fs.statSync(target).size > 5 * 1024 * 1024) {
                            fs.truncateSync(target, 0);
                        }
                        const stats = { ts: new Date().toISOString(), prependChars: prepend.length };
                        fs.mkdirSync(pathMod.dirname(target), { recursive: true });
                        fs.appendFileSync(target, JSON.stringify(stats) + "\n");
                    }
                    catch {
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
function num(v, dflt) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function clampInt(v, lo, hi) {
    return Math.round(clamp(v, lo, hi));
}
function expandHome(p) {
    if (p === "~")
        return os.homedir();
    if (p.startsWith("~/"))
        return pathMod.join(os.homedir(), p.slice(2));
    return p;
}
