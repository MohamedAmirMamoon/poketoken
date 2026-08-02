'use strict';

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

function pct(n, digits = 2) {
  return `${(n * 100).toFixed(digits)}%`;
}

function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad(id) {
  return String(id).padStart(3, '0');
}

/**
 * The banner appended after a turn that produced a catch.
 *
 * When `config.sprites` is on and the sprite bakes cleanly, the art is placed
 * above the text block; otherwise the text block is emitted unchanged.
 */
function renderCatch({ pokemon, tier, tokens, chance, roll, uniqueCount, totalCount, dexSize, isNew, config, sprite, shiny }) {
  const notable = tier === 'mythical' || tier === 'legendary';
  let head;
  if (shiny) {
    // A shiny outranks the tier headline: it is the rarer of the two events, and
    // burying it under "A LEGENDARY encounter" is how people miss it entirely.
    head = `${TIER_ICON[tier]} SHINY!! A shiny ${pokemon.name.toUpperCase()} appeared and was caught!`;
  } else if (notable) {
    head = `${TIER_ICON[tier]} A ${TIER_LABEL[tier]} encounter! ${pokemon.name.toUpperCase()} was caught!`;
  } else {
    head = `A wild ${pokemon.name.toUpperCase()} appeared and was caught!`;
  }

  let art = null;
  if (!config || config.sprites !== false) {
    try {
      const render = sprite || require('./sprite.js').renderSprite;
      art = render(pokemon.id, {
        maxWidth: config ? config.spriteWidth : undefined,
        shiny: !!shiny,
      }) || null;
    } catch (_) {
      // Art is decoration; a missing or broken sprite must not cost the banner.
      art = null;
    }
  }

  const dupe = isNew ? 'NEW' : 'dupe';
  const marks = [TIER_LABEL[tier]];
  if (shiny) marks.push('SHINY');
  marks.push(dupe);
  return [
    '',
    ...(art ? [art, ''] : []),
    `+-- ${head}`,
    `|   #${pad(pokemon.id)} - Gen ${pokemon.gen} - ${marks.join(' - ')}`,
    `|   ${commas(tokens)} tokens -> ${pct(chance)} chance -> rolled ${pct(roll)}`,
    `|   Pokedex: ${totalCount} caught - ${uniqueCount}/${dexSize} unique (${dexSize > 0 ? pct(uniqueCount / dexSize, 1) : '0.0%'})`,
    `+-- /pokedex to view your collection`,
  ].join('\n');
}

/** Optional one-liner for misses, when showMisses is enabled. */
function renderMiss({ tokens, chance, roll }) {
  return `[token-pokemon] ${commas(tokens)} tokens -> ${pct(chance)} chance, rolled ${pct(roll)} - no catch.`;
}

module.exports = { renderCatch, renderMiss, TIER_LABEL, TIER_ICON, pct, commas, pad };
