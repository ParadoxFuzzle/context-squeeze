import { compressHistory, estimateTokens } from "./compress.js";
function mkOpts(cfg, ratioOverride, budgetOverride) {
    return {
        keepRecentTurns: num(cfg.keepRecentTurns, 6),
        compressionRatio: clamp(num(ratioOverride ?? cfg.compressionRatio, 0.3), 0.05, 0.95),
        minTurnsBeforeCompression: num(cfg.minTurnsBeforeCompression, 10),
        targetTokenBudget: num(budgetOverride ?? cfg.targetTokenBudget, 0),
        anchorPreserve: cfg.anchorPreserve !== false,
        minMessageChars: num(cfg.minMessageChars, 400),
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
            const debugStatsFile = typeof cfg.debugStatsFile === "string" ? cfg.debugStatsFile : "";
            if (debugStatsFile) {
                void (async () => {
                    try {
                        const fs = await import("node:fs");
                        const path = await import("node:path");
                        const stats = { ts: new Date().toISOString(), prependChars: prepend.length };
                        fs.mkdirSync(path.dirname(debugStatsFile), { recursive: true });
                        fs.appendFileSync(debugStatsFile, JSON.stringify(stats) + "\n");
                    }
                    catch {
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
function num(v, dflt) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
