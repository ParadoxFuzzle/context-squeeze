// compress.ts — core hot/cold context compression with lossless anchors.
//
// Design principles (vs. plain extractive turboquant):
// 1. ANCHOR PRESERVATION: exact strings that a future turn may need verbatim
//    (file paths, commands, URLs, numbers, error codes, quoted identifiers)
//    survive compression as a compact anchor list per turn. Compression must
//    never lose a fact that aggregation would need — it loses prose redundancy.
// 2. SPEAKER/TIME STRUCTURE: every cold turn is tagged [tN user]/[tN assistant]
//    so temporal ordering and attribution survive compression.
// 3. PRIORITIZED EXTRACTION: sentences scored by (anchor density + position +
//    decision/commit markers + question markers), not just term frequency.
// 4. TOKEN BUDGET MODE: if targetTokenBudget > 0, compress the cold zone to
//    FIT the budget (iterative ratio), instead of a fixed ratio.
// 5. NO AI CALLS: deterministic, fast, free — same spirit as turboquant.
// ---- Anchor extraction ------------------------------------------------------
const ANCHOR_PATTERNS = [
    { re: /(?:^|\s)(?:\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[a-z]{1,6})(?=\s|$|[,)\]])/gi, kind: "path" },
    { re: /(?:^|\s)(?:~\/(?:[\w.@+-]+\/)*[\w.@+-]+)/gi, kind: "path" },
    { re: /\b[a-z][\w-]*\.(?:js|ts|py|json|md|sh|yaml|yml|html|css|php|toml|conf)\b/gi, kind: "file" },
    { re: /(?:https?:\/\/|www\.)[^\s)>\]]+/gi, kind: "url" },
    { re: /\b(?:localhost:\d+|127\.0\.0\.1:\d+|192\.168\.\d+\.\d+(?::\d+)?|10\.\d+\.\d+\.\d+(?::\d+)?)\b/g, kind: "addr" },
    { re: /(?:`[^`\n]{3,90}`)/g, kind: "code" },
    { re: /\b(?:npm|yarn|pnpm|pip|apt|systemctl|docker|git|curl|ssh|sudo|make|cargo|python3?|node)\s+[^\n;]{4,90}/gi, kind: "cmd" },
    { re: /\b\d+(?:\.\d+)?\s?(?:GB|MB|KB|tb|ms|s\b|min|tokens?|tok\/s|%)/gi, kind: "metric" },
    { re: /\b[A-Z]{2,8}-\d{1,6}\b/g, kind: "ticket" }, // TICKET-123 / AB-123 style refs
    { re: /\b(?:port|pin|key|token|id|version|v)\s*[=:]\s*"?\S{1,40}/gi, kind: "kv" },
    { re: /\b[a-f0-9]{7,64}\b/g, kind: "hash" },
    { re: /\b[A-Z][A-Z0-9_]{2,28}\b/g, kind: "const" },
];
export function extractAnchors(text, cap = 24) {
    const seen = new Set();
    const out = [];
    for (const { re, kind } of ANCHOR_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const raw = m[0].trim().replace(/^[`"'(]+|[`"')]+$/g, "");
            if (!raw || raw.length < 3 || raw.length > 110)
                continue;
            const dedup = raw.toLowerCase();
            if (seen.has(dedup))
                continue;
            seen.add(dedup);
            out.push(raw);
            if (out.length >= cap)
                return out;
        }
    }
    return out;
}
// ---- Sentence scoring -------------------------------------------------------
const DECISION_RE = /\b(decided|decision|agree|chose|chosen|will use|should use|must|requirement|requires|rule|constraint|remember|important|critical|bug|fix|broke|error|failed|root cause|conclusion|conclude|prefer|instead of|because)\b/i;
const QUESTION_RE = /\?/;
const PRONOUN_HEAVY_RE = /^(?:it|that|this|they|them|then|so|and|also|anyway|yeah|okay|ok|lol|haha)\b/i;
function splitSentences(text) {
    return text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-Z0-9`\w])/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}
function scoreSentence(s, position, total) {
    let score = 0;
    if (DECISION_RE.test(s))
        score += 3;
    if (QUESTION_RE.test(s))
        score += 2;
    if (s.length > 40 && s.length < 320)
        score += 1;
    const anchors = extractAnchors(s, 6);
    score += Math.min(3, anchors.length * 0.75);
    // First sentences of a turn often carry intent ("Can you fix…").
    if (position === 0)
        score += 1.5;
    else if (position / Math.max(1, total) > 0.8)
        score += 0.5;
    // Pronoun-only openers have little standalone value.
    if (PRONOUN_HEAVY_RE.test(s) && score < 2)
        score -= 1.5;
    return score;
}
// ---- Per-turn compression ---------------------------------------------------
export function compressTurnText(text, budgetChars, anchorPreserve) {
    const sentences = splitSentences(text);
    if (sentences.length === 0)
        return { compressed: text.slice(0, Math.max(40, budgetChars)), anchors: 0 };
    const scored = sentences
        .map((s, i) => ({ s, i, score: scoreSentence(s, i, sentences.length) }))
        .sort((a, b) => b.score - a.score);
    const anchors = anchorPreserve ? extractAnchors(text) : [];
    const anchorBlock = anchors.length
        ? `[anchors: ${anchors.map(a => (a.includes("`") ? a : `\`${a}\``)).join(" · ")}]`
        : "";
    // Greedy fill: highest-scored sentences first, but reassemble in original order.
    const keep = new Set();
    let used = anchorBlock.length + 4;
    for (const { s, i } of scored) {
        const cost = s.length + 1;
        if (used + cost <= budgetChars || keep.size === 0) {
            keep.add(i);
            used += cost;
        }
        if (used >= budgetChars)
            break;
    }
    const keptSentences = sentences.filter((_, i) => keep.has(i));
    let body = keptSentences.join(" ");
    if (anchorBlock)
        body = body ? `${anchorBlock} ${body}` : anchorBlock;
    // Hard guarantee on budget.
    if (body.length > budgetChars)
        body = body.slice(0, Math.max(40, budgetChars - 1)) + "…";
    return { compressed: body, anchors: anchors.length };
}
// ---- Token estimate (chars/4 heuristic, no tiktoken dependency) --------------
export const estimateTokens = (chars) => Math.ceil(chars / 4);
// ---- Main hot/cold split -----------------------------------------------------
const TAG_RE_HISTORY = /\[(?:user|assistant|tool|system)\]/;
export function compressHistory(history, opts) {
    const n = history.length;
    const minTurns = Math.max(2, opts.minTurnsBeforeCompression);
    const hotStart = Math.max(0, n - opts.keepRecentTurns);
    const before = history.reduce((a, t) => a + t.text.length, 0);
    const projected = [];
    let anchorsKept = 0;
    let turnsCompressed = 0;
    let after = 0;
    // Budget-mode tuning: how aggressively to squeeze the cold zone.
    const coldOriginal = history.slice(0, hotStart).reduce((a, t) => a + t.text.length, 0);
    const totalOriginal = before;
    let ratio = opts.compressionRatio;
    if (opts.targetTokenBudget > 0) {
        const budgetChars = opts.targetTokenBudget * 4;
        const hotChars = history.slice(hotStart).reduce((a, t) => a + t.text.length, 0);
        const coldBudget = Math.max(200, budgetChars - hotChars);
        ratio = Math.min(0.95, coldBudget / Math.max(1, coldOriginal));
        if (totalOriginal - hotChars <= coldBudget)
            ratio = 1; // already fits
    }
    for (let i = 0; i < n; i++) {
        const turn = history[i];
        const msgActualChars = turn.text.length;
        if (i >= hotStart || msgActualChars < opts.minMessageChars || n < minTurns || ratio >= 1) {
            projected.push({ role: turn.role, text: turn.text, ti: i });
            after += msgActualChars;
            continue;
        }
        const budget = Math.max(80, Math.round(msgActualChars * ratio));
        const { compressed, anchors } = compressTurnText(turn.text, budget, opts.anchorPreserve);
        anchorsKept += anchors;
        turnsCompressed++;
        const text = `[t${i + 1} ${turn.role}, compressed] ${compressed}`;
        projected.push({ role: turn.role, text, compressed: true, ti: i });
        after += text.length;
    }
    const stats = {
        turnsTotal: n,
        turnsCompressed,
        charsBefore: before,
        charsAfter: after,
        anchorsKept,
        savingsPct: before > 0 ? Math.round((1 - after / before) * 100) : 0,
    };
    return { projected, stats };
}
