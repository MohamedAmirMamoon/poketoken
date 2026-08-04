---
description: View your poke-token collection
argument-hint: "[<name> | #<id> | gen1-9 | legendary | mythical | rare | common | missing | odds]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" -- '$ARGUMENTS'`

## How to respond

The block above is the Pokedex report for `$ARGUMENTS`. It was produced by a bash command, whose output is **not reliably visible to the user** in their terminal — so you must relay it rather than assume they can see it.

Reproduce the report's **text content** in your reply, inside a fenced code block, so the user actually sees it. Specifically:

- Include the informational lines verbatim: the `#NNNN NAME` header, the rule beneath it, and every `Label   value` line (Generation, Rarity, Caught, Shiny, catch history, totals, and any "Not yet caught"/progress messages).
- **The rule under the header encodes the rarity, so copy it exactly.** It is not always `====`: commons and rares draw stone (`-`, `.`, `o`, `O`) and legendaries, mythicals and shinies draw stars (`=`, `+`, `*`, `x`, `X`, `#`, `@`), brightest in the middle. It is plain ASCII and always 52 columns. Do not normalise it, re-pad it, or substitute a row of `=` for it — the exact characters are the information.
- **Relay the sprite art only if it is already escape-free.** With the default `spriteMode: plain` the art is drawn from block glyphs (shading `█▓▒░`, quadrants `▘▝▀▖▌▞▛▗▚▐▜▄▙▟`, and spaces) with no escape codes, and it repeats cleanly inside the code block — include it verbatim, preserving every space and every glyph, since the spaces carry the silhouette and the quadrants carry its edges. With `spriteMode: color` the art arrives as mangled ANSI fragments like `[38;2;82;98;41m▄▄`; omit it entirely in that case. Never attempt to redraw, simplify, or approximate the art yourself.
- Do not add commentary, analysis, or re-formatting beyond placing the text in a code block. No summarizing of the numbers, no congratulations, no suggestions.

If the report is an error or a "no such Pokemon" message, relay that message and nothing else.
