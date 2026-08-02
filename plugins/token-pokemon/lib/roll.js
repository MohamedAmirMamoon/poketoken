'use strict';

const crypto = require('crypto');

const TIER_ORDER = ['common', 'rare', 'legendary', 'mythical'];

/** Uniform float in [0,1) from a CSPRNG, so odds aren't skewed by Math.random bias. */
function randomFloat() {
  // 2^53-safe: 6 bytes gives 48 bits of entropy, plenty for percentile rolls.
  const buf = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + buf[i];
  return n / 281474976710656; // 256^6
}

/** Catch chance for a turn: rate * tokens, clamped to [0, maxChance]. */
function chanceFor(tokens, config) {
  const t = typeof tokens === 'number' && isFinite(tokens) && tokens > 0 ? tokens : 0;
  return Math.max(0, Math.min(config.maxChance, t * config.ratePerToken));
}

/** Picks a tier by relative weight. Returns null if no tier has weight. */
function pickTier(weights, rnd) {
  const total = TIER_ORDER.reduce((sum, t) => sum + (weights[t] || 0), 0);
  if (total <= 0) return null;
  let target = rnd * total;
  for (const tier of TIER_ORDER) {
    target -= weights[tier] || 0;
    if (target < 0) return tier;
  }
  return TIER_ORDER[TIER_ORDER.length - 1];
}

/**
 * Rolls for a catch.
 *
 * @param {number} tokens  tokens spent this turn
 * @param {object} config  from lib/config.js
 * @param {Array}  pokemon dex entries [{id,name,gen,tier}]
 * @param {function} [rng] injectable [0,1) source, for deterministic tests
 * @returns {{caught:boolean, chance:number, roll:number, tokens:number, pokemon?:object, tier?:string, shiny?:boolean}}
 */
function roll(tokens, config, pokemon, rng) {
  const rnd = rng || randomFloat;
  const chance = chanceFor(tokens, config);
  const value = rnd();

  const result = { caught: false, chance, roll: value, tokens: tokens || 0 };
  if (value >= chance) return result;

  const tier = pickTier(config.tierWeights, rnd());
  if (!tier) return result;

  // Fall back through tiers so an empty tier never silently voids a won roll.
  let pool = pokemon.filter((p) => p.tier === tier);
  let chosenTier = tier;
  if (pool.length === 0) {
    for (const alt of TIER_ORDER) {
      const altPool = pokemon.filter((p) => p.tier === alt);
      if (altPool.length) { pool = altPool; chosenTier = alt; break; }
    }
  }
  if (pool.length === 0) return result;

  result.caught = true;
  result.tier = chosenTier;
  result.pokemon = pool[Math.floor(rnd() * pool.length) % pool.length];

  // An independent roll on top of the catch, so a shiny is rare in its own right
  // rather than just riding a rare tier. Drawn last so the species choice above
  // stays bit-for-bit identical to what it was before shinies existed.
  const shinyChance = typeof config.shinyChance === 'number' && isFinite(config.shinyChance)
    ? Math.max(0, Math.min(1, config.shinyChance))
    : 0;
  result.shiny = shinyChance > 0 && rnd() < shinyChance;
  return result;
}

module.exports = { roll, chanceFor, pickTier, randomFloat, TIER_ORDER };
