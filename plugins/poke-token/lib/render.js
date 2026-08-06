'use strict';

const color = require('./color.js');

const TIER_LABEL = {
  common: 'Common',
  rare: 'Rare',
  legendary: 'LEGENDARY',
  mythical: 'MYTHICAL',
};

const TIER_ICON = {
  common: '*',
  rare: '**',
  legendary: '***',
  mythical: '****',
};

/** Width of every header rule, matching the report bodies drawn beneath them. */
const RULE_WIDTH = 52;

/**
 * The glyph ramps each rarity draws its header rule from, dimmest first.
 *
 * The vocabulary itself carries the tier. Commons and rares are stone -- dashes
 * with pebbles worn into them -- and legendaries and mythicals are sky, drawn
 * from the `+ * x #` marks that read as stars in a terminal. That split is what
 * makes a rare card recognisable at a glance, before the `Rarity` line is read.
 *
 * Everything is plain ASCII on purpose. The rule sits in the same captured
 * stdout as the sprite art, and a header that degrades to mojibake in a narrow
 * font would cost more than the decoration is worth.
 *
 * `spread` is how far from the centre the brightest band reaches, as a fraction
 * of the half-width, so rarity shows up as reach as well as vocabulary: a common
 * barely lifts off its baseline, a mythical is lit end to end.
 */
const TIER_RULE = {
  common: { ramp: ['-', '-', '.'], spread: 0.55 },
  rare: { ramp: ['-', '.', 'o', 'O'], spread: 0.8 },
  legendary: { ramp: ['=', '+', '*', 'x'], spread: 1 },
  mythical: { ramp: ['=', '+', '*', 'X', '#'], spread: 1 },
};

/**
 * The rule for a report with no single rarity to describe -- the collection
 * summary, the odds page, the config screen. Flat `=`, which is what every
 * header used before rarity had anything to say about it.
 */
const PLAIN_RULE = { ramp: ['='], spread: 1 };

/**
 * A shiny draws the top rule whatever its tier, for the same reason it takes the
 * banner headline: at 1 in 128 a shiny common is rarer than the legendary next to
 * it, and demoting it to a stone rule would bury the rarer of the two events.
 *
 * It is not the mythical rule reused -- `@` in place of `#` keeps the two
 * distinguishable, so a shiny mythical still reads as its own thing.
 */
const SHINY_RULE = { ramp: ['=', '+', '*', 'X', '@'], spread: 1 };

/**
 * Draws a header rule as a symmetric burst: brightest in the middle, falling off
 * through the ramp toward both ends.
 *
 * A flat run of one character was the same line on a Rattata as on Arceus. This
 * spends the same row on telling you which you are looking at, and stays a single
 * line of ASCII while doing it.
 *
 * An unknown tier falls back to the flat rule rather than throwing: the rule is
 * ornament, and a header must still be drawn.
 *
 * @param {string} [tier] tier name; anything unrecognised draws the flat rule
 * @param {number} [width] columns to fill; defaults to the report width
 * @param {boolean} [shiny] draw the shiny rule instead of the tier's own
 */
function rule(tier, width = RULE_WIDTH, shiny = false) {
  // Only a known tier name selects a ramp. Callers pass a tier straight out of a
  // catch record or a dex entry, so a null, a number, or a tier this version has
  // never heard of all have to land on the flat rule rather than throwing.
  const named = typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_RULE, tier)
    ? TIER_RULE[tier]
    : PLAIN_RULE;
  const spec = shiny ? SHINY_RULE : named;
  // A non-finite width would leave the loop bound NaN and silently return an
  // empty string, dropping the header line entirely; fall back to the default.
  const n = Number(width);
  const w = isFinite(n) ? Math.max(1, Math.floor(n)) : RULE_WIDTH;
  if (w === 1) return spec.ramp[spec.ramp.length - 1];

  const mid = (w - 1) / 2;
  let out = '';
  for (let i = 0; i < w; i++) {
    // 1 at the centre, 0 once the falloff has run out, so the ramp index rises
    // toward the middle from both directions.
    const heat = Math.max(0, (spec.spread - Math.abs(i - mid) / mid) / spec.spread);
    const slot = Math.floor(heat * spec.ramp.length);
    out += spec.ramp[slot < spec.ramp.length ? slot : spec.ramp.length - 1];
  }
  return out;
}

function pct(n, digits = 2) {
  return `${(n * 100).toFixed(digits)}%`;
}

function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad(id) {
  return String(id).padStart(3, '0');
}

/** Strips SGR escapes so a coloured line's on-screen width can be measured. */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** On-screen width of a line, i.e. its length once the escapes are removed. */
function visibleWidth(s) {
  return stripAnsi(s).length;
}

/**
 * Frames a stack of already-coloured rows in a box drawn in the accent colour.
 *
 * The width has to be measured with the escapes stripped, since a coloured row
 * is far longer as a string than it is on screen; padding by raw length would
 * push every right border a random distance off the edge. Each row is padded to
 * the widest row's visible width so the borders line up into a rectangle.
 *
 * The border sequence is spent per line rather than left open, so the accent
 * colour can never bleed past a border into the content or the row beneath.
 *
 * @param {[number,number,number]} accent frame colour
 * @param {string[]} rows coloured content lines, no border
 * @returns {string[]} the framed card, top border to bottom
 */
function frameCard(accent, rows) {
  const bar = color.fg(accent, '│', { bold: true }); // │, redrawn each side
  const inner = Math.max(1, ...rows.map(visibleWidth));
  const horizontal = '─'.repeat(inner + 2); // ─, one space of padding each side
  const top = color.fg(accent, `╭${horizontal}╮`, { bold: true }); // ╭╮
  const bottom = color.fg(accent, `╰${horizontal}╯`, { bold: true }); // ╰╯
  const body = rows.map((row) => {
    const gap = ' '.repeat(inner - visibleWidth(row));
    return `${bar} ${row}${gap} ${bar}`;
  });
  return [top, ...body, bottom];
}

/**
 * The banner appended after a turn that produced a catch.
 *
 * Two shapes come out of here. The default is a colour card: a truecolour sprite
 * above a box whose frame, headline and rarity label all take the rarity's accent
 * colour, so a legendary reads as gold and a common as muted grey at a glance.
 * This is what ships, because the banner is delivered as a hook `systemMessage`
 * and Claude Code paints those with the escapes intact.
 *
 * The other is the plain text block, drawn only when `config.sprites` is false.
 * That flag is the user's "no escapes" switch -- some hosts strip SGR from
 * captured output -- so it stays byte-for-byte the escape-free banner it has
 * always been rather than a decoloured version of the new card.
 */
function renderCatch({ pokemon, tier, tokens, chance, roll, uniqueCount, totalCount, dexSize, isNew, config, sprite, shiny }) {
  const notable = tier === 'mythical' || tier === 'legendary';
  const name = pokemon.name.toUpperCase();
  const dexPct = dexSize > 0 ? pct(uniqueCount / dexSize, 1) : '0.0%';

  // The escape-free fallback: only when the user has explicitly turned art off.
  // Kept identical to the historical banner so a host that strips escapes still
  // gets exactly the plain block it always did.
  if (config && config.sprites === false) {
    let head;
    if (shiny) {
      // A shiny outranks the tier headline: it is the rarer of the two events,
      // and burying it under "A LEGENDARY encounter" is how people miss it.
      head = `${TIER_ICON[tier]} SHINY!! A shiny ${name} appeared and was caught!`;
    } else if (notable) {
      head = `${TIER_ICON[tier]} A ${TIER_LABEL[tier]} encounter! ${name} was caught!`;
    } else {
      head = `A wild ${name} appeared and was caught!`;
    }
    const marks = [TIER_LABEL[tier]];
    if (shiny) marks.push('SHINY');
    marks.push(isNew ? 'NEW' : 'dupe');
    return [
      '',
      `+-- ${head}`,
      `|   #${pad(pokemon.id)} - Gen ${pokemon.gen} - ${marks.join(' - ')}`,
      `|   ${commas(tokens)} tokens -> ${pct(chance)} chance -> rolled ${pct(roll)}`,
      `|   Pokedex: ${totalCount} caught - ${uniqueCount}/${dexSize} unique (${dexPct})`,
      `+-- /pokedex to view your collection`,
    ].join('\n');
  }

  const accent = color.accentFor(tier, shiny);

  let art = null;
  try {
    // An explicit renderer from the caller wins; otherwise a just-caught Pokemon
    // always shows in colour at fine resolution, since the catch banner is the
    // celebratory reward and colour art earns its keep here regardless of the
    // configured spriteMode.
    const lib = require('./sprite.js');
    const render = sprite || lib.renderSprite;
    // The banner is emitted as a systemMessage, which truncates past ~10KB.
    // Colour art is dense enough that a wide sprite blows that cap and arrives
    // cut off, so hold the colour width to the safe ceiling even when the config
    // asks for more. A caller-supplied renderer manages its own width.
    const requested = config ? config.spriteWidth : undefined;
    const maxWidth = sprite
      ? requested
      : Math.min(requested || lib.SAFE_SYSTEMMESSAGE_WIDTH, lib.SAFE_SYSTEMMESSAGE_WIDTH);
    art = render(pokemon.id, {
      maxWidth,
      shiny: !!shiny,
    }) || null;
  } catch (_) {
    // Art is decoration; a missing or broken sprite drops the picture but must
    // never cost the coloured card beneath it.
    art = null;
  }

  // The headline. A shiny takes it whatever the tier -- see the accent above for
  // why -- and the notable tiers keep their bit of encounter flavour.
  let headline;
  if (shiny) {
    headline = `✧ A wild SHINY ${name} appeared!`;
  } else if (notable) {
    headline = `✦ A ${TIER_LABEL[tier]} encounter — ${name}!`;
  } else {
    headline = `✦ A wild ${name} appeared!`;
  }

  // Dex number in the accent, then the type chips each in its chart colour, so a
  // Grass/Poison catch reads as green-and-purple beside its number. Types are
  // whatever the dex entry carries; an entry without them just drops the chips.
  const types = Array.isArray(pokemon.types) ? pokemon.types : [];
  const chips = types.map((t) => color.fg(color.typeColor(t), t.toUpperCase())).join(color.dim(' / '));
  const numberLine = color.fg(accent, `#${pad(pokemon.id)}`, { bold: true })
    + color.dim(`  Gen ${pokemon.gen}`)
    + (chips ? `   ${chips}` : '');

  // NEW is the milestone worth shouting, in gold; a duplicate is a quieter,
  // dimmer note so the run of dupes between new catches does not read as loud.
  const status = isNew
    ? color.fg(color.NEW_RGB, `★ NEW`, { bold: true }) + color.fg(color.NEW_RGB, ' — added to your Pokedex')
    : color.dim('↺ duplicate — already in your Pokedex');

  // The rarity label in its own colour, bold only for the two premium tiers so
  // the gold and diamond genuinely stand out from the muted commons and rares.
  const rarityLine = color.fg(accent, TIER_LABEL[tier], { bold: notable });

  const rows = [numberLine, status];
  // Shininess is its own line, independent of the tier, so a shiny duplicate
  // still shows both facts rather than one masking the other.
  if (shiny) rows.push(color.fg(color.SHINY_RGB, '✧ SHINY', { bold: true }));
  rows.push(rarityLine, '');
  rows.push(color.dim(`${commas(tokens)} tokens → ${pct(chance)} chance → rolled ${pct(roll)}`));
  rows.push(color.dim(`Pokedex ${uniqueCount}/${dexSize} unique · ${totalCount} caught (${dexPct})`));
  rows.push(color.dim('/pokedex to view your collection'));

  // The headline leads as a bare text line, not the sprite. This banner is
  // emitted as a Stop-hook systemMessage, and Claude Code prepends its own label
  // while eating the leading newline -- so whatever is first lands beside that
  // label. If that is the sprite's top row, the art gets shunted sideways (the
  // same collision commit e28dfa3 fixed for the /pokedex detail view). The
  // headline takes the hit instead and announces the catch while doing it.
  return [
    headline,
    ...(art ? ['', art] : []),
    '',
    ...frameCard(accent, rows),
  ].join('\n');
}

/** Optional one-liner for misses, when showMisses is enabled. */
function renderMiss({ tokens, chance, roll }) {
  return `[poke-token] ${commas(tokens)} tokens -> ${pct(chance)} chance, rolled ${pct(roll)} - no catch.`;
}

module.exports = {
  renderCatch,
  renderMiss,
  frameCard,
  stripAnsi,
  visibleWidth,
  rule,
  TIER_LABEL,
  TIER_ICON,
  TIER_RULE,
  RULE_WIDTH,
  pct,
  commas,
  pad,
};
