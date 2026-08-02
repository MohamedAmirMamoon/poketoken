#!/usr/bin/env node
/**
 * Test suite. No framework: run with `node tests/roll.test.js`.
 * Exits non-zero on the first failure.
 */

'use strict';

const path = require('path');
const assert = require('assert');
const PLUGIN_ROOT = path.join(__dirname, '..');

const { roll, chanceFor, pickTier, randomFloat } = require(path.join(PLUGIN_ROOT, 'lib', 'roll.js'));
const { DEFAULTS } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const { isUserPrompt, messageTokens } = require(path.join(PLUGIN_ROOT, 'lib', 'transcript.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
}

console.log('\ndex integrity');

// Canonical species counts per generation, used to prove the dex matches the games.
const CANONICAL_GEN_COUNTS = { 1: 151, 2: 100, 3: 135, 4: 107, 5: 156, 6: 72, 7: 88, 8: 96, 9: 120 };
const DEX_SIZE = dex.count;

test('count field matches the actual species list', () => {
  assert.strictEqual(dex.pokemon.length, DEX_SIZE);
});

test('every generation present has its canonical species count', () => {
  const gens = Array.from(new Set(dex.pokemon.map((p) => p.gen))).sort((a, b) => a - b);
  assert.ok(gens.length > 0, 'dex has no generations');
  for (const g of gens) {
    const actual = dex.pokemon.filter((p) => p.gen === g).length;
    assert.strictEqual(actual, CANONICAL_GEN_COUNTS[g], `gen ${g}: expected ${CANONICAL_GEN_COUNTS[g]}, got ${actual}`);
  }
  // The total must be exactly the sum of the generations it claims to cover.
  const expectedTotal = gens.reduce((sum, g) => sum + CANONICAL_GEN_COUNTS[g], 0);
  assert.strictEqual(DEX_SIZE, expectedTotal);
});

test('generations are contiguous starting at 1', () => {
  const gens = Array.from(new Set(dex.pokemon.map((p) => p.gen))).sort((a, b) => a - b);
  for (let i = 0; i < gens.length; i++) assert.strictEqual(gens[i], i + 1);
});

test('ids are contiguous 1..count', () => {
  const ids = dex.pokemon.map((p) => p.id).sort((a, b) => a - b);
  for (let i = 0; i < DEX_SIZE; i++) assert.strictEqual(ids[i], i + 1);
});

test('every entry has a valid tier', () => {
  const valid = new Set(['common', 'rare', 'legendary', 'mythical']);
  for (const p of dex.pokemon) assert.ok(valid.has(p.tier), `${p.name} has tier ${p.tier}`);
});

test('known legendaries and mythicals are tiered correctly', () => {
  const byName = new Map(dex.pokemon.map((p) => [p.name, p]));
  assert.strictEqual(byName.get('Mewtwo').tier, 'legendary');
  assert.strictEqual(byName.get('Rayquaza').tier, 'legendary');
  assert.strictEqual(byName.get('Kyurem').tier, 'legendary');
  assert.strictEqual(byName.get('Mew').tier, 'mythical');
  assert.strictEqual(byName.get('Arceus').tier, 'mythical');
  assert.strictEqual(byName.get('Genesect').tier, 'mythical');
  assert.strictEqual(byName.get('Rattata').tier, 'common');
});

test('later-generation legendaries and mythicals are tiered correctly', () => {
  const byName = new Map(dex.pokemon.map((p) => [p.name, p]));
  const expected = {
    Xerneas: 'legendary',
    Solgaleo: 'legendary',
    Zacian: 'legendary',
    Koraidon: 'legendary',
    Terapagos: 'legendary',
    Magearna: 'mythical',
    Zarude: 'mythical',
    Pecharunt: 'mythical',
  };
  for (const [name, tier] of Object.entries(expected)) {
    // Only assert for species this dex actually covers.
    if (byName.has(name)) assert.strictEqual(byName.get(name).tier, tier, `${name}`);
  }
});

test('starters across generations are not tiered common', () => {
  const byName = new Map(dex.pokemon.map((p) => [p.name, p]));
  for (const name of ['Bulbasaur', 'Chespin', 'Sprigatito', 'Rowlet', 'Grookey']) {
    if (byName.has(name)) {
      assert.notStrictEqual(byName.get(name).tier, 'common', `${name} should not be common`);
    }
  }
});

console.log('\nchance math');

test('chance scales linearly with tokens', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} !~ ${b}`);
  near(chanceFor(5000, DEFAULTS), 0.01);
  near(chanceFor(50000, DEFAULTS), 0.1);
  near(chanceFor(500, DEFAULTS), 0.001);
});

test('chance is capped', () => {
  assert.strictEqual(chanceFor(100000000, DEFAULTS), DEFAULTS.maxChance);
});

test('bad token inputs yield zero chance', () => {
  for (const bad of [0, -5, NaN, Infinity, null, undefined, 'abc']) {
    assert.strictEqual(chanceFor(bad, DEFAULTS), 0, `input ${bad}`);
  }
});

console.log('\nroll behaviour');

test('roll below chance catches, at or above misses', () => {
  const cfg = Object.assign({}, DEFAULTS, { ratePerToken: 0.0001 }); // 5000 tok -> 50%
  const hit = roll(5000, cfg, dex.pokemon, () => 0.1);
  assert.strictEqual(hit.caught, true);
  assert.ok(hit.pokemon && hit.pokemon.name);

  const miss = roll(5000, cfg, dex.pokemon, () => 0.9);
  assert.strictEqual(miss.caught, false);
  assert.strictEqual(miss.pokemon, undefined);
});

test('zero tokens can never catch', () => {
  const r = roll(0, DEFAULTS, dex.pokemon, () => 0);
  assert.strictEqual(r.caught, false);
});

test('caught pokemon always belongs to the reported tier', () => {
  for (let i = 0; i < 2000; i++) {
    const r = roll(1000000, DEFAULTS, dex.pokemon);
    if (r.caught) assert.strictEqual(r.pokemon.tier, r.tier);
  }
});

test('pickTier respects weights', () => {
  const w = { common: 1, rare: 0, legendary: 0, mythical: 0 };
  for (const v of [0, 0.3, 0.99]) assert.strictEqual(pickTier(w, v), 'common');
});

test('pickTier handles all-zero weights', () => {
  assert.strictEqual(pickTier({ common: 0, rare: 0, legendary: 0, mythical: 0 }, 0.5), null);
});

console.log('\nshiny rolls');

/** Always catches, so every roll exercises the shiny draw. */
const ALWAYS_CATCH = Object.assign({}, DEFAULTS, { ratePerToken: 1, maxChance: 1 });

test('shinyChance defaults to 1 in 128', () => {
  assert.strictEqual(DEFAULTS.shinyChance, 1 / 128);
});

test('a caught pokemon always reports shiny as a boolean', () => {
  for (let i = 0; i < 500; i++) {
    const r = roll(1, ALWAYS_CATCH, dex.pokemon);
    assert.strictEqual(typeof r.shiny, 'boolean', `shiny was ${JSON.stringify(r.shiny)}`);
  }
});

test('a miss carries no shiny flag at all', () => {
  const r = roll(5000, Object.assign({}, DEFAULTS, { shinyChance: 1 }), dex.pokemon, () => 0.99);
  assert.strictEqual(r.caught, false);
  assert.strictEqual(r.shiny, undefined, 'a miss claimed a shiny');
});

test('shinyChance 0 turns shinies off entirely', () => {
  const cfg = Object.assign({}, ALWAYS_CATCH, { shinyChance: 0 });
  for (let i = 0; i < 2000; i++) {
    assert.strictEqual(roll(1, cfg, dex.pokemon).shiny, false, 'a shiny slipped through at 0');
  }
});

test('shinyChance 1 makes every catch shiny', () => {
  const cfg = Object.assign({}, ALWAYS_CATCH, { shinyChance: 1 });
  for (let i = 0; i < 500; i++) {
    assert.strictEqual(roll(1, cfg, dex.pokemon).shiny, true, 'a normal slipped through at 1');
  }
});

test('a missing or malformed shinyChance is treated as off, never as a crash', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'lots', {}]) {
    const cfg = Object.assign({}, ALWAYS_CATCH, { shinyChance: bad });
    const r = roll(1, cfg, dex.pokemon);
    assert.strictEqual(r.caught, true, `input ${JSON.stringify(bad)} broke the catch`);
    assert.strictEqual(r.shiny, false, `input ${JSON.stringify(bad)} produced ${r.shiny}`);
  }
});

test('out-of-range shinyChance is clamped rather than trusted', () => {
  // A hand-edited config could hold either; neither may skew the draw.
  assert.strictEqual(roll(1, Object.assign({}, ALWAYS_CATCH, { shinyChance: 5 }), dex.pokemon).shiny, true);
  assert.strictEqual(roll(1, Object.assign({}, ALWAYS_CATCH, { shinyChance: -3 }), dex.pokemon).shiny, false);
});

test('the shiny draw is last, so species selection is unchanged by it', () => {
  // Same rng sequence, different shinyChance: the species and tier must match
  // exactly. Otherwise adding shinies would have silently reshuffled the odds of
  // every existing collection.
  const scripted = (values) => {
    let i = 0;
    return () => values[i++ % values.length];
  };
  for (const seed of [[0, 0.1, 0.2], [0, 0.5, 0.9], [0, 0.995, 0.4], [0, 0.75, 0.63]]) {
    const off = roll(5000, Object.assign({}, ALWAYS_CATCH, { shinyChance: 0 }), dex.pokemon, scripted(seed));
    const on = roll(5000, Object.assign({}, ALWAYS_CATCH, { shinyChance: 1 }), dex.pokemon, scripted(seed));
    assert.strictEqual(on.tier, off.tier, `tier differs for ${seed}`);
    assert.deepStrictEqual(on.pokemon, off.pokemon, `species differs for ${seed}`);
    assert.strictEqual(off.shiny, false);
    assert.strictEqual(on.shiny, true);
  }
});

test('any species can be shiny, not just the rare tiers', () => {
  const cfg = Object.assign({}, ALWAYS_CATCH, { shinyChance: 1 });
  const tiers = new Set();
  for (let i = 0; i < 5000; i++) tiers.add(roll(1, cfg, dex.pokemon).tier);
  assert.deepStrictEqual([...tiers].sort(), ['common', 'legendary', 'mythical', 'rare']);
});

console.log('\nstatistical distribution (100k trials)');

test('observed shiny rate matches the configured 1-in-128', () => {
  const N = 100000;
  let shiny = 0;
  for (let i = 0; i < N; i++) if (roll(1, ALWAYS_CATCH, dex.pokemon).shiny) shiny++;
  const observed = shiny / N;
  const expected = DEFAULTS.shinyChance;
  assert.ok(Math.abs(observed - expected) < expected * 0.15,
    `expected ~${(expected * 100).toFixed(3)}%, got ${(observed * 100).toFixed(3)}%`);
});

test('shininess is independent of tier', () => {
  // If the two draws shared entropy, shinies would cluster in one tier and the
  // "independent roll" comment in lib/roll.js would be a lie.
  const cfg = Object.assign({}, ALWAYS_CATCH, { shinyChance: 0.25 });
  const seen = { common: [0, 0], rare: [0, 0], legendary: [0, 0], mythical: [0, 0] };
  for (let i = 0; i < 100000; i++) {
    const r = roll(1, cfg, dex.pokemon);
    seen[r.tier][0]++;
    if (r.shiny) seen[r.tier][1]++;
  }
  for (const tier of Object.keys(seen)) {
    const [total, shiny] = seen[tier];
    if (total < 500) continue; // too few draws for a meaningful rate
    const rate = shiny / total;
    assert.ok(Math.abs(rate - 0.25) < 0.05,
      `${tier}: shiny rate ${(rate * 100).toFixed(1)}% of ${total}, expected ~25%`);
  }
});

test('observed catch rate matches configured chance within tolerance', () => {
  const cfg = Object.assign({}, DEFAULTS, { ratePerToken: 0.00002 }); // 5000 tok -> 10%
  const N = 100000;
  let caught = 0;
  for (let i = 0; i < N; i++) if (roll(5000, cfg, dex.pokemon).caught) caught++;
  const observed = caught / N;
  assert.ok(Math.abs(observed - 0.1) < 0.005, `expected ~10%, got ${(observed * 100).toFixed(2)}%`);
});

test('tier distribution matches weights within tolerance', () => {
  const N = 100000;
  const cfg = Object.assign({}, DEFAULTS, { ratePerToken: 1, maxChance: 1 }); // always catch
  const seen = { common: 0, rare: 0, legendary: 0, mythical: 0 };
  for (let i = 0; i < N; i++) {
    const r = roll(1, cfg, dex.pokemon);
    if (r.caught) seen[r.tier]++;
  }
  const totalWeight = Object.values(DEFAULTS.tierWeights).reduce((a, b) => a + b, 0);
  for (const tier of Object.keys(seen)) {
    const expected = DEFAULTS.tierWeights[tier] / totalWeight;
    const observed = seen[tier] / N;
    assert.ok(
      Math.abs(observed - expected) < Math.max(0.005, expected * 0.15),
      `${tier}: expected ~${(expected * 100).toFixed(2)}%, got ${(observed * 100).toFixed(2)}%`
    );
  }
});

test('randomFloat stays in [0,1) and spreads across buckets', () => {
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 50000; i++) {
    const v = randomFloat();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    buckets[Math.floor(v * 10)]++;
  }
  for (const b of buckets) assert.ok(b > 3500 && b < 6500, `uneven bucket: ${b}`);
});

test('every species is reachable', () => {
  const cfg = Object.assign({}, DEFAULTS, { ratePerToken: 1, maxChance: 1 });
  const seen = new Set();
  for (let i = 0; i < 2000000 && seen.size < DEX_SIZE; i++) {
    const r = roll(1, cfg, dex.pokemon);
    if (r.caught) seen.add(r.pokemon.id);
  }
  assert.strictEqual(seen.size, DEX_SIZE, `only reached ${seen.size}/${DEX_SIZE} species`);
});

console.log('\ntranscript parsing');

test('string content is a prompt', () => {
  assert.strictEqual(isUserPrompt({ type: 'user', message: { content: 'hello' } }), true);
});

test('tool results are not prompts', () => {
  assert.strictEqual(isUserPrompt({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'x' }] },
  }), false);
});

test('meta and sidechain messages are not prompts', () => {
  assert.strictEqual(isUserPrompt({ type: 'user', isMeta: true, message: { content: 'hi' } }), false);
  assert.strictEqual(isUserPrompt({ type: 'user', isSidechain: true, message: { content: 'hi' } }), false);
});

test('empty content is not a prompt', () => {
  assert.strictEqual(isUserPrompt({ type: 'user', message: { content: '   ' } }), false);
});

test('messageTokens excludes cache reads', () => {
  const tokens = messageTokens({
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 999999,
    output_tokens: 50,
  });
  assert.strictEqual(tokens, 160);
});

test('messageTokens tolerates missing usage', () => {
  assert.strictEqual(messageTokens(undefined), 0);
  assert.strictEqual(messageTokens({}), 0);
});

console.log(`\n${passed} tests passed\n`);
