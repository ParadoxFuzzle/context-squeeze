// compress.ts — deterministic hot/cold context compression.
//
// The compressor keeps recent messages verbatim, compresses older prose with
// priority-weighted sentence extraction, and preserves exact facts (paths,
// commands, addresses, ticket ids) as best-effort anchor lists.
//
// It never compresses system instructions, tool results, or messages carrying
// non-text content. The caller decides those boundaries; this module only
// compresses Turn objects marked as compressible.
//
// Budget accounting uses an approximate message overhead so a token budget is a
// real upper bound on the projected payload, not just a per-message suggestion.
const MESSAGE_OVERHEAD_CHARS = 8;
const MIN_SOURCE_CHARS = 40;
const MIN_TEXT_CHARS = 8;
const TAG_ROLE_FALLBACK = "other";
// ---- Anchor extraction ------------------------------------------------------
const ANCHOR_PATTERNS = [
    { re: /(?:^|\s)(?:\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[a-z]{1,6})(?=\s|$|[,)\]])/gi, kind: "path" },
    { re: /(?:^|\s)(?:~\/(?:[\w.@+-]+\/)*[\w.@+-]+)/gi, kind: "path" },
    { re: /\b[a-z][\w-]*\.(?:js|ts|py|json|md|sh|yaml|yml|html|css|php|toml|conf)\b/gi, kind: "file" },
    { re: /(?:https?:\/\/|www\.)[^\s)>\\]]+/gi, kind: "url" },
    { re: /\b(?:localhost:\d+|127\.0\.0\.1:\d+|192\.168\.\d+\.\d+(?::\d+)?|10\.\d+\.\d+\.\d+(?::\d+)?)\b/g, kind: "addr" },
    { re: /(?:`[^`\n]{3,90}`)/g, kind: "code" },
    { re: /\b(?:npm|yarn|pnpm|pip|apt|systemctl|docker|git|curl|ssh|sudo|make|cargo|python3?|node)\s+[^\n;]{4,90}/gi, kind: "cmd" },
    { re: /\b\d+(?:\.\d+)?\s?(?:GB|MB|KB|tb|ms|s\b|min|tokens?|tok\/s|%)/gi, kind: "metric" },
    { re: /\b[A-Z]{2,8}-\d{1,6}\b/g, kind: "ticket" },
    { re: /\b(?:port|pin|key|token|id|version|v)\s*[=:]\s*"?\S{1,40}/gi, kind: "kv" },
    { re: /\b[a-f0-9]{7,64}\b/g, kind: "hash" },
    { re: /\b[A-Z][A-Z0-9_]{2,28}\b/g, kind: "const" },
];
export function extractAnchors(text, cap = 24) {
    const seen = new Set();
    const out = [];
    for (const { re } of ANCHOR_PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            const raw = match[0].trim().replace(/^[`"'(]+|[`"')]+$/g, "");
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
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);
}
function scoreSentence(sentence, position, total) {
    let score = 0;
    if (DECISION_RE.test(sentence))
        score += 3;
    if (QUESTION_RE.test(sentence))
        score += 2;
    if (sentence.length > 40 && sentence.length < 320)
        score += 1;
    score += Math.min(3, extractAnchors(sentence, 6).length * 0.75);
    if (position === 0)
        score += 1.5;
    else if (position / Math.max(1, total) > 0.8)
        score += 0.5;
    if (PRONOUN_HEAVY_RE.test(sentence) && score < 2)
        score -= 1.5;
    return score;
}
export function compressTurnText(text, budgetChars, anchorPreserve) {
    const budget = Math.max(0, Math.floor(budgetChars));
    if (budget === 0)
        return { compressed: "", anchors: 0, anchorsClipped: 0 };
    const anchors = anchorPreserve ? extractAnchors(text) : [];
    const anchorCap = Math.min(budget, Math.floor(budget * 0.6));
    const anchorBlock = buildAnchorBlock(anchors, anchorCap);
    const anchorsKept = anchorBlock ? countAnchorBlockItems(anchorBlock) : 0;
    const anchorsClipped = Math.max(0, anchors.length - anchorsKept);
    const proseBudget = Math.max(0, budget - (anchorBlock ? anchorBlock.length + 1 : 0));
    const sentences = splitSentences(text);
    if (sentences.length === 0 || proseBudget === 0) {
        return { compressed: anchorBlock || clip(text, budget), anchors: anchorsKept, anchorsClipped };
    }
    const scored = sentences
        .map((sentence, index) => ({
        sentence,
        index,
        score: scoreSentence(sentence, index, sentences.length),
    }))
        .sort((a, b) => b.score - a.score);
    // Greedy fill: highest-scored sentences first, then reassemble in original order.
    const keep = new Set();
    let used = 0;
    for (const { sentence, index } of scored) {
        const cost = sentence.length + 1;
        if (used + cost <= proseBudget || keep.size === 0) {
            keep.add(index);
            used += cost;
        }
        if (used >= proseBudget)
            break;
    }
    let body = sentences.filter((_, index) => keep.has(index)).join(" ");
    body = clip(body, proseBudget);
    const compressed = anchorBlock ? (body ? `${anchorBlock} ${body}` : anchorBlock) : body;
    return {
        compressed: compressed.length <= budget ? compressed : clip(compressed, budget),
        anchors: anchorsKept,
        anchorsClipped,
    };
}
function buildAnchorBlock(anchors, cap) {
    if (anchors.length === 0 || cap < 12)
        return "";
    const prefix = "[anchors: ";
    const suffix = "]";
    const chosen = [];
    for (const anchor of anchors) {
        const formatted = anchor.includes("`") ? anchor : `\`${anchor}\``;
        const candidate = `${prefix}${[...chosen, formatted].join(" · ")}${suffix}`;
        if (candidate.length > cap)
            break;
        chosen.push(formatted);
    }
    return chosen.length > 0 ? `${prefix}${chosen.join(" · ")}${suffix}` : "";
}
function countAnchorBlockItems(block) {
    return block.slice("[anchors: ".length, -1).split(" · ").filter(Boolean).length;
}
function clip(text, limit) {
    if (text.length <= limit)
        return text;
    if (limit <= 0)
        return "";
    if (limit === 1)
        return "…";
    return text.slice(0, limit - 1).trimEnd() + "…";
}
// ---- Token estimate (chars/4 heuristic, no tokenizer dependency) -------------
export const estimateTokens = (chars) => Math.ceil(chars / 4);
// ---- Main hot/cold split ----------------------------------------------------
export function compressHistory(history, opts) {
    const before = history.reduce((sum, turn) => sum + turn.text.length, 0);
    const minTurns = Math.max(2, opts.minTurnsBeforeCompression);
    const hotStart = Math.max(0, history.length - opts.keepRecentTurns);
    const beforeCost = history.reduce((sum, turn) => sum + messageCost(turn.text), 0);
    const budgetChars = resolveBudgetChars(opts);
    const hardLimit = budgetChars !== null && beforeCost > budgetChars;
    const eligible = [];
    for (let index = 0; index < history.length; index++) {
        const turn = history[index];
        const compressible = turn.compressible ?? (turn.role === "user" || turn.role === "assistant");
        if (history.length >= minTurns &&
            index < hotStart &&
            compressible &&
            turn.text.trim().length > 0 &&
            turn.text.length >= Math.max(MIN_SOURCE_CHARS, opts.minMessageChars)) {
            eligible.push(index);
        }
    }
    const eligibleSet = new Set(eligible);
    const projected = [];
    let anchorsKept = 0;
    let anchorsClipped = 0;
    let turnsCompressed = 0;
    let turnsDropped = 0;
    let charsAfter = 0;
    const fixedCost = history.reduce((sum, turn, index) => {
        if (eligibleSet.has(index))
            return sum;
        return sum + messageCost(turn.text);
    }, 0);
    let allocations = new Map();
    if (eligible.length > 0) {
        if (hardLimit && budgetChars !== null) {
            let available = budgetChars - fixedCost;
            while (eligible.length > 0 && available < minimumAllocation(eligible, history)) {
                eligible.shift();
            }
            available = budgetChars - fixedCost;
            if (available > 0 && eligible.length > 0) {
                allocations = allocateHardBudget(eligible, history, available, opts.compressionRatio);
            }
        }
        else {
            for (const index of eligible) {
                const turn = history[index];
                const tagLength = tagFor(index, turn.role).length;
                const target = Math.max(tagLength + MIN_TEXT_CHARS, Math.round(turn.text.length * opts.compressionRatio));
                allocations.set(index, Math.min(turn.text.length - 1, target));
            }
        }
    }
    for (let index = 0; index < history.length; index++) {
        const turn = history[index];
        const allocation = allocations.get(index);
        if (allocation === undefined) {
            if (eligibleSet.has(index)) {
                turnsDropped++;
                continue;
            }
            projected.push({ role: turn.role, text: turn.text, compressed: false, originalIndex: index, anchors: 0 });
            charsAfter += turn.text.length;
            continue;
        }
        const tag = tagFor(index, turn.role);
        const textBudget = Math.max(1, allocation - tag.length);
        const compressed = compressTurnText(turn.text, textBudget, opts.anchorPreserve);
        const candidate = tag + compressed.compressed;
        if (budgetChars === null && candidate.length >= turn.text.length) {
            projected.push({ role: turn.role, text: turn.text, compressed: false, originalIndex: index, anchors: 0 });
            charsAfter += turn.text.length;
            continue;
        }
        anchorsKept += compressed.anchors;
        anchorsClipped += compressed.anchorsClipped;
        turnsCompressed++;
        projected.push({
            role: turn.role,
            text: candidate,
            compressed: true,
            originalIndex: index,
            anchors: compressed.anchors,
        });
        charsAfter += candidate.length;
    }
    const projectedCost = projected.reduce((sum, turn) => sum + messageCost(turn.text), 0);
    const stats = {
        turnsTotal: history.length,
        turnsCompressed,
        turnsDropped,
        charsBefore: before,
        charsAfter,
        anchorsKept,
        anchorsClipped,
        savingsPct: before > 0 ? Math.round((1 - charsAfter / before) * 100) : 0,
        budgetChars,
        overBudget: budgetChars !== null && projectedCost > budgetChars,
    };
    return { projected, stats };
}
function resolveBudgetChars(opts) {
    const configBudget = opts.targetTokenBudget > 0 ? opts.targetTokenBudget * 4 : Number.POSITIVE_INFINITY;
    const hostBudget = (opts.hostTokenBudget ?? 0) > 0 ? opts.hostTokenBudget * 4 : Number.POSITIVE_INFINITY;
    const charBudget = Math.min(configBudget, hostBudget);
    return Number.isFinite(charBudget) ? Math.floor(charBudget) : null;
}
function allocateHardBudget(eligible, history, available, ratio) {
    const allocations = new Map();
    const totalLength = eligible.reduce((sum, index) => sum + history[index].text.length, 0);
    let remaining = available;
    for (let position = 0; position < eligible.length; position++) {
        const index = eligible[position];
        const turn = history[index];
        const slotsLeft = eligible.length - position;
        const minimum = tagFor(index, turn.role).length + MIN_TEXT_CHARS;
        const weighted = totalLength > 0 ? Math.floor(available * (turn.text.length / totalLength)) : minimum;
        const cap = remaining - (slotsLeft - 1) * minimum;
        // The budget is a cap, not a spending target. Never allocate more than the
        // configured ratio would have used just because the cap is larger.
        const ratioTarget = Math.round(turn.text.length * ratio);
        const allocation = Math.max(minimum, Math.min(weighted, cap, ratioTarget, Math.max(minimum, turn.text.length - 1)));
        allocations.set(index, allocation);
        remaining -= allocation;
    }
    return allocations;
}
function minimumAllocation(eligible, history) {
    return eligible.reduce((sum, index) => sum + tagFor(index, history[index].role).length + MIN_TEXT_CHARS, 0);
}
function tagFor(index, role) {
    const safeRole = role === TAG_ROLE_FALLBACK ? TAG_ROLE_FALLBACK : role;
    return `[t${index + 1} ${safeRole}, compressed] `;
}
function messageCost(text) {
    return text.length + MESSAGE_OVERHEAD_CHARS;
}
