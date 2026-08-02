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

module.exports = { renderSprite, spritePath, shinyPath, renderSize, applyShiny, ALPHABET };
