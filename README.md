# Context Squeeze

A deterministic, token-reducing context engine for OpenClaw.

Context Squeeze keeps the most recent messages verbatim and compresses older prose before each model call. The compressed view is the message array OpenClaw sends, so old history is replaced rather than injected a second time. On-disk transcripts are unchanged.

## How it works

- **Hot zone** — up to the last N messages stay byte-verbatim.
- **Cold zone** — older user/assistant prose is reduced with priority-weighted sentence extraction.
- **Anchors** — paths, commands, addresses, ticket ids, numbers, and similar facts are collected into a compact `[anchors: …]` list. Anchors are best-effort: they are clipped when the selected budget cannot hold them.
- **Hard budget** — the engine uses the host's `tokenBudget`, plus an optional `targetTokenBudget` cap. If compression alone cannot fit, the oldest compressible cold messages are omitted from the prompt. The transcript is never rewritten.
- **Preserved messages** — system instructions, tool results, images, tool calls, and custom/structured messages are passed through unchanged.
- **No AI calls** — deterministic and local.

The engine delegates `/compact` and overflow-recovery compaction to OpenClaw's built-in runtime compaction (`ownsCompaction: false`). Its own job is per-request assembly.

## Requirements

- OpenClaw `>=2026.11.1`
- Node `>=24.16.0`
- An agent runtime that supports `assemble-before-prompt` (the native embedded runtime does; generic CLI backends do not)

## Install

```bash
openclaw plugins install clawhub:context-squeeze
```

Select the engine slot and enable the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "context-squeeze"
    },
    "entries": {
      "context-squeeze": {
        "enabled": true,
        "config": {
          "keepRecentTurns": 6,
          "compressionRatio": 0.3,
          "minTurnsBeforeCompression": 10
        }
      }
    }
  }
}
```

Restart the Gateway after changing the slot.

## Config

| Key | Default | Meaning |
|---|---|---|
| `keepRecentTurns` | 6 | Most recent messages kept verbatim (1–200) |
| `compressionRatio` | 0.3 | Cold-zone target as a fraction of original size (0.05–0.95) |
| `minTurnsBeforeCompression` | 10 | Histories shorter than this many messages are untouched (2–1000) |
| `targetTokenBudget` | 0 | Additional hard cap in tokens; 0 uses the host budget only |
| `anchorPreserve` | true | Collect exact paths/commands/numbers/tickets as anchors |
| `minMessageChars` | 400 | Cold messages shorter than this stay verbatim |
| `debugStatsFile` | `""` | Optional absolute path for append-only JSONL stats |

`keepRecentTurns` counts messages, not user/assistant exchanges.

If the original prompt already fits the available budget, the engine uses ratio mode and leaves the host's fixed overhead alone. A budget becomes a hard constraint when the input is over it: cold messages are compressed, then dropped oldest-first if necessary. The hot zone and protected messages can still exceed a cap that is smaller than they are; the stats report that as `overBudget`.

## Verify it

Use the dry-run tool:

```text
context-squeeze-stats  sample: "user: <long turn 1>\nassistant: <reply>..."
```

It reports the hot/compressed/dropped counts, chars before and after, anchor clipping, and whether the result is still over budget.

For live stats, set `debugStatsFile` to an absolute path. Each assembled turn appends a JSON line with the same counters; the file is truncated after 5 MiB.

## Limits

- Compression is sentence-level and deterministic. It is not a semantic summary and can drop nuance outside the anchor classes.
- Anchor preservation is best-effort under tight budgets.
- System/tool/structured messages are preserved, so a prompt dominated by those can remain over budget.
- The engine only changes the model-facing projection. Long-term session storage and `/compact` remain OpenClaw's responsibility.

MIT licensed. Runs entirely locally.
