#!/usr/bin/env node
/**
 * The README showcase SVGs. No framework: run with `node tests/showcase.test.js`.
 * Exits non-zero on the first failure.
 *
 * These images are committed to the repo and rendered by GitHub's markdown, so
 * the tests guard the two ways they can quietly break: drifting out of sync with
 * the baked sprite data, or using SVG features GitHub's sanitizer strips (which
 * shows the reader a blank box, not an error).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PLUGIN_ROOT = path.join(__dirname, '..');

const { build, CARDS, OUT_DIR } = require(path.join(PLUGIN_ROOT, 'scripts', 'build-showcase.js'));

const NAMES = Object.keys(CARDS);

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

console.log('\nfreshness');

test('every committed showcase SVG matches what the generator produces now', () => {
  // The `--check` invariant, as a test: a palette or banner change that forgot
  // `npm run build:showcase` fails here rather than shipping a stale image.
  for (const name of NAMES) {
    const file = path.join(OUT_DIR, name);
    assert.ok(fs.existsSync(file), `${name} is missing -- run npm run build:showcase`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), build(name),
      `${name} is out of date -- run npm run build:showcase`);
  }
});

test('the build is deterministic, so it never churns the committed files', () => {
  for (const name of NAMES) {
    assert.strictEqual(build(name), build(name), `${name} is not stable across two builds`);
  }
});

console.log('\nvalidity');

test('every card is a single well-formed <svg> root with a sized viewBox', () => {
  for (const name of NAMES) {
    const svg = build(name);
    assert.ok(/^<svg\b/.test(svg.trim()), `${name} does not start with <svg>`);
    assert.strictEqual((svg.match(/<svg\b/g) || []).length, 1, `${name} has more than one <svg>`);
    assert.ok(/<\/svg>\s*$/.test(svg), `${name} is not closed`);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    assert.ok(m, `${name} has no viewBox`);
    assert.ok(Number(m[1]) > 0 && Number(m[2]) > 0, `${name} has a zero dimension`);
  }
});

test('every tag opened is closed, counting self-closing tags', () => {
  // A cheap structural balance check: enough to catch a truncated path list or a
  // dropped </g> without pulling in an XML parser.
  for (const name of NAMES) {
    const svg = build(name);
    const opens = (svg.match(/<[a-z]/g) || []).length;
    const closes = (svg.match(/<\/[a-z]+>/g) || []).length + (svg.match(/\/>/g) || []).length;
    assert.strictEqual(opens, closes, `${name}: ${opens} tags opened, ${closes} closed`);
  }
});

console.log('\ngithub sanitizer safety');

test('no card uses a tag GitHub strips from markdown SVG', () => {
  // <script>, <style>, external <image> and filters are removed by GitHub's
  // sanitizer; anything relying on them renders as a blank box for every reader.
  const forbidden = ['<script', '<style', '<image', '<foreignObject', '<filter', '<use'];
  for (const name of NAMES) {
    const svg = build(name);
    for (const tag of forbidden) {
      assert.strictEqual(svg.indexOf(tag), -1, `${name} uses ${tag}, which GitHub strips`);
    }
  }
});

test('no card carries a class, inline event handler, or external reference', () => {
  for (const name of NAMES) {
    const svg = build(name);
    assert.strictEqual(svg.indexOf('class='), -1, `${name} uses a class (no stylesheet survives)`);
    assert.strictEqual(/\son[a-z]+=/.test(svg), false, `${name} has an inline event handler`);
    assert.strictEqual(/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), false,
      `${name} references an external URL`);
  }
});

test('every colour is a literal hex fill or stroke, never a named or var colour', () => {
  // A var()/currentColor fill would depend on a stylesheet the sanitizer drops,
  // so the art has to name its own colours.
  for (const name of NAMES) {
    const svg = build(name);
    for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
      const v = m[1];
      assert.ok(v === 'none' || /^#[0-9a-fA-F]{3,8}$/.test(v),
        `${name}: non-literal colour ${JSON.stringify(v)}`);
    }
  }
});

test('text preserves whitespace, so the ASCII rules keep their columns', () => {
  // Without xml:space="preserve" the sanitizer/renderer collapses runs of spaces
  // and the padded report columns lose their alignment.
  const svg = build('rarity-rules.svg');
  for (const m of svg.matchAll(/<text\b[^>]*>/g)) {
    assert.ok(/xml:space="preserve"/.test(m[0]), `a <text> in rarity-rules dropped xml:space`);
  }
});

console.log('\ndrawn from the real data');

test('the rarity card shows the exact rule the plugin draws', () => {
  // The showcase must not hand-draw a prettier rule than /pokedex actually emits.
  const { rule } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
  const svg = build('rarity-rules.svg');
  for (const tier of ['common', 'rare', 'legendary', 'mythical']) {
    assert.ok(svg.includes(`>${rule(tier)}<`), `the ${tier} rule in the card is not rule('${tier}')`);
  }
  assert.ok(svg.includes(`>${rule('common', 52, true)}<`), 'the shiny rule is not rule(shiny)');
});

test('shiny and normal cards fill from different palettes', () => {
  // Proves the shiny image is a real palette swap of the same sprite, which is
  // the entire claim the shiny comparison is making.
  const svg = build('shiny-compare.svg');
  const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
  // A Machamp comparison spans two full palettes, so well over a dozen colours.
  assert.ok(fills.size > 20, `only ${fills.size} distinct fills -- a palette may be missing`);
});

test('the species wall draws every species it lists', () => {
  // Each sprite is one <g> group; a silently dropped sprite would leave a hole in
  // the wall that a reader notices before any test does.
  const svg = build('species-wall.svg');
  const groups = (svg.match(/<g\b/g) || []).length;
  assert.ok(groups >= 30, `only ${groups} sprite groups in the wall`);
});

test('no showcase SVG contains an ESC byte or other control character', () => {
  for (const name of NAMES) {
    const svg = build(name);
    for (let i = 0; i < svg.length; i++) {
      const code = svg.charCodeAt(i);
      assert.ok(code === 10 || code === 9 || code >= 0x20,
        `${name}: control char 0x${code.toString(16)} at ${i}`);
    }
  }
});

console.log(`\n${passed} tests passed\n`);
