#!/usr/bin/env node
/**
 * Escape-free ("plain") sprite rendering. No framework: run with
 * `node tests/sprite-plain.test.js`. Exits non-zero on the first failure.
 *
 * The point of this mode is that slash command output reaches the model as a
 * plain string with the ESC bytes stripped, so these tests care above all that
 * nothing in the output depends on an escape sequence surviving.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PLUGIN_ROOT = path.join(__dirname, '..');

const spriteLib = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
const {
  renderSprite, renderSpritePlain, spritePath, plainSize,
  PLAIN_RAMP, PLAIN_QUADRANT, PLAIN_SUB, PLAIN_MAX_WIDTH,
} = spriteLib;
const { loadConfig, DEFAULTS, SPRITE_MODES, CONFIG_PATH } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

const IDS = dex.pokemon.map((p) => p.id);
// A spread of gens and shapes: Bulbasaur, Charizard, Pikachu, Mew, Rayquaza,
// Genesect, Greninja, Mimikyu, Koraidon, and whatever currently ends the dex.
const SAMPLE = [1, 6, 25, 151, 384, 649, 658, 778, 1007, Math.max.apply(null, IDS)];
const TRANSPARENT = spriteLib.ALPHABET[0];

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

/** Reads every baked sprite once; the geometry tests all share this. */
const sprites = new Map();
for (const id of IDS) {
  sprites.set(id, JSON.parse(fs.readFileSync(spritePath(id), 'utf8')));
}

/** The cell grid the plain renderer should choose for a sprite at a budget. */
function sizeOf(sprite, maxWidth) {
  return plainSize(sprite.w, sprite.h, Math.min(Math.floor(maxWidth), PLAIN_MAX_WIDTH));
}

const RAMP_SET = new Set(PLAIN_RAMP.split(''));
// Every glyph the renderer may emit for a drawn cell: a quadrant for a partly
// covered cell, a ramp glyph for a fully covered one. The empty quadrant is a
// space, which counts as blank rather than drawn.
const QUAD_SET = new Set(PLAIN_QUADRANT.slice(1));
const DRAWN_SET = new Set([...RAMP_SET, ...QUAD_SET]);

console.log('\nescape freedom');

test('no rendered sprite in the dex contains an ESC byte', () => {
  // The whole reason this mode exists. Checked across the entire dex rather than
  // a sample, because one escaped sprite is one broken /pokedex entry.
  for (const id of IDS) {
    const art = renderSpritePlain(id, { maxWidth: 48 });
    assert.ok(art, `#${id}: no art`);
    assert.strictEqual(art.indexOf('\x1b'), -1, `#${id}: art contains an ESC byte`);
  }
});

test('no ESC byte appears at any width, indent, or shininess', () => {
  for (const id of SAMPLE) {
    for (const maxWidth of [8, 16, 32, 48, 64, 128]) {
      for (const shiny of [false, true]) {
        const art = renderSpritePlain(id, { maxWidth, shiny, indent: '>> ' });
        assert.strictEqual(art.indexOf('\x1b'), -1, `#${id} @${maxWidth} shiny=${shiny}`);
      }
    }
  }
});

test('output holds no C0 control character other than the line separator', () => {
  // A bare CR or a stray backspace would corrupt the captured string just as
  // surely as an ESC does, so nothing below 0x20 but \n is acceptable.
  for (const id of SAMPLE) {
    const art = renderSpritePlain(id, { maxWidth: 48 });
    for (let i = 0; i < art.length; i++) {
      const code = art.charCodeAt(i);
      assert.ok(code === 10 || code >= 0x20, `#${id}: control char 0x${code.toString(16)} at ${i}`);
    }
  }
});

test('the colour renderer still emits escapes, so the two modes stay distinct', () => {
  // Guards against a refactor that accidentally routed colour through plain.
  const colour = renderSprite(25);
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(colour), 'colour mode lost its escapes');
  assert.notStrictEqual(colour, renderSpritePlain(25));
});

console.log('\nglyph vocabulary');

test('only ramp glyphs, quadrant glyphs, spaces and newlines are ever emitted', () => {
  for (const id of IDS) {
    const art = renderSpritePlain(id, { maxWidth: 48, indent: '' });
    for (const ch of new Set(art.replace(/\n/g, '').split(''))) {
      assert.ok(ch === ' ' || DRAWN_SET.has(ch), `#${id}: unexpected glyph ${JSON.stringify(ch)}`);
    }
  }
});

test('the ramp runs darkest to lightest and every glyph is distinct', () => {
  assert.ok(PLAIN_RAMP.length >= 2, 'a ramp of one glyph cannot show shading');
  assert.strictEqual(new Set(PLAIN_RAMP.split('')).size, PLAIN_RAMP.length, 'duplicate ramp glyph');
  assert.strictEqual(PLAIN_RAMP.indexOf(' '), -1, 'space must not be a ramp entry: it means transparent');
});

test('the quadrant table is a complete, distinct 4-bit coverage map', () => {
  // The renderer indexes this table by a raw bitmask, so a short or duplicated
  // table would silently draw the wrong shape for some coverage patterns.
  assert.strictEqual(PLAIN_QUADRANT.length, 1 << (PLAIN_SUB * PLAIN_SUB),
    'the table must hold one glyph per coverage mask');
  assert.strictEqual(new Set(PLAIN_QUADRANT).size, PLAIN_QUADRANT.length, 'duplicate quadrant glyph');
  assert.strictEqual(PLAIN_QUADRANT[0], ' ', 'the empty mask must be blank');
  assert.strictEqual(PLAIN_QUADRANT.indexOf(' '), 0, 'only the empty mask may be a space');
});

test('quadrants actually appear, which is what makes the art fine-grained', () => {
  // Without these the art degrades to one glyph per cell -- the coarse rendering
  // this mode exists to avoid. Every sprite has edges, so every sprite has some.
  for (const id of SAMPLE) {
    const art = renderSpritePlain(id, { maxWidth: 32, indent: '' });
    const quads = art.split('').filter((c) => QUAD_SET.has(c)).length;
    assert.ok(quads > 0, `#${id}: no quadrant glyph -- edges are being rounded to whole cells`);
  }
});

console.log('\nluminance mapping');

/**
 * Renders a synthetic one-row sprite through the real renderer by swapping a
 * baked file, so the ramp is exercised end to end rather than through a private
 * helper. Restores the original file afterwards.
 */
function withSprite(payload, fn) {
  const backup = fs.readFileSync(spritePath(1), 'utf8');
  try {
    fs.writeFileSync(spritePath(1), JSON.stringify(payload));
    return fn();
  } finally {
    fs.writeFileSync(spritePath(1), backup);
  }
}

/**
 * Source pixels one output CELL covers, on each axis.
 *
 * A cell is PLAIN_SUB subcells wide, each one source pixel at native width; it is
 * PLAIN_SUB subrows tall, and a subrow spans PLAIN_ASPECT source rows because the
 * grid is squashed vertically to correct the cell aspect ratio.
 */
const CELL_W = PLAIN_SUB;
const CELL_H = PLAIN_SUB * spriteLib.PLAIN_ASPECT;

/**
 * Builds a one-row-of-cells sprite from a list of palette symbol indices, one per
 * cell, each filling its cell completely. Uniform cells are what isolate the
 * luminance ramp: every subcell of a cell agrees, so the glyph is a ramp entry
 * chosen purely by colour rather than a quadrant chosen by coverage.
 */
function cellBands(pal, indices) {
  const w = indices.length * CELL_W;
  let px = '';
  for (let y = 0; y < CELL_H; y++) {
    for (const index of indices) px += spriteLib.ALPHABET[index].repeat(CELL_W);
  }
  return { w, h: CELL_H, pal, px };
}

/** Renders a `cellBands` fixture and returns the single row of cells. */
function renderBands(pal, indices) {
  return withSprite(cellBands(pal, indices),
    () => renderSpritePlain(1, { maxWidth: indices.length, indent: '' }));
}

test('a dark colour and a light colour map to different glyphs', () => {
  // Black, mid grey and white, one uniform cell each, so nothing but the ramp is
  // under test.
  const art = renderBands(['000000', '808080', 'ffffff'], [1, 2, 3]);
  assert.strictEqual(art.length, 3, `expected 3 cells, got ${JSON.stringify(art)}`);
  assert.strictEqual(art[0], PLAIN_RAMP[0], `black is not the darkest glyph: ${art}`);
  assert.strictEqual(art[2], PLAIN_RAMP[PLAIN_RAMP.length - 1],
    `white is not the lightest glyph: ${art}`);
  assert.notStrictEqual(art[0], art[1], 'black and grey share a glyph');
  assert.notStrictEqual(art[1], art[2], 'grey and white share a glyph');
});

test('the ramp is monotonic: brighter never yields a denser glyph', () => {
  // Sweeping the full grey range must produce ramp indices that only ever move
  // toward lighter, which is what makes the art readable as shading.
  const steps = 32;
  const pal = [];
  const indices = [];
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i / (steps - 1)) * 255).toString(16).padStart(2, '0');
    pal.push(v + v + v);
    indices.push(i + 1);
  }
  const art = renderBands(pal, indices);
  let last = -1;
  for (let i = 0; i < steps; i++) {
    const idx = PLAIN_RAMP.indexOf(art[i]);
    assert.ok(idx >= 0, `step ${i} is not a ramp glyph: ${JSON.stringify(art[i])}`);
    assert.ok(idx >= last, `step ${i} got denser (${idx} < ${last}) as the colour brightened`);
    last = idx;
  }
  assert.ok(last > 0, 'the whole grey sweep collapsed onto one glyph');
});

test('luminance is perceptual, not a channel average', () => {
  // Pure green and pure blue have identical channel sums but are nowhere near
  // equally bright; a naive (r+g+b)/3 would map them to the same glyph.
  const art = renderBands(['00ff00', '0000ff'], [1, 2]);
  const green = PLAIN_RAMP.indexOf(art[0]);
  const blue = PLAIN_RAMP.indexOf(art[1]);
  assert.ok(green > blue, `green (${green}) should read lighter than blue (${blue}): ${art}`);
});

console.log('\ntransparency');

test('a fully transparent cell renders as a space, not a glyph', () => {
  // The silhouette is the whole point: transparent must be blank, and must not
  // be mistaken for the black end of the ramp.
  const art = renderBands(['ffffff'], [1, 0, 1]);
  assert.strictEqual(art[1], ' ', `transparent middle was painted: ${JSON.stringify(art)}`);
});

test('transparent pixels never become the darkest glyph even against black art', () => {
  // Black art on a clear background is the case that catches an implementation
  // treating index 0 as a real colour: both would come out as a full block.
  const art = renderBands(['000000'], [1, 1, 0]);
  assert.strictEqual(art, PLAIN_RAMP[0].repeat(2), `black art did not fill its cells: ${JSON.stringify(art)}`);
});

test('a half-covered cell draws a quadrant, not a whole-cell glyph', () => {
  // The core of the fine-grained rendering: a cell whose left half is opaque must
  // come out as a left-half glyph. Rounding it to a full block would fatten the
  // silhouette by half a cell, and to a space would eat that half outright.
  const w = PLAIN_SUB;
  let px = '';
  for (let y = 0; y < CELL_H; y++) px += '1'.repeat(w / 2) + '0'.repeat(w / 2);
  const art = withSprite({ w, h: CELL_H, pal: ['ffffff'], px },
    () => renderSpritePlain(1, { maxWidth: 1, indent: '' }));
  assert.strictEqual(art, '▌', `left-half cell drew ${JSON.stringify(art)}`);
});

test('each quadrant of a cell is resolved independently', () => {
  // One opaque subcell per corner, each in its own cell, must select that corner's
  // glyph -- proof the 2x2 mask maps to the right bit rather than collapsing.
  const half = CELL_H / PLAIN_SUB; // source rows spanned by one subrow
  const corners = [
    { at: [0, 0], glyph: '▘' },
    { at: [0, 1], glyph: '▝' },
    { at: [1, 0], glyph: '▖' },
    { at: [1, 1], glyph: '▗' },
  ];
  for (const { at, glyph } of corners) {
    const [sy, sx] = at;
    let px = '';
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < PLAIN_SUB; x++) {
        const inRow = y >= sy * half && y < (sy + 1) * half;
        px += inRow && x === sx ? '1' : '0';
      }
    }
    const art = withSprite({ w: PLAIN_SUB, h: CELL_H, pal: ['ffffff'], px },
      () => renderSpritePlain(1, { maxWidth: 1, indent: '' }));
    assert.strictEqual(art, glyph, `subcell (${sx},${sy}) drew ${JSON.stringify(art)}, expected ${glyph}`);
  }
});

test('every cell draws exactly the quadrant mask its source blocks imply', () => {
  // Full-fidelity check over real art, at subcell resolution. Re-derive the
  // coverage mask independently from the alpha channel and require the art to
  // agree cell for cell: that is what proves the silhouette is driven by the
  // source at half-cell precision rather than rounded to whole cells.
  for (const id of SAMPLE) {
    const s = sprites.get(id);
    const art = renderSpritePlain(id, { maxWidth: PLAIN_MAX_WIDTH, indent: '' });
    const rows = art.split('\n');
    const size = sizeOf(s, PLAIN_MAX_WIDTH);
    assert.strictEqual(rows.length, size.rows, `#${id}: row count ${rows.length} != ${size.rows}`);

    const covered = (sy, sx) => {
      const y0 = Math.floor((sy * s.h) / size.subH);
      const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * s.h) / size.subH));
      const x0 = Math.floor((sx * s.w) / size.subW);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * s.w) / size.subW));
      let opaque = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          if (s.px[y * s.w + x] !== TRANSPARENT) opaque++;
        }
      }
      return opaque / total >= 0.5;
    };

    for (let row = 0; row < size.rows; row++) {
      // Trailing blanks are trimmed, so pad the row back out before comparing.
      const line = rows[row].padEnd(size.cols, ' ');
      for (let col = 0; col < size.cols; col++) {
        let mask = 0;
        for (let sy = 0; sy < PLAIN_SUB; sy++) {
          const y = row * PLAIN_SUB + sy;
          if (y >= size.subH) continue;
          for (let sx = 0; sx < PLAIN_SUB; sx++) {
            if (covered(y, col * PLAIN_SUB + sx)) mask |= 1 << (sy * PLAIN_SUB + sx);
          }
        }
        const glyph = line[col];
        const where = `#${id}: cell (${col},${row}) mask ${mask}`;
        if (mask === PLAIN_QUADRANT.length - 1) {
          // A full cell spends its glyph on shading instead of on the mask.
          assert.ok(RAMP_SET.has(glyph), `${where} is full but drew ${JSON.stringify(glyph)}`);
        } else {
          assert.strictEqual(glyph, PLAIN_QUADRANT[mask], `${where} drew ${JSON.stringify(glyph)}`);
        }
      }
    }
  }
});

test('art is neither blank nor a solid blob: the silhouette has real edges', () => {
  // A transparency bug shows up as one of two failures -- everything blank, or
  // every cell filled. Real sprite art sits well inside both bounds.
  for (const id of IDS) {
    const art = renderSpritePlain(id, { maxWidth: 48, indent: '' });
    const body = art.replace(/\n/g, '');
    let filled = 0;
    for (const ch of body) if (ch !== ' ') filled++;
    const ratio = filled / body.length;
    assert.ok(ratio > 0.1, `#${id}: only ${(ratio * 100).toFixed(1)}% of cells drawn -- art is near blank`);
    assert.ok(ratio < 0.98, `#${id}: ${(ratio * 100).toFixed(1)}% of cells drawn -- art is a solid blob`);
  }
});

test('a sprite with a transparent border leaves that border blank', () => {
  // A ring of clear cells around a solid centre: the outer rows and columns must
  // come back empty, which is the minimal form of "the silhouette reads". Built
  // 3x3 in cells so the centre fills exactly one cell and the border is a
  // full cell thick on every side.
  const w = 3 * CELL_W;
  let px = '';
  for (let y = 0; y < 3 * CELL_H; y++) {
    const midRow = y >= CELL_H && y < CELL_H * 2;
    for (let x = 0; x < w; x++) {
      const midCol = x >= CELL_W && x < CELL_W * 2;
      px += midRow && midCol ? '1' : '0';
    }
  }
  const art = withSprite({ w, h: 3 * CELL_H, pal: ['ffffff'], px },
    () => renderSpritePlain(1, { maxWidth: 3, indent: '' }));
  const rows = art.split('\n');
  assert.strictEqual(rows.length, 3, `expected 3 rows, got ${rows.length}: ${JSON.stringify(art)}`);
  assert.strictEqual(rows[0], '', `top border not blank: ${JSON.stringify(rows[0])}`);
  assert.strictEqual(rows[2], '', `bottom border not blank: ${JSON.stringify(rows[2])}`);
  assert.strictEqual(rows[1][0], ' ', `left border not blank: ${JSON.stringify(rows[1])}`);
  assert.ok(RAMP_SET.has(rows[1][1]), `centre cell not drawn: ${JSON.stringify(rows[1])}`);
  assert.strictEqual(rows[1].length, 2, `right border not trimmed: ${JSON.stringify(rows[1])}`);
});

console.log('\ngeometry and width');

test('plain art stays compact even though each cell resolves four subcells', () => {
  // The detail comes from subdividing cells, not from spending more of them: a
  // cell per PLAIN_SUB source pixels, bounded by PLAIN_MAX_WIDTH, with rows
  // squashed for cell aspect. The footprint must stay roughly a quarter of the
  // source pixel grid, which is what keeps the banner terminal-sized.
  for (const id of SAMPLE) {
    const s = sprites.get(id);
    const art = renderSpritePlain(id, { maxWidth: 48, indent: '' });
    const rows = art.split('\n');
    const expected = sizeOf(s, 48);
    assert.strictEqual(rows.length, expected.rows,
      `#${id}: ${rows.length} rows, expected ${expected.rows}`);
    const widest = Math.max.apply(null, rows.map((r) => r.length));
    assert.ok(widest <= PLAIN_MAX_WIDTH,
      `#${id}: ${widest} columns exceeds the ${PLAIN_MAX_WIDTH} cap`);
    assert.ok(widest <= Math.ceil(s.w / PLAIN_SUB),
      `#${id}: ${widest} columns is wider than a cell per ${PLAIN_SUB} pixels`);
    // A quarter of the source height, give or take rounding, is the whole point.
    const cellRows = PLAIN_SUB * spriteLib.PLAIN_ASPECT;
    assert.ok(rows.length <= Math.ceil(s.h / cellRows) + 1,
      `#${id}: ${rows.length} rows is not a squashed ${s.h}`);
  }
});

test('no line exceeds the requested width in characters', () => {
  for (const maxWidth of [8, 16, 32, 48, 64]) {
    for (const id of IDS) {
      const indent = '   ';
      for (const line of renderSpritePlain(id, { maxWidth, indent }).split('\n')) {
        assert.ok(line.length - indent.length <= maxWidth,
          `#${id} @${maxWidth}: line of ${line.length - indent.length} exceeds budget`);
      }
    }
  }
});

test('the cell grid matches the exported sizing rule at every width', () => {
  for (const maxWidth of [8, 16, 32, 48, 64]) {
    for (const id of IDS) {
      const expected = sizeOf(sprites.get(id), maxWidth);
      const lines = renderSpritePlain(id, { maxWidth, indent: '' }).split('\n');
      assert.strictEqual(lines.length, expected.rows, `#${id} @${maxWidth}: height`);
      // Trailing blanks are trimmed, so the widest line is the true grid width.
      const widest = Math.max.apply(null, lines.map((l) => l.length));
      assert.ok(widest <= expected.cols, `#${id} @${maxWidth}: ${widest} > ${expected.cols}`);
    }
  }
});

test('plainSize agrees with the source aspect ratio in subcells', () => {
  // The sizing rule is the only place the aspect correction lives, so check it
  // directly: a subcell is one source pixel wide and PLAIN_ASPECT tall, so the
  // subcell grid should be about half the source ratio.
  for (const id of IDS) {
    const s = sprites.get(id);
    const size = plainSize(s.w, s.h, PLAIN_MAX_WIDTH);
    assert.strictEqual(size.subW, size.cols * PLAIN_SUB, `#${id}: subW is not cols x ${PLAIN_SUB}`);
    assert.strictEqual(size.rows, Math.ceil(size.subH / PLAIN_SUB), `#${id}: rows is not subH / ${PLAIN_SUB}`);
    const wanted = (s.h / s.w) / spriteLib.PLAIN_ASPECT;
    const got = size.subH / size.subW;
    assert.ok(Math.abs(got - wanted) / wanted < 0.1,
      `#${id}: subcell ratio ${got.toFixed(3)} vs expected ${wanted.toFixed(3)}`);
  }
});

test('a wider budget never yields fewer columns than a narrower one', () => {
  for (const id of SAMPLE) {
    let previous = 0;
    for (const maxWidth of [8, 16, 24, 32, 48, 64]) {
      const lines = renderSpritePlain(id, { maxWidth, indent: '' }).split('\n');
      const widest = Math.max.apply(null, lines.map((l) => l.length));
      assert.ok(widest >= previous, `#${id}: @${maxWidth} narrower (${widest}) than the previous step (${previous})`);
      previous = widest;
    }
  }
});

test('the art is never upscaled past one subcell per pixel', () => {
  // Subcells already resolve every source pixel; more cells would stretch the art
  // without recovering detail. An absurd budget must still cap out.
  for (const id of SAMPLE) {
    const s = sprites.get(id);
    const lines = renderSpritePlain(id, { maxWidth: 512, indent: '' }).split('\n');
    const widest = Math.max.apply(null, lines.map((l) => l.length));
    assert.ok(widest <= Math.min(Math.ceil(s.w / PLAIN_SUB), PLAIN_MAX_WIDTH),
      `#${id}: ${widest} chars exceeds the source width / cap`);
    assert.strictEqual(lines.length, sizeOf(s, 512).rows, `#${id}: height was upscaled`);
  }
});

test('the aspect ratio stays close to the source once cells are counted as half-width', () => {
  // A cell is about half as wide as it is tall, so a source region drawn two cells
  // wide and one row tall is roughly square. The rendered ratio should therefore
  // track the source ratio rather than drifting toward a squashed banner.
  for (const id of SAMPLE) {
    const s = sprites.get(id);
    const lines = renderSpritePlain(id, { maxWidth: 48, indent: '' }).split('\n');
    const squareW = Math.max.apply(null, lines.map((l) => l.length)) / 2;
    const rendered = squareW / lines.length;
    const source = s.w / s.h;
    assert.ok(Math.abs(rendered - source) / source < 0.25,
      `#${id}: rendered ratio ${rendered.toFixed(2)} vs source ${source.toFixed(2)}`);
  }
});

test('indent prefixes every non-blank line and is not counted as art', () => {
  for (const indent of ['', '   ', '>>>>']) {
    for (const line of renderSpritePlain(25, { indent }).split('\n')) {
      // A row that is entirely transparent trims to empty, indent included.
      assert.ok(line === '' || line.startsWith(indent), `missing indent ${JSON.stringify(indent)}: ${JSON.stringify(line)}`);
    }
  }
});

console.log('\ndownsampling');

test('a narrow budget still produces recognisable, non-degenerate art', () => {
  for (const id of SAMPLE) {
    const art = renderSpritePlain(id, { maxWidth: 16, indent: '' });
    const body = art.replace(/\n/g, '');
    let filled = 0;
    for (const ch of body) if (ch !== ' ') filled++;
    assert.ok(filled > 0, `#${id}: downsampled to nothing`);
    assert.ok(filled < body.length, `#${id}: downsampled to a solid block`);
    assert.ok(art.split('\n').length >= 4, `#${id}: only ${art.split('\n').length} rows at width 16`);
  }
});

/**
 * Renders a single cell whose four subcells each average a 2x2 source block.
 *
 * `block` is the 2x2 pattern of palette symbols every subcell is filled with, so
 * the same downsampling question is asked four times over and the answer shows up
 * as a whole-cell glyph rather than a quadrant.
 */
function oneCell(pal, block) {
  const w = 2 * PLAIN_SUB;
  let px = '';
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) px += block[(y % 2) * 2 + (x % 2)];
  }
  return withSprite({ w, h: w, pal, px },
    () => renderSpritePlain(1, { maxWidth: 1, indent: '' }));
}

test('a mostly-clear block downsamples to a space and a mostly-solid one to a glyph', () => {
  // Coverage thresholding, now per subcell: a 2x2 source block with one opaque
  // pixel is 25% covered and must stay blank, while three opaque pixels is 75% and
  // must draw. With every subcell the same, the whole cell follows.
  const quarter = oneCell(['ffffff'], '1000');
  // The blank cell is the whole row, so trailing-blank trimming empties it.
  assert.strictEqual(quarter, '', `25% coverage drew art: ${JSON.stringify(quarter)}`);

  const threeQuarters = oneCell(['ffffff'], '1110');
  assert.ok(RAMP_SET.has(threeQuarters[0]), `75% coverage stayed blank: ${JSON.stringify(threeQuarters)}`);
});

test('downsampling averages luminance rather than point sampling', () => {
  // A block of two black and two white pixels should land mid-ramp, not on
  // whichever pixel a point sampler happened to hit.
  const art = oneCell(['000000', 'ffffff'], '1212');
  const idx = PLAIN_RAMP.indexOf(art[0]);
  assert.ok(idx > 0 && idx < PLAIN_RAMP.length - 1,
    `averaged block landed at ramp end ${idx}: ${JSON.stringify(art)}`);
});

console.log('\nshiny and failure modes');

test('shiny art renders escape-free and keeps the silhouette', () => {
  for (const id of SAMPLE) {
    const normal = renderSpritePlain(id, { maxWidth: 48 });
    const shiny = renderSpritePlain(id, { maxWidth: 48, shiny: true });
    assert.ok(shiny, `#${id}: no shiny art`);
    assert.strictEqual(shiny.indexOf('\x1b'), -1, `#${id}: shiny art contains an ESC byte`);
    // A recolour may shift glyphs on the ramp, but the alpha mask is unchanged,
    // so the blank cells must land in exactly the same places.
    const mask = (s) => s.split('\n').map((l) => l.padEnd(200, ' ').replace(/[^ ]/g, '#')).join('\n');
    assert.strictEqual(mask(shiny), mask(normal), `#${id}: shiny silhouette differs`);
  }
});

test('shiny:false matches an omitted flag', () => {
  for (const id of SAMPLE) {
    assert.strictEqual(renderSpritePlain(id, { shiny: false }), renderSpritePlain(id), `#${id}`);
  }
});

test('nonexistent ids return null rather than throwing', () => {
  for (const bad of [0, -1, dex.count + 1, 99999, 1.5, NaN, null, undefined, '25', {}]) {
    assert.strictEqual(renderSpritePlain(bad), null, `input ${JSON.stringify(bad)}`);
  }
});

test('malformed options fall back to defaults instead of throwing', () => {
  for (const bad of [null, {}, { maxWidth: 'wide' }, { maxWidth: NaN }, { maxWidth: 0 },
    { maxWidth: -5 }, { maxWidth: Infinity }, { indent: 7 }]) {
    const art = renderSpritePlain(25, bad);
    assert.ok(typeof art === 'string' && art.length > 0, `options ${JSON.stringify(bad)}`);
    assert.strictEqual(art.indexOf('\x1b'), -1, `options ${JSON.stringify(bad)} leaked an escape`);
  }
});

test('a corrupted sprite file returns null rather than throwing', () => {
  const corruptions = [
    'not json at all',
    '[]',
    'null',
    '{"w":64,"h":64,"pal":["ff0000"],"px":"abc"}',
    '{"w":64,"h":2,"pal":[],"px":"' + '0'.repeat(128) + '"}',
    '{"w":64,"h":1,"pal":["ZZZZZZ"],"px":"' + '1'.repeat(64) + '"}',
    '{"w":0,"h":0,"pal":["ff0000"],"px":""}',
  ];
  const backup = fs.readFileSync(spritePath(1), 'utf8');
  try {
    for (const bad of corruptions) {
      fs.writeFileSync(spritePath(1), bad);
      assert.strictEqual(renderSpritePlain(1), null, `accepted ${bad.slice(0, 40)}`);
    }
  } finally {
    fs.writeFileSync(spritePath(1), backup);
  }
  assert.ok(renderSpritePlain(1), 'restore of sprite 1 failed');
});

test('the last palette slot is drawn without indexing off the luminance table', () => {
  // loadSprite accepts indices up to pal.length; a payload whose symbol exceeds
  // that is rejected outright, but the renderer must also survive the in-range
  // edge -- the final slot -- without reading past the end of the table.
  const art = renderBands(['ffffff'], [1, 0]);
  assert.strictEqual(art, PLAIN_RAMP[PLAIN_RAMP.length - 1],
    `the last palette slot did not draw: ${JSON.stringify(art)}`);
});

console.log('\nconfig integration');

test('spriteMode defaults to plain, the only mode that survives capture', () => {
  assert.strictEqual(DEFAULTS.spriteMode, 'plain');
  assert.deepStrictEqual(SPRITE_MODES, ['color', 'plain']);
});

/** Runs loadConfig against a temporary config directory holding `raw`. */
function withConfig(raw, fn) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tp-plain-cfg-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    if (raw !== undefined) fs.writeFileSync(CONFIG_PATH(), raw);
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig accepts either mode and normalises case and padding', () => {
  for (const value of ['color', 'COLOR', '  Color  ']) {
    const cfg = withConfig(JSON.stringify({ spriteMode: value }), () => loadConfig());
    assert.strictEqual(cfg.spriteMode, 'color', `value ${JSON.stringify(value)}`);
  }
  assert.strictEqual(withConfig(JSON.stringify({ spriteMode: 'PLAIN' }), () => loadConfig()).spriteMode, 'plain');
});

test('an unrecognised spriteMode falls back to plain rather than disabling art', () => {
  for (const bad of ['plane', '', 'true', 42, null, [], {}]) {
    const cfg = withConfig(JSON.stringify({ spriteMode: bad }), () => loadConfig());
    assert.strictEqual(cfg.spriteMode, 'plain', `value ${JSON.stringify(bad)}`);
  }
  // An absent field and an unreadable file both mean "the default".
  assert.strictEqual(withConfig('{}', () => loadConfig()).spriteMode, 'plain');
  assert.strictEqual(withConfig('not json', () => loadConfig()).spriteMode, 'plain');
  assert.strictEqual(withConfig(undefined, () => loadConfig()).spriteMode, 'plain');
});

test('the catch banner honours plain mode and stays escape-free', () => {
  const { renderCatch } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
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
  const plain = renderCatch(Object.assign({}, args, {
    config: { sprites: true, spriteWidth: 48, spriteMode: 'plain' },
  }));
  assert.strictEqual(plain.indexOf('\x1b'), -1, 'plain catch banner leaked an escape');
  assert.ok(plain.indexOf('A wild PIKACHU') !== -1, 'the banner text is missing');
  const drawn = plain.split('').filter((c) => DRAWN_SET.has(c)).length;
  assert.ok(drawn > 100, `only ${drawn} art glyphs in the banner -- art is missing`);

  // An omitted mode means the default, which is plain: a banner that reaches the
  // model with its escapes stripped must not be the thing that carries them.
  const fallback = renderCatch(Object.assign({}, args, {
    config: { sprites: true, spriteWidth: 48 },
  }));
  assert.strictEqual(fallback.indexOf('\x1b'), -1, 'the default catch banner is not escape-free');
  assert.strictEqual(fallback, plain, 'an omitted mode did not fall back to plain');

  // Colour is still reachable, and still colour.
  const colour = renderCatch(Object.assign({}, args, {
    config: { sprites: true, spriteWidth: 48, spriteMode: 'color' },
  }));
  assert.ok(/\x1b\[38;2;/.test(colour), 'colour mode lost its colour art');
});

console.log('\nstats.js integration');

const { spawnSync } = require('child_process');

/**
 * Runs /pokedex for one species against a sandboxed config + collection. An
 * undefined `spriteMode` writes an empty config, i.e. exercises the default.
 */
function pokedex(spriteMode, arg) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tp-plain-stats-'));
  try {
    const dataDirPath = path.join(dir, 'token-pokemon');
    fs.mkdirSync(dataDirPath, { recursive: true });
    fs.writeFileSync(path.join(dataDirPath, 'config.json'),
      JSON.stringify(spriteMode === undefined ? {} : { spriteMode }));
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'stats.js'), '--', arg], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: dir }),
    });
    assert.strictEqual(r.status, 0, `stats.js exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('/pokedex in plain mode emits a sprite with no ESC byte at all', () => {
  const out = pokedex('plain', 'pikachu');
  assert.strictEqual(out.indexOf('\x1b'), -1, 'plain mode leaked an escape through stats.js');
  // The art must actually be there, not silently dropped.
  const drawn = out.split('').filter((c) => DRAWN_SET.has(c)).length;
  assert.ok(drawn > 100, `only ${drawn} art glyphs in the report -- art is missing`);
  assert.ok(/PIKACHU/.test(out), 'the text report is missing');
});

test('/pokedex with no configured mode is escape-free, since plain is the default', () => {
  // This is the path that matters most: the command's stdout is captured as a
  // string, so the out-of-the-box report must not depend on escapes surviving.
  const out = pokedex(undefined, 'pikachu');
  assert.strictEqual(out.indexOf('\x1b'), -1, 'the default /pokedex leaked an escape');
  const drawn = out.split('').filter((c) => DRAWN_SET.has(c)).length;
  assert.ok(drawn > 100, `only ${drawn} art glyphs in the report -- art is missing`);
});

test('/pokedex in colour mode still emits colour escapes', () => {
  const out = pokedex('color', 'pikachu');
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(out), 'colour mode lost its colour art');
});

console.log('\nperformance');

test('a single plain render stays well under 50ms', () => {
  renderSpritePlain(25); // warm the require and fs caches
  for (const id of SAMPLE) {
    const t0 = process.hrtime.bigint();
    renderSpritePlain(id, { maxWidth: 48 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `#${id} took ${ms.toFixed(2)}ms`);
  }
});

test('mean plain render time across the whole dex is under 15ms', () => {
  const t0 = process.hrtime.bigint();
  for (const id of IDS) renderSpritePlain(id, { maxWidth: 48 });
  const mean = Number(process.hrtime.bigint() - t0) / 1e6 / IDS.length;
  console.log(`      mean plain render ${mean.toFixed(3)}ms/sprite`);
  assert.ok(mean < 15, `mean ${mean.toFixed(3)}ms exceeds 15ms`);
});

console.log(`\n${passed} tests passed\n`);
