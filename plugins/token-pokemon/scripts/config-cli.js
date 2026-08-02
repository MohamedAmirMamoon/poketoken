#!/usr/bin/env node
/**
 * Reads and writes ~/.claude/token-pokemon/config.json for the /pokeconfig
 * slash command.
 *
 *   node scripts/config-cli.js                        show effective config
 *   node scripts/config-cli.js show
 *   node scripts/config-cli.js set maxChance 60%
 *   node scripts/config-cli.js set tierWeights.legendary 5
 *   node scripts/config-cli.js rate 1%/5000
 *   node scripts/config-cli.js gens 1-3,7-9
 *   node scripts/config-cli.js preset kanto
 *   node scripts/config-cli.js reset [key]
 *   node scripts/config-cli.js path
 *   node scripts/config-cli.js simulate [tokensPerTurn] [turns]
 *
 * Writing rules: the file stays SPARSE - only keys whose value differs from the
 * shipped default are persisted, so changing a default later still reaches users
 * who never customised it. Unknown keys the user added by hand are preserved.
 * Writes are atomic (temp file + rename) and a malformed existing file is backed
 * up to config.json.bak rather than discarded.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');

const {
  loadConfig, DEFAULTS, dataDir, CONFIG_PATH, COLLECTION_PATH,
} = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const { commas, pct, TIER_LABEL } = require(path.join(PLUGIN_ROOT, 'lib', 'render.js'));
const gensLib = require(path.join(PLUGIN_ROOT, 'lib', 'gens.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

const TIERS = ['common', 'rare', 'legendary', 'mythical'];
const DEX_GENS = gensLib.allGens(dex.pokemon);

// gens is not (yet) known to lib/config.js, so the CLI owns its default.
const GENS_DEFAULT = DEX_GENS.slice();

const out = [];
const say = (s) => out.push(s === undefined ? '' : s);
const flush = () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); out.length = 0; };

/** A user-facing failure: message is printed as-is and the process exits 1. */
function UserError(message, detail) {
  const err = new Error(message);
  err.userFacing = true;
  err.detail = detail || null;
  return err;
}

// ---------------------------------------------------------------------------
// field schema
// ---------------------------------------------------------------------------

const MIN_SPRITE_WIDTH = 8;
const MAX_SPRITE_WIDTH = 64;

function parseBool(raw, key) {
  const v = String(raw).trim().toLowerCase();
  if (['true', 'on', 'yes', 'y', '1', 'enable', 'enabled'].indexOf(v) !== -1) return true;
  if (['false', 'off', 'no', 'n', '0', 'disable', 'disabled'].indexOf(v) !== -1) return false;
  throw UserError(`${key} must be a boolean`, 'accepted: true/false, on/off, yes/no, 1/0');
}

function parseNumber(raw, key) {
  const v = String(raw).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) {
    throw UserError(`${key} must be a number, got "${raw}"`);
  }
  return Number(v);
}

/**
 * maxChance accepts a fraction or a percentage. Disambiguation rule:
 *   - a trailing `%` always means percent      -> 60%   = 0.60,  0.5% = 0.005
 *   - a bare value greater than 1 means percent-> 75     = 0.75
 *   - a bare value of 1 or less is a fraction  -> 0.75   = 0.75,  1 = 1.00
 * Note: bare `1` is read as the fraction 1.0 (= 100%). Users wanting 1% must write `1%`.
 */
function parseChance(raw, key) {
  const text = String(raw).trim();
  const isPercent = /%$/.test(text);
  const n = parseNumber(isPercent ? text.slice(0, -1) : text, key);
  const value = (isPercent || n > 1) ? n / 100 : n;
  if (!isFinite(value) || value < 0 || value > 1) {
    throw UserError(
      `${key} must land between 0 and 1 (0% and 100%), got ${text}`,
      'write a fraction (0.75) or a percentage (75 or 75%)'
    );
  }
  return value;
}

const FIELDS = {
  ratePerToken: {
    help: 'catch probability per token spent (0 < r <= 1)',
    parse: (raw) => {
      const n = parseNumber(raw, 'ratePerToken');
      if (!(n > 0) || n > 1) {
        throw UserError(
          `ratePerToken must be greater than 0 and at most 1, got ${raw}`,
          'try `rate 1%/5000` instead - it is much easier to reason about'
        );
      }
      return n;
    },
    format: (v) => `${(v * 100).toFixed(6)}% per token  (1% per ${tokensPerPercent(v)} tokens)`,
  },
  maxChance: {
    help: 'ceiling on one turn\'s catch chance (0-1, or a percentage)',
    parse: (raw) => parseChance(raw, 'maxChance'),
    format: (v) => `${pct(v, 2)} max in one turn`,
  },
  showMisses: {
    help: 'print a one-line report on missed rolls too (true/false)',
    parse: (raw) => parseBool(raw, 'showMisses'),
    format: (v) => String(v),
  },
  enabled: {
    help: 'master switch - false pauses rolling without uninstalling (true/false)',
    parse: (raw) => parseBool(raw, 'enabled'),
    format: (v) => String(v),
  },
  sprites: {
    help: 'draw sprite art above the catch banner (true/false)',
    parse: (raw) => parseBool(raw, 'sprites'),
    format: (v) => String(v),
  },
  shinyChance: {
    help: 'chance a catch is the alternate-colour shiny variant (0-1, or a percentage)',
    parse: (raw) => parseChance(raw, 'shinyChance'),
    format: (v) => (v > 0
      ? `${pct(v, 3)}  (about 1 in ${commas(1 / v)} catches)`
      : '0%  (shinies off)'),
  },
  spriteWidth: {
    help: `terminal columns for sprite art (${MIN_SPRITE_WIDTH}-${MAX_SPRITE_WIDTH})`,
    parse: (raw) => {
      const n = parseNumber(raw, 'spriteWidth');
      if (!Number.isInteger(n) || n < MIN_SPRITE_WIDTH || n > MAX_SPRITE_WIDTH) {
        throw UserError(
          `spriteWidth must be a whole number between ${MIN_SPRITE_WIDTH} and ${MAX_SPRITE_WIDTH}, got ${raw}`
        );
      }
      return n;
    },
    format: (v) => `${v} columns`,
  },
  gens: {
    help: `generations the catch pool draws from (${DEX_GENS[0]}-${DEX_GENS[DEX_GENS.length - 1]}, or "all")`,
    parse: (raw) => gensLib.parseGenSpec(String(raw), DEX_GENS),
    format: (v) => `${gensLib.formatGenSpec(v, DEX_GENS)}  (${commas(gensLib.activePool(dex.pokemon, { gens: v }).length)} species)`,
  },
};

for (const tier of TIERS) {
  FIELDS[`tierWeights.${tier}`] = {
    help: `relative weight for ${TIER_LABEL[tier]} picks (>= 0)`,
    parse: (raw) => {
      const n = parseNumber(raw, `tierWeights.${tier}`);
      if (!(n >= 0) || !isFinite(n)) {
        throw UserError(`tierWeights.${tier} must be zero or a positive number, got ${raw}`);
      }
      return n;
    },
    format: (v) => String(v),
  };
}

const SHOW_ORDER = ['enabled', 'ratePerToken', 'maxChance', 'gens']
  .concat(TIERS.map((t) => `tierWeights.${t}`))
  .concat(['showMisses', 'sprites', 'spriteWidth', 'shinyChance']);

// ---------------------------------------------------------------------------
// raw file access
// ---------------------------------------------------------------------------

function defaultFor(key) {
  if (key === 'gens') return GENS_DEFAULT;
  if (key.indexOf('tierWeights.') === 0) return DEFAULTS.tierWeights[key.slice(12)];
  return DEFAULTS[key];
}

function getPath(obj, key) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) {
      return undefined;
    }
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, key) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur === null || typeof cur[p] !== 'object' || cur[p] === null) return false;
    cur = cur[p];
  }
  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cur, leaf)) return false;
  delete cur[leaf];
  return true;
}

/**
 * Reads the config file verbatim (no default merging), so we can tell which
 * keys the user actually customised.
 *
 * @returns {{raw:object, existed:boolean, backedUp:string|null}}
 */
function readRaw() {
  const file = CONFIG_PATH();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { raw: {}, existed: false, backedUp: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Do not silently destroy hand-written content we could not understand.
    const backup = `${file}.bak`;
    try {
      fs.writeFileSync(backup, text);
    } catch (err) {
      throw UserError(`config.json is malformed and could not be backed up: ${err.message}`);
    }
    return { raw: {}, existed: true, backedUp: backup };
  }
  return { raw: parsed, existed: true, backedUp: null };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Drops any known key whose value already matches the shipped default. */
function pruneDefaults(raw) {
  for (const key of Object.keys(FIELDS)) {
    const present = getPath(raw, key);
    if (present === undefined) continue;
    if (sameValue(present, defaultFor(key))) deletePath(raw, key);
  }
  // Only collapse an empty tierWeights *object*. A hand-written non-object (say
  // `"tierWeights": null` or a string) has no keys either, and deleting it would
  // silently destroy content the user wrote -- readRaw() deliberately preserves
  // anything it did not understand.
  if (isPlainObject(raw.tierWeights) && Object.keys(raw.tierWeights).length === 0) {
    delete raw.tierWeights;
  }
  return raw;
}

/** Atomic write: temp file beside the target, then rename. */
function writeRaw(raw) {
  pruneDefaults(raw);
  const dir = dataDir();
  const file = CONFIG_PATH();

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw UserError(`could not create ${dir}: ${err.message}`);
  }

  if (Object.keys(raw).length === 0) {
    // Nothing customised left: remove the file so defaults apply cleanly.
    try { fs.unlinkSync(file); } catch (_) { /* already absent */ }
    return;
  }

  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw UserError(`could not write ${file}: ${err.message}`);
  }
}

/**
 * Effective config: exactly what the hook will act on.
 *
 * lib/config.js already resolves `gens` (null means "no filter"), so this must
 * report that same resolution rather than re-deriving it -- an independent second
 * opinion here is how /pokeconfig show ends up lying about what the hook does.
 * The only translation is null -> the full generation list, for display.
 */
function effective() {
  const config = loadConfig();
  const info = readRaw();
  config.gens = gensLib.isGenList(config.gens)
    ? config.gens.slice()
    : GENS_DEFAULT.slice();
  return { config: config, info: info };
}

// ---------------------------------------------------------------------------
// derived numbers
// ---------------------------------------------------------------------------

function tokensPerPercent(ratePerToken) {
  const n = 1 / ratePerToken / 100;
  if (!isFinite(n) || n < 1) return 'under 1';
  return commas(n);
}

function chanceAt(tokens, config) {
  return Math.max(0, Math.min(config.maxChance, tokens * config.ratePerToken));
}

function bar(fraction, width) {
  const w = width || 24;
  const filled = Math.max(0, Math.min(w, Math.round(fraction * w)));
  return `[${'#'.repeat(filled)}${'-'.repeat(w - filled)}]`;
}

function tierShares(weights) {
  const total = TIERS.reduce((s, t) => s + (weights[t] || 0), 0);
  const shares = {};
  for (const t of TIERS) shares[t] = total > 0 ? (weights[t] || 0) / total : 0;
  return shares;
}

// ---------------------------------------------------------------------------
// rate spec
// ---------------------------------------------------------------------------

/**
 * Parses an ergonomic rate spec into a per-token probability.
 *
 * Accepted forms (case-insensitive, whitespace-insensitive):
 *   1%/5000            1% per 5,000 tokens
 *   1% per 5000 tokens same thing, spelled out
 *   1%/5k              k and m suffixes are honoured
 *   0.0002%/token      per-token percentage (denominator of 1)
 *   0.0002%            bare percentage, denominator defaults to 1 token
 *   5000               bare token count: 1% per 5,000 tokens
 *
 * Disambiguation rule: the numerator MUST carry a `%` unless the whole spec is a
 * single bare number, which is always read as "tokens per 1%". That keeps `5000`
 * (a friendly token count) from ever being mistaken for a probability.
 */
function parseRateSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw UserError('rate needs a spec', 'examples: `rate 1%/5000`, `rate 1% per 5000 tokens`, `rate 5000`');
  }
  let text = spec.toLowerCase().trim();
  text = text.replace(/\bper\b/g, '/').replace(/\btokens?\b/g, 'token').replace(/\s+/g, '');
  text = text.replace(/,/g, '');

  const suffix = (numText) => {
    const m = /^(\d+\.?\d*|\.\d+)([km])?$/.exec(numText);
    if (!m) return null;
    let n = Number(m[1]);
    if (m[2] === 'k') n *= 1000;
    if (m[2] === 'm') n *= 1000000;
    return n;
  };

  // Bare token count: "5000" or "5k" -> 1% per that many tokens.
  if (!/%/.test(text) && text.indexOf('/') === -1) {
    const tokens = suffix(text);
    if (tokens === null || !(tokens > 0)) {
      throw UserError(
        `could not read rate spec "${spec}"`,
        'examples: `1%/5000`, `1% per 5000 tokens`, `0.0002%/token`, `5000`'
      );
    }
    return { rate: 0.01 / tokens, percent: 1, tokens: tokens };
  }

  const parts = text.split('/');
  if (parts.length > 2) throw UserError(`could not read rate spec "${spec}"`, 'only one "/" or "per" is allowed');

  const numText = parts[0];
  const denText = parts.length === 2 ? parts[1] : 'token';

  if (!/%$/.test(numText)) {
    throw UserError(
      `could not read rate spec "${spec}"`,
      'the chance part needs a % sign, e.g. `1%/5000`. A bare number like `5000` means 1% per 5,000 tokens.'
    );
  }
  const percent = suffix(numText.slice(0, -1));
  if (percent === null || !(percent > 0) || percent > 100) {
    throw UserError(`rate chance must be greater than 0% and at most 100%, got "${numText}"`);
  }

  let tokens;
  if (denText === 'token' || denText === '' || denText === '1' || denText === '1token') {
    tokens = 1;
  } else {
    tokens = suffix(denText.replace(/token/g, ''));
  }
  if (tokens === null || !(tokens > 0)) {
    throw UserError(`could not read the token count in "${spec}"`, 'e.g. `1%/5000` or `1% per 5000 tokens`');
  }

  const rate = (percent / 100) / tokens;
  if (!(rate > 0) || rate > 1) {
    throw UserError(`"${spec}" works out to a per-token chance of ${rate}, which is out of range`);
  }
  return { rate: rate, percent: percent, tokens: tokens };
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

const PRESETS = {
  'default': {
    blurb: 'restore every shipped default',
    values: {
      ratePerToken: DEFAULTS.ratePerToken,
      maxChance: DEFAULTS.maxChance,
      showMisses: DEFAULTS.showMisses,
      enabled: DEFAULTS.enabled,
      sprites: DEFAULTS.sprites,
      spriteWidth: DEFAULTS.spriteWidth,
      shinyChance: DEFAULTS.shinyChance,
      gens: GENS_DEFAULT.slice(),
      'tierWeights.common': DEFAULTS.tierWeights.common,
      'tierWeights.rare': DEFAULTS.tierWeights.rare,
      'tierWeights.legendary': DEFAULTS.tierWeights.legendary,
      'tierWeights.mythical': DEFAULTS.tierWeights.mythical,
    },
  },
  hardcore: {
    blurb: 'about half the default rate - 1% per 10,000 tokens',
    values: { ratePerToken: 0.000001, maxChance: 0.5 },
  },
  casual: {
    blurb: 'generous - 1% per 1,000 tokens',
    values: { ratePerToken: 0.00001 },
  },
  kanto: {
    blurb: 'Gen 1 only',
    values: { gens: [1] },
  },
  classic: {
    blurb: 'Gens 1-3',
    values: { gens: [1, 2, 3] },
  },
  modern: {
    blurb: 'Gens 6-9',
    values: { gens: [6, 7, 8, 9] },
  },
  'no-legendaries': {
    blurb: 'commons and rares only',
    values: { 'tierWeights.legendary': 0, 'tierWeights.mythical': 0 },
  },
  'shiny-hunt': {
    blurb: 'shinies 8x more often - 1 in 16 catches',
    values: { shinyChance: 0.0625 },
  },
  'no-shinies': {
    blurb: 'turn alternate colours off entirely',
    values: { shinyChance: 0 },
  },
};

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function noteBackup(info) {
  if (info.backedUp) {
    say(`  NOTE  your config.json was not valid JSON. It has been copied to`);
    say(`        ${info.backedUp} and defaults are in effect until you fix it.`);
    say();
  }
}

function cmdShow() {
  const state = effective();
  const config = state.config;
  const raw = state.info.raw;

  say('TOKEN-POKEMON CONFIG');
  say('='.repeat(52));
  say();
  noteBackup(state.info);

  say('  SETTINGS                                    (d)efault (u)ser');
  for (const key of SHOW_ORDER) {
    const field = FIELDS[key];
    const value = key.indexOf('tierWeights.') === 0
      ? config.tierWeights[key.slice(12)]
      : config[key];
    const userSet = getPath(raw, key) !== undefined;
    say(`    ${key.padEnd(22)} ${field.format(value).padEnd(44)} ${userSet ? 'u' : 'd'}`);
  }
  say();

  say('  WHAT THAT MEANS');
  say(`    1% chance costs         ${tokensPerPercent(config.ratePerToken)} tokens`);
  for (const t of [500, 5000, 40000]) {
    const c = chanceAt(t, config);
    say(`    ${(commas(t) + ' token turn').padEnd(24)}${bar(c, 20)} ${pct(c, 2)}`);
  }
  say(`    Expected 1 catch per    ${commas(1 / config.ratePerToken)} tokens`);
  say();

  const shares = tierShares(config.tierWeights);
  say('  ODDS ONCE A CATCH IS WON');
  for (const t of TIERS) {
    say(`    ${TIER_LABEL[t].padEnd(10)} ${bar(shares[t], 20)} ${pct(shares[t], 2)}`);
  }
  say();

  const pool = gensLib.activePool(dex.pokemon, config);
  say('  ACTIVE POOL');
  say(`    Generations  ${gensLib.formatGenSpec(config.gens, DEX_GENS)}`);
  say(`    Species      ${commas(pool.length)} of ${commas(dex.pokemon.length)}`
    + `  ${bar(pool.length / dex.pokemon.length, 20)}`);
  const byGen = gensLib.countByGen(pool);
  say('    Per gen      ' + DEX_GENS.map((g) => `${g}:${byGen[g] || 0}`).join('  '));
  say();

  say(`  Config file  ${CONFIG_PATH()}${state.info.existed ? '' : '  (not created yet)'}`);
  say('  Change it    /pokeconfig set <key> <value>   /pokeconfig preset <name>');
}

function cmdSet(argv) {
  const key = argv[0];
  const value = argv.slice(1).join(' ');

  if (!key) {
    say('Usage: /pokeconfig set <key> <value>');
    say();
    say('KEYS');
    for (const k of SHOW_ORDER) say(`  ${k.padEnd(22)} ${FIELDS[k].help}`);
    throw UserError('no key given');
  }
  if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
    throw UserError(`unknown key "${key}"`, `valid keys: ${SHOW_ORDER.join(', ')}`);
  }
  if (value === '') throw UserError(`set ${key} needs a value`, FIELDS[key].help);

  const parsed = FIELDS[key].parse(value);
  const state = effective();
  const before = key.indexOf('tierWeights.') === 0
    ? state.config.tierWeights[key.slice(12)]
    : state.config[key];

  const raw = state.info.raw;
  setPath(raw, key, parsed);
  writeRaw(raw);

  say('TOKEN-POKEMON CONFIG - SET');
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  ${key}`);
  say(`    was  ${FIELDS[key].format(before)}`);
  say(`    now  ${FIELDS[key].format(parsed)}`);
  if (sameValue(parsed, defaultFor(key))) {
    say(`    (that is the shipped default, so the key was dropped from the file)`);
  }
  say();
  say(`  Saved to ${CONFIG_PATH()}`);
}

function cmdRate(argv) {
  const spec = argv.join(' ');
  const parsed = parseRateSpec(spec);
  const state = effective();
  const before = state.config.ratePerToken;

  const raw = state.info.raw;
  raw.ratePerToken = parsed.rate;
  writeRaw(raw);

  say('TOKEN-POKEMON CONFIG - RATE');
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  was  1% per ${tokensPerPercent(before)} tokens  (${(before * 100).toFixed(6)}% per token)`);
  say(`  now  1% per ${tokensPerPercent(parsed.rate)} tokens  (${(parsed.rate * 100).toFixed(6)}% per token)`);
  say();
  const cfg = { ratePerToken: parsed.rate, maxChance: state.config.maxChance };
  for (const t of [500, 5000, 40000]) {
    const c = chanceAt(t, cfg);
    say(`    ${(commas(t) + ' token turn').padEnd(24)}${bar(c, 20)} ${pct(c, 2)}`);
  }
  say();
  say(`  Saved to ${CONFIG_PATH()}`);
}

function cmdGens(argv) {
  let args = argv.slice();
  let exclude = false;
  if (args.length && String(args[0]).toLowerCase() === 'exclude') {
    exclude = true;
    args = args.slice(1);
  }
  const spec = args.join(',').replace(/,+/g, ',');
  if (spec === '') {
    throw UserError(
      'gens needs a spec',
      'examples: `gens 1-5`, `gens 1,3,5`, `gens 1-3,7-9`, `gens all`, `gens gen1-gen5`, '
      + '`gens -6` (all but gen 6), `gens exclude 6,8`'
    );
  }

  let chosen;
  if (exclude) {
    const drop = gensLib.parseGenSpec(spec, DEX_GENS);
    chosen = DEX_GENS.filter((g) => drop.indexOf(g) === -1);
    if (chosen.length === 0) throw UserError(`excluding "${spec}" leaves no generations`);
  } else {
    chosen = gensLib.parseGenSpec(spec, DEX_GENS);
  }

  const state = effective();
  const raw = state.info.raw;
  raw.gens = chosen;
  writeRaw(raw);

  const pool = gensLib.activePool(dex.pokemon, { gens: chosen });
  const byGen = gensLib.countByGen(pool);

  say('TOKEN-POKEMON CONFIG - GENERATIONS');
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  was  ${gensLib.formatGenSpec(state.config.gens, DEX_GENS)}`);
  say(`  now  ${gensLib.formatGenSpec(chosen, DEX_GENS)}`);
  say();
  say(`  POOL  ${commas(pool.length)} of ${commas(dex.pokemon.length)} species`
    + `  ${bar(pool.length / dex.pokemon.length, 20)} ${pct(pool.length / dex.pokemon.length, 1)}`);
  for (const g of DEX_GENS) {
    const total = dex.pokemon.filter((p) => p.gen === g).length;
    const active = byGen[g] || 0;
    say(`    Gen ${g}  ${String(active).padStart(4)}/${String(total).padEnd(4)} ${active ? 'in' : 'out'}`);
  }
  say();
  const tiers = {};
  for (const p of pool) tiers[p.tier] = (tiers[p.tier] || 0) + 1;
  say('  BY RARITY  ' + TIERS.map((t) => `${TIER_LABEL[t]} ${tiers[t] || 0}`).join('   '));
  say();
  say(`  Saved to ${CONFIG_PATH()}`);
}

function cmdPreset(argv) {
  const name = String(argv[0] || '').toLowerCase();
  if (!name || !Object.prototype.hasOwnProperty.call(PRESETS, name)) {
    say('TOKEN-POKEMON CONFIG - PRESETS');
    say('='.repeat(52));
    say();
    for (const k of Object.keys(PRESETS)) say(`  ${k.padEnd(16)} ${PRESETS[k].blurb}`);
    say();
    say('  Usage: /pokeconfig preset <name>');
    throw UserError(name ? `unknown preset "${argv[0]}"` : 'no preset name given');
  }

  const preset = PRESETS[name];
  const state = effective();
  const raw = state.info.raw;

  const changes = [];
  for (const key of Object.keys(preset.values)) {
    const target = preset.values[key];
    const before = key.indexOf('tierWeights.') === 0
      ? state.config.tierWeights[key.slice(12)]
      : state.config[key];
    if (name === 'default') {
      // Restoring defaults means removing the key outright.
      deletePath(raw, key);
    } else {
      setPath(raw, key, target);
    }
    if (!sameValue(before, target)) {
      changes.push({ key: key, before: before, after: target });
    }
  }
  writeRaw(raw);

  say(`TOKEN-POKEMON CONFIG - PRESET ${name.toUpperCase()}`);
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  ${preset.blurb}`);
  say();
  if (changes.length === 0) {
    say('  CHANGED  nothing - your config already matched this preset.');
  } else {
    say('  CHANGED');
    for (const c of changes) {
      say(`    ${c.key.padEnd(22)} ${FIELDS[c.key].format(c.before)}`);
      say(`    ${''.padEnd(22)} -> ${FIELDS[c.key].format(c.after)}`);
    }
  }
  say();
  say(`  Saved to ${CONFIG_PATH()}`);
}

function cmdReset(argv) {
  const key = argv[0];
  const state = effective();

  say('TOKEN-POKEMON CONFIG - RESET');
  say('='.repeat(52));
  say();
  noteBackup(state.info);

  if (!key) {
    const file = CONFIG_PATH();
    let removed = false;
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw UserError(`could not remove ${file}: ${err.message}`);
    }
    say(removed
      ? `  Removed ${file}`
      : `  Nothing to remove - ${file} does not exist.`);
    say('  Every setting is back to its shipped default.');
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
    throw UserError(`unknown key "${key}"`, `valid keys: ${SHOW_ORDER.join(', ')}`);
  }

  const raw = state.info.raw;
  const had = getPath(raw, key) !== undefined;
  deletePath(raw, key);
  writeRaw(raw);

  say(had
    ? `  Removed ${key} - back to the default: ${FIELDS[key].format(defaultFor(key))}`
    : `  ${key} was not customised; it is already the default: ${FIELDS[key].format(defaultFor(key))}`);
}

function cmdPath() {
  const state = effective();
  say('TOKEN-POKEMON PATHS');
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  Config      ${CONFIG_PATH()}${state.info.existed ? '' : '  (not created yet)'}`);
  say(`  Collection  ${COLLECTION_PATH()}`);
  say(`  Data dir    ${dataDir()}`);
  say(`  Plugin      ${PLUGIN_ROOT}`);
}

function cmdSimulate(argv) {
  const { roll } = require(path.join(PLUGIN_ROOT, 'lib', 'roll.js'));

  const tokensArg = argv[0] === undefined ? 5000 : parseNumber(argv[0], 'tokensPerTurn');
  const turnsArg = argv[1] === undefined ? 1000 : parseNumber(argv[1], 'turns');
  if (!(tokensArg > 0)) throw UserError(`tokensPerTurn must be greater than 0, got ${argv[0]}`);
  if (!Number.isInteger(turnsArg) || turnsArg < 1 || turnsArg > 5000000) {
    throw UserError(`turns must be a whole number between 1 and 5,000,000, got ${argv[1]}`);
  }

  const state = effective();
  const config = state.config;
  const pool = gensLib.activePool(dex.pokemon, config);
  const chance = chanceAt(tokensArg, config);

  let catches = 0;
  let shinies = 0;
  const tierSeen = { common: 0, rare: 0, legendary: 0, mythical: 0 };
  const genSeen = {};
  let firstCatchTurn = null;
  let gapSum = 0;
  let gapCount = 0;
  let lastCatch = 0;

  for (let i = 1; i <= turnsArg; i++) {
    const r = roll(tokensArg, config, pool);
    if (!r.caught) continue;
    catches++;
    if (r.shiny) shinies++;
    tierSeen[r.tier] = (tierSeen[r.tier] || 0) + 1;
    genSeen[r.pokemon.gen] = (genSeen[r.pokemon.gen] || 0) + 1;
    if (firstCatchTurn === null) firstCatchTurn = i;
    gapSum += i - lastCatch;
    gapCount++;
    lastCatch = i;
  }

  const observedRate = catches / turnsArg;
  const shares = tierShares(config.tierWeights);

  say('TOKEN-POKEMON CONFIG - SIMULATE');
  say('='.repeat(52));
  say();
  noteBackup(state.info);
  say(`  ${commas(turnsArg)} turns of ${commas(tokensArg)} tokens `
    + `(${commas(turnsArg * tokensArg)} tokens total)`);
  say(`  Rate 1% per ${tokensPerPercent(config.ratePerToken)} tokens, cap ${pct(config.maxChance, 0)}`);
  say(`  Pool ${commas(pool.length)} species, gens ${gensLib.formatGenSpec(config.gens, DEX_GENS)}`);
  say();

  say('  PER-TURN CHANCE');
  say(`    Configured   ${bar(chance, 20)} ${pct(chance, 3)}`);
  say(`    Observed     ${bar(observedRate, 20)} ${pct(observedRate, 3)}`);
  say();

  say('  CATCHES');
  say(`    Expected     ${commas(turnsArg * chance)}`);
  say(`    Simulated    ${commas(catches)}`);
  if (config.shinyChance > 0) {
    say(`    Shiny        ${commas(shinies)}  expected ${commas(catches * config.shinyChance)}`
      + `  (1 in ${commas(1 / config.shinyChance)} catches)`);
  }
  say();

  say('  TURNS TO A CATCH');
  if (chance > 0) {
    say(`    Expected     ${commas(1 / chance)} turns  (~${commas(tokensArg / chance)} tokens)`);
  } else {
    say('    Expected     never - the chance for this turn size is 0%');
  }
  say(`    Observed avg ${gapCount ? commas(gapSum / gapCount) + ' turns' : 'no catches in this run'}`);
  say(`    First catch  ${firstCatchTurn === null ? 'never' : 'turn ' + commas(firstCatchTurn)}`);
  say();

  say('  PROJECTED TIERS');
  for (const t of TIERS) {
    const got = tierSeen[t] || 0;
    say(`    ${TIER_LABEL[t].padEnd(10)} ${String(got).padStart(7)}  ${pct(catches ? got / catches : 0, 2).padStart(7)}`
      + `   expected ${pct(shares[t], 2)}`);
  }
  say();

  const activeGens = DEX_GENS.filter((g) => config.gens.indexOf(g) !== -1);
  say('  PROJECTED GENERATIONS');
  say('    ' + activeGens.map((g) => `${g}:${genSeen[g] || 0}`).join('  '));
  const leaked = Object.keys(genSeen).filter((g) => config.gens.indexOf(Number(g)) === -1);
  if (leaked.length) say(`    WARNING  catches leaked from filtered gens: ${leaked.join(', ')}`);
  say();
  say('  Tune with /pokeconfig rate <spec> then simulate again.');
}

function cmdHelp() {
  say('TOKEN-POKEMON CONFIG - HELP');
  say('='.repeat(52));
  say();
  say('  COMMANDS');
  say('    show                        current settings and what they mean');
  say('    set <key> <value>           change one setting');
  say('    rate <spec>                 friendly rate setter, e.g. 1%/5000');
  say('    gens <spec>                 limit the pool, e.g. 1-3,7-9 or all or -6');
  say('    gens exclude <spec>         drop specific generations');
  say('    preset <name>               apply a bundle of settings');
  say('    reset [key]                 forget one key, or the whole file');
  say('    path                        where the files live');
  say('    simulate [tokens] [turns]   Monte-Carlo the current settings');
  say();
  say('  KEYS');
  for (const k of SHOW_ORDER) say(`    ${k.padEnd(22)} ${FIELDS[k].help}`);
  say();
  say('  PRESETS');
  for (const k of Object.keys(PRESETS)) say(`    ${k.padEnd(16)} ${PRESETS[k].blurb}`);
  say();
  say('  EXAMPLES');
  say('    /pokeconfig rate 1% per 2000 tokens');
  say('    /pokeconfig set maxChance 60%');
  say('    /pokeconfig set tierWeights.legendary 5');
  say('    /pokeconfig preset kanto');
  say('    /pokeconfig simulate 8000 20000');
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main(argvIn) {
  // The slash command passes `-- '$ARGUMENTS'`: single-quoted so the shell cannot
  // expand or execute anything inside it, and `--`-separated so a spec starting
  // with `-` (e.g. `gens -6`) is never mistaken for a flag by anything upstream.
  let incoming = argvIn[0] === '--' ? argvIn.slice(1) : argvIn;
  // Single-quoting also means the whole thing arrives as one argument; split it
  // back out on whitespace.
  if (incoming.length === 1 && /\s/.test(String(incoming[0]))) {
    incoming = String(incoming[0]).trim().split(/\s+/);
  }
  // Slash-command expansion can hand us one empty quoted arg; drop blanks.
  const argv = incoming.filter((a) => String(a).trim() !== '');
  const cmd = (argv[0] || 'show').toLowerCase();
  const rest = argv.slice(1);

  switch (cmd) {
    case 'show': case 'status': case 'get': cmdShow(); break;
    case 'set': cmdSet(rest); break;
    case 'rate': cmdRate(rest); break;
    case 'gens': case 'gen': case 'generations': cmdGens(rest); break;
    case 'preset': case 'presets': cmdPreset(rest); break;
    case 'reset': case 'unset': cmdReset(rest); break;
    case 'path': case 'paths': cmdPath(); break;
    case 'simulate': case 'sim': cmdSimulate(rest); break;
    case 'help': case '--help': case '-h': cmdHelp(); break;
    default:
      cmdHelp();
      throw UserError(`unknown command "${argv[0]}"`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
    flush();
  } catch (err) {
    // Never leak a stack trace at users; always exit non-zero on failure.
    flush();
    const lines = [`/pokeconfig: ${err && err.message ? err.message : err}`];
    if (err && err.detail) lines.push(`  ${err.detail}`);
    if (!(err && (err.userFacing || err.code === 'BAD_GEN_SPEC'))) {
      lines.push('  Nothing was written.');
    }
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
  }
}

module.exports = {
  main,
  parseRateSpec,
  parseChance,
  parseBool,
  readRaw,
  writeRaw,
  effective,
  FIELDS,
  PRESETS,
  SHOW_ORDER,
  GENS_DEFAULT,
};
