'use strict';

const fs = require('fs');
const path = require('path');

const SPRITE_DIR = path.join(__dirname, '..', 'data', 'sprites');
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-';

const UPPER_HALF = '▀'; // top pixel painted as foreground
const LOWER_HALF = '▄'; // bottom pixel painted as foreground
const RESET = '\x1b[0m';

const DEFAULT_MAX_WIDTH = 48;
const DEFAULT_INDENT = '   ';

/**
 * The widest a colour sprite may be drawn when it will travel through a hook
 * `systemMessage` (the catch banner and /pokedex).
 *
 * Truecolour art is dense: at width 48 the busiest species render past 16KB of
 * escapes, and Claude Code truncates a systemMessage beyond ~10KB into a
 * "<persisted-output>" file preview -- so the sprite arrives cut off instead of
 * whole. The banner is the tightest consumer: its rarity card and shiny row sit
 * in the same message as the art, so the cap has to hold the WHOLE banner under
 * 10KB, not just the sprite. At width 32 the worst shiny legendary banner still
 * lands at ~10.4KB and truncates; width 28 pulls every one of the 1025 species
 * safely under 8.5KB, roughly 1.5KB of headroom below the cap. Callers that do
 * NOT go through a systemMessage (the README SVG showcase) are free to ask for
 * more.
 */
const SAFE_SYSTEMMESSAGE_WIDTH = 28;

/**
 * The width ladder `renderSpriteFit` steps down, widest first.
 *
 * A flat cap of SAFE_SYSTEMMESSAGE_WIDTH is set by the ~36 densest species, and
 * shrinking every one of the 1025 to fit that worst case throws away resolution
 * on the other 989 -- most of which are far sparser and render well under the
 * truncation cap even at 48. So rather than one width for all, each sprite is
 * drawn as wide as its OWN byte size allows: the ladder is walked from 48 down,
 * and the first render whose art fits SAFE_SYSTEMMESSAGE_BYTES is kept. 28 stays
 * the floor -- it is the proven-safe width, so the walk always terminates on a
 * result rather than falling through to nothing.
 *
 * Steps of 4 keep the walk cheap (at most six renders, ~2ms) while still giving
 * the size real granularity; per-sprite byte size rises monotonically with
 * width, so the first fit from the top is also the widest safe one.
 */
const FIT_WIDTH_LADDER = [48, 44, 40, 36, 32, 28];

/**
 * Byte budget for the ART ALONE when it must fit through a systemMessage.
 *
 * The banner is the tightest consumer: its rarity card and shiny row add a fixed
 * ~1500 bytes of chrome (measured worst case 1494B), and the whole message has
 * to clear Claude Code's ~10KB truncation cap. Holding the art to 7700 bytes
 * lands the worst banner at ~9.2KB -- roughly 800 bytes of headroom below the
 * cap, matching the margin the old flat width-28 cap held while letting most
 * species render far wider. The detail view's chrome is lighter, so it clears by
 * even more.
 *
 * The value sits just above the densest species' floor render (the width-28
 * Groudon shiny at 7685B), so the ladder floor always satisfies the budget and
 * `renderSpriteFit` never has to fall back to a truncating render. Raising this
 * trades headroom for width; do not exceed ~8300 without re-measuring, or the
 * densest shiny banners begin to truncate.
 */
const SAFE_SYSTEMMESSAGE_BYTES = 7700;

/**
 * Shading glyphs from darkest to lightest, for the escape-free renderer.
 *
 * Transparent pixels are drawn as a space rather than a ramp entry, so the
 * silhouette is carried by the space/non-space boundary and survives even if a
 * consumer cannot display the block glyphs themselves.
 */
const PLAIN_RAMP = '█▓▒░';

/**
 * Quadrant glyphs indexed by a 4-bit coverage mask over a cell's subcells:
 * bit 0 top-left, bit 1 top-right, bit 2 bottom-left, bit 3 bottom-right.
 *
 * These are what make the art fine-grained. A shading glyph can only say "this
 * whole cell is drawn, at roughly this brightness", so a cell straddling an edge
 * had to choose between swallowing the background or dropping the foreground.
 * Quadrants let each cell resolve four independent pieces of the silhouette, so
 * the outline lands on half-cell boundaries instead of whole ones.
 *
 * Index 0 is the empty cell and index 15 the full one; the renderer substitutes a
 * ramp glyph for 15 so interiors keep their shading.
 */
const PLAIN_QUADRANT = [
  ' ', '▘', '▝', '▀',
  '▖', '▌', '▞', '▛',
  '▗', '▚', '▐', '▜',
  '▄', '▙', '▟', '█',
];

/** Subcells per cell on each axis. 2x2 is what the quadrant glyphs can express. */
const PLAIN_SUB = 2;

/**
 * Fraction of a downsampled block that must be opaque before the block is drawn
 * at all. At one half, an averaged block joins the silhouette only when opaque
 * pixels actually dominate it, which keeps antialiased edges from inflating the
 * outline by a full character cell.
 */
const PLAIN_COVERAGE = 0.5;

/**
 * Height of a terminal cell relative to its width. A subcell is half a cell on
 * each axis, so subcells inherit the same ratio, and the subrow count is divided
 * by this to keep the sprite in proportion instead of coming out twice as tall as
 * it should be.
 */
const PLAIN_ASPECT = 2;

/**
 * Plain art is one cell per pixel, so it needs far fewer columns than the colour
 * renderer's half-block packing. Most sprites are well under this and are drawn
 * at their native pixel width.
 *
 * Quadrants subdivide each cell 2x2, so this cap resolves 64 subcolumns -- the
 * native width of even the largest baked sprite. Raising it would spend columns
 * without recovering any more source detail.
 */
const PLAIN_MAX_WIDTH = 32;

// Symbol -> palette index (0 = transparent). Built once; lib is hot in hooks.
const SYMBOL_INDEX = new Map();
for (let i = 0; i < ALPHABET.length; i++) SYMBOL_INDEX.set(ALPHABET[i], i);

/** Absolute path of the baked sprite payload for a dex id. */
function spritePath(id) {
  return path.join(SPRITE_DIR, `${id}.json`);
}

/** Absolute path of the baked alternate-colour payload for a dex id. */
function shinyPath(id) {
  return path.join(SPRITE_DIR, 'shiny', `${id}.json`);
}

/** True when `pal` is a usable palette: non-empty and all 6-digit hex. */
function isPalette(pal) {
  if (!Array.isArray(pal) || pal.length === 0) return false;
  for (const entry of pal) {
    if (typeof entry !== 'string' || !/^[0-9a-f]{6}$/.test(entry)) return false;
  }
  return true;
}

/** Reads and structurally checks one baked sprite. Returns null on any problem. */
function loadSprite(id) {
  if (!Number.isInteger(id) || id < 1) return null;
  let sprite;
  try {
    sprite = JSON.parse(fs.readFileSync(spritePath(id), 'utf8'));
  } catch (_) {
    return null;
  }
  if (!sprite || typeof sprite !== 'object' || Array.isArray(sprite)) return null;
  if (!Number.isInteger(sprite.w) || !Number.isInteger(sprite.h)) return null;
  if (sprite.w < 1 || sprite.h < 1) return null;
  if (typeof sprite.px !== 'string' || sprite.px.length !== sprite.w * sprite.h) return null;
  if (!isPalette(sprite.pal)) return null;
  return sprite;
}

/**
 * Swaps a sprite to its alternate (shiny) colours.
 *
 * Most shinies are a pure recolour, so the baked payload is just a replacement
 * palette of the same length and the normal `px` is reused untouched. A minority
 * bake to slightly different geometry and ship a full standalone payload instead;
 * those are recognised by carrying their own `px`.
 *
 * Returns the ORIGINAL sprite whenever the alternate art is missing or unusable:
 * a shiny is a cosmetic reward, and losing the art must never lose the catch.
 */
function applyShiny(id, sprite) {
  let alt;
  try {
    alt = JSON.parse(fs.readFileSync(shinyPath(id), 'utf8'));
  } catch (_) {
    return sprite;
  }
  if (!alt || typeof alt !== 'object' || Array.isArray(alt)) return sprite;
  if (!isPalette(alt.pal)) return sprite;

  // Full standalone payload: validate it exactly as loadSprite would.
  if (typeof alt.px === 'string') {
    if (!Number.isInteger(alt.w) || !Number.isInteger(alt.h)) return sprite;
    if (alt.w < 1 || alt.h < 1) return sprite;
    if (alt.px.length !== alt.w * alt.h) return sprite;
    return { w: alt.w, h: alt.h, pal: alt.pal, px: alt.px };
  }

  // Palette swap: only valid when it covers every slot the pixels reference.
  if (alt.pal.length !== sprite.pal.length) return sprite;
  return { w: sprite.w, h: sprite.h, pal: alt.pal, px: sprite.px };
}

/**
 * Decodes the palette to a flat [r,g,b,...] table, index 0 reserved for
 * transparent so palette entry k lands at symbol index k+1.
 */
function decodePalette(pal) {
  const rgb = new Uint8Array((pal.length + 1) * 3);
  for (let i = 0; i < pal.length; i++) {
    const v = parseInt(pal[i], 16);
    const d = (i + 1) * 3;
    rgb[d] = (v >> 16) & 0xff;
    rgb[d + 1] = (v >> 8) & 0xff;
    rgb[d + 2] = v & 0xff;
  }
  return rgb;
}

/**
 * Perceived luminance per palette slot, on the same 0-255 scale as the channels.
 *
 * Rec. 709 coefficients, so the ramp follows what the eye actually reads as
 * light and dark: a saturated green is far brighter than a blue of identical
 * channel magnitude, and averaging the raw channels would rank them equal.
 *
 * Index 0 is the reserved transparent slot and is left at 0; nothing reads it,
 * because transparent pixels never reach the ramp.
 */
function decodeLuminance(pal) {
  const lum = new Float64Array(pal.length + 1);
  for (let i = 0; i < pal.length; i++) {
    const v = parseInt(pal[i], 16);
    lum[i + 1] = 0.2126 * ((v >> 16) & 0xff)
      + 0.7152 * ((v >> 8) & 0xff)
      + 0.0722 * (v & 0xff);
  }
  return lum;
}

/** Ramp glyph for a 0-255 luminance: darkest colours get the densest block. */
function rampGlyph(luminance) {
  const t = luminance < 0 ? 0 : luminance > 255 ? 255 : luminance;
  const slot = Math.floor((t / 256) * PLAIN_RAMP.length);
  return PLAIN_RAMP[slot < PLAIN_RAMP.length ? slot : PLAIN_RAMP.length - 1];
}

/**
 * Output dimensions for a baked sprite at a requested width.
 *
 * Baked sizes vary widely (21x39 Kakuna vs 64x60 Rayquaza), so downscale-only
 * rendering would draw early-gen sprites at a third the size of late-gen ones.
 * Small sprites are therefore upscaled by an INTEGER factor -- pixel art stays
 * crisp when doubled, whereas fractional scaling smears it.
 *
 * Height is bounded as well as width: a tall narrow sprite doubled on width
 * alone would produce a banner taller than the terminal. The cap is the tallest
 * a downscaled sprite could be, so upscaling never costs extra vertical rows.
 *
 * Exported so tests assert against the same math the renderer uses.
 *
 * @returns {{w:number, h:number, scale:number}}
 */
function renderSize(srcW, srcH, requested, allowUpscale) {
  const maxH = requested; // same bound both axes: art stays within a square box
  let scale = Math.min(requested / srcW, maxH / srcH);
  if (scale > 1) {
    // Upscaling: snap down to a whole factor, or stay 1:1 when not permitted.
    scale = allowUpscale === false ? 1 : Math.max(1, Math.floor(scale));
  }
  return {
    scale,
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * Renders a baked sprite as half-block ANSI art.
 *
 * Each character cell stacks two vertically-adjacent pixels: the foreground
 * colour paints one half and the background paints the other, so a 48x48 sprite
 * comes out as 48 columns by 24 rows. Escapes are emitted only when a colour
 * actually changes, which shrinks the payload several-fold.
 *
 * @param {number} id dex id
 * @param {{maxWidth?:number, indent?:string, shiny?:boolean}} [options]
 * @returns {string|null} multi-line art, or null when unavailable/malformed
 */
function renderSprite(id, options) {
  try {
    const opts = options || {};
    let sprite = loadSprite(id);
    if (!sprite) return null;
    if (opts.shiny) sprite = applyShiny(id, sprite);

    const requested = typeof opts.maxWidth === 'number' && isFinite(opts.maxWidth) && opts.maxWidth >= 1
      ? Math.floor(opts.maxWidth)
      : DEFAULT_MAX_WIDTH;
    const indent = typeof opts.indent === 'string' ? opts.indent : DEFAULT_INDENT;

    const size = renderSize(sprite.w, sprite.h, requested, opts.upscale !== false);
    const outW = size.w;
    const outH = size.h;

    const pal = decodePalette(sprite.pal);
    const maxIndex = sprite.pal.length;
    const px = sprite.px;
    const srcW = sprite.w;
    const srcH = sprite.h;

    // Row of palette indices for one output line, reused across the two halves.
    const indexAt = (ox, oy) => {
      const sx = Math.min(srcW - 1, Math.floor((ox * srcW) / outW));
      const sy = Math.min(srcH - 1, Math.floor((oy * srcH) / outH));
      const index = SYMBOL_INDEX.get(px[sy * srcW + sx]);
      return index === undefined || index > maxIndex ? 0 : index;
    };

    const lines = [];
    for (let oy = 0; oy < outH; oy += 2) {
      let line = indent;
      let fg = -1;
      let bg = -1;
      for (let ox = 0; ox < outW; ox++) {
        const top = indexAt(ox, oy);
        // Odd heights pad the final row with a transparent bottom pixel.
        const bottom = oy + 1 < outH ? indexAt(ox, oy + 1) : 0;

        if (top === 0 && bottom === 0) {
          // Never paint transparent as black: clear any background, then a space.
          if (bg !== 0) {
            line += RESET;
            bg = 0;
            fg = -1;
          }
          line += ' ';
          continue;
        }

        // One-sided cells reset the background so the clear half stays clear.
        const solid = top !== 0 && bottom !== 0;
        const glyph = solid || top !== 0 ? UPPER_HALF : LOWER_HALF;
        const fgIndex = top !== 0 ? top : bottom;
        const bgIndex = solid ? bottom : 0;

        let cell = '';
        if (bgIndex === 0) {
          if (bg !== 0) {
            cell += RESET;
            bg = 0;
            fg = -1; // the reset also cleared the foreground
          }
        } else if (bgIndex !== bg) {
          const d = bgIndex * 3;
          cell += `\x1b[48;2;${pal[d]};${pal[d + 1]};${pal[d + 2]}m`;
          bg = bgIndex;
        }
        if (fgIndex !== fg) {
          const d = fgIndex * 3;
          cell += `\x1b[38;2;${pal[d]};${pal[d + 1]};${pal[d + 2]}m`;
          fg = fgIndex;
        }
        line += cell + glyph;
      }
      lines.push(line + RESET);
    }

    return lines.join('\n');
  } catch (_) {
    // A cosmetic sprite must never break the caller.
    return null;
  }
}

/**
 * Renders a sprite as wide as it can go while its art stays under a byte budget.
 *
 * The colour renderer packs the densest colour a terminal can show -- two pixels
 * per cell, via the half-block glyph -- so the only lever left for finer art is
 * width, and width is bounded by the systemMessage truncation cap rather than by
 * quality. A single flat width wastes that budget: it has to be small enough for
 * the very densest species, so every sparser sprite renders smaller than it
 * safely could. This walks FIT_WIDTH_LADDER from the widest down and returns the
 * first render whose art fits `maxBytes`, so each species is drawn at its own
 * largest safe size instead of everyone's smallest.
 *
 * The ladder's narrowest rung is SAFE_SYSTEMMESSAGE_WIDTH, which is known to fit
 * every species, so a walk that rejects every wider rung still returns that
 * narrowest render rather than null. A genuinely unavailable sprite (bad id,
 * missing file) still returns null, exactly as renderSprite does.
 *
 * A caller may cap the width with `maxWidth`: it is a HARD ceiling, so a narrow
 * terminal or a small configured spriteWidth is honoured even when it is below
 * the ladder floor -- a sub-floor width is not a truncation concern, so the
 * sprite is simply drawn at that width. Rungs above the ceiling are skipped.
 *
 * @param {number} id dex id
 * @param {{maxWidth?:number, indent?:string, shiny?:boolean, maxBytes?:number}} [options]
 * @returns {string|null} the widest safe art, or null when unavailable
 */
function renderSpriteFit(id, options) {
  const opts = options || {};
  const budget = typeof opts.maxBytes === 'number' && isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? opts.maxBytes
    : SAFE_SYSTEMMESSAGE_BYTES;
  const ceiling = typeof opts.maxWidth === 'number' && isFinite(opts.maxWidth)
    ? Math.floor(opts.maxWidth)
    : Infinity;

  // Candidate widths, widest first: the ladder rungs at or below the ceiling. If
  // the ceiling sits below every rung (a very narrow request), the ceiling itself
  // is the only candidate, so an explicit small width is honoured rather than
  // silently widened back up to the floor.
  const candidates = FIT_WIDTH_LADDER.filter((w) => w <= ceiling);
  if (candidates.length === 0) candidates.push(Math.max(1, ceiling));

  let narrowestArt = null;
  for (const width of candidates) {
    const art = renderSprite(id, { maxWidth: width, indent: opts.indent, shiny: opts.shiny });
    // A null here is not "too big", it is "no sprite" -- neither widening nor
    // narrowing helps, so report it as unavailable exactly as renderSprite does.
    if (art === null) return null;
    if (Buffer.byteLength(art) <= budget) return art;
    // Track the narrowest render as the last resort: if even it overflows the
    // budget, a whole (if large) sprite still beats returning nothing.
    narrowestArt = art;
  }
  return narrowestArt;
}

/**
 * Cell and subcell grid the plain renderer draws a sprite on.
 *
 * Cells are capped both by the caller's budget and by the source: quadrants
 * resolve PLAIN_SUB subcolumns each, so one cell per PLAIN_SUB source pixels
 * already samples every pixel there is, and going wider would stretch the art
 * without recovering detail. This keeps the cell footprint the same as one glyph
 * per pixel would have produced while quadrupling the detail inside it.
 *
 * Subcells are half a cell on each axis, so they carry the cell's aspect ratio:
 * roughly twice as tall as they are wide. The subrow count is therefore the
 * source ratio taken off the CELL width, which is the subcolumn count already
 * divided by PLAIN_ASPECT.
 *
 * Exported so tests assert against the same math the renderer uses.
 *
 * @returns {{cols:number, rows:number, subW:number, subH:number}}
 */
function plainSize(srcW, srcH, requested) {
  const cols = Math.max(1, Math.min(Math.ceil(srcW / PLAIN_SUB), requested));
  const subW = cols * PLAIN_SUB;
  const subH = Math.max(PLAIN_SUB, Math.round((subW * (srcH / srcW)) / PLAIN_ASPECT));
  return { cols, subW, subH, rows: Math.max(1, Math.ceil(subH / PLAIN_SUB)) };
}

/**
 * Renders a baked sprite as escape-free shaded text.
 *
 * Slash command output reaches the model as a plain string with the ESC bytes
 * stripped, which turns the colour renderer's art into literal `[38;2;...m`
 * noise. This mode spends no escapes at all: the shape is carried by block
 * glyphs and the space/non-space boundary, so it survives capture even though the
 * colour cannot.
 *
 * Each cell is sampled as a 2x2 grid of subcells and drawn with the quadrant
 * glyph matching which of the four are opaque, so the silhouette resolves at
 * twice the cell resolution on both axes -- four times the effective pixel count
 * of one glyph per cell. Edges are what identify a sprite (ear tips, a snout, the
 * notch in Pikachu's tail), and at these widths an edge almost never falls on a
 * cell boundary; quadrants let it land mid-cell instead of rounding the whole
 * cell to filled or blank.
 *
 * Fully-covered cells are drawn from the luminance ramp rather than as a solid
 * block, so interiors keep their shading and the art still reads as a form rather
 * than a stencil. Partial cells spend their glyph on the edge itself: shape wins
 * over shade there, because a misplaced edge is a misidentified Pokemon.
 *
 * Subcells average luminance over their source block instead of point sampling,
 * because a subcell stands for an area once it covers more than one pixel; it is
 * drawn only when opaque pixels cover at least half of it.
 *
 * @param {number} id dex id
 * @param {{maxWidth?:number, indent?:string, shiny?:boolean}} [options]
 * @returns {string|null} multi-line art, free of ESC bytes, or null when unavailable
 */
function renderSpritePlain(id, options) {
  try {
    const opts = options || {};
    let sprite = loadSprite(id);
    if (!sprite) return null;
    if (opts.shiny) sprite = applyShiny(id, sprite);

    // spriteWidth is a column budget shared with the colour renderer, whose
    // half-block packing spends one column per pixel. Plain art resolves two
    // subcolumns per column, so it is capped here rather than taken at face value:
    // a smaller setting still shrinks the art, but the wider defaults do not
    // stretch it past the detail the source actually holds.
    const requested = typeof opts.maxWidth === 'number' && isFinite(opts.maxWidth) && opts.maxWidth >= 1
      ? Math.min(Math.floor(opts.maxWidth), PLAIN_MAX_WIDTH)
      : PLAIN_MAX_WIDTH;
    const indent = typeof opts.indent === 'string' ? opts.indent : DEFAULT_INDENT;

    const srcW = sprite.w;
    const srcH = sprite.h;
    const px = sprite.px;
    const lum = decodeLuminance(sprite.pal);
    const maxIndex = sprite.pal.length;

    const { cols, rows, subW, subH } = plainSize(srcW, srcH, requested);

    /**
     * Coverage and mean luminance of one subcell's source block. Coverage is the
     * opaque fraction, so the caller can threshold the silhouette; luminance is
     * averaged over the opaque pixels only, so a mostly-clear block is not dragged
     * dark by the transparency around its content.
     */
    const sample = (sy, sx) => {
      const y0 = Math.floor((sy * srcH) / subH);
      const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * srcH) / subH));
      const x0 = Math.floor((sx * srcW) / subW);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * srcW) / subW));
      let sum = 0;
      let opaque = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          const index = SYMBOL_INDEX.get(px[y * srcW + x]);
          // An out-of-range symbol is treated as transparent, exactly as the
          // colour renderer does, so corrupt data degrades to a hole.
          if (index === undefined || index === 0 || index > maxIndex) continue;
          sum += lum[index];
          opaque++;
        }
      }
      return { covered: opaque / total >= PLAIN_COVERAGE, lum: opaque ? sum / opaque : 0 };
    };

    const lines = [];
    for (let row = 0; row < rows; row++) {
      let line = indent;
      for (let col = 0; col < cols; col++) {
        // Quadrant bit order: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right.
        let mask = 0;
        let sum = 0;
        let drawn = 0;
        for (let sy = 0; sy < PLAIN_SUB; sy++) {
          const y = row * PLAIN_SUB + sy;
          // An odd subrow count leaves the last cell's bottom half off the grid;
          // treat it as clear rather than sampling past the sprite.
          if (y >= subH) break;
          for (let sx = 0; sx < PLAIN_SUB; sx++) {
            const cell = sample(y, col * PLAIN_SUB + sx);
            if (!cell.covered) continue;
            mask |= 1 << (sy * PLAIN_SUB + sx);
            sum += cell.lum;
            drawn++;
          }
        }

        // A full cell has no edge to describe, so it spends its glyph on shading
        // instead. Anything partial draws the quadrant, which is the edge.
        line += mask === PLAIN_QUADRANT.length - 1
          ? rampGlyph(sum / drawn)
          : PLAIN_QUADRANT[mask];
      }
      // Trailing blanks carry no shape and would only pad every line out to the
      // full width, so they are dropped.
      lines.push(line.replace(/ +$/, ''));
    }

    return lines.join('\n');
  } catch (_) {
    // A cosmetic sprite must never break the caller.
    return null;
  }
}

module.exports = {
  renderSprite,
  renderSpriteFit,
  renderSpritePlain,
  spritePath,
  shinyPath,
  renderSize,
  plainSize,
  applyShiny,
  ALPHABET,
  PLAIN_RAMP,
  PLAIN_QUADRANT,
  PLAIN_SUB,
  PLAIN_MAX_WIDTH,
  PLAIN_ASPECT,
  SAFE_SYSTEMMESSAGE_WIDTH,
  SAFE_SYSTEMMESSAGE_BYTES,
  FIT_WIDTH_LADDER,
};
