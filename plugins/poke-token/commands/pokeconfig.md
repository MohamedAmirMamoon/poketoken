---
description: View and tune your poke-token settings
argument-hint: "[set <key> <value> | rate <spec> | gens <spec> | preset <name> | reset [key] | simulate [tokens] [turns] | path | help]"
allowed-tools: Bash(node:*), AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config-cli.js" -- '$ARGUMENTS'`

## How to respond

The block above is the config CLI's output for whatever the user typed (`$ARGUMENTS`).

**If the user typed arguments** (`set`, `rate`, `gens`, `preset`, `reset`, `simulate`, `path`, `help`): relay that output verbatim in a fenced code block and stop. Nothing else.

**If the user typed NO arguments** (a bare `/pokeconfig`): do NOT relay the report. It is your data source, not user-facing text. Read the current value of every setting out of it and drive the menu below. Print no config text at all — the questions are the entire interface.

### Menu flow

Everything the user needs to see lives in the option labels and descriptions. Always show the CURRENT value of a setting in its description so they know what they are changing from.

**Question 1 — pick an area.** Header `Setting`. Four options. Put the live current values in each description, so all thirteen settings are visible at this step:

- **Catch odds** — describe with the current `ratePerToken` (as "1% per N tokens") and `maxChance`.
- **Catch pool** — describe with the current `gens` (and species count) and the four `tierWeights`.
- **Sprite art** — describe with the current `sprites`, `spriteWidth`, and `spriteMode`.
- **Shinies and misc** — describe with the current `shinyChance`, `enabled`, and `showMisses`.

**Question 2 — pick the setting.** Header `Setting`. List only the settings in the chosen area (each area has 2–4, so they all fit). Each label is the setting name; each description states its current value and what the setting does.

**Question 3 — pick the new value.** Header matching the setting. Offer up to 4 concrete values, chosen sensibly around the current one, and never re-offer the current value as an option. Suggested value sets:

- `ratePerToken` → use `rate 1%/1000`, `rate 1%/2500`, `rate 1%/5000`, `rate 1%/10000`
- `maxChance` → `set maxChance 25%`, `50%`, `75%`, `100%`
- `gens` → `gens all`, `gens 1`, `gens 1-3`, `gens 6-9`
- `tierWeights.*` → offer 0, and values above/below the current weight
- `sprites` → `set sprites true` / `set sprites false`
- `spriteWidth` → `set spriteWidth 12`, `16`, `24`, `32` (valid range is 8–64; `plain` mode caps at 32, above which it is already at full detail)
- `spriteMode` → `set spriteMode plain` / `set spriteMode color`
- `shinyChance` → `preset shiny-hunt` (1 in 16), `set shinyChance 0.781%` (1 in 128), `set shinyChance 0.1%`, `preset no-shinies`
- `enabled` → `set enabled true` / `set enabled false`
- `showMisses` → `set showMisses true` / `set showMisses false`

"Other" is always available for a free-form value; pass whatever the user types straight through to the CLI.

### Apply

Run the chosen command once:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/config-cli.js" -- '<subcommand and args>'`

Relay that confirmation verbatim in a fenced code block and stop. No commentary.

Never invent a setting, preset, or value that is not in the report above.
