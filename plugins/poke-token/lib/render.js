'use strict';

const TIER_LABEL = {
  common: 'Common',
  rare: 'Rare',
  legendary: 'LEGENDARY',
  mythical: 'MYTHICAL',
};

const TIER_ICON = {
  common: '*',
  rare: '**',
  legendary: '***',
  mythical: '****',
};

/** Width of every header rule, matching the report bodies drawn beneath them. */
const RULE_WIDTH = 52;

/**
 * The glyph ramps each rarity draws its header rule from, dimmest first.
 *
 * The vocabulary itself carries the tier. Commons and rares are stone -- dashes
 * with pebbles worn into them -- and legendaries and mythicals are sky, drawn
 * from the `+ * x #` marks that read as stars in a terminal. That split is what
 * makes a rare card recognisable at a glance, before the `Rarity` line is read.
 *
 * Everything is plain ASCII on purpose. The rule sits in the same captured
 * stdout as the sprite art, and a header that degrades to mojibake in a narrow
 * font would cost more than the decoration is worth.
 *
 * `spread` is how far from the centre the brightest band reaches, as a fraction
 * of the half-width, so rarity shows up as reach as well as vocabulary: a common
 * barely lifts off its baseline, a mythical is lit end to end.
 */
const TIER_RULE = {
  common: { ramp: ['-', '-', '.'], spread: 0.55 },
  rare: { ramp: ['-', '.', 'o', 'O'], spread: 0.8 },
  legendary: { ramp: ['=', '+', '*', 'x'], spread: 1 },
  mythical: { ramp: ['=', '+', '*', 'X', '#'], spread: 1 },
};

/**
 * The rule for a report with no single rarity to describe -- the collection
 * summary, the odds page, the config screen. Flat `=`, which is what every
 * header used before rarity had anything to say about it.
 */
const PLAIN_RULE = { ramp: ['='], spread: 1 };

/**
 * A shiny draws the top rule whatever its tier, for the same reason it takes the
 * banner headline: at 1 in 128 a shiny common is rarer than the legendary next to
 * it, and demoting it to a stone rule would bury the rarer of the two events.
 *
 * It is not the mythical rule reused -- `@` in place of `#` keeps the two
 * distinguishable, so a shiny mythical still reads as its own thing.
 */
const SHINY_RULE = { ramp: ['=', '+', '*', 'X', '@'], spread: 1 };

/**
 * Draws a header rule as a symmetric burst: brightest in the middle, falling off
 * through the ramp toward both ends.
 *
 * A flat run of one character was the same line on a Rattata as on Arceus. This
 * spends the same row on telling you which you are looking at, and stays a single
 * line of ASCII while doing it.
 *
 * An unknown tier falls back to the flat rule rather than throwing: the rule is
 * ornament, and a header must still be drawn.
 *
 * @param {string} [tier] tier name; anything unrecognised draws the flat rule
 * @param {number} [width] columns to fill; defaults to the report width
 * @param {boolean} [shiny] draw the shiny rule instead of the tier's own
 */
function rule(tier, width = RULE_WIDTH, shiny = false) {
  // Only a known tier name selects a ramp. Callers pass a tier straight out of a
  // catch record or a dex entry, so a null, a number, or a tier this version has
  // never heard of all have to land on the flat rule rather than throwing.
  const named = typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_RULE, tier)
    ? TIER_RULE[tier]
    : PLAIN_RULE;
  const spec = shiny ? SHINY_RULE : named;
  // A non-finite width would leave the loop bound NaN and silently return an
  // empty string, dropping the header line entirely; fall back to the default.
  const n = Number(width);
  const w = isFinite(n) ? Math.max(1, Math.floor(n)) : RULE_WIDTH;
  if (w === 1) return spec.ramp[spec.ramp.length - 1];

  const mid = (w - 1) / 2;
  let out = '';
  for (let i = 0; i < w; i++) {
    // 1 at the centre, 0 once the falloff has run out, so the ramp index rises
    // toward the middle from both directions.
    const heat = Math.max(0, (spec.spread - Math.abs(i - mid) / mid) / spec.spread);
    const slot = Math.floor(heat * spec.ramp.length);
    out += spec.ramp[slot < spec.ramp.length ? slot : spec.ramp.length - 1];
  }
  return out;
}

function pct(n, digits = 2) {
  return `${(n * 100).toFixed(digits)}%`;
}

function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad(id) {
  return String(id).padStart(3, '0');
}

/**
 * The banner appended after a turn that produced a catch.
 *
 * When `config.sprites` is on and the sprite bakes cleanly, the art is placed
 * above the text block; otherwise the text block is emitted unchanged.
 */
function renderCatch({ pokemon, tier, tokens, chance, roll, uniqueCount, totalCount, dexSize, isNew, config, sprite, shiny }) {
  const notable = tier === 'mythical' || tier === 'legendary';
  let head;
  if (shiny) {
    // A shiny outranks the tier headline: it is the rarer of the two events, and
    // burying it under "A LEGENDARY encounter" is how people miss it entirely.
    head = `${TIER_ICON[tier]} SHINY!! A shiny ${pokemon.name.toUpperCase()} appeared and was caught!`;
  } else if (notable) {
    head = `${TIER_ICON[tier]} A ${TIER_LABEL[tier]} encounter! ${pokemon.name.toUpperCase()} was caught!`;
  } else {
    head = `A wild ${pokemon.name.toUpperCase()} appeared and was caught!`;
  }

  let art = null;
  if (!config || config.sprites !== false) {
    try {
      // An explicit renderer from the caller wins; otherwise the configured mode
      // picks one, so the mode applies to the catch banner as well as /pokedex.
      // Only an explicit "color" opts out of plain: an absent mode means the
      // default, and colour art is unreadable wherever the escapes are stripped.
      const lib = require('./sprite.js');
      const render = sprite
        || (config && config.spriteMode === 'color' ? lib.renderSprite : lib.renderSpritePlain);
      art = render(pokemon.id, {
        maxWidth: config ? config.spriteWidth : undefined,
        shiny: !!shiny,
      }) || null;
    } catch (_) {
      // Art is decoration; a missing or broken sprite must not cost the banner.
      art = null;
    }
  }

  const dupe = isNew ? 'NEW' : 'dupe';
  const marks = [TIER_LABEL[tier]];
  if (shiny) marks.push('SHINY');
  marks.push(dupe);
  return [
    '',
    ...(art ? [art, ''] : []),
    `+-- ${head}`,
    `|   #${pad(pokemon.id)} - Gen ${pokemon.gen} - ${marks.join(' - ')}`,
    `|   ${commas(tokens)} tokens -> ${pct(chance)} chance -> rolled ${pct(roll)}`,
    `|   Pokedex: ${totalCount} caught - ${uniqueCount}/${dexSize} unique (${dexSize > 0 ? pct(uniqueCount / dexSize, 1) : '0.0%'})`,
    `+-- /pokedex to view your collection`,
  ].join('\n');
}

/** Optional one-liner for misses, when showMisses is enabled. */
function renderMiss({ tokens, chance, roll }) {
  return `[poke-token] ${commas(tokens)} tokens -> ${pct(chance)} chance, rolled ${pct(roll)} - no catch.`;
}

module.exports = {
  renderCatch,
  renderMiss,
  rule,
  TIER_LABEL,
  TIER_ICON,
  TIER_RULE,
  RULE_WIDTH,
  pct,
  commas,
  pad,
};
