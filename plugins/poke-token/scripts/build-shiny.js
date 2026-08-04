#!/usr/bin/env node
/**
 * Regenerates data/sprites/shiny/<id>.json — the alternate-colour palette for
 * every species that already has baked art. Development-only, like
 * build-sprites.js: the plugin ships the generated files and never fetches at
 * runtime.
 *
 *   node scripts/build-shiny.js            # every id with a baked sprite
 *   node scripts/build-shiny.js 25 384     # only these ids
 *   node scripts/build-shiny.js --missing  # only ids with no shiny palette yet
 *
 * A shiny is a pure recolour: the games reuse the same pixels and swap the
 * colours. So instead of baking a second full sprite (which would double the
 * 4.7MB of art for no new shape information), this reuses the normal sprite's
 * `px` verbatim and stores ONLY a replacement palette:
 *
 *   {"pal":["f8d030",...]}    ~400 bytes, versus ~4.6KB for a full payload
 *
 * The palette is derived by bucketing: every pixel that uses palette slot k in
 * the normal sprite contributes its shiny colour to bucket k, and the bucket
 * average becomes the shiny slot k. Deriving it through the normal sprite's own
 * indices — rather than quantizing the shiny PNG independently — is what
 * guarantees the two sprites share an exact silhouette. Quantizing separately
 * lets median-cut split a full 63-colour palette differently and shifts pixels
 * between slots, which shows up as speckle along the edges.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  getWithRetry, mapWithConcurrency, decodePng, contentBox, resample, encode, trim,
  validate: validateFull, BASE_URL, ALPHABET,
} = require(path.join(__dirname, 'build-sprites.js'));

const SPRITE_DIR = path.join(__dirname, '..', 'data', 'sprites');
const SHINY_DIR = path.join(SPRITE_DIR, 'shiny');
const CONCURRENCY = 10;

/** The baked normal sprite for an id, or null when it has no art. */
function readNormal(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SPRITE_DIR, `${id}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

function hex2(v) {
  return v.toString(16).padStart(2, '0');
}

/**
 * Builds the shiny palette for one species.
 *
 * @param {{w:number,h:number,pal:string[],px:string}} normal baked normal sprite
 * @param {{w:number,h:number,mask:Uint8Array,rgb:Uint8Array}} shiny resampled shiny image
 * @returns {string[]} one hex entry per normal palette slot
 */
function derivePalette(normal, shiny) {
  if (shiny.w !== normal.w || shiny.h !== normal.h) {
    throw new Error(`geometry ${shiny.w}x${shiny.h} != normal ${normal.w}x${normal.h}`);
  }

  const slots = normal.pal.length;
  const sum = new Float64Array((slots + 1) * 3);
  const count = new Uint32Array(slots + 1);

  for (let i = 0; i < normal.px.length; i++) {
    const slot = ALPHABET.indexOf(normal.px[i]);
    if (slot <= 0) continue;            // transparent in the normal sprite
    if (!shiny.mask[i]) continue;       // transparent in the shiny: no colour to learn
    const s = i * 3;
    const d = slot * 3;
    sum[d] += shiny.rgb[s];
    sum[d + 1] += shiny.rgb[s + 1];
    sum[d + 2] += shiny.rgb[s + 2];
    count[slot]++;
  }

  const pal = [];
  for (let slot = 1; slot <= slots; slot++) {
    if (count[slot] === 0) {
      // No shiny pixel landed on this slot (a one-pixel feature the shiny mask
      // clips). Keeping the normal colour is the honest fallback -- inventing one
      // would put a colour on screen that appears in neither sprite.
      pal.push(normal.pal[slot - 1]);
      continue;
    }
    const d = slot * 3;
    pal.push(
      hex2(Math.round(sum[d] / count[slot]))
      + hex2(Math.round(sum[d + 1] / count[slot]))
      + hex2(Math.round(sum[d + 2] / count[slot]))
    );
  }
  return pal;
}

/** Throws unless the payload satisfies every invariant lib/sprite.js relies on. */
function validate(id, normal, pal) {
  if (!Array.isArray(pal) || pal.length !== normal.pal.length) {
    throw new Error(`#${id}: palette of ${pal.length} != normal ${normal.pal.length}`);
  }
  for (const entry of pal) {
    if (!/^[0-9a-f]{6}$/.test(entry)) throw new Error(`#${id}: bad palette entry ${entry}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  const onlyMissing = argv.includes('--missing');

  fs.mkdirSync(SHINY_DIR, { recursive: true });

  // The baked normal art is the source of truth: a shiny palette is meaningless
  // without the pixels it recolours.
  let ids = explicit.length
    ? explicit
    : fs.readdirSync(SPRITE_DIR)
      .map((f) => /^(\d+)\.json$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  if (onlyMissing) ids = ids.filter((id) => !fs.existsSync(path.join(SHINY_DIR, `${id}.json`)));

  process.stderr.write(`Baking ${ids.length} shiny palettes from ${BASE_URL}/shiny...\n`);

  const skipped = [];
  let done = 0;
  let written = 0;
  let bytes = 0;
  let identical = 0;
  let full = 0;

  await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
    try {
      const normal = readNormal(id);
      if (!normal) throw new Error('no baked normal sprite');

      const png = await getWithRetry(`${BASE_URL}/shiny/${id}.png`);
      const image = decodePng(png);
      const box = contentBox(image.width, image.height, image.rgba);
      if (!box) throw new Error('fully transparent image');

      const resampled = resample(image, box);
      let payload;
      if (resampled.w === normal.w && resampled.h === normal.h) {
        const pal = derivePalette(normal, resampled);
        validate(id, normal, pal);
        // A shiny that recolours to exactly its normal palette would be invisible
        // as a reward. Worth reporting, not worth failing over.
        if (pal.every((c, i) => c === normal.pal[i])) identical++;
        payload = { pal };
      } else {
        // A minority of species (measured at 39 of 1,025) bake to a content box a
        // pixel or two off their normal art, because the shiny's own antialiasing
        // crosses the alpha cutoff differently. Their pixels are not
        // interchangeable, so they get a full standalone payload instead of a
        // palette swap. lib/sprite.js tells the two apart by looking for `px`.
        payload = trim(encode(resampled));
        validateFull(id, payload);
        full++;
      }

      const json = JSON.stringify(payload);
      fs.writeFileSync(path.join(SHINY_DIR, `${id}.json`), json);
      written++;
      bytes += Buffer.byteLength(json);
    } catch (err) {
      skipped.push(`#${id}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) process.stderr.write(`  ${done}/${ids.length}\n`);
  });

  process.stderr.write(`\nWrote ${written} shiny palettes to ${SHINY_DIR}\n`);
  process.stderr.write(`Total ${bytes} bytes, average ${written ? Math.round(bytes / written) : 0} bytes/palette\n`);
  process.stderr.write(`${written - full} palette swaps, ${full} full payloads (geometry differed)\n`);
  if (identical) process.stderr.write(`note: ${identical} recolour to their normal palette\n`);
  if (skipped.length) {
    process.stderr.write(`Skipped ${skipped.length}:\n`);
    for (const s of skipped.slice(0, 40)) process.stderr.write(`  ${s}\n`);
    if (skipped.length > 40) process.stderr.write(`  ... and ${skipped.length - 40} more\n`);
  }
  // Shinies degrade to normal art when a palette is absent, so a few gaps are
  // survivable -- but a broad failure means the mirror or decoder changed.
  if (ids.length && skipped.length > Math.max(10, ids.length * 0.02)) {
    throw new Error(`too many failures: ${skipped.length}/${ids.length}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`build-shiny failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { derivePalette, SHINY_DIR };
