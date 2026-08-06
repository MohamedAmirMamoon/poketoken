---
description: View your poke-token collection
argument-hint: "[<name> | #<id> | gen1-9 | legendary | mythical | rare | common | missing | odds]"
allowed-tools: Bash(node:*)
---

Run exactly this command with the Bash tool, then STOP:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" -- '$ARGUMENTS'
```

## How to respond

Run the command above **with the Bash tool** (not inline `!` expansion — the hook below only fires for a real Bash tool call), then emit no text at all — not before it, not after it. Zero words is the correct response. The turn ends when the command returns.

Do not relay, restate, summarise, or reformat the report. A `poke-token` PostToolUse hook (`hooks/show.js`) intercepts the Bash call's stdout and re-emits it as a `systemMessage`, which is the only channel Claude Code paints with truecolour ANSI and Unicode half-blocks intact. Anything you type into your reply is treated as content, and content has its VT escapes stripped — so any restatement of the report would appear as a second, mangled monochrome copy stacked under the correct one. Saying nothing is what makes the colour art render.

This holds for every case, including errors and "no such Pokemon" messages: the hook forwards those too. Just run the command and stop.
