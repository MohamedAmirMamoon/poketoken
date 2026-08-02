'use strict';

/**
 * Generation filtering for the catch pool.
 *
 * The dex spans generations 1-9. Users who only care about, say, Kanto can set
 * `gens` in config.json and every roll draws from that slice instead. Filtering
 * is OFF by default: the default value is every generation the dex contains.
 *
 * Spec grammar accepted by parseGenSpec (whitespace is insignificant, the
 * literal `gen` prefix is optional and case-insensitive):
 *
 *   all | *          every generation in the dex
 *   3                a single generation
 *   1-5              an inclusive range
 *   1,3,5            a list
 *   1-3,7-9          any mix of ranges and singles
 *   gen1-gen5        `gen` prefixes are ignored
 *   -6               EXCLUSION: everything except gen 6
 *   all,-6,-8        exclusions applied after inclusions
 *   1-9,-6-8         exclusion ranges
 *
 * Disambiguation rule for the leading minus: a comma-separated token whose
 * FIRST character is `-` (or `!` / `^`) is an exclusion; a `-` anywhere else in
 * the token is a range separator. So `-6` excludes gen 6 while `1-6` includes
 * gens 1 through 6, with no ambiguity. If a spec contains only exclusions the
 * base set is every generation in the dex.
 */

const DEX_MIN_GEN = 1;
const DEX_MAX_GEN = 9;

/** Every generation actually present in a dex list, sorted ascending. */
function allGens(pokemon) {
  if (!Array.isArray(pokemon) || pokemon.length === 0) {
    const out = [];
    for (let g = DEX_MIN_GEN; g <= DEX_MAX_GEN; g++) out.push(g);
    return out;
  }
  const seen = new Set();
  for (const p of pokemon) {
    if (p && typeof p.gen === 'number' && isFinite(p.gen)) seen.add(p.gen);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function fail(msg) {
  const err = new Error(msg);
  err.code = 'BAD_GEN_SPEC';
  throw err;
}

function intOrFail(text, token) {
  if (!/^\d+$/.test(text)) fail(`"${token}" is not a generation number`);
  const n = Number(text);
  if (n < DEX_MIN_GEN || n > DEX_MAX_GEN) {
    fail(`generation ${n} is out of range (${DEX_MIN_GEN}-${DEX_MAX_GEN})`);
  }
  return n;
}

/**
 * Parses a generation spec into a normalized, sorted, de-duplicated int array.
 * Throws an Error (code BAD_GEN_SPEC) with a user-readable message on anything
 * malformed, so callers can print it verbatim.
 *
 * @param {string} spec
 * @param {number[]} [universe] generations available (defaults to 1-9)
 * @returns {number[]}
 */
function parseGenSpec(spec, universe) {
  const all = Array.isArray(universe) && universe.length
    ? universe.slice().sort((a, b) => a - b)
    : allGens(null);

  if (typeof spec !== 'string') fail('expected a generation spec string');
  const cleaned = spec.toLowerCase().replace(/\s+/g, '').replace(/,+$/, '');
  if (cleaned === '') fail('empty generation spec');

  const include = new Set();
  const exclude = new Set();
  let sawInclude = false;

  for (const rawToken of cleaned.split(',')) {
    if (rawToken === '') fail('empty item in generation spec (stray comma?)');

    let token = rawToken;
    let negate = false;
    if (token[0] === '-' || token[0] === '!' || token[0] === '^') {
      negate = true;
      token = token.slice(1);
      if (token === '') fail(`"${rawToken}" is missing a generation to exclude`);
    }

    const target = negate ? exclude : include;
    if (!negate) sawInclude = true;

    if (token === 'all' || token === '*') {
      if (negate) fail('cannot exclude "all" - that leaves no generations');
      for (const g of all) target.add(g);
      continue;
    }

    // Range: strip optional `gen` prefixes then split on the separator.
    const bare = token.replace(/gen/g, '');
    if (bare === '') fail(`"${rawToken}" has no generation number`);

    if (bare.indexOf('-') !== -1) {
      const parts = bare.split('-');
      if (parts.length !== 2) fail(`"${rawToken}" is not a valid range`);
      const lo = intOrFail(parts[0], rawToken);
      const hi = intOrFail(parts[1], rawToken);
      if (lo > hi) fail(`range "${rawToken}" runs backwards (write ${hi}-${lo})`);
      for (let g = lo; g <= hi; g++) target.add(g);
    } else {
      target.add(intOrFail(bare, rawToken));
    }
  }

  // Exclusion-only specs like "-6" mean "everything but gen 6".
  if (!sawInclude) for (const g of all) include.add(g);

  const result = Array.from(include)
    .filter((g) => !exclude.has(g))
    .filter((g) => all.indexOf(g) !== -1)
    .sort((a, b) => a - b);

  if (result.length === 0) fail(`"${spec}" leaves no generations selected`);
  return result;
}

/** Collapses a sorted int array back into the shortest readable spec. */
function formatGenSpec(gens, universe) {
  if (!Array.isArray(gens) || gens.length === 0) return 'none';
  const all = Array.isArray(universe) && universe.length ? universe : allGens(null);
  const sorted = Array.from(new Set(gens)).sort((a, b) => a - b);
  if (sorted.length === all.length && sorted.every((g, i) => g === all[i])) return 'all';

  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? String(start) : `${start}-${prev}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(',');
}

/** True when `gens` is a usable list of generation numbers. */
function isGenList(v) {
  return Array.isArray(v) && v.length > 0
    && v.every((g) => typeof g === 'number' && isFinite(g) && g >= DEX_MIN_GEN && g <= DEX_MAX_GEN);
}

/**
 * The species a roll may draw from, honouring config.gens.
 *
 * Never returns an empty array for a non-empty dex: a nonsensical filter falls
 * back to the whole dex rather than silently voiding every won roll.
 *
 * @param {Array} pokemon dex entries [{id,name,gen,tier}]
 * @param {object} [config] anything with an optional `gens` array
 * @returns {Array}
 */
function activePool(pokemon, config) {
  if (!Array.isArray(pokemon) || pokemon.length === 0) return [];
  const gens = config && config.gens;
  if (!isGenList(gens)) return pokemon;
  const wanted = new Set(gens.map(Number));
  const pool = pokemon.filter((p) => wanted.has(p.gen));
  return pool.length ? pool : pokemon;
}

/** Species count per generation for a pool, as {gen: count}. */
function countByGen(pokemon) {
  const out = {};
  for (const p of pokemon) out[p.gen] = (out[p.gen] || 0) + 1;
  return out;
}

module.exports = {
  allGens,
  parseGenSpec,
  formatGenSpec,
  isGenList,
  activePool,
  countByGen,
  DEX_MIN_GEN,
  DEX_MAX_GEN,
};
