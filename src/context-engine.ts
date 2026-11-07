// context-engine.ts — OpenClaw context-engine implementation.
//
// OpenClaw calls assemble() with the messages it intends to send. Returning a
// projected message array is what actually replaces old history; unlike the old
// before_prompt_build hook, this does not send the originals alongside a summary.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as pathMod from "node:path";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  compressHistory,
  estimateTokens,
  type CompressStats,
  type Turn,
  type TurnRole,
} from "./compress.js";
import type { ContextSqueezeConfig } from "./config.js";

type ContextEngineFactory = Parameters<OpenClawPluginApi["registerContextEngine"]>[1];
type ContextEngine = Awaited<ReturnType<ContextEngineFactory>>;

export interface EngineLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export interface DebugStats extends CompressStats {
  ts: string;
  sessionId: string | null;
  projectedMessages: number;
  estimatedTokens: number;
}

const MAX_COMMITTED_KEYS = 10_000;

export function createContextSqueezeEngine(
  config: ContextSqueezeConfig,
  logger: EngineLogger = {}
): ContextEngine {
  const committed = new Set<string>();

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
          unsupportedMessage:
            "Context Squeeze needs an agent runtime that calls assemble() before the prompt. Use the native embedded runtime or select the legacy context engine.",
        },
      },
    },

    async ingest() {
      // Stateless: the host already owns the transcript and passes the full
      // history to assemble(). There is no second copy to ingest.
      return { ingested: true };
    },

    async assemble(params) {
      const messages = params.messages as unknown as MessageLike[];
      if (messages.length === 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
          promptAuthority: "preassembly_may_overflow" as const,
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
          promptAuthority: "preassembly_may_overflow" as const,
        };
      }

      const out = projected.map((turn) => {
        const original = messages[turn.originalIndex];
        if (!turn.compressed) return original;
        return compressMessageContent(original, turn.text);
      });

      logger.debug?.(
        `context-squeeze: ${stats.turnsCompressed} compressed, ${stats.turnsDropped} dropped, ` +
          `${stats.charsBefore}→${stats.charsAfter} chars (${stats.savingsPct}%), ` +
          `${stats.anchorsKept} anchors kept, ${stats.anchorsClipped} clipped` +
          (stats.overBudget ? ", still over budget" : "")
      );

      const debugStats: DebugStats = {
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
        messages: out as unknown as typeof params.messages,
        estimatedTokens: debugStats.estimatedTokens,
        promptAuthority: "preassembly_may_overflow" as const,
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
      if (committed.has(advancementKey)) return { status: "duplicate" as const };
      committed.add(advancementKey);
      if (committed.size > MAX_COMMITTED_KEYS) {
        const oldest = committed.values().next().value;
        if (oldest !== undefined) committed.delete(oldest);
      }
      return { status: "committed" as const };
    },

    async dispose() {
      committed.clear();
    },
  };
}

export async function writeDebugStats(
  file: string,
  stats: DebugStats,
  logger: EngineLogger = {}
): Promise<void> {
  try {
    const target = expandHome(file);
    if (!pathMod.isAbsolute(target)) {
      logger.warn?.("context-squeeze: debugStatsFile must be an absolute path; not writing stats");
      return;
    }
    await fs.mkdir(pathMod.dirname(target), { recursive: true });
    try {
      const info = await fs.stat(target);
      if (info.size > 5 * 1024 * 1024) await fs.truncate(target, 0);
    } catch {
      // The file does not exist yet.
    }
    await fs.appendFile(target, `${JSON.stringify(stats)}\n`, "utf8");
  } catch {
    // Debug logging must never break a model turn.
  }
}

function toTurn(message: MessageLike): Turn {
  const role = normalizeRole(message.role);
  const text = messageText(message);
  const compressible =
    (role === "user" || role === "assistant") &&
    (typeof message.content === "string" || isTextOnlyContent(message.content));
  return { role, text, compressible };
}

function normalizeRole(role: unknown): TurnRole {
  const value = String(role ?? "").toLowerCase();
  if (value.startsWith("assistant")) return "assistant";
  if (value === "toolresult" || value === "tool" || value === "function") return "tool";
  if (value.startsWith("system")) return "system";
  if (value === "user") return "user";
  return "other";
}

function messageText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(contentBlockText).filter(Boolean).join("\n");
  }
  if (typeof message.summary === "string") return message.summary;
  if (typeof message.output === "string") return message.output;
  return "";
}

function contentBlockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const value = block as { type?: unknown; text?: unknown };
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function isTextOnlyContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => {
      if (!block || typeof block !== "object") return false;
      return (block as { type?: unknown }).type === "text";
    })
  );
}

function compressMessageContent(message: MessageLike, text: string): MessageLike {
  if (typeof message.content === "string") return { ...message, content: text };
  if (!Array.isArray(message.content)) return { ...message, content: text };

  const firstText = message.content.find(
    (block): block is { type: "text"; text: string; textSignature?: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
  );
  const replacement: { type: "text"; text: string; textSignature?: string } = {
    type: "text",
    text,
  };
  if (firstText?.textSignature) replacement.textSignature = firstText.textSignature;
  return { ...message, content: [replacement] };
}

function expandHome(file: string): string {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/")) return pathMod.join(os.homedir(), file.slice(2));
  return file;
}
