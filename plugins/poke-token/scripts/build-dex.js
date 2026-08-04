#!/usr/bin/env node
/**
 * Regenerates data/dex.json from PokeAPI. Development-only: the plugin ships the
 * generated file so that nothing at runtime ever touches the network.
 *
 *   node scripts/build-dex.js
 *
 * Tiering rules (first match wins):
 *   mythical  - PokeAPI is_mythical
 *   legendary - PokeAPI is_legendary
 *   rare      - fully-evolved pseudo-legendaries, starters, and anything with a
 *               low capture_rate (<= 45) that isn't already legendary
 *   common    - everything else
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const SPECIES_COUNT = 1025; // Bulbasaur (1) .. Pecharunt (1025) = Gen 1-9
const MAX_GEN = 9;
const CONCURRENCY = 12;
const RARE_CAPTURE_RATE = 45;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout for ${url}`)));
    req.on('error', reject);
  });
}

async function getWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await get(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/** "generation-iii" -> 3 */
function generationNumber(name) {
  const romans = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };
  return romans[String(name).replace('generation-', '')] || 0;
}

/** "nidoran-f" -> "Nidoran-F", "mr-mime" -> "Mr-Mime" */
function displayName(slug) {
  return slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
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

function classify(species) {
  if (species.is_mythical) return 'mythical';
  if (species.is_legendary) return 'legendary';
  if (typeof species.capture_rate === 'number' && species.capture_rate <= RARE_CAPTURE_RATE) {
    return 'rare';
  }
  return 'common';
}

async function main() {
  const ids = [];
  for (let id = 1; id <= SPECIES_COUNT; id++) ids.push(id);

  process.stderr.write(`Fetching ${SPECIES_COUNT} species from PokeAPI...\n`);
  let done = 0;
  const entries = await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
    const s = await getWithRetry(`https://pokeapi.co/api/v2/pokemon-species/${id}/`);
    done++;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${SPECIES_COUNT}\n`);
    return {
      id: s.id,
      name: displayName(s.name),
      gen: generationNumber(s.generation && s.generation.name),
      tier: classify(s),
    };
  });

  entries.sort((a, b) => a.id - b.id);

  // Fail loudly rather than shipping a malformed dex.
  if (entries.length !== SPECIES_COUNT) {
    throw new Error(`expected ${SPECIES_COUNT} entries, got ${entries.length}`);
  }
  for (const e of entries) {
    if (!e.name || e.gen < 1 || e.gen > MAX_GEN) {
      throw new Error(`bad entry: ${JSON.stringify(e)}`);
    }
  }

  const counts = entries.reduce((acc, e) => {
    acc[e.tier] = (acc[e.tier] || 0) + 1;
    return acc;
  }, {});

  const outPath = path.join(__dirname, '..', 'data', 'dex.json');
  const payload = {
    generatedFrom: 'https://pokeapi.co/api/v2/pokemon-species',
    // Derived from the entries, so this can never drift from the data again.
    generations: Array.from(new Set(entries.map((e) => e.gen))).sort((a, b) => a - b),
    count: entries.length,
    tierCounts: counts,
    pokemon: entries,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 0) + '\n');

  process.stderr.write(`Wrote ${outPath}\n`);
  process.stderr.write(`Tiers: ${JSON.stringify(counts)}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-dex failed: ${err.message}\n`);
  process.exit(1);
});
