// context-engine.ts — OpenClaw context-engine implementation.
//
// OpenClaw calls assemble() with the messages it intends to send. Returning a
// projected message array is what actually replaces old history; unlike the old
// before_prompt_build hook, this does not send the originals alongside a summary.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as pathMod from "node:path";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { compressHistory, estimateTokens, } from "./compress.js";
const MAX_COMMITTED_KEYS = 10_000;
export function createContextSqueezeEngine(config, logger = {}) {
    const committed = new Set();
    return {
        info: {
            id: "context-squeeze",
            name: "Context Squeeze",
            version: "0.3.0",
            acceptedHostParams: ["sessionKey", "sessionTarget", "runtimeSettings", "runtimeContext", "abortSignal"],
            transcriptSemantics: {
                currentTurnFence: "before-current-turn-entry-v1",
                turnAdvancementIdempotency: "atomic-idempotent-v1",
            },
            ownsCompaction: false,
            hostRequirements: {
                "agent-run": {
                    requiredCapabilities: ["assemble-before-prompt"],
                    unsupportedMessage: "Context Squeeze needs an agent runtime that calls assemble() before the prompt. Use the native embedded runtime or select the legacy context engine.",
                },
            },
        },
        async ingest() {
            // Stateless: the host already owns the transcript and passes the full
            // history to assemble(). There is no second copy to ingest.
            return { ingested: true };
        },
        async assemble(params) {
            const messages = params.messages;
            if (messages.length === 0) {
                return {
                    messages: params.messages,
                    estimatedTokens: 0,
                    promptAuthority: "preassembly_may_overflow",
                };
            }
            const turns = messages.map(toTurn);
            const { projected, stats } = compressHistory(turns, {
                ...config,
                hostTokenBudget: params.tokenBudget,
            });
            if (stats.turnsCompressed === 0 && stats.turnsDropped === 0) {
                return {
                    messages: params.messages,
                    estimatedTokens: estimateTokens(stats.charsAfter),
                    promptAuthority: "preassembly_may_overflow",
                };
            }
            const out = projected.map((turn) => {
                const original = messages[turn.originalIndex];
                if (!turn.compressed)
                    return original;
                return compressMessageContent(original, turn.text);
            });
            logger.debug?.(`context-squeeze: ${stats.turnsCompressed} compressed, ${stats.turnsDropped} dropped, ` +
                `${stats.charsBefore}→${stats.charsAfter} chars (${stats.savingsPct}%), ` +
                `${stats.anchorsKept} anchors kept, ${stats.anchorsClipped} clipped` +
                (stats.overBudget ? ", still over budget" : ""));
            const debugStats = {
                ...stats,
                ts: new Date().toISOString(),
                sessionId: params.sessionId ?? null,
                projectedMessages: out.length,
                estimatedTokens: estimateTokens(stats.charsAfter),
            };
            if (config.debugStatsFile) {
                await writeDebugStats(config.debugStatsFile, debugStats, logger);
            }
            return {
                messages: out,
                estimatedTokens: debugStats.estimatedTokens,
                promptAuthority: "preassembly_may_overflow",
            };
        },
        async compact(params) {
            // Compression here is a prompt projection, not a transcript rewrite.
            // Delegate /compact and overflow recovery to OpenClaw's built-in path.
            return delegateCompactionToRuntime(params);
        },
        async commitTurn({ advancementKey }) {
            // The engine has no durable turn store. Recording the key still gives the
            // host the idempotent committed/duplicate contract it requires to use
            // assemble() for admitted turns.
            if (committed.has(advancementKey))
                return { status: "duplicate" };
            committed.add(advancementKey);
            if (committed.size > MAX_COMMITTED_KEYS) {
                const oldest = committed.values().next().value;
                if (oldest !== undefined)
                    committed.delete(oldest);
            }
            return { status: "committed" };
        },
        async dispose() {
            committed.clear();
        },
    };
}
export async function writeDebugStats(file, stats, logger = {}) {
    try {
        const target = expandHome(file);
        if (!pathMod.isAbsolute(target)) {
            logger.warn?.("context-squeeze: debugStatsFile must be an absolute path; not writing stats");
            return;
        }
        await fs.mkdir(pathMod.dirname(target), { recursive: true });
        try {
            const info = await fs.stat(target);
            if (info.size > 5 * 1024 * 1024)
                await fs.truncate(target, 0);
        }
        catch {
            // The file does not exist yet.
        }
        await fs.appendFile(target, `${JSON.stringify(stats)}\n`, "utf8");
    }
    catch {
        // Debug logging must never break a model turn.
    }
}
function toTurn(message) {
    const role = normalizeRole(message.role);
    const text = messageText(message);
    const compressible = (role === "user" || role === "assistant") &&
        (typeof message.content === "string" || isTextOnlyContent(message.content));
    return { role, text, compressible };
}
function normalizeRole(role) {
    const value = String(role ?? "").toLowerCase();
    if (value.startsWith("assistant"))
        return "assistant";
    if (value === "toolresult" || value === "tool" || value === "function")
        return "tool";
    if (value.startsWith("system"))
        return "system";
    if (value === "user")
        return "user";
    return "other";
}
function messageText(message) {
    if (typeof message.content === "string")
        return message.content;
    if (Array.isArray(message.content)) {
        return message.content.map(contentBlockText).filter(Boolean).join("\n");
    }
    if (typeof message.summary === "string")
        return message.summary;
    if (typeof message.output === "string")
        return message.output;
    return "";
}
function contentBlockText(block) {
    if (typeof block === "string")
        return block;
    if (!block || typeof block !== "object")
        return "";
    const value = block;
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
}
function isTextOnlyContent(content) {
    return (Array.isArray(content) &&
        content.length > 0 &&
        content.every((block) => {
            if (!block || typeof block !== "object")
                return false;
            return block.type === "text";
        }));
}
function compressMessageContent(message, text) {
    if (typeof message.content === "string")
        return { ...message, content: text };
    if (!Array.isArray(message.content))
        return { ...message, content: text };
    const firstText = message.content.find((block) => Boolean(block) &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string");
    const replacement = {
        type: "text",
        text,
    };
    if (firstText?.textSignature)
        replacement.textSignature = firstText.textSignature;
    return { ...message, content: [replacement] };
}
function expandHome(file) {
    if (file === "~")
        return os.homedir();
    if (file.startsWith("~/"))
        return pathMod.join(os.homedir(), file.slice(2));
    return file;
}
