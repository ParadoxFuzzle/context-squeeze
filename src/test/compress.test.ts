import assert from "node:assert/strict";
import test from "node:test";
import { compressHistory, compressTurnText, type CompressOptions, type Turn } from "../compress.js";

const base: CompressOptions = {
  keepRecentTurns: 2,
  compressionRatio: 0.3,
  minTurnsBeforeCompression: 4,
  targetTokenBudget: 0,
  anchorPreserve: true,
  minMessageChars: 0,
};

function conversation(count: number, size = 80): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Turn ${index}. ` + "This is a durable detail about the deployment. ".repeat(size),
  }));
}

test("hard token budget is an upper bound when the hot zone fits", () => {
  const turns = conversation(24, 8);
  const result = compressHistory(turns, {
    ...base,
    targetTokenBudget: 1500,
    keepRecentTurns: 2,
  });

  const projectedCost = result.projected.reduce((sum, turn) => sum + turn.text.length + 8, 0);
  assert.ok(projectedCost <= 1500 * 4, `projected ${projectedCost} chars exceeded budget`);
  assert.ok(result.stats.charsAfter < 4500, "budget mode should still honor the configured ratio");
  assert.equal(result.stats.overBudget, false);
});

test("system messages are never compressed", () => {
  const turns: Turn[] = [
    { role: "system", text: "SYSTEM RULES: ".repeat(80) },
    ...conversation(12),
  ];
  const result = compressHistory(turns, base);

  assert.equal(result.projected[0].text, turns[0].text);
  assert.equal(result.projected[0].compressed, false);
});

test("short and structured turns stay verbatim", () => {
  const turns: Turn[] = [
    { role: "tool", text: "tool output ".repeat(100) },
    { role: "other", text: "custom structured message ".repeat(100) },
    ...conversation(12),
  ];
  const result = compressHistory(turns, base);

  assert.equal(result.projected[0].text, turns[0].text);
  assert.equal(result.projected[1].text, turns[1].text);
});

test("ratio mode never expands a message", () => {
  const turns = conversation(20, 20);
  const result = compressHistory(turns, { ...base, keepRecentTurns: 2, compressionRatio: 0.95 });
  for (const turn of result.projected) {
    assert.ok(turn.text.length <= turns[turn.originalIndex].text.length);
  }
});

test("anchor output is clipped to the requested character budget", () => {
  const text =
    "Deploy /srv/app/config.json with `npm run build --prod` on port 8080 for OPS-42. " +
    "More prose follows here and should be shortened.";
  const compressed = compressTurnText(text, 60, true);
  assert.ok(compressed.compressed.length <= 60);
  assert.ok(compressed.anchors > 0);
});

test("dropping cold messages still respects protected messages", () => {
  const turns: Turn[] = [
    { role: "system", text: "keep me " + "x".repeat(500) },
    ...conversation(16),
  ];
  const result = compressHistory(turns, {
    ...base,
    targetTokenBudget: 80,
    keepRecentTurns: 1,
  });

  assert.equal(result.projected[0].text, turns[0].text);
  assert.ok(result.stats.turnsDropped > 0);
  assert.equal(result.stats.overBudget, true);
});
