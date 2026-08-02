---
description: View your token-pokemon collection
argument-hint: "[<name> | #<id> | gen1-9 | legendary | mythical | rare | common | missing | odds]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" -- '$ARGUMENTS'`

The Pokedex report above is the complete answer to the user's request. Relay nothing further unless they asked a specific question about it — do not summarize, re-format, or comment on the numbers.
