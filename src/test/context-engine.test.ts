import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../config.js";
import { createContextSqueezeEngine } from "../context-engine.js";

type AssembleParams = Parameters<
  Awaited<ReturnType<typeof createContextSqueezeEngine>>["assemble"]
>[0];

function params(messages: unknown[], tokenBudget = 1_000_000): AssembleParams {
  return { sessionId: "session-1", tokenBudget, messages } as unknown as AssembleParams;
}

test("assemble replaces compressed messages instead of adding a second copy", async () => {
  const engine = createContextSqueezeEngine(
    resolveConfig({
      keepRecentTurns: 2,
      minTurnsBeforeCompression: 4,
      minMessageChars: 20,
      compressionRatio: 0.3,
    })
  );
  const messages = [
    { role: "system", content: "system instructions ".repeat(30), timestamp: 1 },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content:
        index % 2 === 0
          ? "Please inspect /srv/app/config.json and ticket OPS-42. " + "Details. ".repeat(80)
          : [{ type: "text", text: "The deployment uses port 8080. " + "Analysis. ".repeat(80) }],
      timestamp: index + 2,
    })),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "tool output must survive" }],
      isError: false,
      timestamp: 20,
    },
    { role: "user", content: "What changed?", timestamp: 21 },
  ];

  const result = await engine.assemble(params(messages));
  assert.equal(result.messages[0].role, "system");
  assert.equal((result.messages[0] as { content: string }).content, messages[0].content);

  const tool = result.messages.find((message) => message.role === "toolResult");
  assert.deepEqual(tool, messages[messages.length - 2]);
  assert.equal(result.messages.length, messages.length);
  const compressed = result.messages.find((message) => (message as { timestamp?: number }).timestamp === 2) as {
    content: string;
  };
  assert.ok(compressed.content.length < (messages[1] as { content: string }).content.length);
  assert.match(compressed.content, /compressed/);
  assert.ok(result.estimatedTokens > 0);
});

test("commitTurn reports committed once and duplicate on retry", async () => {
  const engine = createContextSqueezeEngine(resolveConfig({}));
  const commit = engine.commitTurn as unknown as (params: {
    advancementKey: string;
  }) => Promise<{ status: string }>;

  assert.deepEqual(await commit({ advancementKey: "turn-1" }), { status: "committed" });
  assert.deepEqual(await commit({ advancementKey: "turn-1" }), { status: "duplicate" });
  await engine.dispose?.();
});

test("ingest is a stateless no-op", async () => {
  const engine = createContextSqueezeEngine(resolveConfig({}));
  assert.deepEqual(
    await engine.ingest({ sessionId: "s", message: { role: "user" } } as never),
    { ingested: true }
  );
});
