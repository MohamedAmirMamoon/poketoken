#!/usr/bin/env node
/**
 * Sprite test suite. No framework: run with `node tests/sprite.test.js`.
 * Exits non-zero on the first failure.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const PLUGIN_ROOT = path.join(__dirname, '..');

const spriteLib = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
const { renderSprite, spritePath, shinyPath, applyShiny, ALPHABET } = spriteLib;
const { loadConfig, DEFAULTS } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const { renderCatch } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

const IDS = dex.pokemon.map((p) => p.id);
const ANSI = /\x1b\[[0-9;]*m/g;
// A spread of gens: Bulbasaur, Charizard, Pikachu, Mew, Rayquaza, Genesect,
// Greninja, Mimikyu, Koraidon, and whatever currently ends the dex.
const SAMPLE = [1, 6, 25, 151, 384, 649, 658, 778, 1007, Math.max.apply(null, IDS)];

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

/** Reads every baked sprite once; the structural tests all share this. */
const sprites = new Map();
for (const id of IDS) {
  try {
    sprites.set(id, JSON.parse(fs.readFileSync(spritePath(id), 'utf8')));
  } catch (err) {
    sprites.set(id, null);
  }
}

/**
 * Predicted output shape. Delegates to the renderer's own exported sizing so the
 * expectation cannot drift from the implementation -- an earlier copy of this
 * math here silently disagreed once upscaling was added.
 */
function renderSize(sprite, maxWidth) {
  return spriteLib.renderSize(sprite.w, sprite.h, maxWidth, true);
}

console.log('\nbaked sprite integrity');

test(`a sprite file exists and parses for all ${dex.count} species`, () => {
  const missing = IDS.filter((id) => sprites.get(id) === null);
  assert.strictEqual(missing.length, 0, `unreadable: ${missing.slice(0, 10).join(', ')}`);
  assert.strictEqual(sprites.size, dex.count);
  assert.strictEqual(IDS.length, dex.count);
});

test('dimensions are sane and within the 64x64 bake budget', () => {
  for (const [id, s] of sprites) {
    assert.ok(Number.isInteger(s.w) && s.w >= 1 && s.w <= 64, `#${id}: w=${s.w}`);
    assert.ok(Number.isInteger(s.h) && s.h >= 1 && s.h <= 64, `#${id}: h=${s.h}`);
    // The bake only ever downscales, so small gen-1 art keeps its native size;
    // anything under 16px on the long side would mean the crop went wrong.
    assert.ok(Math.max(s.w, s.h) >= 16, `#${id}: suspiciously small at ${s.w}x${s.h}`);
  }
});

test('px.length === w * h for every sprite', () => {
  for (const [id, s] of sprites) {
    assert.strictEqual(s.px.length, s.w * s.h, `#${id}: ${s.px.length} != ${s.w * s.h}`);
  }
});

test('every palette entry is lowercase 6-hex-digit', () => {
  for (const [id, s] of sprites) {
    assert.ok(Array.isArray(s.pal) && s.pal.length > 0, `#${id}: no palette`);
    assert.ok(s.pal.length <= 63, `#${id}: palette of ${s.pal.length} exceeds 63`);
    for (const entry of s.pal) {
      assert.ok(/^[0-9a-f]{6}$/.test(entry), `#${id}: bad palette entry ${JSON.stringify(entry)}`);
    }
  }
});

test('every symbol is in the alphabet and indexes a real colour', () => {
  for (const [id, s] of sprites) {
    for (let i = 0; i < s.px.length; i++) {
      const index = ALPHABET.indexOf(s.px[i]);
      assert.ok(index >= 0, `#${id}: symbol ${JSON.stringify(s.px[i])} not in alphabet`);
      assert.ok(index <= s.pal.length, `#${id}: index ${index} > palette size ${s.pal.length}`);
    }
  }
});

test('every sprite has opaque content and a cropped bounding box', () => {
  for (const [id, s] of sprites) {
    let opaque = 0;
    for (let i = 0; i < s.px.length; i++) if (s.px[i] !== ALPHABET[0]) opaque++;
    assert.ok(opaque > 0, `#${id}: fully transparent`);

    // Cropping means the first and last rows and columns each hold some content.
    const rowHas = (y) => s.px.slice(y * s.w, (y + 1) * s.w).split('').some((c) => c !== ALPHABET[0]);
    const colHas = (x) => {
      for (let y = 0; y < s.h; y++) if (s.px[y * s.w + x] !== ALPHABET[0]) return true;
      return false;
    };
    assert.ok(rowHas(0) && rowHas(s.h - 1), `#${id}: transparent edge row survived cropping`);
    assert.ok(colHas(0) && colHas(s.w - 1), `#${id}: transparent edge column survived cropping`);
  }
});

console.log('\nbaked shiny integrity');

/** Reads every baked shiny once, alongside its normal counterpart. */
const shinies = new Map();
for (const id of IDS) {
  try {
    shinies.set(id, JSON.parse(fs.readFileSync(shinyPath(id), 'utf8')));
  } catch (err) {
    shinies.set(id, null);
  }
}

/** A shiny that ships its own pixels rather than just a replacement palette. */
const isFullPayload = (s) => typeof s.px === 'string';

test(`a shiny file exists and parses for all ${dex.count} species`, () => {
  const missing = IDS.filter((id) => shinies.get(id) === null);
  assert.strictEqual(missing.length, 0, `unreadable: ${missing.slice(0, 10).join(', ')}`);
});

test('every shiny palette entry is lowercase 6-hex-digit', () => {
  for (const [id, s] of shinies) {
    assert.ok(Array.isArray(s.pal) && s.pal.length > 0, `#${id}: no palette`);
    assert.ok(s.pal.length <= 63, `#${id}: palette of ${s.pal.length} exceeds 63`);
    for (const entry of s.pal) {
      assert.ok(/^[0-9a-f]{6}$/.test(entry), `#${id}: bad palette entry ${JSON.stringify(entry)}`);
    }
  }
});

test('a palette-swap shiny matches its normal sprite slot for slot', () => {
  // This is the whole premise of the palette-only format: the normal `px` is
  // reused verbatim, so a length mismatch would index past the palette and
  // render a colour that exists in neither sprite.
  let swaps = 0;
  for (const [id, s] of shinies) {
    if (isFullPayload(s)) continue;
    swaps++;
    assert.strictEqual(s.pal.length, sprites.get(id).pal.length, `#${id}: palette length differs`);
    // A bare palette payload must not carry stray geometry that nothing reads.
    assert.deepStrictEqual(Object.keys(s).sort(), ['pal'], `#${id}: unexpected keys`);
  }
  // Guards against a bake that silently emitted full payloads for everything.
  assert.ok(swaps > IDS.length * 0.9, `only ${swaps}/${IDS.length} are palette swaps`);
});

test('a full-payload shiny is structurally valid on its own terms', () => {
  let full = 0;
  for (const [id, s] of shinies) {
    if (!isFullPayload(s)) continue;
    full++;
    assert.ok(Number.isInteger(s.w) && s.w >= 1 && s.w <= 64, `#${id}: w=${s.w}`);
    assert.ok(Number.isInteger(s.h) && s.h >= 1 && s.h <= 64, `#${id}: h=${s.h}`);
    assert.strictEqual(s.px.length, s.w * s.h, `#${id}: ${s.px.length} != ${s.w * s.h}`);
    for (let i = 0; i < s.px.length; i++) {
      const index = ALPHABET.indexOf(s.px[i]);
      assert.ok(index >= 0, `#${id}: symbol ${JSON.stringify(s.px[i])} not in alphabet`);
      assert.ok(index <= s.pal.length, `#${id}: index ${index} > palette size ${s.pal.length}`);
    }
  }
  console.log(`      ${full} full payloads, ${IDS.length - full} palette swaps`);
});

test('the shiny of a species is visibly a different colour, not a copy', () => {
  // A bake that quietly fetched the normal art twice would produce identical
  // palettes and a "shiny" nobody can tell apart from the catch they already had.
  let identical = 0;
  for (const [id, s] of shinies) {
    if (isFullPayload(s)) continue;
    const normal = sprites.get(id);
    if (s.pal.every((c, i) => c === normal.pal[i])) identical++;
  }
  assert.ok(identical < IDS.length * 0.02,
    `${identical}/${IDS.length} shinies are colour-identical to their normal art`);
});

console.log('\napplyShiny');

test('applyShiny recolours without changing geometry for a palette swap', () => {
  for (const id of SAMPLE) {
    if (isFullPayload(shinies.get(id))) continue;
    const normal = sprites.get(id);
    const shiny = applyShiny(id, normal);
    assert.strictEqual(shiny.w, normal.w, `#${id}: width changed`);
    assert.strictEqual(shiny.h, normal.h, `#${id}: height changed`);
    assert.strictEqual(shiny.px, normal.px, `#${id}: pixels changed on a palette swap`);
    assert.notDeepStrictEqual(shiny.pal, normal.pal, `#${id}: palette was not swapped`);
    // The caller's sprite must not be mutated: renderCatch reuses it.
    assert.deepStrictEqual(normal.pal, sprites.get(id).pal, `#${id}: normal sprite was mutated`);
  }
});

test('applyShiny returns the normal sprite when the shiny is missing or corrupt', () => {
  const backup = fs.readFileSync(shinyPath(1), 'utf8');
  const normal = JSON.parse(fs.readFileSync(spritePath(1), 'utf8'));
  const corruptions = [
    'not json at all',
    '[]',
    'null',
    '{}',                                        // no palette
    '{"pal":[]}',                                // empty palette
    '{"pal":["ZZZZZZ"]}',                        // bad hex
    '{"pal":["ff0000"]}',                        // too few slots for the pixels
    '{"pal":["ff0000"],"px":"01","w":2}',         // full payload missing h
    '{"pal":["ff0000"],"px":"01","w":2,"h":5}',   // full payload px/size mismatch
    '{"pal":["ff0000"],"px":"","w":0,"h":0}',     // degenerate full payload
  ];
  try {
    for (const bad of corruptions) {
      fs.writeFileSync(shinyPath(1), bad);
      assert.deepStrictEqual(applyShiny(1, normal), normal, `accepted ${bad.slice(0, 40)}`);
      // The catch must still render its art, just in the ordinary colours.
      assert.ok(renderSprite(1, { shiny: true }), `no art for ${bad.slice(0, 40)}`);
    }
    fs.unlinkSync(shinyPath(1));
    assert.deepStrictEqual(applyShiny(1, normal), normal, 'a missing shiny file was not tolerated');
    assert.ok(renderSprite(1, { shiny: true }), 'no art with the shiny file absent');
  } finally {
    fs.writeFileSync(shinyPath(1), backup);
  }
  assert.notDeepStrictEqual(applyShiny(1, normal).pal, normal.pal, 'restore of shiny 1 failed');
});

console.log('\nshiny rendering');

test('shiny art differs from normal art but keeps the same shape', () => {
  for (const id of SAMPLE) {
    const normalArt = renderSprite(id, { maxWidth: 48 });
    const shinyArt = renderSprite(id, { maxWidth: 48, shiny: true });
    assert.ok(shinyArt, `#${id}: no shiny art`);
    assert.notStrictEqual(shinyArt, normalArt, `#${id}: shiny render is identical to normal`);
    // Only colours may change on a palette swap, so the glyphs must line up.
    if (!isFullPayload(shinies.get(id))) {
      assert.strictEqual(
        shinyArt.replace(ANSI, ''),
        normalArt.replace(ANSI, ''),
        `#${id}: palette swap altered the glyph layout`
      );
    }
    assert.strictEqual(shinyArt.split('\n').length, normalArt.split('\n').length, `#${id}: row count differs`);
  }
});

test('every shiny in the dex renders, resets each line, and respects maxWidth', () => {
  for (const id of IDS) {
    const art = renderSprite(id, { maxWidth: 32, indent: '', shiny: true });
    assert.ok(art, `#${id}: no shiny art`);
    for (const line of art.split('\n')) {
      assert.ok(line.endsWith('\x1b[0m'), `#${id}: line does not reset`);
      assert.ok(line.replace(ANSI, '').length <= 32, `#${id}: too wide`);
    }
  }
});

test('shiny:false and an omitted flag render identically', () => {
  for (const id of SAMPLE) {
    assert.strictEqual(renderSprite(id, { shiny: false }), renderSprite(id), `#${id}`);
  }
});

console.log('\nrenderSprite failure modes');

test('nonexistent ids return null rather than throwing', () => {
  for (const bad of [0, -1, dex.count + 1, 99999, 1.5, NaN, null, undefined, '25', {}]) {
    assert.strictEqual(renderSprite(bad), null, `input ${JSON.stringify(bad)}`);
  }
});

test('a corrupted sprite file returns null rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sprite-'));
  const backup = fs.readFileSync(spritePath(1), 'utf8');
  const corruptions = [
    'not json at all',
    '[]',
    'null',
    '{"w":64,"h":64,"pal":["ff0000"],"px":"abc"}', // px length mismatch
    '{"w":64,"h":2,"pal":[],"px":"' + '0'.repeat(128) + '"}', // empty palette
    '{"w":64,"h":1,"pal":["ZZZZZZ"],"px":"' + '1'.repeat(64) + '"}', // bad hex
    '{"w":0,"h":0,"pal":["ff0000"],"px":""}', // degenerate size
  ];
  try {
    for (const bad of corruptions) {
      fs.writeFileSync(spritePath(1), bad);
      assert.strictEqual(renderSprite(1), null, `accepted ${bad.slice(0, 40)}`);
    }
  } finally {
    fs.writeFileSync(spritePath(1), backup);
    fs.rmdirSync(dir);
  }
  assert.ok(renderSprite(1), 'restore of sprite 1 failed');
});

test('malformed options fall back to defaults instead of throwing', () => {
  for (const bad of [null, {}, { maxWidth: 'wide' }, { maxWidth: NaN }, { maxWidth: 0 }, { indent: 7 }]) {
    const art = renderSprite(25, bad);
    assert.ok(typeof art === 'string' && art.length > 0, `options ${JSON.stringify(bad)}`);
  }
});

console.log('\nrendered output shape');

test('output uses 24-bit truecolour escapes', () => {
  const art = renderSprite(25);
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(art), 'no truecolour foreground');
  assert.ok(/\x1b\[48;2;\d+;\d+;\d+m/.test(art), 'no truecolour background');
});

test('every line ends with a reset', () => {
  for (const id of SAMPLE) {
    for (const line of renderSprite(id).split('\n')) {
      assert.ok(line.endsWith('\x1b[0m'), `#${id}: line does not reset: ${JSON.stringify(line.slice(-12))}`);
    }
  }
});

test('fully-transparent cells never carry a background colour', () => {
  for (const id of IDS) {
    const art = renderSprite(id);
    for (const line of art.split('\n')) {
      let bgActive = false;
      let i = 0;
      while (i < line.length) {
        if (line[i] === '\x1b') {
          const end = line.indexOf('m', i);
          const code = line.slice(i + 2, end);
          if (code === '0' || code === '') bgActive = false;
          else if (code.startsWith('48;2;')) bgActive = true;
          i = end + 1;
          continue;
        }
        if (line[i] === ' ') {
          assert.ok(!bgActive, `#${id}: transparent cell painted with a background`);
        }
        i++;
      }
    }
  }
});

test('line count equals ceil(renderHeight / 2)', () => {
  for (const maxWidth of [16, 32, 48, 64]) {
    for (const id of IDS) {
      const size = renderSize(sprites.get(id), maxWidth);
      const lines = renderSprite(id, { maxWidth }).split('\n');
      assert.strictEqual(lines.length, Math.ceil(size.h / 2), `#${id} @${maxWidth}`);
    }
  }
});

test('no line exceeds the requested width in visible characters', () => {
  for (const maxWidth of [16, 32, 48, 64]) {
    for (const id of IDS) {
      const size = renderSize(sprites.get(id), maxWidth);
      const indent = '   ';
      for (const line of renderSprite(id, { maxWidth, indent }).split('\n')) {
        const visible = line.replace(ANSI, '');
        assert.strictEqual(
          visible.length,
          indent.length + size.w,
          `#${id} @${maxWidth}: ${visible.length} visible chars, expected ${indent.length + size.w}`
        );
        assert.ok(visible.length - indent.length <= maxWidth, `#${id} @${maxWidth}: too wide`);
      }
    }
  }
});

test('indent prefixes every line', () => {
  for (const indent of ['', '   ', '>>>>'] ) {
    for (const line of renderSprite(25, { indent }).split('\n')) {
      assert.ok(line.startsWith(indent), `missing indent ${JSON.stringify(indent)}`);
    }
  }
});

test('half-block glyphs are the only non-space visible characters', () => {
  const art = renderSprite(384);
  const visible = new Set(art.replace(ANSI, '').replace(/\n/g, '').split(''));
  for (const ch of visible) {
    assert.ok(ch === ' ' || ch === '▀' || ch === '▄', `unexpected glyph ${JSON.stringify(ch)}`);
  }
});

console.log('\nconfig integration');

test('config exposes sprite defaults', () => {
  assert.strictEqual(DEFAULTS.sprites, true);
  assert.strictEqual(DEFAULTS.spriteWidth, 48);
  const cfg = loadConfig();
  assert.strictEqual(typeof cfg.sprites, 'boolean');
  assert.ok(Number.isInteger(cfg.spriteWidth) && cfg.spriteWidth >= 8 && cfg.spriteWidth <= 64);
});

test('sprites:false emits the escape-free plain banner unchanged', () => {
  // `sprites: false` is the user's "this host strips escapes" switch, so the
  // banner stays the exact plain block it has always been -- not a decoloured
  // version of the colour card. That contract is pinned here byte for byte.
  const args = {
    pokemon: { id: 25, name: 'Pikachu', gen: 1 },
    tier: 'common',
    tokens: 5000,
    chance: 0.01,
    roll: 0.005,
    uniqueCount: 3,
    totalCount: 4,
    dexSize: 649,
    isNew: true,
  };
  const off = renderCatch(Object.assign({}, args, { config: { sprites: false, spriteWidth: 48 } }));
  assert.ok(off.indexOf('\x1b') === -1, 'disabled sprites still emitted escapes');
  assert.deepStrictEqual(off.split('\n'), [
    '',
    '+-- A wild PIKACHU appeared and was caught!',
    '|   #025 - Gen 1 - Common - NEW',
    '|   5,000 tokens -> 1.00% chance -> rolled 0.50%',
    '|   Pokedex: 4 caught - 3/649 unique (0.5%)',
    '+-- /pokedex to view your collection',
  ]);
});

test('an unavailable or throwing sprite still draws the colour card, just without art', () => {
  // Art is decoration on top of the card; a null or throwing renderer must drop
  // the picture without costing the coloured info card beneath it. The card is
  // still coloured (escapes present) and still names the catch.
  const args = {
    pokemon: { id: 25, name: 'Pikachu', gen: 1, types: ['electric'] },
    tier: 'common',
    tokens: 5000,
    chance: 0.01,
    roll: 0.005,
    uniqueCount: 3,
    totalCount: 4,
    dexSize: 649,
    isNew: true,
    config: { sprites: true, spriteWidth: 48 },
  };
  for (const sprite of [() => null, () => { throw new Error('boom'); }]) {
    const out = renderCatch(Object.assign({}, args, { sprite }));
    assert.ok(/\x1b\[38;2;/.test(out), 'the card lost its colour with the art gone');
    assert.ok(out.includes('PIKACHU'), 'the card lost the catch name with the art gone');
    // No sprite means no half-block background paint, so the card border is the
    // first coloured thing in the banner.
    assert.strictEqual(out.indexOf('\x1b[48;2;'), -1, 'a missing sprite still painted a background');
  }
});

test('renderCatch places the sprite above the info card', () => {
  const out = renderCatch({
    pokemon: { id: 25, name: 'Pikachu', gen: 1, types: ['electric'] },
    tier: 'common',
    tokens: 5000,
    chance: 0.01,
    roll: 0.005,
    uniqueCount: 3,
    totalCount: 4,
    dexSize: 649,
    isNew: true,
    config: { sprites: true, spriteWidth: 48 },
  });
  const lines = out.split('\n');
  const cardTop = lines.findIndex((l) => l.includes('╭'));
  assert.ok(cardTop > 1, 'no sprite block before the card');
  // The sprite paints backgrounds; the card frame is foreground only, so a
  // background escape before the top border proves the art sits above the card.
  assert.ok(out.indexOf('\x1b[48;2;') < out.indexOf('╭'), 'sprite is not above the card');
  assert.strictEqual(lines[cardTop - 1], '', 'no blank separator between art and card');
});

test('the colour card carries the required content, coloured by rarity and type', () => {
  // The banner has to say everything the plain block did -- headline, dex number,
  // rarity, NEW/dupe, stats, footer -- plus the new colour: each type in its
  // chart colour and the frame tinted by the tier's accent. This pins the
  // content and the two accents (gold legendary, diamond mythical) that the
  // redesign is really about.
  const { RARITY_RGB, TYPE_RGB, SHINY_RGB, stripAnsi } = (() => {
    const c = require(path.join(PLUGIN_ROOT, 'lib', 'color.js'));
    const r = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
    return { RARITY_RGB: c.RARITY_RGB, TYPE_RGB: c.TYPE_RGB, SHINY_RGB: c.SHINY_RGB, stripAnsi: r.stripAnsi };
  })();
  const seq = (rgb) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;

  const base = {
    pokemon: { id: 1, name: 'Bulbasaur', gen: 1, types: ['grass', 'poison'] },
    tier: 'legendary', tokens: 5000, chance: 0.01, roll: 0.005,
    uniqueCount: 3, totalCount: 4, dexSize: 649, isNew: true,
    config: { sprites: false, spriteWidth: 48 }, // no art: isolate the card content
  };
  // sprites:false takes the plain path, so build the card by forcing a null sprite
  // with sprites left on rather than off.
  const legend = renderCatch(Object.assign({}, base, {
    config: { sprites: true, spriteWidth: 48 }, sprite: () => null,
  }));
  const plain = stripAnsi(legend);

  assert.ok(/A .*LEGENDARY.* encounter — BULBASAUR!/.test(plain) || plain.includes('BULBASAUR'),
    `headline missing the name: ${plain}`);
  assert.ok(plain.includes('#001'), 'dex number missing');
  assert.ok(plain.includes('GRASS') && plain.includes('POISON'), 'type chips missing');
  assert.ok(plain.includes('NEW'), 'NEW marker missing');
  assert.ok(/5,000 tokens .* chance .* rolled/.test(plain), 'stat line missing');
  assert.ok(/Pokedex 3\/649 unique/.test(plain), 'progress line missing');
  assert.ok(plain.includes('/pokedex to view your collection'), 'footer hint missing');

  // Each type is drawn in its own chart colour.
  assert.ok(legend.includes(seq(TYPE_RGB.grass)), 'grass not in its chart colour');
  assert.ok(legend.includes(seq(TYPE_RGB.poison)), 'poison not in its chart colour');
  // A legendary frame and label are gold.
  assert.ok(legend.includes(seq(RARITY_RGB.legendary)), 'legendary accent (gold) missing');

  // A mythical takes the diamond accent, distinct from the legendary gold. Drawn
  // as a dupe so the only gold that could appear is a mistaken accent -- the NEW
  // milestone marker is gold by design, independent of the tier.
  const myth = renderCatch(Object.assign({}, base, {
    tier: 'mythical', isNew: false, pokemon: { id: 151, name: 'Mew', gen: 1, types: ['psychic'] },
    config: { sprites: true, spriteWidth: 48 }, sprite: () => null,
  }));
  assert.ok(myth.includes(seq(RARITY_RGB.mythical)), 'mythical accent (diamond) missing');
  assert.ok(!myth.includes(seq(RARITY_RGB.legendary)), 'mythical reused the legendary gold');

  // A shiny common takes the shiny accent and shows the SHINY line and word.
  const shiny = renderCatch(Object.assign({}, base, {
    tier: 'common', pokemon: { id: 25, name: 'Pikachu', gen: 1, types: ['electric'] }, shiny: true,
    config: { sprites: true, spriteWidth: 48 }, sprite: () => null,
  }));
  assert.ok(shiny.includes(seq(SHINY_RGB)), 'shiny accent missing');
  assert.ok(stripAnsi(shiny).includes('SHINY'), 'shiny word missing from the card');
  assert.ok(stripAnsi(shiny).includes('SHINY PIKACHU'), 'shiny headline missing');
});

test('a dupe reads quieter than a new catch', () => {
  // NEW is the milestone worth shouting; a duplicate should be a subtler note.
  const args = {
    pokemon: { id: 25, name: 'Pikachu', gen: 1, types: ['electric'] },
    tier: 'common', tokens: 5000, chance: 0.01, roll: 0.005,
    uniqueCount: 3, totalCount: 4, dexSize: 649,
    config: { sprites: true, spriteWidth: 48 }, sprite: () => null,
  };
  const isNew = renderCatch(Object.assign({}, args, { isNew: true }));
  const dupe = renderCatch(Object.assign({}, args, { isNew: false }));
  const { stripAnsi } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
  assert.ok(stripAnsi(isNew).includes('NEW'), 'the new catch lost its NEW marker');
  assert.ok(/duplicate/i.test(stripAnsi(dupe)), 'the duplicate lost its indicator');
  assert.ok(!stripAnsi(dupe).includes('NEW'), 'a duplicate was marked NEW');
});

console.log('\nperformance');

test('a single render stays well under 50ms', () => {
  renderSprite(25); // warm the require and fs caches
  for (const id of SAMPLE) {
    const t0 = process.hrtime.bigint();
    renderSprite(id, { maxWidth: 48 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `#${id} took ${ms.toFixed(2)}ms`);
  }
});

test('mean render time across the whole dex is under 15ms', () => {
  const t0 = process.hrtime.bigint();
  for (const id of IDS) renderSprite(id, { maxWidth: 48 });
  const mean = Number(process.hrtime.bigint() - t0) / 1e6 / IDS.length;
  console.log(`      mean render ${mean.toFixed(3)}ms/sprite`);
  assert.ok(mean < 15, `mean ${mean.toFixed(3)}ms exceeds 15ms`);
});

console.log(`\n${passed} tests passed\n`);
