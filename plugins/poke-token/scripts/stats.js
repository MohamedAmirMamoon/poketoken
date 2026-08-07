#!/usr/bin/env node
/**
 * Renders the Pokedex report for the /pokedex slash command.
 *
 *   node scripts/stats.js            full collection summary
 *   node scripts/stats.js gen3       filter to one generation
 *   node scripts/stats.js legendary  filter to one rarity tier
 *   node scripts/stats.js odds       lifetime rates and tuning
 *   node scripts/stats.js missing    what you still need, by generation
 */

'use strict';

const path = require('path');
const PLUGIN_ROOT = path.join(__dirname, '..');

const store = require(path.join(PLUGIN_ROOT, 'lib', 'store.js'));
const { loadConfig, CONFIG_PATH, COLLECTION_PATH } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const { commas, pct, rule, TIER_LABEL } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
const color = require(path.join(PLUGIN_ROOT, 'lib', 'color.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));
const { renderSpriteFit, renderSpritePlain } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));

const TIERS = ['common', 'rare', 'legendary', 'mythical'];
/** Generations present in the shipped dex, ascending. Derived so it never goes stale. */
const GENS = Array.from(new Set(dex.pokemon.map((p) => p.gen))).sort((a, b) => a - b);
const out = [];
const say = (s) => out.push(s === undefined ? '' : s);

/**
 * Zero-padded dex number, widened to the largest id in the dex so 4-digit
 * Gen 9 entries stay column-aligned with 3-digit Gen 1 ones.
 */
const ID_WIDTH = String(dex.count).length;
function dexId(id) {
  return `#${String(id).padStart(ID_WIDTH, '0')}`;
}

/** Tokens needed for a 1% chance, phrased safely for any configured rate. */
function tokensPerPercent(config) {
  const n = 1 / config.ratePerToken / 100;
  if (!isFinite(n) || n < 1) return 'under 1';
  return commas(n);
}

function bar(fraction, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function tally(list, key) {
  return list.reduce((acc, item) => {
    const k = item[key];
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function summary(data, config) {
  const catches = data.catches;
  const uniqueIds = new Set(catches.map((c) => c.id));

  say(`POKEDEX  (Gen ${GENS[0]}-${GENS[GENS.length - 1]}, ${commas(dex.count)} species)`);
  // The summary has no one species to describe, so it wears the rarest thing in
  // the collection: the header doubles as a trophy, and it changes as you climb.
  const best = TIERS.filter((t) => catches.some((c) => c.tier === t)).pop();
  say(rule(best, undefined, catches.some((c) => c.shiny)));

  if (catches.length === 0) {
    say();
    say('  No Pokemon caught yet.');
    say();
    say(`  Every ${tokensPerPercent(config)} tokens you spend buys about a 1% chance.`);
    say('  Keep working - they will come.');
    say();
    say(`  Turns so far: ${commas(data.stats.turns)}   Tokens: ${commas(data.stats.tokens)}`);
    return;
  }

  const byTier = tally(catches, 'tier');
  const uniqueByTier = {};
  for (const t of TIERS) {
    uniqueByTier[t] = new Set(catches.filter((c) => c.tier === t).map((c) => c.id)).size;
  }

  const shinies = catches.filter((c) => c.shiny);

  say();
  say(`  Caught ${commas(catches.length)} total - ${uniqueIds.size} unique species`);
  say(`  ${bar(uniqueIds.size / dex.count)} ${pct(uniqueIds.size / dex.count, 1)} complete`);
  if (shinies.length) {
    const uniqueShiny = new Set(shinies.map((c) => c.id)).size;
    say(`  ${commas(shinies.length)} SHINY - ${uniqueShiny} unique`);
  }
  say();

  say('  BY RARITY');
  for (const t of TIERS) {
    const available = dex.pokemon.filter((p) => p.tier === t).length;
    const got = uniqueByTier[t] || 0;
    const total = byTier[t] || 0;
    say(`    ${TIER_LABEL[t].padEnd(10)} ${String(got).padStart(3)}/${String(available).padEnd(3)} unique`
      + `  (${total} caught)`);
  }
  say();

  say('  BY GENERATION');
  for (const g of GENS) {
    const available = dex.pokemon.filter((p) => p.gen === g).length;
    const got = new Set(catches.filter((c) => c.gen === g).map((c) => c.id)).size;
    say(`    Gen ${g}  ${String(got).padStart(3)}/${String(available).padEnd(3)} ${bar(got / available, 16)}`);
  }
  say();

  // Shinies belong here regardless of tier: at 1/128 a shiny common is rarer
  // than the legendary sitting next to it.
  const notable = catches.filter((c) => c.tier === 'legendary' || c.tier === 'mythical' || c.shiny);
  if (notable.length) {
    say('  HALL OF FAME');
    const seen = new Set();
    for (const c of notable) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      say(`    ${dexId(c.id)} ${c.name.padEnd(12)} ${TIER_LABEL[c.tier].padEnd(10)} ${c.caughtAt.slice(0, 10)}`
        + `${c.shiny ? '  SHINY' : ''}`);
    }
    say();
  }

  say('  MOST RECENT');
  for (const c of catches.slice(-5).reverse()) {
    say(`    ${dexId(c.id)} ${c.name.padEnd(12)} Gen ${c.gen}  ${TIER_LABEL[c.tier].padEnd(10)}`
      + ` ${c.caughtAt.slice(0, 16).replace('T', ' ')}`);
  }
}

function filtered(data, { gen, tier }) {
  const catches = data.catches;
  const pool = dex.pokemon.filter((p) => (gen ? p.gen === gen : true) && (tier ? p.tier === tier : true));
  const owned = new Map();
  for (const c of catches) {
    if (gen && c.gen !== gen) continue;
    if (tier && c.tier !== tier) continue;
    owned.set(c.id, (owned.get(c.id) || 0) + 1);
  }

  const label = gen ? `GENERATION ${gen}` : TIER_LABEL[tier].toUpperCase();
  say(`POKEDEX - ${label}`);
  // A tier filter has a rarity to advertise; a generation filter spans all four.
  say(rule(tier));
  say();
  const frac = pool.length > 0 ? owned.size / pool.length : 0;
  say(`  ${owned.size}/${pool.length} unique  ${bar(frac)} ${pct(frac, 1)}`);
  say();

  const lines = [];
  for (const p of pool) {
    const count = owned.get(p.id) || 0;
    if (count > 0) {
      lines.push(`    ${dexId(p.id)} ${p.name.padEnd(13)} x${count}`);
    }
  }
  if (lines.length === 0) {
    say('    Nothing caught here yet.');
  } else {
    say('  CAUGHT');
    lines.forEach(say);
  }
}

// The most a single generation lists by name before collapsing the rest into a
// "+N more" tail. An empty collection is missing all ~1025 species; naming every
// one blows past the ~10KB systemMessage cap the report is relayed through (and
// a wall of 1025 names is unreadable anyway), so each gen shows a scannable
// slice and its true total. Four rows of six keeps every gen well within budget.
const MISSING_NAMES_PER_GEN = 24;

function missing(data) {
  const owned = new Set(data.catches.map((c) => c.id));
  say('POKEDEX - STILL MISSING');
  say(rule());
  for (const g of GENS) {
    const gaps = dex.pokemon.filter((p) => p.gen === g && !owned.has(p.id));
    say();
    say(`  Gen ${g} - ${gaps.length} missing`);
    // Keep the output readable: names in wrapped rows, capped per generation.
    const shown = gaps.slice(0, MISSING_NAMES_PER_GEN);
    for (let i = 0; i < shown.length; i += 6) {
      say('    ' + shown.slice(i, i + 6).map((p) => p.name.padEnd(13)).join(''));
    }
    if (gaps.length > shown.length) {
      say(`    ... and ${gaps.length - shown.length} more`);
    }
  }
}

function odds(data, config) {
  const s = data.stats;
  say('POKEDEX - ODDS');
  say(rule());
  say();
  say(`  Rate         ${(config.ratePerToken * 100).toFixed(6)}% per token`
    + `  (1% per ${tokensPerPercent(config)} tokens)`);
  say(`  Cap          ${pct(config.maxChance, 0)} max chance in one turn`);
  say(`  Tier weights ${TIERS.map((t) => `${t} ${config.tierWeights[t]}`).join(', ')}`);
  say();
  say('  LIFETIME');
  say(`    Turns        ${commas(s.turns)}`);
  say(`    Tokens       ${commas(s.tokens)}`);
  say(`    Catches      ${commas(s.pulls)}`);
  if (s.pulls > 0) {
    say(`    Tokens/catch ${commas(s.tokens / s.pulls)}`);
    say(`    Catch rate   ${pct(s.pulls / Math.max(1, s.turns), 1)} of turns`);
  } else if (s.tokens > 0) {
    say(`    Expected     ~1 catch per ${commas(1 / config.ratePerToken)} tokens`);
  }
  say();
  say(`  Tune by editing ${CONFIG_PATH()}`);
  say(`  Collection at   ${COLLECTION_PATH()}`);
}

function pokemonDetail(data, pokemon) {
  const config = loadConfig();
  const catches = data.catches.filter((c) => c.id === pokemon.id);
  const count = catches.length;
  const shinies = catches.filter((c) => c.shiny).length;

  // A text header on line 0, not the sprite. This view is re-emitted as a hook
  // systemMessage, and Claude Code prepends "PostToolUse:Bash says:" while eating
  // the leading newline -- so whatever is first lands beside that label. If that
  // is the sprite's top row, the art gets shunted sideways; a title line takes
  // the hit instead and names the entry while doing it.
  say(`POKEDEX  ${dexId(pokemon.id)}`);
  say();

  // The same switch the whole detail card rides on: a caught species (or an
  // explicit "color" mode) is drawn in colour, and everything else stays plain
  // and escape-free for hosts that strip SGR from captured stdout. sprites:false
  // is the user's blanket "no escapes" switch, so it forces the card fully plain
  // -- the rarity label below shares this flag, so it never colours when the art
  // would not, and never leaks an escape when sprites are off.
  const colour = config.sprites !== false && (count > 0 || config.spriteMode === 'color');

  // Show the shiny art to anyone who has earned it: it is the whole point of
  // the reward, and a normal recolour would bury it.
  if (config.sprites !== false) {
    // The report is re-emitted as a systemMessage, capped at 10,000 characters.
    // Colour art is dense, so renderSpriteFit draws each species as wide as its
    // own character count allows under that cap rather than shrinking all of them
    // to the densest one's width; the configured spriteWidth caps it from above
    // for a narrow terminal. Plain art is escape-free and tiny, so it keeps the
    // configured width directly.
    //
    // A species you have not caught is drawn as a flat dark-grey silhouette -- the
    // Pokedex's "not yet registered" shadow -- so the full colours stay a reward
    // for actually catching it. Plain mode has no colour to withhold, so it shows
    // the shaded shape either way.
    const art = colour
      ? renderSpriteFit(pokemon.id, { maxWidth: config.spriteWidth, shiny: shinies > 0, silhouette: count === 0 })
      : renderSpritePlain(pokemon.id, { maxWidth: config.spriteWidth, shiny: shinies > 0 });
    if (art) {
      say(art);
      say();
    }
  }

  // Dex number, name, then the three metrics -- no header rule between them. The
  // rarity value is tinted with its tier accent (gold legendary, diamond
  // mythical, silver rare, grey common), bold for the two premium tiers, so the
  // rarity reads at a glance. In plain mode the label is left uncoloured so the
  // report stays escape-free.
  say(`${dexId(pokemon.id)} ${pokemon.name.toUpperCase()}${shinies > 0 ? '  * SHINY *' : ''}`);
  say();
  const notable = pokemon.tier === 'legendary' || pokemon.tier === 'mythical';
  const rarityValue = colour
    ? color.fg(color.accentFor(pokemon.tier, false), TIER_LABEL[pokemon.tier], { bold: notable })
    : TIER_LABEL[pokemon.tier];
  say(`  Generation   ${pokemon.gen}`);
  say(`  Rarity       ${rarityValue}`);
  say(`  Caught       ${count} time${count !== 1 ? 's' : ''}`);
  if (shinies > 0) say(`  Shiny        ${shinies} of those`);
  if (count > 0) {
    say();
    say('  CATCH HISTORY');
    for (const c of catches.slice(-10).reverse()) {
      say(`    ${c.caughtAt.slice(0, 16).replace('T', ' ')}  ${commas(c.tokens)} tokens`
        + `${c.shiny ? '  SHINY' : ''}`);
    }
    if (catches.length > 10) say(`    ... and ${catches.length - 10} more`);
  } else {
    say();
    say('  Not yet caught. Keep coding!');
  }
}

/**
 * The single filter argument, ignoring the `--` the slash command passes to keep
 * a leading-dash argument from being read as a flag.
 */
function readArg(argv) {
  const rest = argv[0] === '--' ? argv.slice(1) : argv;
  return String(rest[0] === undefined ? '' : rest[0]).toLowerCase().trim();
}

function main() {
  const arg = readArg(process.argv.slice(2));
  const data = store.read();
  const config = loadConfig();

  // A bare number is a generation, never a dex id: `/pokedex 3` has always meant
  // Gen 3. Species lookup by number uses the explicit `#25` form instead.
  const genMatch = /^gen\s*(\d+)$/.exec(arg) || /^(\d+)$/.exec(arg);
  if (genMatch && !GENS.includes(Number(genMatch[1]))) {
    process.stdout.write(`No generation ${genMatch[1]} in this dex (have ${GENS.join(', ')}).\n`);
    return;
  }

  // `#25` / `#025` addresses one species by dex id.
  const idMatch = /^#\s*(\d+)$/.exec(arg);
  const byId = idMatch ? dex.pokemon.find((p) => p.id === Number(idMatch[1])) : null;

  // Exact name first, then a unique prefix so `pikach` still resolves. An
  // ambiguous prefix (`gen` matches Gengar and Genesect) is NOT a species query
  // and falls through to the summary, same as any other unrecognised argument.
  let byName = null;
  if (!idMatch && arg) {
    byName = dex.pokemon.find((p) => p.name.toLowerCase() === arg) || null;
    if (!byName) {
      const prefixed = dex.pokemon.filter((p) => p.name.toLowerCase().startsWith(arg));
      if (prefixed.length === 1) byName = prefixed[0];
    }
  }

  if (arg === 'odds' || arg === 'stats') {
    odds(data, config);
  } else if (arg === 'missing') {
    missing(data);
  } else if (genMatch) {
    filtered(data, { gen: Number(genMatch[1]) });
  } else if (TIERS.includes(arg)) {
    filtered(data, { tier: arg });
  } else if (arg === 'legendaries') {
    filtered(data, { tier: 'legendary' });
  } else if (idMatch) {
    if (byId) {
      pokemonDetail(data, byId);
    } else {
      say(`No species #${idMatch[1]} in this dex (ids run 1-${dex.count}).`);
    }
  } else if (byName) {
    pokemonDetail(data, byName);
  } else {
    summary(data, config);
  }

  process.stdout.write(out.join('\n') + '\n');
}

try {
  main();
} catch (err) {
  process.stdout.write(`Could not read your Pokedex: ${err.message}\n`);
}
