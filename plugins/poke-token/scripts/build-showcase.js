#!/usr/bin/env node
/**
 * Regenerates docs/showcase/*.svg — the truecolour art and catch banners the
 * README shows off. Development-only, like the other build scripts: the repo
 * ships the generated SVGs and nothing fetches or renders at runtime.
 *
 *   node scripts/build-showcase.js          # rebuild every showcase image
 *   node scripts/build-showcase.js --check   # fail if any file is out of date
 *
 * Why SVG rather than a screenshot. The terminal art is truecolour, and a README
 * fenced code block can only show the escape-free version -- so the colour mode,
 * which is the good-looking one, was invisible to anyone browsing the repo. A PNG
 * screenshot would show it but rots immediately: it cannot be diffed, it blurs
 * when zoomed, and it drifts from the code the moment a palette or a banner line
 * changes. This draws the SAME baked payloads the plugin renders from, one <rect>
 * per run of same-coloured pixels, so the image cannot disagree with the plugin
 * and `--check` fails the moment it would.
 *
 * Constraints imposed by GitHub's markdown SVG sanitizer, all deliberate:
 *   - no <script>, no <style>, no CSS classes; every attribute is inline
 *   - no external or web fonts; `monospace` is named generically and the layout
 *     is built on a fixed advance width so a substituted font cannot reflow it
 *   - no <image>, no filters, nothing that needs a second network fetch
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(PLUGIN_ROOT, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'showcase');

const { ALPHABET, applyShiny } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
const { rule, TIER_LABEL, TIER_ICON, commas, pct } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

// ---------------------------------------------------------------------------
// Card geometry. One scale for everything, so the sprite pixels and the text
// share a grid and the whole card can be sized in one place.
// ---------------------------------------------------------------------------

const PX = 5; // svg units per sprite pixel
const FONT = 13; // text size in svg units
const LINE = 20; // baseline-to-baseline
const ADVANCE = FONT * 0.6; // monospace advance width; 0.6em is the common ratio
const PAD = 20;

/** A terminal card, dark enough to sit on either GitHub theme unchanged. */
const CARD = {
  bg: '#12141a',
  edge: '#2b303b',
  text: '#c8ccd4',
  dim: '#7f8794',
  frame: '#4b5261',
};

/** Banner accent per tier, and the colour a shiny takes over from its tier. */
const TIER_COLOR = {
  common: '#9aa3b0',
  rare: '#5aa9e6',
  legendary: '#e0a13c',
  mythical: '#d472d4',
};
const SHINY_COLOR = '#f5d76e';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Sprite -> rects
// ---------------------------------------------------------------------------

/** Loads a baked sprite, optionally swapped to its shiny palette. */
function sprite(id, shiny) {
  const s = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'data', 'sprites', `${id}.json`), 'utf8'));
  return shiny ? applyShiny(id, s) : s;
}

/**
 * Draws a sprite as a small set of <rect>s covering exactly its opaque pixels.
 *
 * Rect-merging is what keeps these files small enough to live in a repo. A naive
 * rect per pixel puts a 59x64 sprite at ~3,800 elements and a 33-sprite wall well
 * past a megabyte, which is too heavy to ask a README reader to download. So runs
 * are merged on both axes: first into horizontal spans of one colour, then any
 * span directly below an identical span is absorbed into it. Pixel art is mostly
 * flat blocks, so this typically cuts the element count by an order of magnitude
 * with a byte-identical rendering.
 *
 * Transparent pixels emit nothing at all, so the card background shows through
 * exactly as the terminal's does.
 */
function spriteRects(s, ox, oy, px = PX) {
  // Palette index per pixel, 0 for transparent, so the merge below compares
  // indices rather than re-parsing symbols.
  const index = new Int16Array(s.w * s.h);
  for (let i = 0; i < index.length; i++) {
    const k = ALPHABET.indexOf(s.px[i]);
    index[i] = k > 0 && k <= s.pal.length ? k : 0;
  }

  // Horizontal spans per row: {x, w, index}.
  const rows = [];
  for (let y = 0; y < s.h; y++) {
    const spans = [];
    let start = -1;
    for (let x = 0; x <= s.w; x++) {
      const k = x < s.w ? index[y * s.w + x] : 0;
      if (start >= 0 && k === index[y * s.w + start]) continue;
      if (start >= 0) spans.push({ x: start, w: x - start, index: index[y * s.w + start] });
      start = k === 0 ? -1 : x;
    }
    rows.push(spans);
  }

  // Grow each span downward through identical spans, marking absorbed ones so a
  // later row cannot emit them again.
  const byColor = new Map();
  for (let y = 0; y < s.h; y++) {
    for (const span of rows[y]) {
      if (span.taken) continue;
      let h = 1;
      for (let y2 = y + 1; y2 < s.h; y2++) {
        const below = rows[y2].find((o) => o.x === span.x && o.w === span.w
          && o.index === span.index && !o.taken);
        if (!below) break;
        below.taken = true;
        h++;
      }
      // Every box of one colour joins that colour's subpath list. A path carries
      // its fill once for hundreds of boxes, where a <rect> repeats the whole
      // attribute set for each -- on this art that is most of the file.
      if (!byColor.has(span.index)) byColor.set(span.index, []);
      byColor.get(span.index).push(`M${span.x} ${y}h${span.w}v${h}h-${span.w}z`);
    }
  }

  // Coordinates stay in sprite-pixel units and the group scales them, so they are
  // one or two digits instead of four. Combined with the per-colour paths this is
  // what brings the species wall down from megabytes to something a README can
  // reasonably load.
  const out = [`<g transform="translate(${ox} ${oy}) scale(${px})" shape-rendering="crispEdges">`];
  for (const [index, boxes] of byColor) {
    out.push(`<path fill="#${s.pal[index - 1]}" d="${boxes.join('')}"/>`);
  }
  out.push('</g>');
  return out;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * One line of monospace text. `xml:space="preserve"` is what keeps the ASCII
 * rules and the padded columns intact -- without it every run of spaces
 * collapses and the alignment the reports depend on is lost.
 */
function textLine(x, y, str, fill, weight) {
  return `<text x="${x}" y="${y}" xml:space="preserve"`
    + ' font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"'
    + ` font-size="${FONT}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}>`
    + `${esc(str)}</text>`;
}

/**
 * Wraps a body in an SVG root sized to it.
 *
 * `role="img"` plus a <title> is what makes the card mean something to a screen
 * reader, which otherwise gets a few hundred unlabelled rectangles.
 */
function svg(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
    + ` viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t">\n`
    + `<title id="t">${esc(title)}</title>\n`
    + `<rect width="${width}" height="${height}" rx="8" fill="${CARD.bg}"/>\n`
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8"`
    + ` fill="none" stroke="${CARD.edge}"/>\n`
    + body.join('\n')
    + '\n</svg>\n';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * A catch banner: the truecolour art above the exact text the hook prints.
 *
 * The banner lines are rebuilt here rather than parsed out of renderCatch, since
 * that function bakes in the escape-free art; the text below is character-for-
 * character what it emits.
 */
function catchCard(opts) {
  const p = dex.pokemon.find((x) => x.id === opts.id);
  const tier = p.tier;
  const accent = opts.shiny ? SHINY_COLOR : TIER_COLOR[tier];
  const s = sprite(opts.id, opts.shiny);

  let head;
  if (opts.shiny) {
    head = `${TIER_ICON[tier]} SHINY!! A shiny ${p.name.toUpperCase()} appeared and was caught!`;
  } else if (tier === 'legendary' || tier === 'mythical') {
    head = `${TIER_ICON[tier]} A ${TIER_LABEL[tier]} encounter! ${p.name.toUpperCase()} was caught!`;
  } else {
    head = `A wild ${p.name.toUpperCase()} appeared and was caught!`;
  }

  const marks = [TIER_LABEL[tier]];
  if (opts.shiny) marks.push('SHINY');
  marks.push(opts.dupe ? 'dupe' : 'NEW');

  const chance = Math.min(0.75, opts.tokens * 0.000002);
  const lines = [
    { text: head, fill: accent, weight: 'bold' },
    { text: `#${String(opts.id).padStart(3, '0')} - Gen ${p.gen} - ${marks.join(' - ')}`, fill: CARD.text },
    { text: `${commas(opts.tokens)} tokens -> ${pct(chance)} chance -> rolled ${pct(opts.roll)}`, fill: CARD.dim },
    { text: `Pokedex: ${opts.caught} caught - ${opts.unique}/${dex.count} unique`
      + ` (${pct(opts.unique / dex.count, 1)})`, fill: CARD.dim },
    { text: '/pokedex to view your collection', fill: CARD.dim },
  ];

  const artW = s.w * PX;
  const artH = s.h * PX;
  const textW = Math.max.apply(null, lines.map((l) => l.text.length)) + 4;
  const width = Math.round(PAD * 2 + Math.max(artW, textW * ADVANCE));
  const height = Math.round(PAD * 2 + artH + 14 + lines.length * LINE);

  const body = spriteRects(s, Math.round((width - artW) / 2), PAD);

  // The `+--` / `|` frame is drawn as text so it stays exactly the hook's output.
  let y = PAD + artH + 14 + FONT;
  lines.forEach((l, i) => {
    const gutter = i === 0 || i === lines.length - 1 ? '+-- ' : '|   ';
    body.push(textLine(PAD, y, gutter, CARD.frame));
    body.push(textLine(PAD + gutter.length * ADVANCE, y, l.text, l.fill, l.weight));
    y += LINE;
  });

  return { width, height, title: `${p.name} catch banner`, body };
}

/**
 * The rarity rules, stacked, so the stone-to-stars progression is visible at a
 * glance instead of having to be described.
 */
function rulesCard() {
  const rows = [
    { id: 19, tier: 'common' },
    { id: 6, tier: 'rare' },
    { id: 384, tier: 'legendary' },
    { id: 151, tier: 'mythical' },
    { id: 25, tier: 'common', shiny: true },
  ];

  // Three text lines per row plus a gap between rows. Derived rather than
  // guessed, so adding a row cannot clip the card.
  const ROW_H = LINE * 3 + 12;
  const width = Math.round(PAD * 2 + 52 * ADVANCE);
  const height = Math.round(PAD * 2 + rows.length * ROW_H);
  const body = [];

  rows.forEach((row, i) => {
    const p = dex.pokemon.find((x) => x.id === row.id);
    const accent = row.shiny ? SHINY_COLOR : TIER_COLOR[row.tier];
    const title = `#${String(p.id).padStart(4, '0')} ${p.name.toUpperCase()}`
      + (row.shiny ? '  * SHINY *' : '');
    let y = PAD + FONT + i * ROW_H;
    body.push(textLine(PAD, y, title, CARD.text, 'bold'));
    y += LINE;
    body.push(textLine(PAD, y, rule(row.tier, 52, row.shiny), accent));
    y += LINE;
    body.push(textLine(PAD, y, `  Rarity       ${TIER_LABEL[row.tier]}`
      + (row.shiny ? '  SHINY' : ''), CARD.dim));
  });

  return { width, height, title: 'Rarity header rules by tier', body };
}

/** A shiny beside its ordinary colours, which is the whole point of a shiny. */
function shinyCard(id) {
  const p = dex.pokemon.find((x) => x.id === id);
  const normal = sprite(id, false);
  const shiny = sprite(id, true);

  const artW = Math.max(normal.w, shiny.w) * PX;
  const artH = Math.max(normal.h, shiny.h) * PX;
  const gap = 40;
  const width = Math.round(PAD * 2 + artW * 2 + gap);
  const height = Math.round(PAD * 2 + artH + LINE + 10);

  const body = [];
  const left = PAD + Math.round((artW - normal.w * PX) / 2);
  const right = PAD + artW + gap + Math.round((artW - shiny.w * PX) / 2);
  body.push(...spriteRects(normal, left, PAD));
  body.push(...spriteRects(shiny, right, PAD));

  const y = PAD + artH + 10 + FONT;
  const label = (x, w, str, fill) => textLine(
    Math.round(x + (w - str.length * ADVANCE) / 2), y, str, fill, 'bold',
  );
  body.push(label(PAD, artW, p.name.toUpperCase(), CARD.dim));
  body.push(label(PAD + artW + gap, artW, `SHINY ${p.name.toUpperCase()}`, SHINY_COLOR));

  return { width, height, title: `${p.name}, ordinary and shiny colours`, body };
}

/**
 * A wall of species, to make the size of the dex felt rather than stated. Ids
 * are listed explicitly so the lineup is a deliberate spread of gens, shapes and
 * tiers rather than whatever the first N ids happen to be.
 */
function wallCard(ids, perRow) {
  const scale = 3;
  const cell = 64 * scale + 10;
  const rows = Math.ceil(ids.length / perRow);
  const width = PAD * 2 + perRow * cell;
  const height = PAD * 2 + rows * cell;
  const body = [];

  ids.forEach((id, i) => {
    const s = sprite(id, false);
    const cx = PAD + (i % perRow) * cell + Math.round((cell - s.w * scale) / 2);
    // Bottom-align inside the cell, so the sprites stand on a line instead of
    // floating at different heights.
    const cy = PAD + Math.floor(i / perRow) * cell + (cell - 10 - s.h * scale);
    body.push(...spriteRects(s, cx, cy, scale));
  });

  return { width, height, title: `${ids.length} of the 1,025 species`, body };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const CARDS = {
  'catch-legendary.svg': () => catchCard({
    id: 384, tokens: 41203, roll: 0.0211, caught: 24, unique: 19,
  }),
  'catch-shiny.svg': () => catchCard({
    id: 68, tokens: 38410, roll: 0.0102, caught: 25, unique: 20, shiny: true,
  }),
  'catch-common.svg': () => catchCard({
    id: 25, tokens: 6120, roll: 0.0044, caught: 26, unique: 21,
  }),
  'rarity-rules.svg': () => rulesCard(),
  'shiny-compare.svg': () => shinyCard(68),
  'species-wall.svg': () => wallCard([
    1, 4, 7, 25, 39, 94, 130, 143, 150,
    157, 197, 249, 254, 282, 384, 448, 483, 493,
    501, 570, 643, 658, 700, 778, 800, 887, 898,
    906, 989, 1007, 1017, 1024, 151,
  ], 9),
};

function build(name) {
  const card = CARDS[name]();
  return svg(card.width, card.height, card.title, card.body);
}

function main() {
  const check = process.argv.includes('--check');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let stale = 0;
  for (const name of Object.keys(CARDS)) {
    const file = path.join(OUT_DIR, name);
    const next = build(name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

    if (current === next) {
      process.stdout.write(`  ok    ${name}\n`);
      continue;
    }
    if (check) {
      stale++;
      process.stdout.write(`  STALE ${name}\n`);
      continue;
    }
    fs.writeFileSync(file, next);
    const kb = (Buffer.byteLength(next) / 1024).toFixed(1);
    process.stdout.write(`  ${current === null ? 'new' : 'upd'}   ${name}  ${kb}KB\n`);
  }

  if (check && stale) {
    process.stdout.write(`\n${stale} showcase image(s) out of date -- run npm run build:showcase\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { build, CARDS, OUT_DIR };
