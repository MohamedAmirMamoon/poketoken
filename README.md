# poke-token

Catch Pokémon by working. Every time Claude Code finishes a turn, this plugin rolls for a
wild encounter and the odds scale with how many tokens that turn burned. A one-line
answer is almost certainly nothing. A long refactor across a dozen files is a real shot at
something good.

All 1,025 species, Generations 1 through 9, every legendary and mythical included.

<p align="center">
  <img src="docs/showcase/catch-legendary.svg" alt="A LEGENDARY encounter: Rayquaza, drawn in colour above its catch banner" width="440">
</p>

About 1 catch in 128 comes out **shiny** : the alternate colouring, which takes the
headline over the tier because at those odds it's the rarer half of the event:

<p align="center">
  <img src="docs/showcase/catch-shiny.svg" alt="A shiny Machamp catch banner, drawn in its alternate green colouring" width="440">
</p>

A shiny is a recolour of the same pixels : the ordinary steel-grey Machamp beside the shiny
green one, identical down to the last pixel but the palette:

<p align="center">
  <img src="docs/showcase/shiny-compare.svg" alt="Machamp in its ordinary grey colours beside the shiny green version" width="620">
</p>

There are 1,025 of them waiting:

<p align="center">
  <img src="docs/showcase/species-wall.svg" alt="A wall of Pokémon sprites spanning all nine generations, drawn in colour" width="880">
</p>

> The images above are SVGs generated from the exact same baked sprite data the plugin
> renders from, so they can't drift from what you'll actually catch. In your terminal it's
> live text, not an image.

## Install

```
/plugin marketplace add MohamedAmirMamoon/poketoken
/plugin install poke-token@claude-pokemon
```

No configuration required. You need `node` on your `PATH` (16 or newer); there are no
dependencies, no network access at runtime, and no build step. The art defaults to block
glyphs that draw on any terminal.

## How the odds work

Each turn, the plugin sums the tokens billed for that turn and turns the total into a catch
chance : 1% per 5,000 tokens, capped at 75%. Cache *reads* are excluded, since they balloon
to six figures in a long conversation and would make every turn a guaranteed catch.

| Turn size | Chance |
|---|---|
| 500 tokens (quick question) | 0.1% |
| 5,000 tokens (normal edit) | 1% |
| 40,000 tokens (heavy session) | 8% |
| 375,000+ tokens | 75% (capped) |

Win the roll and a second roll picks the tier : Common 78%, Rare 19%, Legendary 2.7%,
Mythical 0.3% : then a species uniformly within it. So a mythical is roughly 1 in 333
catches, and catches themselves are uncommon. Arceus is meant to be a story, not a Tuesday.

Misses are silent. Shinies are a last independent roll, 1 in 128 on any species at any
tier, so they change nothing about which Pokémon you catch.

## Commands

| Command | Shows |
|---|---|
| `/pokedex` | Collection summary: totals, completion, rarity and generation breakdowns, hall of fame, recent catches |
| `/pokedex pikachu` | One species: sprite, generation, rarity, and your catch history (`#25` works too) |
| `/pokedex gen3` | Everything caught from one generation (`gen1`–`gen9`) |
| `/pokedex legendary` | One rarity tier (`common`, `rare`, `legendary`, `mythical`) |
| `/pokedex missing` | What you still need, grouped by generation |
| `/pokedex odds` | Your configured rates and lifetime tokens-per-catch |
| `/pokeconfig` | Current settings, and a menu to change them |

Every card is headed by a rule that encodes its rarity, so you can read what you're looking
at before you reach the `Rarity` line. Commons and rares are stone; legendaries and
mythicals are sky:

<p align="center">
  <img src="docs/showcase/rarity-rules.svg" alt="The header rule for each rarity tier, from a plain common line up to a starry mythical and shiny one" width="440">
</p>

## Tuning

Optional, and easiest through `/pokeconfig`, which validates what you give it and writes
only the keys you actually changed:

```
/pokeconfig rate 1% per 2000 tokens      # set the catch rate
/pokeconfig gens 1-3,7-9                 # limit the catch pool
/pokeconfig set spriteMode color         # truecolour art, if your terminal does it
/pokeconfig preset kanto                 # default, hardcore, casual, kanto, classic,
                                         # modern, no-legendaries, shiny-hunt, no-shinies
/pokeconfig simulate 8000 20000          # project your settings before committing
/pokeconfig reset [key]                  # undo one key, or the whole file
```

Settable keys: `ratePerToken`, `maxChance`, `tierWeights.*`, `gens`, `showMisses`,
`sprites`, `spriteWidth`, `spriteMode`, `shinyChance`, `enabled`. A bare `/pokeconfig`
lists them all with their current values and what each one does. Any malformed value
silently falls back to its default, and changes apply on the next turn.

## Your data

Two files under `~/.claude/poke-token/` (or `$CLAUDE_CONFIG_DIR`, if you've set one):
`collection.json` holds every catch plus lifetime totals, and `config.json` holds only the
settings you changed. Both are plain JSON — back them up, sync them, or hand-edit them.
`/pokeconfig path` prints the resolved locations.

To start over, delete `collection.json`. To pause, `/pokeconfig set enabled false`.
Uninstalling leaves both files where they are.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing ever happens | Usually just the odds. Confirm the wiring with `node hooks/pull.js --dry-run 400000`, check `node --version` resolves, then set `POKE_TOKEN_DEBUG=1` for the real error |
| Escape codes instead of art | `/pokeconfig set spriteMode plain` |
| Art too wide, or blocky | `/pokeconfig set spriteWidth 32` |
| Commands not found | The plugin isn't installed or is disabled — check `/plugin` |
| A catch missed on an expensive turn | Cache *reads* don't count toward the roll, only fresh input, cache writes, and output |

Every failure path in the hook is silent by design — it exits 0 no matter what, because a
gacha toy is not allowed to interrupt real work. `POKE_TOKEN_DEBUG=1` is the one way to make
it talk.

## Design notes

**It cannot break your session.** The hook wraps everything in try/catch and always exits
0. Malformed stdin, a missing transcript, a corrupt collection — all exit silently.

**The art defaults to escape-free, without defaulting to coarse.** Slash command output
reaches the model with ESC bytes stripped, so truecolour art would arrive as literal
`[38;2;...m` noise and `/pokedex` couldn't relay it. Plain mode spends no escapes: the
silhouette rides on the space/non-space boundary, the ramp `█▓▒░` carries depth, and each
cell is sampled as a 2×2 grid drawn with the matching quadrant glyph (`▘▝▀▖▌▞▛▗▚▐▜▄▙▟`) —
which puts edges on half-cell boundaries and quadruples the effective resolution at the
same column footprint.

**Shinies cost almost nothing to ship.** A shiny is a pure recolour for 986 of the 1,025
species, so `data/sprites/shiny/` stores a replacement palette and reuses the normal pixels
— 396 bytes each instead of a duplicate sprite. The other 39 crop differently and ship a
standalone payload.

**Concurrency-safe and bounded.** Multiple sessions finishing at once go through an advisory
lockfile and an atomic rename, and a lock is only reclaimed when provably abandoned.
Per-catch history caps at 20,000 rows so the critical section can't grow without limit;
lifetime totals stay exact regardless.

**Token counting is transcript-aware.** Records are deduped by message ID (Claude Code
writes one per content block, each repeating that message's cumulative usage, so naive
summing inflates counts ~3×), subagent messages are excluded, and interrupts are recognized
rather than mistaken for new prompts.

## Development

Everything runs from `plugins/poke-token/`, with no dev dependencies and no test framework:

```
npm test                                 # 308 tests across 8 suites
node hooks/pull.js --dry-run 40000       # simulate a 40k-token turn
node hooks/pull.js --sprite 25           # preview one sprite
npm run build:dex                        # regenerate data/dex.json from PokeAPI
npm run build:sprites                    # regenerate data/sprites/ from PokeAPI artwork
npm run build:shiny                      # regenerate data/sprites/shiny/ (needs sprites first)
npm run build:showcase                   # regenerate docs/showcase/*.svg (the README art)
```

Only the first three build scripts touch the network. Tests write only to `os.tmpdir()` via
`CLAUDE_CONFIG_DIR`, so the suite never touches your real collection.

The repo is a marketplace containing one plugin: `.claude-plugin/marketplace.json` lists
`plugins/poke-token/`, which holds the Stop hook (`hooks/pull.js`), the two commands and the
scripts behind them, `lib/` (config, store, roll, render, sprite, transcript), the baked
`data/`, and one test suite per concern.

## License

MIT
