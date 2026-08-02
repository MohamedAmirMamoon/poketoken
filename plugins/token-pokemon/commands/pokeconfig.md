---
description: View and tune your token-pokemon settings
argument-hint: "[show | set <key> <value> | rate <spec> | gens <spec> | preset <name> | reset [key] | simulate [tokens] [turns] | path | help]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config-cli.js" -- '$ARGUMENTS'`

The config report above is the complete answer to the user's request. Relay nothing further unless they asked a specific question about it — do not summarize, re-format, or comment on the numbers.
