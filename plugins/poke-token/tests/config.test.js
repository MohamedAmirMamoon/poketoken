#!/usr/bin/env node
/**
 * Config CLI + generation filtering tests. No framework: run with
 * `node tests/config.test.js`. Exits non-zero on the first failure.
 *
 * Every case runs against a throwaway CLAUDE_CONFIG_DIR under os.tmpdir(), so
 * the real ~/.claude/poke-token/config.json is never read or written.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'config-cli.js');

const gensLib = require(path.join(PLUGIN_ROOT, 'lib', 'gens.js'));
const { DEFAULTS } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

const DEX_GENS = gensLib.allGens(dex.pokemon);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
}

// --- sandbox harness --------------------------------------------------------

const SANDBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-token-test-'));

// Registered here, next to the mkdtemp, rather than at the end of the file: a
// failing test() calls process.exit(1), so anything registered further down is
// never reached and every failed run would leak a sandbox tree.
process.on('exit', () => {
  try {
    fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  } catch (_) { /* leaving temp dirs behind is not a test failure */ }
});

let sandboxSeq = 0;
let SANDBOX = null;

/** Fresh, empty CLAUDE_CONFIG_DIR for the next case. */
function sandbox() {
  SANDBOX = path.join(SANDBOX_ROOT, `case-${++sandboxSeq}`);
  fs.mkdirSync(path.join(SANDBOX, 'poke-token'), { recursive: true });
  return SANDBOX;
}

function configFile() {
  return path.join(SANDBOX, 'poke-token', 'config.json');
}

function writeConfigText(text) {
  fs.writeFileSync(configFile(), text);
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
}

function configExists() {
  return fs.existsSync(configFile());
}

/** Runs the CLI in the sandbox. Returns {code, out}; never throws. */
function cli() {
  const args = Array.prototype.slice.call(arguments);
  try {
    const out = execFileSync(process.execPath, [CLI].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: SANDBOX }),
    });
    return { code: 0, out: out };
  } catch (err) {
    return { code: err.status === undefined ? 1 : err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function ok(res, label) {
  assert.strictEqual(res.code, 0, `${label} exited ${res.code}:\n${res.out}`);
  return res.out;
}

function fails(res, label) {
  assert.notStrictEqual(res.code, 0, `${label} unexpectedly succeeded:\n${res.out}`);
  return res.out;
}

// --- gen spec parsing -------------------------------------------------------

console.log('\ngeneration spec parsing');

test('single, range, list and mixed forms', () => {
  const p = (s) => gensLib.parseGenSpec(s, DEX_GENS);
  assert.deepStrictEqual(p('3'), [3]);
  assert.deepStrictEqual(p('1-5'), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(p('1,3,5'), [1, 3, 5]);
  assert.deepStrictEqual(p('1-3,7-9'), [1, 2, 3, 7, 8, 9]);
  assert.deepStrictEqual(p('9-9'), [9]);
});

test('all and * cover every dex generation', () => {
  assert.deepStrictEqual(gensLib.parseGenSpec('all', DEX_GENS), DEX_GENS);
  assert.deepStrictEqual(gensLib.parseGenSpec('*', DEX_GENS), DEX_GENS);
  assert.deepStrictEqual(gensLib.parseGenSpec('ALL', DEX_GENS), DEX_GENS);
});

test('gen prefixes and whitespace are ignored', () => {
  assert.deepStrictEqual(gensLib.parseGenSpec('gen1-gen5', DEX_GENS), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(gensLib.parseGenSpec(' Gen1 , gen3 ', DEX_GENS), [1, 3]);
  assert.deepStrictEqual(gensLib.parseGenSpec('GEN9', DEX_GENS), [9]);
});

test('leading minus excludes, inner minus is a range', () => {
  assert.deepStrictEqual(gensLib.parseGenSpec('-6', DEX_GENS), [1, 2, 3, 4, 5, 7, 8, 9]);
  assert.deepStrictEqual(gensLib.parseGenSpec('1-6', DEX_GENS), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(gensLib.parseGenSpec('all,-6,-8', DEX_GENS), [1, 2, 3, 4, 5, 7, 9]);
  assert.deepStrictEqual(gensLib.parseGenSpec('1-9,-6-8', DEX_GENS), [1, 2, 3, 4, 5, 9]);
  assert.deepStrictEqual(gensLib.parseGenSpec('!2', DEX_GENS), [1, 3, 4, 5, 6, 7, 8, 9]);
});

test('duplicates and overlaps normalize to a sorted unique list', () => {
  assert.deepStrictEqual(gensLib.parseGenSpec('3,1,3,2-3', DEX_GENS), [1, 2, 3]);
  assert.deepStrictEqual(gensLib.parseGenSpec('5,1-2,4', DEX_GENS), [1, 2, 4, 5]);
});

test('malformed specs throw a readable BAD_GEN_SPEC error', () => {
  const bad = ['', '   ', 'abc', '0', '10', '1-', '-', '5-2', '1-2-3', '1,,2', 'gen', '-all', '99', '1.5'];
  for (const spec of bad) {
    assert.throws(
      () => gensLib.parseGenSpec(spec, DEX_GENS),
      (err) => err.code === 'BAD_GEN_SPEC' && typeof err.message === 'string' && err.message.length > 0,
      `expected "${spec}" to be rejected`
    );
  }
  assert.throws(() => gensLib.parseGenSpec(null, DEX_GENS), /generation spec/);
});

test('formatGenSpec round-trips through parseGenSpec', () => {
  for (const spec of ['1', '1-5', '1,3,5', '1-3,7-9', 'all', '-6']) {
    const parsed = gensLib.parseGenSpec(spec, DEX_GENS);
    const formatted = gensLib.formatGenSpec(parsed, DEX_GENS);
    assert.deepStrictEqual(gensLib.parseGenSpec(formatted, DEX_GENS), parsed, `${spec} -> ${formatted}`);
  }
  assert.strictEqual(gensLib.formatGenSpec(DEX_GENS, DEX_GENS), 'all');
  assert.strictEqual(gensLib.formatGenSpec([1, 2, 3, 7, 8, 9], DEX_GENS), '1-3,7-9');
  assert.strictEqual(gensLib.formatGenSpec([4], DEX_GENS), '4');
});

console.log('\nactivePool filtering');

test('no gens key means the whole dex', () => {
  assert.strictEqual(gensLib.activePool(dex.pokemon, {}).length, dex.pokemon.length);
  assert.strictEqual(gensLib.activePool(dex.pokemon, undefined).length, dex.pokemon.length);
  assert.strictEqual(gensLib.activePool(dex.pokemon, { gens: DEX_GENS }).length, dex.pokemon.length);
});

test('a filter restricts the pool to exactly those generations', () => {
  const pool = gensLib.activePool(dex.pokemon, { gens: [1] });
  assert.strictEqual(pool.length, 151);
  assert.ok(pool.every((p) => p.gen === 1));

  const mixed = gensLib.activePool(dex.pokemon, { gens: [1, 3] });
  assert.strictEqual(mixed.length, 151 + 135);
  assert.ok(mixed.every((p) => p.gen === 1 || p.gen === 3));
});

test('garbage gens values fall back to the full dex rather than emptying it', () => {
  for (const bad of [[], null, 'kanto', [0], [42], ['1'], {}]) {
    assert.strictEqual(gensLib.activePool(dex.pokemon, { gens: bad }).length, dex.pokemon.length,
      `gens=${JSON.stringify(bad)}`);
  }
});

// --- rate spec -------------------------------------------------------------

console.log('\nrate spec parsing');

const { parseRateSpec, parseChance } = require(CLI);

test('all documented rate forms parse to the right per-token chance', () => {
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-15, `${label}: ${a} !~ ${b}`);
  near(parseRateSpec('1%/5000').rate, 0.000002, '1%/5000');
  near(parseRateSpec('1% per 5000 tokens').rate, 0.000002, 'spelled out');
  near(parseRateSpec('1% per 5,000 tokens').rate, 0.000002, 'with a comma');
  near(parseRateSpec('1%/5k').rate, 0.000002, 'k suffix');
  near(parseRateSpec('5000').rate, 0.000002, 'bare token count');
  near(parseRateSpec('0.0002%/token').rate, 0.000002, 'per token');
  near(parseRateSpec('0.0002%').rate, 0.000002, 'bare percentage');
  near(parseRateSpec('1%/1000').rate, 0.00001, '1%/1000');
  near(parseRateSpec('2%/5000').rate, 0.000004, '2%/5000');
  near(parseRateSpec('  1%  PER  5000  TOKENS ').rate, 0.000002, 'case and space');
});

test('bare numbers are token counts, never probabilities', () => {
  assert.strictEqual(parseRateSpec('5000').tokens, 5000);
  assert.strictEqual(parseRateSpec('5000').percent, 1);
  assert.strictEqual(parseRateSpec('1000').tokens, 1000);
});

test('malformed rate specs throw without a stack-worthy error', () => {
  const bad = ['', '   ', 'abc', '0', '-5', '1%/0', '1%/abc', '0%/5000', '101%/5000',
    '1%/5000/2', '%/5000', '/5000'];
  for (const spec of bad) {
    assert.throws(() => parseRateSpec(spec), (err) => err.userFacing === true, `expected "${spec}" rejected`);
  }
  assert.throws(() => parseRateSpec(null), (err) => err.userFacing === true);
});

console.log('\nmaxChance percentage disambiguation');

test('trailing % is always percent', () => {
  assert.strictEqual(parseChance('60%', 'maxChance'), 0.6);
  assert.strictEqual(parseChance('75%', 'maxChance'), 0.75);
  assert.ok(Math.abs(parseChance('0.5%', 'maxChance') - 0.005) < 1e-15);
  assert.strictEqual(parseChance('100%', 'maxChance'), 1);
});

test('bare > 1 is percent, bare <= 1 is a fraction', () => {
  assert.strictEqual(parseChance('75', 'maxChance'), 0.75);
  assert.strictEqual(parseChance('0.75', 'maxChance'), 0.75);
  assert.strictEqual(parseChance('50', 'maxChance'), 0.5);
  assert.strictEqual(parseChance('0.5', 'maxChance'), 0.5);
  assert.strictEqual(parseChance('1', 'maxChance'), 1); // the one overlap: 100% either way
  assert.strictEqual(parseChance('0', 'maxChance'), 0);
});

test('out-of-range chances are rejected', () => {
  for (const bad of ['150%', '101', '100.1', '-1', '-0.5', 'abc', '', '  ']) {
    assert.throws(() => parseChance(bad, 'maxChance'), (err) => err.userFacing === true, `input ${bad}`);
  }
  // Consistency of the rule: a bare 1.5 is 1.5%, not an out-of-range fraction.
  assert.ok(Math.abs(parseChance('1.5', 'maxChance') - 0.015) < 1e-15);
});

// --- CLI happy paths -------------------------------------------------------

console.log('\nCLI subcommands (happy path)');

test('show works with no config file and reports defaults', () => {
  sandbox();
  const out = ok(cli('show'), 'show');
  assert.ok(/POKE-TOKEN CONFIG/.test(out));
  assert.ok(/1% chance costs\s+5,000 tokens/.test(out), 'derived 1% cost missing');
  assert.ok(/5,000 token turn.*1\.00%/.test(out), '5k turn chance missing');
  assert.ok(/500 token turn.*0\.10%/.test(out), '500 turn chance missing');
  assert.ok(/40,000 token turn.*8\.00%/.test(out), '40k turn chance missing');
  assert.ok(/78\.00%/.test(out), 'common tier share missing');
  assert.ok(new RegExp(`${dex.pokemon.length.toLocaleString('en-US')} of`).test(out), 'pool size missing');
  assert.ok(!configExists(), 'show must not create the config file');
});

test('no-arg invocation is the same as show', () => {
  sandbox();
  const bare = ok(cli(), 'bare');
  assert.ok(/POKE-TOKEN CONFIG/.test(bare));
  assert.ok(/SETTINGS/.test(bare));
});

test('set writes the value and reports was/now', () => {
  sandbox();
  const out = ok(cli('set', 'spriteWidth', '32'), 'set spriteWidth');
  assert.ok(/was\s+48 columns/.test(out), out);
  assert.ok(/now\s+32 columns/.test(out), out);
  assert.strictEqual(readConfig().spriteWidth, 32);
});

test('set handles dotted tier weights', () => {
  sandbox();
  ok(cli('set', 'tierWeights.legendary', '5'), 'set legendary');
  assert.deepStrictEqual(readConfig(), { tierWeights: { legendary: 5 } });
});

test('set accepts every boolean spelling', () => {
  for (const truthy of ['true', 'on', 'yes', '1']) {
    sandbox();
    ok(cli('set', 'showMisses', truthy), `showMisses ${truthy}`);
    assert.strictEqual(readConfig().showMisses, true, truthy);
  }
  for (const falsy of ['false', 'off', 'no', '0']) {
    sandbox();
    ok(cli('set', 'enabled', falsy), `enabled ${falsy}`);
    assert.strictEqual(readConfig().enabled, false, falsy);
  }
});

test('rate sets ratePerToken from a friendly spec', () => {
  sandbox();
  const out = ok(cli('rate', '1%', 'per', '2000', 'tokens'), 'rate');
  assert.ok(/now\s+1% per 2,000 tokens/.test(out), out);
  assert.ok(Math.abs(readConfig().ratePerToken - 0.000005) < 1e-15);
});

test('gens writes a normalized sorted array and reports the pool', () => {
  sandbox();
  const out = ok(cli('gens', '3,1,7-8'), 'gens');
  assert.deepStrictEqual(readConfig().gens, [1, 3, 7, 8]);
  assert.ok(/POOL\s+470 of/.test(out), out); // 151+135+88+96
  assert.ok(/Gen 2\s+0\/100\s+out/.test(out), out);
});

test('gens exclude drops the named generations', () => {
  sandbox();
  ok(cli('gens', 'exclude', '6,7,8,9'), 'gens exclude');
  assert.deepStrictEqual(readConfig().gens, [1, 2, 3, 4, 5]);
});

test('gens all clears the filter entirely (sparse: key dropped)', () => {
  sandbox();
  ok(cli('gens', '1'), 'gens 1');
  assert.deepStrictEqual(readConfig().gens, [1]);
  ok(cli('gens', 'all'), 'gens all');
  assert.ok(!configExists(), 'all-generations is the default, so the file should be gone');
});

test('every preset applies and reports its changes', () => {
  const expectations = {
    hardcore: (c) => assert.ok(Math.abs(c.ratePerToken - 0.000001) < 1e-15, JSON.stringify(c)),
    casual: (c) => assert.ok(Math.abs(c.ratePerToken - 0.00001) < 1e-15, JSON.stringify(c)),
    kanto: (c) => assert.deepStrictEqual(c.gens, [1]),
    classic: (c) => assert.deepStrictEqual(c.gens, [1, 2, 3]),
    modern: (c) => assert.deepStrictEqual(c.gens, [6, 7, 8, 9]),
    'no-legendaries': (c) => assert.deepStrictEqual(c.tierWeights, { legendary: 0, mythical: 0 }),
  };
  for (const name of Object.keys(expectations)) {
    sandbox();
    const out = ok(cli('preset', name), `preset ${name}`);
    assert.ok(/CHANGED/.test(out), `preset ${name} did not report changes:\n${out}`);
    expectations[name](readConfig());
  }
});

test('preset default restores the shipped defaults by emptying the file', () => {
  sandbox();
  ok(cli('preset', 'kanto'), 'kanto');
  ok(cli('set', 'maxChance', '30%'), 'maxChance');
  assert.ok(configExists());
  const out = ok(cli('preset', 'default'), 'preset default');
  assert.ok(/CHANGED/.test(out), out);
  assert.ok(!configExists(), 'preset default should leave no customised keys');
});

test('preset default keeps unknown hand-written keys', () => {
  sandbox();
  writeConfigText(JSON.stringify({ myOwnThing: 1, gens: [1] }));
  ok(cli('preset', 'default'), 'preset default');
  assert.deepStrictEqual(readConfig(), { myOwnThing: 1 });
});

test('reset with a key removes just that key', () => {
  sandbox();
  ok(cli('set', 'spriteWidth', '20'), 'set');
  ok(cli('set', 'maxChance', '40%'), 'set');
  const out = ok(cli('reset', 'spriteWidth'), 'reset key');
  assert.ok(/Removed spriteWidth/.test(out), out);
  assert.deepStrictEqual(readConfig(), { maxChance: 0.4 });
});

test('reset with no key removes the whole file', () => {
  sandbox();
  ok(cli('set', 'maxChance', '40%'), 'set');
  const out = ok(cli('reset'), 'reset all');
  assert.ok(/Removed .*config\.json/.test(out), out);
  assert.ok(!configExists());
  // Idempotent: a second reset is not an error.
  assert.ok(/Nothing to remove/.test(ok(cli('reset'), 'reset again')));
});

test('path prints the config and collection locations', () => {
  sandbox();
  const out = ok(cli('path'), 'path');
  assert.ok(out.indexOf(path.join(SANDBOX, 'poke-token', 'config.json')) !== -1, out);
  assert.ok(out.indexOf(path.join(SANDBOX, 'poke-token', 'collection.json')) !== -1, out);
});

test('help lists commands, keys and presets', () => {
  sandbox();
  const out = ok(cli('help'), 'help');
  for (const needle of ['simulate', 'ratePerToken', 'tierWeights.legendary', 'no-legendaries', 'gens']) {
    assert.ok(out.indexOf(needle) !== -1, `help missing ${needle}`);
  }
});

test('a single pre-joined argument string is split back into argv', () => {
  // /pokeconfig passes "$ARGUMENTS" quoted, so the whole tail arrives as one arg.
  sandbox();
  ok(cli('set tierWeights.legendary 5'), 'quoted set');
  assert.deepStrictEqual(readConfig().tierWeights, { legendary: 5 });

  sandbox();
  ok(cli('rate 1% per 2000 tokens'), 'quoted rate');
  assert.ok(Math.abs(readConfig().ratePerToken - 0.000005) < 1e-15);

  sandbox();
  ok(cli('gens 1-3,7-9'), 'quoted gens');
  assert.deepStrictEqual(readConfig().gens, [1, 2, 3, 7, 8, 9]);

  sandbox();
  assert.ok(/SETTINGS/.test(ok(cli('   '), 'quoted blank')), 'blank args should show config');

  sandbox();
  const out = ok(cli('simulate 5000 2000'), 'quoted simulate');
  assert.ok(/2,000 turns of 5,000 tokens/.test(out), out);
});

test('quoting keeps the shell from glob-expanding gens *', () => {
  // `gens *` unquoted would expand to local filenames; quoted it reaches us whole.
  sandbox();
  ok(cli('gens *'), 'gens star');
  assert.ok(!configExists(), 'gens * means all generations, which is the default');
});

test('unknown command exits non-zero after printing help', () => {
  sandbox();
  const out = fails(cli('flibbertigibbet'), 'unknown command');
  assert.ok(/unknown command/.test(out), out);
});

// --- discoverability -------------------------------------------------------

console.log('\nbare show lists the options');

test('a bare invocation offers every preset and every settable key', () => {
  sandbox();
  // Someone typing `/pokeconfig` with no arguments is asking "what can I do?",
  // so the no-arg screen has to name the options, not just the current values.
  const out = ok(cli(), 'bare');
  for (const name of ['default', 'hardcore', 'casual', 'kanto', 'classic',
    'modern', 'no-legendaries', 'shiny-hunt', 'no-shinies']) {
    assert.ok(out.indexOf(name) !== -1, `preset "${name}" is not offered`);
  }
  for (const key of ['enabled', 'ratePerToken', 'maxChance', 'gens', 'showMisses',
    'sprites', 'spriteWidth', 'shinyChance', 'tierWeights.mythical']) {
    assert.ok(out.indexOf(key) !== -1, `key "${key}" is not offered`);
  }
  for (const verb of ['rate', 'gens', 'simulate', 'reset', 'help']) {
    assert.ok(new RegExp('\\n\\s+' + verb + '\\b').test(out), `verb "${verb}" is not offered`);
  }
});

// --- shinies ---------------------------------------------------------------

console.log('\nshinyChance');

test('show reports the shiny rate as odds a person can read', () => {
  sandbox();
  const out = ok(cli('show'), 'show');
  assert.ok(/shinyChance/.test(out), 'shinyChance is not shown at all');
  assert.ok(/about 1 in 128 catches/.test(out), `no readable odds: ${out.match(/.*shinyChance.*/)}`);
});

test('shinyChance accepts both a fraction and a percentage', () => {
  sandbox();
  ok(cli('set', 'shinyChance', '0.25'), 'fraction');
  assert.strictEqual(readConfig().shinyChance, 0.25);

  sandbox();
  ok(cli('set', 'shinyChance', '5%'), 'percentage');
  assert.ok(Math.abs(readConfig().shinyChance - 0.05) < 1e-15, JSON.stringify(readConfig()));
});

test('shinyChance 0 is a meaningful value, not a rejected one', () => {
  // Unlike ratePerToken, zero here is the documented way to turn shinies off, so
  // it must be storable rather than treated as "unset" and dropped.
  sandbox();
  const out = ok(cli('set', 'shinyChance', '0'), 'set 0');
  assert.strictEqual(readConfig().shinyChance, 0, JSON.stringify(readConfig()));
  assert.ok(/shinies off/.test(out), `zero not explained: ${out.match(/.*now.*/)}`);
});

test('out-of-range shinyChance is rejected without writing', () => {
  // Bare numbers above 1 are percentages, same as maxChance, so `2` means 2% and
  // is perfectly valid; only genuinely impossible odds are refused.
  for (const bad of ['150%', '101', '-1', '-5%', 'lots']) {
    sandbox();
    const out = fails(cli('set', 'shinyChance', bad), `set shinyChance ${bad}`);
    assert.ok(/pokeconfig:/.test(out), `no clear message for ${bad}:\n${out}`);
    assert.ok(!configExists(), `set shinyChance ${bad} wrote a file it should not have`);
  }
});

test('the shiny presets apply and are reversible', () => {
  sandbox();
  ok(cli('preset', 'shiny-hunt'), 'shiny-hunt');
  assert.strictEqual(readConfig().shinyChance, 0.0625);

  ok(cli('preset', 'no-shinies'), 'no-shinies');
  assert.strictEqual(readConfig().shinyChance, 0);

  // default is the round trip back: the shipped rate is sparse, so the key goes.
  ok(cli('preset', 'default'), 'preset default');
  assert.ok(!configExists(), 'preset default left a customised shinyChance behind');
});

test('help lists shinyChance and its presets', () => {
  sandbox();
  const out = ok(cli('help'), 'help');
  for (const needle of ['shinyChance', 'shiny-hunt', 'no-shinies']) {
    assert.ok(out.indexOf(needle) !== -1, `help missing ${needle}`);
  }
});

test('simulate projects shinies at the configured rate, and omits them at 0', () => {
  sandbox();
  ok(cli('set', 'shinyChance', '25%'), 'set rate');
  const out = ok(cli('simulate', '5000', '100000'), 'simulate');
  const row = /Shiny\s+([\d,]+)\s+expected\s+([\d,]+)/.exec(out);
  assert.ok(row, `no shiny row in simulate:\n${out}`);
  const [simulated, expected] = [row[1], row[2]].map((n) => Number(n.replace(/,/g, '')));
  assert.ok(expected > 0, 'expected shinies should not be zero at 25%');
  // Binomial around 25% of ~1,000 catches: SD ~13.7, so 6 sigma is ~82.
  assert.ok(Math.abs(simulated - expected) < Math.max(40, expected * 0.25),
    `simulated ${simulated} shinies vs expected ${expected}`);

  sandbox();
  ok(cli('set', 'shinyChance', '0'), 'set 0');
  assert.ok(!/Shiny\s+\d/.test(ok(cli('simulate'), 'simulate 0')), 'reported shinies with them off');
});

// --- validation ------------------------------------------------------------

console.log('\nCLI validation (nothing is written on bad input)');

test('out-of-range and wrong-type values are rejected without writing', () => {
  const cases = [
    ['maxChance', '150%'], ['maxChance', '101'], ['maxChance', '-1'], ['maxChance', 'abc'],
    ['spriteWidth', '4'], ['spriteWidth', '999'], ['spriteWidth', '12.5'], ['spriteWidth', 'wide'],
    ['ratePerToken', '0'], ['ratePerToken', '-1'], ['ratePerToken', '2'], ['ratePerToken', 'fast'],
    ['tierWeights.legendary', '-1'], ['tierWeights.legendary', 'lots'],
    ['enabled', 'maybe'], ['sprites', 'sometimes'], ['showMisses', '2.5'],
    ['gens', '99'], ['gens', 'kanto'],
  ];
  for (const pair of cases) {
    sandbox();
    const out = fails(cli('set', pair[0], pair[1]), `set ${pair[0]} ${pair[1]}`);
    assert.ok(/pokeconfig:/.test(out), `no clear message for ${pair.join(' ')}:\n${out}`);
    assert.ok(!configExists(), `set ${pair.join(' ')} wrote a file it should not have`);
  }
});

test('a rejected set leaves an existing config untouched', () => {
  sandbox();
  ok(cli('set', 'spriteWidth', '24'), 'seed');
  const before = fs.readFileSync(configFile(), 'utf8');
  fails(cli('set', 'spriteWidth', '9999'), 'bad set');
  assert.strictEqual(fs.readFileSync(configFile(), 'utf8'), before);
});

test('rejection messages state the valid range or type', () => {
  sandbox();
  assert.ok(/between 8 and 64/.test(fails(cli('set', 'spriteWidth', '200'), 'width')));
  assert.ok(/between 0 and 1|0% and 100%/.test(fails(cli('set', 'maxChance', '400'), 'chance')));
  assert.ok(/boolean/.test(fails(cli('set', 'enabled', 'perhaps'), 'bool')));
  assert.ok(/out of range \(1-9\)/.test(fails(cli('gens', '12'), 'gens')));
});

test('unknown keys are rejected by set and reset', () => {
  sandbox();
  assert.ok(/unknown key/.test(fails(cli('set', 'nope', '1'), 'set nope')));
  assert.ok(/unknown key/.test(fails(cli('reset', 'nope'), 'reset nope')));
  assert.ok(!configExists());
});

test('set with a missing value or key fails cleanly', () => {
  sandbox();
  fails(cli('set'), 'bare set');
  fails(cli('set', 'maxChance'), 'set without value');
  fails(cli('gens'), 'bare gens');
  fails(cli('rate'), 'bare rate');
  fails(cli('preset'), 'bare preset');
  fails(cli('preset', 'nonesuch'), 'bad preset');
  assert.ok(!configExists());
});

// --- write semantics -------------------------------------------------------

console.log('\nwrite semantics');

test('setting one key leaves a config containing only that key', () => {
  sandbox();
  ok(cli('set', 'maxChance', '50%'), 'set');
  assert.deepStrictEqual(readConfig(), { maxChance: 0.5 });
});

test('setting a value back to the default drops the key (stays sparse)', () => {
  sandbox();
  ok(cli('set', 'spriteWidth', '32'), 'set 32');
  ok(cli('set', 'maxChance', '50%'), 'set chance');
  ok(cli('set', 'spriteWidth', String(DEFAULTS.spriteWidth)), 'set back to default');
  assert.deepStrictEqual(readConfig(), { maxChance: 0.5 });
});

test('no default values ever appear in the written file', () => {
  sandbox();
  ok(cli('set', 'showMisses', 'true'), 'set');
  const written = readConfig();
  assert.deepStrictEqual(Object.keys(written), ['showMisses']);
  for (const key of ['ratePerToken', 'maxChance', 'enabled', 'sprites', 'spriteWidth', 'gens', 'tierWeights']) {
    assert.ok(!(key in written), `${key} leaked into a sparse config`);
  }
});

test('unknown hand-written keys survive a set', () => {
  sandbox();
  writeConfigText(JSON.stringify({ experimental: { shiny: true }, note: 'hands off', spriteWidth: 16 }, null, 2));
  ok(cli('set', 'maxChance', '50%'), 'set');
  const after = readConfig();
  assert.deepStrictEqual(after.experimental, { shiny: true });
  assert.strictEqual(after.note, 'hands off');
  assert.strictEqual(after.spriteWidth, 16);
  assert.strictEqual(after.maxChance, 0.5);
});

test('unknown keys inside tierWeights survive a set', () => {
  sandbox();
  writeConfigText(JSON.stringify({ tierWeights: { shiny: 42 } }));
  ok(cli('set', 'tierWeights.rare', '30'), 'set');
  assert.deepStrictEqual(readConfig().tierWeights, { shiny: 42, rare: 30 });
});

test('malformed JSON is backed up, announced, and not lost', () => {
  sandbox();
  const broken = '{ "maxChance": 0.5,,, oops';
  writeConfigText(broken);
  const out = ok(cli('set', 'spriteWidth', '20'), 'set over broken config');
  assert.ok(/not valid JSON/.test(out), out);
  assert.ok(/config\.json\.bak/.test(out), out);
  const bak = configFile() + '.bak';
  assert.ok(fs.existsSync(bak), 'no backup written');
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), broken, 'backup does not match the original bytes');
  assert.deepStrictEqual(readConfig(), { spriteWidth: 20 });
});

test('show also reports a malformed config instead of ignoring it', () => {
  sandbox();
  writeConfigText('not json at all');
  const out = ok(cli('show'), 'show');
  assert.ok(/not valid JSON/.test(out), out);
  assert.ok(fs.existsSync(configFile() + '.bak'));
});

test('a JSON array config is treated as malformed', () => {
  sandbox();
  writeConfigText('[1,2,3]');
  const out = ok(cli('show'), 'show');
  assert.ok(/not valid JSON/.test(out), out);
});

test('no temp files are left behind', () => {
  sandbox();
  ok(cli('set', 'maxChance', '50%'), 'set');
  const leftovers = fs.readdirSync(path.join(SANDBOX, 'poke-token'))
    .filter((f) => f.indexOf('.tmp') !== -1);
  assert.deepStrictEqual(leftovers, []);
});

test('the real user config dir is never touched', () => {
  sandbox();
  // A sandbox path is in force for every cli() call; assert it really is.
  const out = ok(cli('path'), 'path');
  assert.ok(out.indexOf(os.homedir() + '/.claude/poke-token') === -1,
    'CLI resolved the real home config despite CLAUDE_CONFIG_DIR');
});

// --- simulate --------------------------------------------------------------

console.log('\nsimulate (statistical sanity)');

test('simulate runs with defaults and reports the expected sections', () => {
  sandbox();
  const out = ok(cli('simulate'), 'simulate');
  for (const needle of ['PER-TURN CHANCE', 'CATCHES', 'TURNS TO A CATCH', 'PROJECTED TIERS', 'PROJECTED GENERATIONS']) {
    assert.ok(out.indexOf(needle) !== -1, `simulate missing ${needle}:\n${out}`);
  }
  assert.ok(/1,000 turns of 5,000 tokens/.test(out), out);
});

test('at 1% per 5,000 tokens over 100,000 turns the catch rate lands near 1%', () => {
  sandbox();
  const out = ok(cli('simulate', '5000', '100000'), 'simulate 100k');
  const configured = /Configured\s+\[[#-]+\]\s+([\d.]+)%/.exec(out);
  const observed = /Observed\s+\[[#-]+\]\s+([\d.]+)%/.exec(out);
  assert.ok(configured && observed, `could not read rates from:\n${out}`);
  assert.strictEqual(Number(configured[1]), 1, 'configured chance should be exactly 1%');
  const obs = Number(observed[1]);
  // SD of the estimate is sqrt(.01*.99/1e5) ~= 0.0314pp; 0.15pp is ~4.8 sigma.
  assert.ok(Math.abs(obs - 1) < 0.15, `observed ${obs}% is not near 1%`);

  const expected = /Expected\s+([\d,]+)\n/.exec(out);
  const simulated = /Simulated\s+([\d,]+)/.exec(out);
  assert.ok(expected && simulated, `could not read catch counts from:\n${out}`);
  assert.strictEqual(Number(expected[1].replace(/,/g, '')), 1000, 'expected catches should be 1,000');
  const got = Number(simulated[1].replace(/,/g, ''));
  assert.ok(got > 850 && got < 1150, `simulated catches ${got} outside 850-1150`);
});

test('expected turns-to-first-catch is 1/chance', () => {
  sandbox();
  ok(cli('rate', '1%/1000'), 'rate'); // 5000 tokens -> 5% -> 20 turns
  const out = ok(cli('simulate', '5000', '20000'), 'simulate');
  assert.ok(/Expected\s+20 turns/.test(out), out);
  const observed = /Observed avg\s+([\d,]+) turns/.exec(out);
  assert.ok(observed, out);
  const avg = Number(observed[1].replace(/,/g, ''));
  assert.ok(avg >= 18 && avg <= 22, `observed average gap ${avg} not near 20`);
});

test('maxChance caps the simulated rate', () => {
  sandbox();
  ok(cli('set', 'maxChance', '10%'), 'cap');
  ok(cli('rate', '1%/10'), 'huge rate'); // uncapped this would be 100%
  const out = ok(cli('simulate', '5000', '20000'), 'simulate');
  const configured = /Configured\s+\[[#-]+\]\s+([\d.]+)%/.exec(out);
  assert.ok(configured && Math.abs(Number(configured[1]) - 10) < 0.001, out);
  const observed = /Observed\s+\[[#-]+\]\s+([\d.]+)%/.exec(out);
  assert.ok(Math.abs(Number(observed[1]) - 10) < 1.5, `observed ${observed[1]}% should be near the 10% cap`);
});

test('tier weights of zero never appear in simulated catches', () => {
  sandbox();
  ok(cli('preset', 'no-legendaries'), 'preset');
  ok(cli('rate', '1%/10'), 'rate');
  const out = ok(cli('simulate', '5000', '5000'), 'simulate');
  assert.ok(/LEGENDARY\s+0\s/.test(out), `legendaries leaked:\n${out}`);
  assert.ok(/MYTHICAL\s+0\s/.test(out), `mythicals leaked:\n${out}`);
});

test('after gens 1, no simulated catch comes from gen 2+', () => {
  sandbox();
  ok(cli('gens', '1'), 'gens 1');
  ok(cli('rate', '1%/10'), 'rate'); // near-certain catches, so plenty of samples
  const out = ok(cli('simulate', '5000', '5000'), 'simulate');
  assert.ok(!/WARNING/.test(out), `filter leaked:\n${out}`);
  const line = /PROJECTED GENERATIONS\n\s+(.+)/.exec(out);
  assert.ok(line, out);
  const pairs = line[1].trim().split(/\s+/).map((s) => s.split(':').map(Number));
  assert.deepStrictEqual(pairs.map((p) => p[0]), [1], 'only gen 1 should be listed');
  assert.ok(pairs[0][1] > 1000, `expected many gen-1 catches, got ${pairs[0][1]}`);
  assert.ok(/Pool 151 species/.test(out), out);
});

test('gens 6-9 restricts simulated catches to modern generations', () => {
  sandbox();
  ok(cli('preset', 'modern'), 'preset modern');
  ok(cli('rate', '1%/10'), 'rate');
  const out = ok(cli('simulate', '5000', '3000'), 'simulate');
  assert.ok(!/WARNING/.test(out), `filter leaked:\n${out}`);
  const line = /PROJECTED GENERATIONS\n\s+(.+)/.exec(out);
  const gens = line[1].trim().split(/\s+/).map((s) => Number(s.split(':')[0]));
  assert.deepStrictEqual(gens, [6, 7, 8, 9]);
  assert.ok(/Pool 376 species/.test(out), out); // 72+88+96+120
});

test('simulate rejects nonsense arguments', () => {
  sandbox();
  for (const args of [['simulate', '0'], ['simulate', '-5'], ['simulate', 'abc'],
    ['simulate', '5000', '0'], ['simulate', '5000', '1.5'], ['simulate', '5000', '99999999']]) {
    fails(cli.apply(null, args), args.join(' '));
  }
});

console.log(`\n${passed} tests passed\n`);
