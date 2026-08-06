#!/usr/bin/env node
'use strict';

/**
 * Measurement-only harness for the shipped Pokemon art paths.
 * Does NOT modify any source. Exercises the exact code that reaches a
 * systemMessage: render.renderCatch (colour) and the stats.js detail view.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

const render = require(path.join(ROOT, 'lib', 'render.js'));
const sprite = require(path.join(ROOT, 'lib', 'sprite.js'));
const color = require(path.join(ROOT, 'lib', 'color.js'));
const dex = require(path.join(ROOT, 'data', 'dex.json'));

const { renderSprite, SAFE_SYSTEMMESSAGE_WIDTH } = sprite;
const { stripAnsi, rule, TIER_LABEL } = render;

const TRUNCATE_CAP = 10000;
const HEADROOM_CAP = 8500;

const SPRITE_WIDTH_DEFAULT = 48; // config default
const DETAIL_MAXWIDTH = Math.min(SPRITE_WIDTH_DEFAULT, SAFE_SYSTEMMESSAGE_WIDTH); // 28
const ID_WIDTH = String(dex.count).length;

function byteLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

// ---- Faithful reconstruction of stats.js pokemonDetail colour path ----
// count>0 (caught) => renderSprite at maxWidth=min(spriteWidth,28); shiny toggles art.
function detailView(pokemon, { shiny }) {
  const out = [];
  const dexId = (id) => `#${String(id).padStart(ID_WIDTH, '0')}`;
  out.push(`POKEDEX  ${dexId(pokemon.id)}`);
  out.push('');
  const art = renderSprite(pokemon.id, { maxWidth: DETAIL_MAXWIDTH, shiny });
  if (art) {
    out.push(art);
    out.push('');
  }
  out.push(`${dexId(pokemon.id)} ${pokemon.name.toUpperCase()}${shiny ? '  * SHINY *' : ''}`);
  out.push(rule(pokemon.tier, undefined, shiny));
  out.push('');
  out.push(`  Generation   ${pokemon.gen}`);
  out.push(`  Rarity       ${TIER_LABEL[pokemon.tier]}`);
  out.push(`  Caught       1 time`);
  if (shiny) out.push(`  Shiny        1 of those`);
  out.push('');
  out.push('  CATCH HISTORY');
  out.push('    2026-08-06 12:00  1,000 tokens' + (shiny ? '  SHINY' : ''));
  return out.join('\n');
}

function catchBanner(pokemon, { tier, shiny }) {
  return render.renderCatch({
    pokemon,
    tier,
    tokens: 999999,
    chance: 0.5,
    roll: 0.25,
    uniqueCount: 812,
    totalCount: 4096,
    dexSize: dex.count,
    isNew: true,
    config: { sprites: true, spriteWidth: SPRITE_WIDTH_DEFAULT },
    shiny,
  });
}

// ---- Per-sprite geometry + anomaly detection (colour renderer, width 28) ----
function analyzeSpriteArt(art) {
  const lines = art.split('\n');
  const widths = lines.map((l) => stripAnsi(l).length);
  const maxW = Math.max(...widths);
  const height = lines.length;

  // Distinct non-empty visible widths among content lines (indent stripped).
  const contentWidths = new Set();
  let blankInterior = 0;
  let leakedEscape = false;
  let danglingColor = 0; // lines that do not end in a RESET but contain colour

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const vis = stripAnsi(raw);
    // A blank/whitespace-only interior line between drawn rows breaks the art.
    if (vis.trim() === '' && i > 0 && i < lines.length - 1) blankInterior++;
    contentWidths.add(vis.length);
    // Detect any literal ESC sequence that is NOT a well-formed SGR (leak).
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (stripped.includes('\x1b')) leakedEscape = true;
    // Colour opened but line does not end in reset.
    if (/\x1b\[3[0-9;]*2m|\x1b\[4[0-9;]*2m|\x1b\[38;2/.test(raw) && !raw.endsWith('\x1b[0m')) {
      danglingColor++;
    }
  }

  return {
    height,
    maxW,
    widths,
    nonUniform: contentWidths.size, // rows should be uniform visible width in colour art
    blankInterior,
    leakedEscape,
    danglingColor,
  };
}

// ---------------- run ----------------
const tiers = ['common', 'rare', 'legendary', 'mythical'];
const bannerResults = [];   // {id,tier,shiny,bytes}
const detailResults = [];   // {id,shiny,bytes}
const spriteGeom = [];      // {id,shiny,height,maxW}
const anomalies = [];

for (const p of dex.pokemon) {
  for (const shiny of [false, true]) {
    // Banner across every tier (headline/rows differ), colour path.
    for (const tier of tiers) {
      const b = catchBanner(p, { tier, shiny });
      bannerResults.push({ id: p.id, name: p.name, tier, shiny, bytes: byteLen(b) });
    }
    // Detail view.
    const d = detailView(p, { shiny });
    detailResults.push({ id: p.id, name: p.name, shiny, bytes: byteLen(d) });

    // Sprite geometry + anomalies at the detail/banner colour width (28).
    const art = renderSprite(p.id, { maxWidth: DETAIL_MAXWIDTH, shiny });
    if (art) {
      const a = analyzeSpriteArt(art);
      spriteGeom.push({ id: p.id, name: p.name, shiny, height: a.height, maxW: a.maxW });
      if (a.nonUniform > 1) {
        anomalies.push({ id: p.id, name: p.name, shiny, kind: 'non-uniform-width', detail: `${a.nonUniform} distinct visible widths (min ${Math.min(...a.widths)}, max ${a.maxW})` });
      }
      if (a.blankInterior > 0) {
        anomalies.push({ id: p.id, name: p.name, shiny, kind: 'blank-interior-line', detail: `${a.blankInterior} blank line(s) inside silhouette` });
      }
      if (a.leakedEscape) {
        anomalies.push({ id: p.id, name: p.name, shiny, kind: 'escape-leak', detail: 'non-SGR ESC byte present' });
      }
      if (a.danglingColor > 0) {
        anomalies.push({ id: p.id, name: p.name, shiny, kind: 'dangling-color', detail: `${a.danglingColor} line(s) not terminated by RESET` });
      }
    } else {
      anomalies.push({ id: p.id, name: p.name, shiny, kind: 'null-art', detail: 'renderSprite returned null' });
    }
  }
}

function report(label, arr, key, cap1, cap2) {
  const over1 = arr.filter((r) => r[key] > cap1);
  const over2 = arr.filter((r) => r[key] > cap2);
  const sorted = [...arr].sort((a, b) => b[key] - a[key]);
  console.log(`\n=== ${label} ===`);
  console.log(`samples: ${arr.length}`);
  console.log(`max ${key}: ${sorted[0][key]}  (id ${sorted[0].id} ${sorted[0].name}${sorted[0].tier ? ' ' + sorted[0].tier : ''}${sorted[0].shiny ? ' shiny' : ''})`);
  console.log(`over ${cap1} (truncate): ${over1.length}`);
  console.log(`over ${cap2} (headroom): ${over2.length}`);
  console.log('top 15 by bytes:');
  for (const r of sorted.slice(0, 15)) {
    console.log(`  ${String(r.bytes).padStart(6)}  #${r.id} ${r.name}${r.tier ? ' [' + r.tier + ']' : ''}${r.shiny ? ' shiny' : ''}`);
  }
  if (over1.length) {
    console.log(`ALL over ${cap1}:`);
    for (const r of over1.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`  ${r.bytes}  #${r.id} ${r.name}${r.tier ? ' [' + r.tier + ']' : ''}${r.shiny ? ' shiny' : ''}`);
    }
  }
}

report('CATCH BANNER (colour, systemMessage path)', bannerResults, 'bytes', TRUNCATE_CAP, HEADROOM_CAP);
report('POKEDEX DETAIL VIEW (colour, systemMessage path)', detailResults, 'bytes', TRUNCATE_CAP, HEADROOM_CAP);

// Sprite geometry
const byHeight = [...spriteGeom].sort((a, b) => b.height - a.height || b.maxW - a.maxW);
const byWidth = [...spriteGeom].sort((a, b) => b.maxW - a.maxW || b.height - a.height);
console.log('\n=== SPRITE GEOMETRY at colour width 28 ===');
console.log(`rendered sprites: ${spriteGeom.length}`);
console.log(`max height (lines): ${byHeight[0].height}   max visible width: ${byWidth[0].maxW}`);
console.log('tallest 15:');
for (const r of byHeight.slice(0, 15)) {
  console.log(`  h=${String(r.height).padStart(3)} w=${String(r.maxW).padStart(3)}  #${r.id} ${r.name}${r.shiny ? ' shiny' : ''}`);
}
console.log('widest 15:');
for (const r of byWidth.slice(0, 15)) {
  console.log(`  w=${String(r.maxW).padStart(3)} h=${String(r.height).padStart(3)}  #${r.id} ${r.name}${r.shiny ? ' shiny' : ''}`);
}
// height histogram
const hist = {};
for (const r of spriteGeom) hist[r.height] = (hist[r.height] || 0) + 1;
console.log('height distribution (lines: count):');
console.log('  ' + Object.keys(hist).map(Number).sort((a, b) => a - b).map((h) => `${h}:${hist[h]}`).join('  '));

// Anomalies
console.log('\n=== ANOMALIES ===');
console.log(`total flagged: ${anomalies.length}`);
const byKind = {};
for (const a of anomalies) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
console.log('by kind: ' + JSON.stringify(byKind));
for (const kind of Object.keys(byKind)) {
  const list = anomalies.filter((a) => a.kind === kind);
  console.log(`\n-- ${kind} (${list.length}) sample up to 20:`);
  for (const a of list.slice(0, 20)) {
    console.log(`  #${a.id} ${a.name}${a.shiny ? ' shiny' : ''}: ${a.detail}`);
  }
}

// Also measure banner at what config WOULD request (spriteWidth 48) to show the cap's effect,
// by rendering the raw sprite at 48 vs 28 for the single worst species.
console.log('\n=== WIDTH-CAP EFFECT (raw sprite bytes, worst species) ===');
const worst = byWidth[0];
for (const w of [28, 32, 48]) {
  const art = renderSprite(worst.id, { maxWidth: w, shiny: worst.shiny });
  console.log(`  #${worst.id} ${worst.name} @width ${w}: sprite ${byteLen(art)} bytes, ${art.split('\n').length} lines, visW ${Math.max(...art.split('\n').map((l) => stripAnsi(l).length))}`);
}
