#!/usr/bin/env node
/**
 * Regenerates data/sprites/<id>.json from the PokeAPI sprite mirror, for every
 * species listed in data/dex.json. Development-only: the plugin ships the
 * generated files so that nothing at runtime ever touches the network, and no
 * PNG decoding happens in a hook.
 *
 *   node scripts/build-sprites.js            # every id in the dex
 *   node scripts/build-sprites.js 25 384     # only these ids
 *   node scripts/build-sprites.js --missing  # only ids with no baked file yet
 *
 * Pipeline per sprite (all with Node stdlib only):
 *   fetch 96x96 PNG -> decode (IHDR/PLTE/tRNS/IDAT, filters 0-4) -> crop to the
 *   content bounding box -> binary alpha mask at >= 128 -> downscale to fit
 *   64x64 (nearest for the mask, opaque-only box average for colour) ->
 *   median-cut to <= 63 colours -> one character per pixel from a 64-symbol
 *   alphabet where index 0 means transparent.
 */

'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const DEX_PATH = path.join(__dirname, '..', 'data', 'dex.json');
const CONCURRENCY = 10;
const BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const MAX_SIDE = 64;
const MAX_COLOURS = 63; // + 1 reserved transparent symbol = 64
const ALPHA_CUTOFF = 128;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-';

function getBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout for ${url}`)));
    req.on('error', reject);
  });
}

async function getWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getBuffer(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------------ PNG */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Undoes a single scanline filter in place. `bpp` is bytes per pixel (>= 1). */
function unfilter(type, line, prev, bpp) {
  const n = line.length;
  switch (type) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        line[i] = (line[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown filter type ${type}`);
  }
}

/**
 * Reads sample `i` of a scanline for any supported bit depth, normalised so
 * that 1/2/4-bit values stay in their own range (palette indices) and 16-bit
 * values are truncated to their high byte.
 */
function sample(line, i, depth) {
  if (depth === 8) return line[i];
  if (depth === 16) return line[i * 2];
  const perByte = 8 / depth;
  const byte = line[Math.floor(i / perByte)];
  const shift = 8 - depth - (i % perByte) * depth;
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Scales a raw sample of the given depth up to 0..255. */
function scaleSample(v, depth) {
  if (depth === 8 || depth === 16) return v;
  return Math.round((v * 255) / ((1 << depth) - 1));
}

/**
 * Decodes a non-interlaced PNG of any bit depth to flat RGBA.
 *
 * @param {Buffer} buf raw PNG bytes
 * @returns {{width:number, height:number, rgba:Uint8Array, depth:number, colourType:number}}
 */
function decodePng(buf) {
  if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let interlace = 0;
  let palette = null;
  let paletteAlpha = null;
  let transparentGray = -1;
  let transparentRgb = null;
  const idat = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) throw new Error(`truncated chunk ${type}`);

    if (type === 'IHDR') {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      depth = buf[start + 8];
      colourType = buf[start + 9];
      interlace = buf[start + 12];
    } else if (type === 'PLTE') {
      palette = buf.slice(start, end);
    } else if (type === 'tRNS') {
      if (colourType === 3) paletteAlpha = buf.slice(start, end);
      else if (colourType === 0) transparentGray = buf.readUInt16BE(start);
      else if (colourType === 2) {
        transparentRgb = [buf.readUInt16BE(start), buf.readUInt16BE(start + 2), buf.readUInt16BE(start + 4)];
      }
    } else if (type === 'IDAT') {
      idat.push(buf.slice(start, end));
    } else if (type === 'IEND') {
      break;
    }
    off = end + 4; // skip CRC
  }

  if (!width || !height) throw new Error('missing IHDR');
  if (interlace !== 0) throw new Error('interlaced (Adam7) PNG');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`unsupported bit depth ${depth}`);
  if (!CHANNELS[colourType]) throw new Error(`unsupported colour type ${colourType}`);
  if (!idat.length) throw new Error('missing IDAT');

  const channels = CHANNELS[colourType];
  // Filtering works on whole bytes, so the filter offset is at least 1 byte.
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('short IDAT stream');

  const rgba = new Uint8Array(width * height * 4);
  let prev = Buffer.alloc(stride);
  let cursor = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[cursor++];
    const line = Buffer.from(raw.slice(cursor, cursor + stride));
    cursor += stride;
    unfilter(filterType, line, prev, bpp);
    prev = line;

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (colourType === 6) {
        r = scaleSample(sample(line, s, depth), depth);
        g = scaleSample(sample(line, s + 1, depth), depth);
        b = scaleSample(sample(line, s + 2, depth), depth);
        a = scaleSample(sample(line, s + 3, depth), depth);
      } else if (colourType === 2) {
        const raw = [sample(line, s, depth), sample(line, s + 1, depth), sample(line, s + 2, depth)];
        r = scaleSample(raw[0], depth);
        g = scaleSample(raw[1], depth);
        b = scaleSample(raw[2], depth);
        if (transparentRgb && raw[0] === transparentRgb[0] && raw[1] === transparentRgb[1] && raw[2] === transparentRgb[2]) a = 0;
      } else if (colourType === 3) {
        if (!palette) throw new Error('palette image without PLTE');
        // Palette indices are never scaled, whatever the bit depth.
        const idx = sample(line, s, depth);
        if (idx * 3 + 2 >= palette.length) throw new Error(`palette index ${idx} out of range`);
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (paletteAlpha && idx < paletteAlpha.length) a = paletteAlpha[idx];
      } else if (colourType === 0) {
        const raw = sample(line, s, depth);
        r = g = b = scaleSample(raw, depth);
        if (transparentGray >= 0 && raw === transparentGray) a = 0;
      } else if (colourType === 4) {
        r = g = b = scaleSample(sample(line, s, depth), depth);
        a = scaleSample(sample(line, s + 1, depth), depth);
      }

      rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
    }
  }

  return { width, height, rgba, depth, colourType };
}

/* ------------------------------------------------------- image pipeline */

/** Bounding box of pixels with alpha >= ALPHA_CUTOFF, or null when fully clear. */
function contentBox(width, height, rgba) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= ALPHA_CUTOFF) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Downscales a cropped region to fit MAX_SIDE. The opacity mask is sampled
 * nearest-neighbour so silhouettes stay crisp; colour is a box average over the
 * opaque source pixels only, so edges never bleed toward transparent black.
 *
 * @returns {{w:number, h:number, mask:Uint8Array, rgb:Uint8Array}}
 */
function resample(src, box) {
  const scale = Math.min(1, MAX_SIDE / Math.max(box.w, box.h));
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));

  const mask = new Uint8Array(w * h);
  const rgb = new Uint8Array(w * h * 3);

  for (let ty = 0; ty < h; ty++) {
    const sy0 = box.y + Math.floor((ty * box.h) / h);
    const sy1 = box.y + Math.max(sy0 - box.y + 1, Math.floor(((ty + 1) * box.h) / h));
    for (let tx = 0; tx < w; tx++) {
      const sx0 = box.x + Math.floor((tx * box.w) / w);
      const sx1 = box.x + Math.max(sx0 - box.x + 1, Math.floor(((tx + 1) * box.w) / w));

      // Nearest sample sits at the centre of the box, so it is always inside it.
      const cx = Math.min(sx1 - 1, sx0 + ((sx1 - sx0) >> 1));
      const cy = Math.min(sy1 - 1, sy0 + ((sy1 - sy0) >> 1));
      const opaque = src.rgba[(cy * src.width + cx) * 4 + 3] >= ALPHA_CUTOFF ? 1 : 0;

      const t = ty * w + tx;
      mask[t] = opaque;
      if (!opaque) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const s = (sy * src.width + sx) * 4;
          if (src.rgba[s + 3] < ALPHA_CUTOFF) continue;
          r += src.rgba[s]; g += src.rgba[s + 1]; b += src.rgba[s + 2]; n++;
        }
      }
      if (n === 0) {
        const s = (cy * src.width + cx) * 4;
        r = src.rgba[s]; g = src.rgba[s + 1]; b = src.rgba[s + 2]; n = 1;
      }
      const d = t * 3;
      rgb[d] = Math.round(r / n);
      rgb[d + 1] = Math.round(g / n);
      rgb[d + 2] = Math.round(b / n);
    }
  }

  return { w, h, mask, rgb };
}

/**
 * Median-cut quantization over the distinct opaque colours.
 *
 * @param {Array<{r:number,g:number,b:number,n:number}>} colours weighted uniques
 * @param {number} limit maximum palette size
 * @returns {Array<[number,number,number]>}
 */
function medianCut(colours, limit) {
  if (colours.length <= limit) {
    return colours.map((c) => [c.r, c.g, c.b]);
  }

  let boxes = [colours];
  while (boxes.length < limit) {
    // Split the box with the largest weighted spread; stop when none can split.
    let bestIndex = -1;
    let bestScore = -1;
    let bestAxis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.length < 2) continue;
      let weight = 0;
      const lo = [255, 255, 255];
      const hi = [0, 0, 0];
      for (const c of bx) {
        weight += c.n;
        const v = [c.r, c.g, c.b];
        for (let k = 0; k < 3; k++) {
          if (v[k] < lo[k]) lo[k] = v[k];
          if (v[k] > hi[k]) hi[k] = v[k];
        }
      }
      // Perceptual-ish axis weights so hue detail survives better than luma noise.
      const spans = [(hi[0] - lo[0]) * 1.0, (hi[1] - lo[1]) * 1.2, (hi[2] - lo[2]) * 0.8];
      const axis = spans.indexOf(Math.max.apply(null, spans));
      const score = spans[axis] * Math.log2(weight + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        bestAxis = axis;
      }
    }
    if (bestIndex < 0 || bestScore <= 0) break;

    const box = boxes[bestIndex];
    const key = ['r', 'g', 'b'][bestAxis];
    box.sort((a, b) => a[key] - b[key]);
    const total = box.reduce((s, c) => s + c.n, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      cut = i + 1;
      if (acc * 2 >= total) break;
    }
    boxes = boxes.slice(0, bestIndex)
      .concat([box.slice(0, cut), box.slice(cut)])
      .concat(boxes.slice(bestIndex + 1));
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const c of box) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function hex2(v) {
  return v.toString(16).padStart(2, '0');
}

/** Builds the {w,h,pal,px} payload for one resampled image. */
function encode(img) {
  const counts = new Map();
  for (let i = 0; i < img.mask.length; i++) {
    if (!img.mask[i]) continue;
    const d = i * 3;
    const key = (img.rgb[d] << 16) | (img.rgb[d + 1] << 8) | img.rgb[d + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const uniques = [];
  for (const [key, n] of counts) {
    uniques.push({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff, n });
  }

  const pal = medianCut(uniques, MAX_COLOURS);
  if (pal.length === 0) pal.push([0, 0, 0]);

  // Map every distinct source colour to its nearest palette entry once.
  const lookup = new Map();
  for (const c of uniques) {
    let best = 0;
    let bestDist = Infinity;
    for (let p = 0; p < pal.length; p++) {
      const dr = c.r - pal[p][0];
      const dg = c.g - pal[p][1];
      const db = c.b - pal[p][2];
      const dist = dr * dr * 3 + dg * dg * 6 + db * db * 1;
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    lookup.set((c.r << 16) | (c.g << 8) | c.b, best);
  }

  let px = '';
  for (let i = 0; i < img.mask.length; i++) {
    if (!img.mask[i]) {
      px += ALPHABET[0];
      continue;
    }
    const d = i * 3;
    const key = (img.rgb[d] << 16) | (img.rgb[d + 1] << 8) | img.rgb[d + 2];
    px += ALPHABET[lookup.get(key) + 1];
  }

  return {
    w: img.w,
    h: img.h,
    pal: pal.map((c) => `${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`),
    px,
  };
}

/**
 * Trims fully-transparent outer rows and columns from an encoded payload.
 * The source crop is exact, but nearest-neighbour downscaling can drop a
 * one-pixel-thin edge feature (an antenna tip, a tail wisp) and leave a blank
 * margin behind. Those rows carry no information, so they go.
 */
function trim(sprite) {
  const clear = (i) => sprite.px[i] === ALPHABET[0];
  const rowClear = (y) => {
    for (let x = 0; x < sprite.w; x++) if (!clear(y * sprite.w + x)) return false;
    return true;
  };
  const colClear = (x) => {
    for (let y = 0; y < sprite.h; y++) if (!clear(y * sprite.w + x)) return false;
    return true;
  };

  let top = 0;
  let bottom = sprite.h - 1;
  while (top < bottom && rowClear(top)) top++;
  while (bottom > top && rowClear(bottom)) bottom--;
  let left = 0;
  let right = sprite.w - 1;
  while (left < right && colClear(left)) left++;
  while (right > left && colClear(right)) right--;

  if (top === 0 && left === 0 && bottom === sprite.h - 1 && right === sprite.w - 1) return sprite;

  const w = right - left + 1;
  const h = bottom - top + 1;
  let px = '';
  for (let y = top; y <= bottom; y++) px += sprite.px.slice(y * sprite.w + left, y * sprite.w + right + 1);
  return { w, h, pal: sprite.pal, px };
}

/** Throws unless the payload satisfies every invariant lib/sprite.js relies on. */
function validate(id, sprite) {
  if (!Number.isInteger(sprite.w) || !Number.isInteger(sprite.h) || sprite.w < 1 || sprite.h < 1) {
    throw new Error(`#${id}: bad dimensions ${sprite.w}x${sprite.h}`);
  }
  if (sprite.w > MAX_SIDE || sprite.h > MAX_SIDE) {
    throw new Error(`#${id}: ${sprite.w}x${sprite.h} exceeds ${MAX_SIDE}`);
  }
  if (sprite.px.length !== sprite.w * sprite.h) {
    throw new Error(`#${id}: px length ${sprite.px.length} != ${sprite.w * sprite.h}`);
  }
  if (sprite.pal.length > MAX_COLOURS) {
    throw new Error(`#${id}: palette of ${sprite.pal.length} exceeds ${MAX_COLOURS}`);
  }
  for (const entry of sprite.pal) {
    if (!/^[0-9a-f]{6}$/.test(entry)) throw new Error(`#${id}: bad palette entry ${entry}`);
  }
  let opaque = 0;
  for (let i = 0; i < sprite.px.length; i++) {
    const index = ALPHABET.indexOf(sprite.px[i]);
    if (index < 0) throw new Error(`#${id}: symbol ${JSON.stringify(sprite.px[i])} not in alphabet`);
    if (index > sprite.pal.length) throw new Error(`#${id}: index ${index} out of palette bounds`);
    if (index > 0) opaque++;
  }
  if (opaque === 0) throw new Error(`#${id}: no opaque pixels`);

  const rowClear = (y) => sprite.px.slice(y * sprite.w, (y + 1) * sprite.w).split('').every((c) => c === ALPHABET[0]);
  const colClear = (x) => {
    for (let y = 0; y < sprite.h; y++) if (sprite.px[y * sprite.w + x] !== ALPHABET[0]) return false;
    return true;
  };
  if (rowClear(0) || rowClear(sprite.h - 1) || colClear(0) || colClear(sprite.w - 1)) {
    throw new Error(`#${id}: transparent margin survived trimming`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  const onlyMissing = argv.includes('--missing');

  const outDir = path.join(__dirname, '..', 'data', 'sprites');
  fs.mkdirSync(outDir, { recursive: true });

  // The dex is the single source of truth for which species need art.
  const dex = JSON.parse(fs.readFileSync(DEX_PATH, 'utf8'));
  let ids = explicit.length ? explicit : dex.pokemon.map((p) => p.id);
  if (onlyMissing) ids = ids.filter((id) => !fs.existsSync(path.join(outDir, `${id}.json`)));

  process.stderr.write(`Baking ${ids.length} sprites from ${BASE_URL}...\n`);

  const skipped = [];
  const notes = [];
  const depths = {};
  let done = 0;
  let written = 0;
  let bytes = 0;

  await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
    try {
      const png = await getWithRetry(`${BASE_URL}/${id}.png`);
      const image = decodePng(png);
      if (image.width !== 96 || image.height !== 96) {
        notes.push(`#${id}: unexpected source size ${image.width}x${image.height}`);
      }
      depths[`${image.depth}-bit type ${image.colourType}`] = (depths[`${image.depth}-bit type ${image.colourType}`] || 0) + 1;
      const box = contentBox(image.width, image.height, image.rgba);
      if (!box) throw new Error('fully transparent image');
      const sprite = trim(encode(resample(image, box)));
      validate(id, sprite);
      const json = JSON.stringify(sprite);
      fs.writeFileSync(path.join(outDir, `${id}.json`), json);
      written++;
      bytes += Buffer.byteLength(json);
    } catch (err) {
      skipped.push(`#${id}: ${err.message}`);
    }
    done++;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${ids.length}\n`);
  });

  process.stderr.write(`\nWrote ${written} sprites to ${outDir}\n`);
  process.stderr.write(`Total ${bytes} bytes, average ${written ? Math.round(bytes / written) : 0} bytes/sprite\n`);
  process.stderr.write(`Source formats: ${JSON.stringify(depths)}\n`);
  for (const note of notes) process.stderr.write(`note: ${note}\n`);
  if (skipped.length) {
    process.stderr.write(`Skipped ${skipped.length}:\n`);
    for (const s of skipped) process.stderr.write(`  ${s}\n`);
  }
  // A handful of upstream gaps is tolerable (renderSprite degrades to text-only),
  // but a broad failure means something is wrong with the decoder or the mirror.
  if (ids.length && skipped.length > Math.max(10, ids.length * 0.02)) {
    throw new Error(`too many failures: ${skipped.length}/${ids.length}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`build-sprites failed: ${err.message}\n`);
    process.exit(1);
  });
}

// Exported so the shiny bake can reuse this exact pipeline: any divergence
// between the two would show up as a shiny whose silhouette does not match its
// own species.
module.exports = {
  getWithRetry, mapWithConcurrency, decodePng, contentBox, resample, encode, trim, validate,
  BASE_URL, ALPHABET, MAX_SIDE, MAX_COLOURS,
};
