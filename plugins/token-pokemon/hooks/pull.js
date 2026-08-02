#!/usr/bin/env node
/**
 * Stop hook: rolls for a Pokemon catch based on the tokens spent this turn.
 *
 * Reads the hook payload on stdin, locates the session transcript, sums the
 * turn's billable tokens, rolls, persists any catch, and prints a JSON
 * systemMessage so the result appears under the finished turn.
 *
 * Hard rule: this must never break a session. Every failure path exits 0 with
 * no output. A gacha toy is not allowed to interrupt real work.
 *
 * Dry run:  node hooks/pull.js --dry-run [tokens]
 */

'use strict';

const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');

function readStdin() {
  return new Promise((resolve) => {
    // If nothing is piped in, don't hang the turn waiting on stdin.
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    const timer = setTimeout(done, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  // Preview path: print one sprite and stop, so art can be checked without a catch.
  const spriteFlag = argv.indexOf('--sprite');
  if (spriteFlag !== -1) {
    const { loadConfig: load } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
    const { renderSprite } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
    const id = Number(argv[spriteFlag + 1]);
    const art = renderSprite(id, { maxWidth: load().spriteWidth });
    process.stdout.write(art === null ? `no sprite for id ${argv[spriteFlag + 1]}\n` : `${art}\n`);
    return;
  }

  const { loadConfig } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
  const { roll } = require(path.join(PLUGIN_ROOT, 'lib', 'roll.js'));
  const { lastTurnTokens } = require(path.join(PLUGIN_ROOT, 'lib', 'transcript.js'));
  const store = require(path.join(PLUGIN_ROOT, 'lib', 'store.js'));
  const { renderCatch, renderMiss } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
  const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

  const config = loadConfig();
  if (!config.enabled) return;

  let tokens = 0;
  let sessionId = null;
  let cwd = null;

  if (dryRun) {
    const explicit = argv.find((a) => /^\d+$/.test(a));
    tokens = explicit ? Number(explicit) : 5000;
  } else {
    const raw = await readStdin();
    let payload = {};
    try { payload = JSON.parse(raw); } catch (_) { payload = {}; }

    // A Stop hook can fire again for the continuation it triggered; the harness
    // sets stop_hook_active so we don't roll twice for one turn.
    if (payload.stop_hook_active) return;

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath) return;
    sessionId = payload.session_id || null;
    cwd = payload.cwd || null;

    const summed = lastTurnTokens(transcriptPath);
    tokens = summed.tokens;
  }

  if (!tokens || tokens <= 0) return;

  // Restrict the pool to the user's chosen generations before rolling.
  const { activePool } = require(path.join(PLUGIN_ROOT, 'lib', 'gens.js'));
  const outcome = roll(tokens, config, activePool(dex.pokemon, config));

  let uniqueCount = 0;
  let totalCount = 0;
  let isNew = false;

  if (outcome.caught) {
    const entry = {
      id: outcome.pokemon.id,
      name: outcome.pokemon.name,
      gen: outcome.pokemon.gen,
      tier: outcome.tier,
      tokens,
      chance: Number(outcome.chance.toFixed(6)),
      roll: Number(outcome.roll.toFixed(6)),
      caughtAt: new Date().toISOString(),
      sessionId,
      cwd,
    };
    // Only stamp shinies, so existing collections stay byte-identical in shape
    // and a normal catch does not carry a redundant `shiny: false`.
    if (outcome.shiny) entry.shiny = true;

    if (dryRun) {
      const current = store.read();
      isNew = !current.catches.some((c) => c.id === entry.id);
      totalCount = current.catches.length + 1;
      uniqueCount = new Set(current.catches.map((c) => c.id).concat(entry.id)).size;
    } else {
      const stats = store.update((data) => {
        const already = data.catches.some((c) => c.id === entry.id);
        data.stats.turns += 1;
        data.stats.tokens += tokens;
        data.stats.pulls += 1;
        data.catches.push(entry);
        return {
          isNew: !already,
          totalCount: data.catches.length,
          uniqueCount: new Set(data.catches.map((c) => c.id)).size,
        };
      });
      isNew = stats.isNew;
      totalCount = stats.totalCount;
      uniqueCount = stats.uniqueCount;
    }

    const message = renderCatch({
      pokemon: outcome.pokemon,
      tier: outcome.tier,
      tokens,
      chance: outcome.chance,
      roll: outcome.roll,
      uniqueCount,
      totalCount,
      dexSize: dex.count,
      isNew,
      config,
      shiny: outcome.shiny,
    });
    process.stdout.write(JSON.stringify({ systemMessage: message }));
    return;
  }

  // Miss: still record the turn so /pokedex odds stays honest.
  if (!dryRun) {
    store.update((data) => {
      data.stats.turns += 1;
      data.stats.tokens += tokens;
      return null;
    });
  }

  if (config.showMisses) {
    process.stdout.write(JSON.stringify({
      systemMessage: renderMiss({ tokens, chance: outcome.chance, roll: outcome.roll }),
    }));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // Surface the reason only when explicitly debugging; otherwise stay silent.
    if (process.env.TOKEN_POKEMON_DEBUG) {
      process.stderr.write(`token-pokemon: ${err && err.stack ? err.stack : err}\n`);
    }
    process.exit(0);
  }
);
