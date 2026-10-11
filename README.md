# Context Squeeze

Hot/cold context compression with **lossless anchors** for OpenClaw. Fewer tokens per turn, same facts.

Every turn your agent sends includes the whole conversation. On long sessions that's mostly old, redundant prose — but plain extractive summarization throws away exactly the details a future turn needs (file paths, commands, ports, ticket IDs). Context Squeeze compresses old turns while **preserving those facts verbatim** as compact anchor lists.

## How it works

- **Hot zone** — the last N turns stay byte-verbatim.
- **Cold zone** — older turns are compressed to ~30% with priority-weighted sentence extraction (decision markers, questions, anchor density — not just term frequency), then prefixed with an exact `[anchors: …]` list.
- **Per-request projection** — the `before_prompt_build` hook injects the compressed view; on-disk transcripts stay lossless.
- **No AI calls, fully deterministic** — free, fast, same output every time.
- **Token-budget mode** — set `targetTokenBudget` to squeeze the cold zone to a hard per-request budget instead of a fixed ratio.

## Install

```bash
openclaw plugins install clawhub:context-squeeze
```

Then in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "context-squeeze": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "keepRecentTurns": 6,
          "compressionRatio": 0.3,
          "minTurnsBeforeCompression": 8
        }
      }
    }
  }
}
```

## Config

| Key | Default | Meaning |
|---|---|---|
| `keepRecentTurns` | 6 | turns kept verbatim (hot zone) |
| `compressionRatio` | 0.3 | cold-zone target size (0.3 ≈ 30% of original) |
| `minTurnsBeforeCompression` | 8 | don't compress sessions shorter than this |
| `targetTokenBudget` | 0 | >0 = squeeze cold zone to fit this token budget |
| `anchorPreserve` | true | keep exact paths/commands/numbers/tickets in anchor lists |
| `minMessageChars` | 400 | messages shorter stay verbatim even if cold |
| `debugStatsFile` | "" | optional local file for per-turn compression stats |

## Verify it's working

Use the built-in dry-run tool:

```
context-squeeze-stats  sample: "user: <long turn 1>\nassistant: <reply>..."
```

Or check gateway logs for `context-squeeze: N cold turns compressed, X→Y chars (Z%), A anchors kept`.

## Measured result

On a 60-turn realistic ops transcript: **59,082 → 25,336 chars (56% saved ≈ 8.4K tokens/request)** with all anchor classes (paths, addresses, metrics, ticket refs) verified present in compressed output and the hot zone byte-identical.

MIT licensed. Runs entirely locally.
