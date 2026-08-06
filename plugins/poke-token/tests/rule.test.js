#!/usr/bin/env node
/**
 * Rarity header rules. No framework: run with `node tests/rule.test.js`.
 * Exits non-zero on the first failure.
 *
 * The rule is pure ornament, so the tests care mostly that it can never break a
 * report: fixed width, plain ASCII, one line, and a usable fallback for every
 * input a caller could plausibly pass.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const PLUGIN_ROOT = path.join(__dirname, '..');

const { rule, RULE_WIDTH, TIER_RULE, TIER_LABEL } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));

const TIERS = ['common', 'rare', 'legendary', 'mythical'];

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

console.log('\nshape');

test('every tier rule is exactly one line of the report width', () => {
  // A rule that ran long or wrapped would break the alignment of every report
  // it heads, which is a real defect rather than a cosmetic one.
  for (const tier of TIERS.concat([undefined, 'nonsense'])) {
    const line = rule(tier);
    assert.strictEqual(line.length, RULE_WIDTH, `${tier}: width ${line.length}`);
    assert.strictEqual(line.indexOf('\n'), -1, `${tier}: rule contains a newline`);
  }
});

test('a rule is drawn at any requested width down to one column', () => {
  for (const tier of TIERS) {
    for (const width of [1, 2, 3, 4, 5, 7, 8, 16, 51, 52, 53, 120]) {
      const line = rule(tier, width);
      assert.strictEqual(line.length, width, `${tier} @${width}: got ${line.length}`);
    }
  }
});

test('a nonsense width degrades to something drawable rather than throwing', () => {
  // The rule must not be the thing that takes a report down, so every caller
  // mistake has to land somewhere safe.
  for (const width of [0, -1, -100, 0.5, NaN, Infinity, null, undefined, 'wide', {}]) {
    const line = rule('rare', width);
    assert.ok(typeof line === 'string' && line.length >= 1,
      `width ${JSON.stringify(width)} produced ${JSON.stringify(line)}`);
    assert.strictEqual(line.indexOf('\n'), -1, `width ${JSON.stringify(width)} wrapped`);
  }
});

test('rules are symmetric about the centre', () => {
  // The burst is meant to read as one deliberate ornament, not a random run.
  for (const tier of TIERS) {
    const line = rule(tier);
    const reversed = line.split('').reverse().join('');
    assert.strictEqual(line, reversed, `${tier} is not symmetric: ${line}`);
  }
});

console.log('\nvocabulary');

test('rules are plain ASCII, so no font can turn a header into mojibake', () => {
  // The rule shares captured stdout with the sprite art. Unlike the art, it has
  // no shape to lose by staying ASCII, so it stays ASCII.
  for (const tier of TIERS.concat([undefined])) {
    for (const shiny of [false, true]) {
      const line = rule(tier, RULE_WIDTH, shiny);
      for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        assert.ok(code >= 0x21 && code <= 0x7e,
          `${tier} shiny=${shiny}: non-printable-ASCII 0x${code.toString(16)} at ${i}`);
      }
    }
  }
});

test('no rule contains an ESC byte or any other control character', () => {
  for (const tier of TIERS.concat([undefined])) {
    const line = rule(tier);
    assert.strictEqual(line.indexOf('\x1b'), -1, `${tier}: ESC byte in a rule`);
  }
});

test('each tier draws a distinguishable rule', () => {
  // The whole point: the rule has to actually say which rarity you are looking
  // at. Two tiers sharing a line would make it decoration and nothing more.
  const seen = new Map();
  for (const tier of TIERS) {
    const line = rule(tier);
    assert.ok(!seen.has(line), `${tier} draws the same rule as ${seen.get(line)}`);
    seen.set(line, tier);
  }
});

test('the ordinary tiers read as stone and the rare ones as stars', () => {
  // The vocabulary split is what makes rarity legible before the Rarity line is
  // read, so it is pinned rather than left to drift.
  const STONE = new Set(['-', '.', 'o', 'O']);
  const STAR = new Set(['=', '+', '*', 'x', 'X', '#', '@']);
  for (const tier of ['common', 'rare']) {
    for (const ch of new Set(rule(tier).split(''))) {
      assert.ok(STONE.has(ch), `${tier} used a star glyph ${JSON.stringify(ch)}`);
    }
  }
  for (const tier of ['legendary', 'mythical']) {
    for (const ch of new Set(rule(tier).split(''))) {
      assert.ok(STAR.has(ch), `${tier} used a stone glyph ${JSON.stringify(ch)}`);
    }
  }
});

test('rarity raises the number of distinct glyphs a rule spends', () => {
  // Rarity should be visible as detail, not just a different character. Each
  // tier gets at least as rich a ramp as the one below it.
  let previous = 0;
  for (const tier of TIERS) {
    const distinct = new Set(rule(tier).split('')).size;
    assert.ok(distinct >= previous, `${tier} has ${distinct} glyphs, fewer than the tier below`);
    previous = distinct;
  }
  assert.ok(new Set(rule('mythical').split('')).size > new Set(rule('common').split('')).size,
    'a mythical rule is no richer than a common one');
});

test('every tier in TIER_LABEL has a rule spec', () => {
  // A tier added to the dex without a rule would silently fall back to flat,
  // which reads as a bug rather than a decision.
  for (const tier of Object.keys(TIER_LABEL)) {
    assert.ok(TIER_RULE[tier], `no rule spec for tier "${tier}"`);
    assert.ok(Array.isArray(TIER_RULE[tier].ramp) && TIER_RULE[tier].ramp.length >= 1,
      `${tier}: unusable ramp`);
    assert.ok(TIER_RULE[tier].spread > 0 && TIER_RULE[tier].spread <= 1,
      `${tier}: spread ${TIER_RULE[tier].spread} outside (0,1]`);
  }
});

console.log('\nfallbacks');

test('an unknown or missing tier falls back to the flat rule', () => {
  // Reports with no single rarity to describe -- the summary, odds, config --
  // all rely on this, so it is the fallback rather than an error.
  const flat = '='.repeat(RULE_WIDTH);
  for (const tier of [undefined, null, '', 'ultra-beast', 0, false, {}, []]) {
    assert.strictEqual(rule(tier), flat, `${JSON.stringify(tier)} did not fall back to flat`);
  }
});

test('the flat fallback is the rule every header used before rarity mattered', () => {
  // Pins the config screens and the odds page to the line they have always had,
  // so this change is additive rather than a reflow of unrelated reports.
  assert.strictEqual(rule(), '='.repeat(52));
});

console.log('\nshiny');

test('a shiny draws the top rule whatever its tier', () => {
  // At 1 in 128 a shiny common is rarer than the legendary beside it, so it gets
  // the loud rule for the same reason it takes the banner headline.
  const common = rule('common', RULE_WIDTH, true);
  assert.notStrictEqual(common, rule('common'), 'a shiny common drew the ordinary common rule');
  for (const tier of TIERS) {
    assert.strictEqual(rule(tier, RULE_WIDTH, true), common,
      `shiny ${tier} differs from shiny common -- shiny should override the tier`);
  }
});

test('the shiny rule is distinct from every ordinary tier rule', () => {
  const shiny = rule('mythical', RULE_WIDTH, true);
  for (const tier of TIERS) {
    assert.notStrictEqual(shiny, rule(tier), `the shiny rule collides with ${tier}`);
  }
});

console.log('\nstats.js integration');

/**
 * Runs /pokedex against a sandboxed collection, so nothing here can read or
 * write the real one.
 */
function pokedex(collection, arg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-rule-'));
  try {
    const dataDir = path.join(dir, 'poke-token');
    fs.mkdirSync(dataDir, { recursive: true });
    if (collection) {
      fs.writeFileSync(path.join(dataDir, 'collection.json'), JSON.stringify(collection));
    }
    const argv = [path.join(PLUGIN_ROOT, 'scripts', 'stats.js'), '--'].concat(arg === undefined ? [] : [arg]);
    const r = spawnSync(process.execPath, argv, {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: dir }),
    });
    assert.strictEqual(r.status, 0, `stats.js exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function caught(id, name, tier, shiny) {
  return {
    id, name, gen: 1, tier, tokens: 9000, caughtAt: '2026-08-01T10:00:00.000Z', shiny: !!shiny,
  };
}

/** The header rule of a report: the line directly after the title. */
function headerRule(out) {
  const lines = out.split('\n');
  // The detail card puts the sprite above the title, and above that a
  // "POKEDEX  #NNNN" view header (so the "PostToolUse:Bash says:" label lands on
  // text, not the sprite's top row). Its own title is the "#NNNN NAME" line, so
  // prefer that; only the summary and filter views, which have no such line,
  // fall back to their "POKEDEX"/"POKE-TOKEN" heading.
  let at = lines.findIndex((l) => /^#\d/.test(l));
  if (at < 0) at = lines.findIndex((l) => /^(POKEDEX|POKE-TOKEN)/.test(l));
  assert.ok(at >= 0, `no title line in report:\n${out}`);
  return lines[at + 1];
}

test('a species card carries no header rule, only its title and metrics', () => {
  // The detail view dropped the header rule: under the title comes a blank line,
  // then the Generation / Rarity / Caught metrics. The rarity is carried by the
  // colour of the Rarity value now, not by a rule glyph vocabulary.
  for (const arg of ['charizard', 'mew']) {
    const lines = pokedex(null, arg).split('\n');
    const at = lines.findIndex((l) => /^#\d/.test(l));
    assert.ok(at >= 0, `no title line for ${arg}`);
    assert.strictEqual(lines[at + 1], '', `${arg}: a rule survived under the title`);
    // None of the tier rule ramps should appear as a full-width line anywhere.
    for (const tier of ['common', 'rare', 'legendary', 'mythical']) {
      assert.ok(!lines.includes(rule(tier)), `${arg}: a ${tier} rule line survived`);
    }
  }
});

test('an owned shiny detail card still shows the shiny mark, without a rule', () => {
  const out = pokedex({
    stats: { turns: 1, tokens: 9000, pulls: 1 },
    catches: [caught(25, 'Pikachu', 'common', true)],
  }, 'pikachu');
  const lines = out.split('\n');
  const at = lines.findIndex((l) => /^#\d/.test(l));
  assert.strictEqual(lines[at + 1], '', 'a rule survived under the shiny card title');
  assert.ok(/SHINY/.test(out), 'the shiny mark is missing from the report');
});

test('the summary is headed by the rarest thing in the collection', () => {
  const base = { stats: { turns: 9, tokens: 90000, pulls: 2 } };
  const commonOnly = pokedex(Object.assign({}, base, {
    catches: [caught(19, 'Rattata', 'common')],
  }));
  const withLegendary = pokedex(Object.assign({}, base, {
    catches: [caught(19, 'Rattata', 'common'), caught(384, 'Rayquaza', 'legendary')],
  }));
  assert.strictEqual(headerRule(commonOnly), rule('common'));
  assert.strictEqual(headerRule(withLegendary), rule('legendary'),
    'a legendary in the collection did not raise the summary rule');
});

test('an empty collection falls back to the flat summary rule', () => {
  // Nothing caught means nothing to advertise, and inventing a rarity there
  // would misreport the collection.
  assert.strictEqual(headerRule(pokedex(null)), rule());
});

test('a tier filter is headed by that tier rule, a gen filter by the flat one', () => {
  // A generation spans all four tiers, so it has no single rarity to draw.
  assert.strictEqual(headerRule(pokedex(null, 'legendary')), rule('legendary'));
  assert.strictEqual(headerRule(pokedex(null, 'gen1')), rule());
});

test('every report but a caught-species detail is escape-free with the rules in place', () => {
  // The rule shares the captured stdout with the art. A caught species now draws
  // its reward art in colour, so those reports carry escapes by design; every
  // other report -- summaries, filters, and not-yet-caught species -- stays
  // escape-free, held to the same standard the plain sprite mode is.
  const collection = {
    stats: { turns: 9, tokens: 90000, pulls: 2 },
    catches: [caught(25, 'Pikachu', 'common', true), caught(384, 'Rayquaza', 'legendary')],
  };
  // `mew` is not in the collection, so its detail view falls back to plain art.
  for (const arg of [undefined, 'mew', 'legendary', 'gen1', 'missing', 'odds']) {
    const out = pokedex(collection, arg);
    assert.strictEqual(out.indexOf('\x1b'), -1, `${arg}: report leaked an ESC byte`);
  }
  // A caught species draws its art in colour, so escapes here are expected.
  const caughtDetail = pokedex(collection, 'pikachu');
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(caughtDetail),
    'a caught species detail lost its colour art');
});

test('every report line stays within the rule width, so nothing wraps', () => {
  // The rule sets the report width; a body line running past it would make the
  // header look short rather than the line look long.
  const out = pokedex(null, 'charizard');
  for (const line of out.split('\n')) {
    assert.ok(line.length <= RULE_WIDTH + 8, `line of ${line.length} chars: ${JSON.stringify(line)}`);
  }
});

console.log('\nconfig screens');

test('the config CLI still heads its screens with the flat rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-rule-cfg-'));
  try {
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'config-cli.js')], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: dir }),
    });
    assert.strictEqual(r.status, 0, `config-cli.js exited ${r.status}: ${r.stderr}`);
    assert.strictEqual(headerRule(r.stdout), rule(), 'the config screen changed its rule');
    assert.strictEqual(r.stdout.indexOf('\x1b'), -1, 'config output leaked an ESC byte');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed\n`);
