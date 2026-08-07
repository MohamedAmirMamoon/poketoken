'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Root of the user's Claude config, honouring CLAUDE_CONFIG_DIR. */
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The plugin was called `token-pokemon` before, and its data directory was named
 * after it. A rename that just moved to the new name would orphan every existing
 * collection.json -- the catches would still be on disk, but /pokedex would report
 * an empty dex, which is indistinguishable from having lost them.
 *
 * So the old directory is adopted when it is there and the new one is not. This is
 * a read, not a migration: nothing is moved, copied or deleted, so there is no
 * window in which a collection exists in neither place. A fresh install has no old
 * directory and takes the new name; an upgrade keeps writing where it already was.
 */
const LEGACY_DIR_NAME = 'token-pokemon';

function dataDir() {
  const root = claudeDir();
  const current = path.join(root, 'poke-token');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(root, LEGACY_DIR_NAME);
  return fs.existsSync(legacy) ? legacy : current;
}

const COLLECTION_PATH = () => path.join(dataDir(), 'collection.json');
const CONFIG_PATH = () => path.join(dataDir(), 'config.json');

const DEFAULTS = {
  // Probability of a catch per token spent. 0.000002 = 0.0002%/token = 1% per 5k tokens.
  ratePerToken: 0.000002,
  // Hard ceiling on a single turn's catch chance, so huge turns stay a gamble.
  maxChance: 0.75,
  // Relative weights for picking a rarity tier once a catch is won.
  tierWeights: {
    common: 78,
    rare: 19,
    legendary: 2.7,
    mythical: 0.3,
  },
  // Print a dim line on misses too.
  showMisses: false,
  // Set false to pause pulling without uninstalling.
  enabled: true,
  // Draw the caught Pokemon as truecolour half-block art above the banner.
  sprites: true,
  // Terminal columns the sprite is drawn at -- the ceiling the fit walk works
  // down from, defaulting to the finest the format bakes (64). Lower it in
  // /pokeconfig for smaller art; the renderer never draws wider than this.
  spriteWidth: 64,
  // How sprite art is drawn:
  //   "color" - truecolour half-block art, and the default. The report reaches
  //             the terminal through the show.js systemMessage relay, which
  //             paints the escapes intact, so colour renders at full fidelity.
  //             renderSpriteFit draws each species as wide as the 10,000-char
  //             systemMessage cap allows, so it is the finest, highest-detail
  //             default; /pokeconfig can trade width down from here.
  //   "plain" - block glyphs only, no escape codes. The escape-free opt-out for
  //             anywhere the ESC bytes are stripped rather than painted, where
  //             colour art would show as literal `[38;2;...m` noise. Quadrant
  //             glyphs resolve the silhouette at half-cell precision, so the
  //             loss is the colour rather than the detail.
  spriteMode: 'color',
  // Chance a catch is the alternate-colour (shiny) variant. The games use
  // 1/4096, which at these catch rates would be a once-a-decade event; 1/128
  // keeps it a genuine surprise you might actually live to see.
  shinyChance: 0.0078125,
};

const MIN_SPRITE_WIDTH = 8;
const MAX_SPRITE_WIDTH = 64;
const SPRITE_MODES = ['color', 'plain'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function positiveNumber(v, fallback) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
}

function clampedInt(v, min, max, fallback) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Normalizes the sprite rendering mode, case-insensitively. Anything
 * unrecognised falls back to the default rather than disabling art: a typo in
 * one cosmetic field should not cost the user their sprites.
 */
function spriteMode(v) {
  if (typeof v !== 'string') return DEFAULTS.spriteMode;
  const mode = v.trim().toLowerCase();
  return SPRITE_MODES.includes(mode) ? mode : DEFAULTS.spriteMode;
}

/**
 * Normalizes a generation filter to a sorted list of positive integers, or null
 * when unset/malformed. null means "every generation", so a bad value widens the
 * pool rather than emptying it.
 */
function genList(v) {
  if (!Array.isArray(v)) return null;
  const clean = Array.from(new Set(
    v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 99)
  )).sort((a, b) => a - b);
  return clean.length ? clean : null;
}

/**
 * Reads ~/.claude/poke-token/config.json, falling back to DEFAULTS for any
 * missing or malformed field. Never throws: a broken config must not break a turn.
 */
function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    if (!isPlainObject(raw)) raw = {};
  } catch (_) {
    raw = {};
  }

  const weights = {};
  const rawWeights = isPlainObject(raw.tierWeights) ? raw.tierWeights : {};
  for (const tier of Object.keys(DEFAULTS.tierWeights)) {
    weights[tier] = positiveNumber(rawWeights[tier], DEFAULTS.tierWeights[tier]);
  }
  // All-zero weights would make tier selection undefined.
  if (Object.values(weights).every((w) => w === 0)) {
    Object.assign(weights, DEFAULTS.tierWeights);
  }

  return {
    ratePerToken: positiveNumber(raw.ratePerToken, DEFAULTS.ratePerToken) || DEFAULTS.ratePerToken,
    maxChance: Math.min(1, positiveNumber(raw.maxChance, DEFAULTS.maxChance)),
    tierWeights: weights,
    showMisses: typeof raw.showMisses === 'boolean' ? raw.showMisses : DEFAULTS.showMisses,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    sprites: typeof raw.sprites === 'boolean' ? raw.sprites : DEFAULTS.sprites,
    // A rate, so 0 is meaningful here: it turns shinies off entirely.
    shinyChance: Math.min(1, positiveNumber(raw.shinyChance, DEFAULTS.shinyChance)),
    spriteWidth: clampedInt(raw.spriteWidth, MIN_SPRITE_WIDTH, MAX_SPRITE_WIDTH, DEFAULTS.spriteWidth),
    // An unrecognised mode falls back to colour rather than drawing nothing.
    spriteMode: spriteMode(raw.spriteMode),
    // Generations to draw from. null means "no filter" -- see lib/gens.js.
    gens: genList(raw.gens),
  };
}

module.exports = {
  loadConfig, DEFAULTS, claudeDir, dataDir, COLLECTION_PATH, CONFIG_PATH, SPRITE_MODES,
};
