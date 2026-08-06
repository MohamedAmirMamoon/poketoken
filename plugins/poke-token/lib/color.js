'use strict';

/**
 * Truecolour SGR helpers for the catch banner.
 *
 * The banner is emitted as a hook `systemMessage`, and Claude Code paints those
 * with 24-bit ANSI escapes and Unicode intact -- the same channel the sprite art
 * already relies on. So unlike the /pokedex reports, which share a stdout that
 * gets its escapes stripped, the banner can spend colour freely. This module is
 * the one place those escapes are spelled, so the render code reads as layout
 * rather than a wall of `\x1b[38;2;...m`.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

/**
 * Wraps `text` in a truecolour foreground and a reset, optionally bold or dim.
 *
 * Every call closes with a reset rather than leaving the colour open, so a line
 * built from several `fg` calls can never bleed its last colour into the newline
 * or the line beneath it.
 *
 * @param {[number,number,number]} rgb foreground colour
 * @param {string} text
 * @param {{bold?:boolean, dim?:boolean}} [opts]
 */
function fg(rgb, text, opts = {}) {
  const weight = opts.bold ? BOLD : opts.dim ? DIM : '';
  return `${weight}\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${RESET}`;
}

/** Dim, uncoloured text -- for the supporting stat lines and the footer hint. */
function dim(text) {
  return `${DIM}${text}${RESET}`;
}

/**
 * The standard Pokemon type-chart colours, as RGB triples. Ported verbatim from
 * the reference banner's TYPE_RGB so a Grass type here is the same green a player
 * sees everywhere else the chart is drawn.
 */
const TYPE_RGB = {
  normal: [168, 168, 120], fire: [240, 128, 48], water: [104, 144, 240],
  electric: [248, 208, 48], grass: [120, 200, 80], ice: [152, 216, 216],
  fighting: [192, 48, 40], poison: [160, 64, 160], ground: [224, 192, 104],
  flying: [168, 144, 240], psychic: [248, 88, 136], bug: [168, 184, 32],
  rock: [184, 160, 56], ghost: [112, 88, 152], dragon: [112, 56, 248],
  dark: [112, 88, 72], steel: [184, 184, 208], fairy: [238, 153, 172],
};

/** A type the dex has but this table does not falls back to a neutral grey. */
const TYPE_FALLBACK = [150, 150, 150];

/**
 * The rarity accent colours, worst-to-best, matching the user's brief: gold and
 * diamond for the top two tiers, and progressively duller colours below.
 *
 *   mythical  -- a light, cool cyan that reads as diamond/shimmer, the rarest look
 *   legendary -- gold
 *   rare      -- silver, a clear step down from gold
 *   common    -- muted grey, the understated "worst" colour
 *
 * These tint both the frame bar and the headline, so the whole card takes the
 * rarity's colour and a legendary reads as gold at a glance without the label.
 */
const RARITY_RGB = {
  mythical: [185, 242, 255],
  legendary: [246, 200, 60],
  rare: [170, 175, 185],
  common: [150, 150, 150],
};

/** A tier the config could invent but the dex never had lands on the common grey. */
const RARITY_FALLBACK = RARITY_RGB.common;

/**
 * A brighter, warmer gold than the legendary accent, kept distinct so a shiny
 * does not just look like another legendary. A shiny outranks its tier for the
 * accent for the same reason it outranks it for the headline.
 */
const SHINY_RGB = [255, 236, 140];

/** Gold for the NEW milestone marker, independent of the catch's rarity. */
const NEW_RGB = [246, 200, 60];

/** Which colour tints the frame and headline: shiny wins, else the tier. */
function accentFor(tier, shiny) {
  if (shiny) return SHINY_RGB;
  return Object.prototype.hasOwnProperty.call(RARITY_RGB, tier)
    ? RARITY_RGB[tier]
    : RARITY_FALLBACK;
}

/** The chart colour for a type name, case-insensitively, or the neutral grey. */
function typeColor(type) {
  const key = typeof type === 'string' ? type.toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TYPE_RGB, key) ? TYPE_RGB[key] : TYPE_FALLBACK;
}

module.exports = {
  RESET, BOLD, DIM,
  fg, dim,
  TYPE_RGB, RARITY_RGB, SHINY_RGB, NEW_RGB,
  accentFor, typeColor,
};
