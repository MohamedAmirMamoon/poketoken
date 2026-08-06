#!/usr/bin/env node
/**
 * Entry-point test suite. No framework: run with `node tests/hook.test.js`.
 *
 * Covers the two things the user actually touches, end to end as real
 * subprocesses with real transcript files and a real collection on disk:
 *
 *   hooks/pull.js     the Stop hook -- stdin handling, token accounting,
 *                     persistence, systemMessage output, and the hard rule that
 *                     it must ALWAYS exit 0 no matter what it is fed
 *   scripts/stats.js  the /pokedex reporter -- every view, on empty and full
 *                     collections, with hostile arguments
 *
 * Every case runs with CLAUDE_CONFIG_DIR pointed at a scratch dir, so the real
 * collection is never read or written.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'pull.js');
const STATS = path.join(PLUGIN_ROOT, 'scripts', 'stats.js');
const SHOW = path.join(PLUGIN_ROOT, 'hooks', 'show.js');
const dex = require(path.join(PLUGIN_ROOT, 'data', 'dex.json'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hook-'));

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

/** A fresh isolated config dir. */
function freshDir(label) {
  const dir = fs.mkdtempSync(path.join(ROOT, `${label}-`));
  fs.mkdirSync(path.join(dir, 'poke-token'), { recursive: true });
  return dir;
}

function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, 'poke-token', 'config.json'), JSON.stringify(config, null, 2));
}

function readCollection(dir) {
  const p = path.join(dir, 'poke-token', 'collection.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Runs a script as a subprocess. Never throws on non-zero exit. */
function run(script, args, opts) {
  const o = opts || {};
  return spawnSync(process.execPath, [script].concat(args || []), {
    input: o.input === undefined ? '' : o.input,
    encoding: 'utf8',
    timeout: 30000,
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: o.dir || freshDir('run') }, o.env || {}),
  });
}

/**
 * Builds a transcript that mimics Claude Code's real JSONL, including the two
 * traps the parser has to survive: streaming writes one record per content block
 * all repeating the SAME cumulative usage, and most `user` records are tool_result
 * plumbing rather than prompts.
 *
 * @param {Array} spec entries like {prompt}, {assistant, id, in, cache, out, blocks}, {toolResult}, {sidechain}
 */
function transcript(dir, spec) {
  const lines = [];
  for (const item of spec) {
    if (item.prompt !== undefined) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: item.prompt } }));
    } else if (item.interrupt !== undefined) {
      // How Claude Code records an Esc: a user-role text block, indistinguishable
      // from a typed prompt except for the text itself.
      const text = item.interrupt === true ? '[Request interrupted by user]' : item.interrupt;
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }));
    } else if (item.toolResult !== undefined) {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: item.toolResult }] },
      }));
    } else if (item.assistant !== undefined) {
      const usage = {
        input_tokens: item.in || 0,
        cache_creation_input_tokens: item.cache || 0,
        cache_read_input_tokens: item.cacheRead || 0,
        output_tokens: item.out || 0,
      };
      // Streaming duplication: N records, one per content block, same usage each.
      for (let b = 0; b < (item.blocks || 1); b++) {
        lines.push(JSON.stringify({
          type: 'assistant',
          isSidechain: !!item.sidechain,
          message: { id: item.id, role: 'assistant', content: [{ type: 'text', text: item.assistant }], usage },
        }));
      }
    }
  }
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function payload(transcriptPath, over) {
  return JSON.stringify(Object.assign({
    session_id: 'sess-test',
    transcript_path: transcriptPath,
    cwd: '/tmp/project',
    hook_event_name: 'Stop',
  }, over || {}));
}

/** Config that makes a catch certain, so output is deterministic. */
const ALWAYS = { ratePerToken: 1, maxChance: 1, sprites: false };
/** Config that makes a catch impossible. */
const NEVER = { ratePerToken: 0, maxChance: 0, sprites: false };

console.log('\npull.js: the exit-0 contract');

test('every malformed stdin still exits 0 and emits nothing', () => {
  const inputs = [
    '', '   ', 'not json', '{', '[]', 'null', 'true', '42', '"str"',
    '{"transcript_path":null}',
    '{"transcript_path":123}',
    '{"transcript_path":"/nonexistent/path/to/nowhere.jsonl"}',
    '{"transcript_path":""}',
    '{}',
    JSON.stringify({ transcript_path: '/etc/passwd' }),
  ];
  for (const input of inputs) {
    const r = run(HOOK, [], { input });
    assert.strictEqual(r.status, 0, `exit ${r.status} for input ${JSON.stringify(input.slice(0, 40))}`);
    assert.strictEqual(r.stdout, '', `unexpected output for ${JSON.stringify(input.slice(0, 40))}: ${r.stdout}`);
  }
});

test('a corrupt transcript exits 0 without output', () => {
  const dir = freshDir('corrupt-transcript');
  const p = path.join(dir, 'bad.jsonl');
  for (const body of ['', 'garbage\nmore garbage', '{"partial":', '\n\n\n', '{}\n{}\n']) {
    fs.writeFileSync(p, body);
    const r = run(HOOK, [], { input: payload(p), dir });
    assert.strictEqual(r.status, 0, `exit ${r.status} for body ${JSON.stringify(body)}`);
    assert.strictEqual(r.stdout, '', `output for body ${JSON.stringify(body)}`);
  }
});

test('a corrupt collection file does not stop a catch being recorded', () => {
  const dir = freshDir('corrupt-collection');
  writeConfig(dir, ALWAYS);
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'), 'not valid json at all');
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 10, out: 90 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.systemMessage, 'no systemMessage after a corrupt collection');
  assert.strictEqual(readCollection(dir).catches.length, 1, 'catch not recovered into a fresh collection');
});

test('an unwritable data dir still exits 0', () => {
  const dir = freshDir('readonly');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 10, out: 90 }]);
  const dataDir = path.join(dir, 'poke-token');
  fs.chmodSync(dataDir, 0o500); // r-x: cannot create the temp file or lock
  try {
    const r = run(HOOK, [], { input: payload(p), dir });
    assert.strictEqual(r.status, 0, `exit ${r.status} on an unwritable dir; stderr: ${r.stderr}`);
  } finally {
    fs.chmodSync(dataDir, 0o700);
  }
});

test('POKE_TOKEN_DEBUG surfaces errors but still exits 0', () => {
  const dir = freshDir('debug');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 10, out: 90 }]);
  const dataDir = path.join(dir, 'poke-token');
  fs.chmodSync(dataDir, 0o500);
  try {
    const r = run(HOOK, [], { input: payload(p), dir, env: { POKE_TOKEN_DEBUG: '1' } });
    assert.strictEqual(r.status, 0, 'debug mode changed the exit code');
    assert.ok(/poke-token:/.test(r.stderr), `no diagnostic on stderr: ${JSON.stringify(r.stderr)}`);
  } finally {
    fs.chmodSync(dataDir, 0o700);
  }
});

console.log('\npull.js: token accounting through the real hook');

test('streaming duplicates are deduped by message.id', () => {
  const dir = freshDir('dedupe');
  writeConfig(dir, ALWAYS);
  // One message, 8 content-block records, each repeating usage of 100 tokens.
  const p = transcript(dir, [
    { prompt: 'go' },
    { assistant: 'working', id: 'msg_dedupe', in: 40, cache: 10, out: 50, blocks: 8 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.status, 0);
  const msg = JSON.parse(r.stdout).systemMessage;
  // 40 + 10 + 50 = 100, counted ONCE despite 8 records.
  assert.ok(/\b100 tokens\b/.test(msg), `expected 100 tokens, got: ${msg.replace(/\n/g, ' | ')}`);
  assert.strictEqual(readCollection(dir).stats.tokens, 100);
});

test('cache reads are excluded from the billable total', () => {
  const dir = freshDir('cacheread');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [
    { prompt: 'go' },
    { assistant: 'ok', id: 'm1', in: 20, cache: 5, cacheRead: 999999, out: 75 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(/\b100 tokens\b/.test(msg), `cache_read leaked into the total: ${msg.replace(/\n/g, ' | ')}`);
});

test('only messages after the last real prompt are counted', () => {
  const dir = freshDir('lastturn');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [
    { prompt: 'first question' },
    { assistant: 'old answer', id: 'old1', in: 5000, out: 5000 },
    { prompt: 'second question' },
    { assistant: 'new answer', id: 'new1', in: 100, out: 150 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(/\b250 tokens\b/.test(msg), `previous turn bled in: ${msg.replace(/\n/g, ' | ')}`);
});

test('tool_result records do not start a new turn', () => {
  const dir = freshDir('toolresult');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [
    { prompt: 'do a thing' },
    { assistant: 'calling tool', id: 'a1', in: 100, out: 100 },
    { toolResult: 'tool output here' },
    { assistant: 'done', id: 'a2', in: 50, out: 50 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const msg = JSON.parse(r.stdout).systemMessage;
  // All four assistant tokens belong to one turn: 200 + 100 = 300.
  assert.ok(/\b300 tokens\b/.test(msg),
    `tool_result was treated as a prompt boundary: ${msg.replace(/\n/g, ' | ')}`);
});

test('sidechain (subagent) messages are not billed to the turn', () => {
  const dir = freshDir('sidechain');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [
    { prompt: 'delegate this' },
    { assistant: 'main work', id: 'main1', in: 100, out: 100 },
    { assistant: 'subagent work', id: 'sub1', in: 9000, out: 9000, sidechain: true },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(/\b200 tokens\b/.test(msg), `sidechain tokens leaked in: ${msg.replace(/\n/g, ' | ')}`);
});

test('an interrupt is not a turn boundary, so pre-interrupt tokens still count', () => {
  const dir = freshDir('interrupt');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [
    { prompt: 'do the big thing' },
    { assistant: 'working hard', id: 'a1', in: 4000, out: 4000 },
    { interrupt: true },
    { prompt: 'actually do this instead' },
    { assistant: 'ok', id: 'a2', in: 100, out: 100 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(/\b200 tokens\b/.test(msg), `expected 200, got: ${msg.replace(/\n/g, ' | ')}`);
});

test('tokens spent before an interrupt are billed, not orphaned', () => {
  const dir = freshDir('interruptorphan');
  writeConfig(dir, ALWAYS);
  // The interrupt is the LAST user record: without the fix it becomes the turn
  // boundary and all 8,000 tokens vanish, reporting a zero-token turn.
  const p = transcript(dir, [
    { prompt: 'do the big thing' },
    { assistant: 'working hard', id: 'a1', in: 4000, out: 4000 },
    { interrupt: true },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.status, 0);
  assert.notStrictEqual(r.stdout, '', 'the interrupted turn was billed as zero tokens');
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(/\b8,?000 tokens\b/.test(msg), `expected 8,000, got: ${msg.replace(/\n/g, ' | ')}`);
});

test('every interrupt spelling is recognised, including the tool-use variant', () => {
  for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
    const dir = freshDir('interruptvariant');
    writeConfig(dir, ALWAYS);
    const p = transcript(dir, [
      { prompt: 'go' },
      { assistant: 'work', id: 'a1', in: 500, out: 500 },
      { interrupt: text },
    ]);
    const r = run(HOOK, [], { input: payload(p), dir });
    assert.notStrictEqual(r.stdout, '', `orphaned by: ${text}`);
    assert.ok(/\b1,?000 tokens\b/.test(JSON.parse(r.stdout).systemMessage), `wrong total for: ${text}`);
  }
});

test('a transcript with no prompt at all bills nothing', () => {
  const dir = freshDir('noprompt');
  writeConfig(dir, ALWAYS);
  // A sidechain-only subagent transcript. Summing the whole file would bill the
  // entire session as one turn -- and do it again on every subsequent Stop.
  const p = transcript(dir, [
    { assistant: 'subagent work', id: 's1', in: 50000, out: 50000, sidechain: true },
    { assistant: 'orphan main', id: 'm1', in: 30000, out: 30000 },
  ]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'a promptless transcript was billed as a turn');
  assert.strictEqual(readCollection(dir), null, 'a promptless transcript wrote a collection');
});

test('a zero-token turn produces no output and no catch', () => {
  const dir = freshDir('zero');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 0, out: 0 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'rolled on a zero-token turn');
  assert.strictEqual(readCollection(dir), null, 'wrote a collection for a zero-token turn');
});

console.log('\npull.js: rolling and persistence');

test('a guaranteed catch writes a well-formed entry', () => {
  const dir = freshDir('catch');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const data = readCollection(dir);
  assert.strictEqual(data.catches.length, 1);
  const c = data.catches[0];
  for (const k of ['id', 'name', 'gen', 'tier', 'tokens', 'chance', 'roll', 'caughtAt', 'sessionId', 'cwd']) {
    assert.ok(c[k] !== undefined, `entry missing ${k}`);
  }
  assert.strictEqual(c.tokens, 1000);
  assert.strictEqual(c.sessionId, 'sess-test', 'session_id not recorded');
  assert.strictEqual(c.cwd, '/tmp/project', 'cwd not recorded');
  assert.ok(dex.pokemon.some((x) => x.id === c.id && x.name === c.name), 'caught a species not in the dex');
  assert.ok(!Number.isNaN(Date.parse(c.caughtAt)), 'caughtAt is not a valid timestamp');
  assert.strictEqual(data.stats.pulls, 1);
  assert.strictEqual(data.stats.turns, 1);
});

test('a guaranteed miss records the turn but emits nothing by default', () => {
  const dir = freshDir('miss');
  writeConfig(dir, NEVER);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.stdout, '', 'a miss produced output with showMisses off');
  const data = readCollection(dir);
  assert.strictEqual(data.catches.length, 0);
  assert.strictEqual(data.stats.turns, 1, 'the miss was not counted for odds honesty');
  assert.strictEqual(data.stats.tokens, 1000);
  assert.strictEqual(data.stats.pulls, 0);
});

test('showMisses emits a miss line', () => {
  const dir = freshDir('showmiss');
  writeConfig(dir, Object.assign({}, NEVER, { showMisses: true }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const out = JSON.parse(r.stdout);
  assert.ok(/no catch/.test(out.systemMessage), `unexpected miss line: ${out.systemMessage}`);
  assert.ok(/1,000 tokens/.test(out.systemMessage), 'miss line omits the token count');
});

test('stop_hook_active suppresses a second roll for the same turn', () => {
  const dir = freshDir('stophook');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p, { stop_hook_active: true }), dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'rolled again while stop_hook_active');
  assert.strictEqual(readCollection(dir), null, 'wrote a collection while stop_hook_active');
});

test('enabled:false disables the hook entirely', () => {
  const dir = freshDir('disabled');
  writeConfig(dir, Object.assign({}, ALWAYS, { enabled: false }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  assert.strictEqual(r.stdout, '', 'output while disabled');
  assert.strictEqual(readCollection(dir), null, 'wrote while disabled');
});

test('stdout is a single parseable JSON object with only systemMessage', () => {
  const dir = freshDir('shape');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const r = run(HOOK, [], { input: payload(p), dir });
  const parsed = JSON.parse(r.stdout); // throws if trailing junk
  assert.deepStrictEqual(Object.keys(parsed), ['systemMessage']);
  assert.strictEqual(typeof parsed.systemMessage, 'string');
});

test('the gens filter constrains what the hook can catch', () => {
  const dir = freshDir('gens');
  writeConfig(dir, Object.assign({}, ALWAYS, { gens: [1] }));
  const maxGen1 = Math.max.apply(null, dex.pokemon.filter((p) => p.gen === 1).map((p) => p.id));
  for (let i = 0; i < 25; i++) {
    const p = transcript(dir, [{ prompt: `q${i}` }, { assistant: 'a', id: `m${i}`, in: 500, out: 500 }]);
    const r = run(HOOK, [], { input: payload(p), dir });
    assert.strictEqual(r.status, 0);
  }
  const data = readCollection(dir);
  assert.strictEqual(data.catches.length, 25, 'not every forced catch landed');
  for (const c of data.catches) {
    assert.strictEqual(c.gen, 1, `caught Gen ${c.gen} #${c.id} with gens:[1]`);
    assert.ok(c.id <= maxGen1, `id ${c.id} is outside Gen 1`);
  }
});

test('sprites:false yields a plain-text banner with no escapes', () => {
  const dir = freshDir('nosprite');
  writeConfig(dir, ALWAYS);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  assert.strictEqual(msg.indexOf('\x1b'), -1, 'escapes present with sprites disabled');
  assert.ok(/\+-- /.test(msg), 'banner frame missing');
  assert.ok(/\/pokedex to view your collection/.test(msg), 'call to action missing');
});

test('spriteMode:color emits truecolour escapes above the banner', () => {
  const dir = freshDir('sprite');
  writeConfig(dir, {
    ratePerToken: 1, maxChance: 1, sprites: true, spriteWidth: 32, spriteMode: 'color',
  });
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(msg), 'no truecolour foreground in the hook output');
  // The sprite paints backgrounds (`48;2;`); the info card's frame is foreground
  // only. So a background escape sitting before the card's top border (╭) is proof
  // the art is drawn above the card rather than below or inside it.
  assert.ok(msg.indexOf('\x1b[48;2;') < msg.indexOf('╭'), 'art is not above the info card');
});

test('sprites:true draws colour art by default, since the catch banner always colours', () => {
  const dir = freshDir('spritedefault');
  writeConfig(dir, { ratePerToken: 1, maxChance: 1, sprites: true, spriteWidth: 32 });
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  // A caught Pokemon's banner always renders in colour, so the default banner now
  // carries truecolour escapes rather than plain block glyphs.
  assert.ok(/\x1b\[38;2;\d+;\d+;\d+m/.test(msg), 'the default banner lost its colour art');
  // See above: a sprite background escape before the card border proves the order.
  assert.ok(msg.indexOf('\x1b[48;2;') < msg.indexOf('╭'), 'art is not above the info card');
});

test('the colour banner leads with a plain text line, so the hook label misses the art', () => {
  // The Stop hook prepends its own label and eats the leading newline, so
  // whatever is first lands beside it. If that were the sprite's top row the art
  // would be shunted sideways (the collision e28dfa3 fixed for the detail view).
  // The first line must be plain text -- no escapes -- to take that hit.
  const dir = freshDir('bannerlead');
  writeConfig(dir, { ratePerToken: 1, maxChance: 1, sprites: true, spriteWidth: 32, spriteMode: 'color' });
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  const first = msg.split('\n')[0];
  assert.strictEqual(first.indexOf('\x1b'), -1, `banner leads with escapes, not plain text: ${JSON.stringify(first.slice(0, 40))}`);
  assert.ok(first.length > 0, 'banner leads with an empty line the label would still eat');
  // And the art still comes before the card, as the ordering tests require.
  assert.ok(msg.indexOf('\x1b[38;2;') < msg.indexOf('╭'), 'art is not above the info card');
});

console.log('\npull.js: shinies');

/** Guarantees both the catch and the shiny, so the banner is deterministic. */
const ALWAYS_SHINY = Object.assign({}, ALWAYS, { shinyChance: 1 });

test('a shiny catch is stamped in the collection and announced in the banner', () => {
  const dir = freshDir('shiny');
  writeConfig(dir, ALWAYS_SHINY);
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;

  const c = readCollection(dir).catches[0];
  assert.strictEqual(c.shiny, true, 'the shiny was not persisted');
  assert.ok(/SHINY!! A shiny /.test(msg), `no shiny headline: ${msg}`);
  assert.ok(msg.includes(`${c.name.toUpperCase()}`), 'banner name disagrees with the stored catch');
  // The marks line has to carry it too, since that is the row people re-read.
  assert.ok(/^\|   #\d+ - Gen \d+ - \w+ - SHINY - (NEW|dupe)$/m.test(msg),
    `marks line missing SHINY: ${msg.match(/^\|   #.*/m)}`);
});

test('a normal catch carries no shiny key and no shiny wording', () => {
  const dir = freshDir('notshiny');
  writeConfig(dir, Object.assign({}, ALWAYS, { shinyChance: 0 }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;

  const c = readCollection(dir).catches[0];
  assert.ok(!('shiny' in c), 'a normal catch was stamped with a shiny key');
  assert.ok(!/SHINY/i.test(msg), `normal catch mentioned shiny: ${msg}`);
});

test('the shiny headline outranks the legendary one', () => {
  // A shiny legendary must read as a shiny first: at 1/128 the shiny is the rarer
  // half of the event, and burying it under the tier is how people miss it.
  const dir = freshDir('shinylegend');
  writeConfig(dir, Object.assign({}, ALWAYS_SHINY, {
    tierWeights: { common: 0, rare: 0, legendary: 1, mythical: 0 },
  }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  assert.strictEqual(readCollection(dir).catches[0].tier, 'legendary');
  assert.ok(/SHINY!! A shiny /.test(msg), `tier headline won: ${msg.match(/\+-- .*/)}`);
  assert.ok(/LEGENDARY - SHINY/.test(msg), `marks line lost a mark: ${msg.match(/^\|   #.*/m)}`);
});

test('a shiny catch renders the recoloured art, not the normal art', () => {
  const dir = freshDir('shinyart');
  // Pinned to colour: a recolour is what this asserts, and the plain renderer
  // deliberately keeps the same silhouette for both.
  const cfg = {
    ratePerToken: 1, maxChance: 1, sprites: true, spriteWidth: 32, gens: [1], spriteMode: 'color',
  };
  writeConfig(dir, Object.assign({}, cfg, { shinyChance: 1 }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const shinyMsg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  const id = readCollection(dir).catches[0].id;

  const { renderSpriteFit } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
  // The banner draws each species as wide as its byte size allows under the cap,
  // with the config spriteWidth (32) as the ceiling -- so the expected art is the
  // fit render at that same ceiling, not a fixed width.
  const normalArt = renderSpriteFit(id, { maxWidth: 32 });
  const shinyArt = renderSpriteFit(id, { maxWidth: 32, shiny: true });
  assert.ok(shinyMsg.includes(shinyArt), `#${id}: banner does not carry the shiny art`);
  assert.ok(!shinyMsg.includes(normalArt), `#${id}: banner carried the normal art instead`);
});

test('sprites:false still announces a shiny in plain text', () => {
  const dir = freshDir('shinynosprite');
  writeConfig(dir, ALWAYS_SHINY); // ALWAYS already has sprites:false
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 500, out: 500 }]);
  const msg = JSON.parse(run(HOOK, [], { input: payload(p), dir }).stdout).systemMessage;
  assert.strictEqual(msg.indexOf('\x1b'), -1, 'escapes present with sprites disabled');
  assert.ok(/SHINY/.test(msg), 'the shiny went unannounced with art off');
});

console.log('\npull.js: flags');

test('--sprite <id> previews art and exits 0', () => {
  const r = run(HOOK, ['--sprite', '25']);
  assert.strictEqual(r.status, 0);
  assert.ok(/\x1b\[38;2;/.test(r.stdout), 'no colour art in the preview');
});

test('--sprite with a bad id reports cleanly instead of crashing', () => {
  for (const bad of ['0', '99999', 'abc', '-1', '']) {
    const r = run(HOOK, ['--sprite', bad]);
    assert.strictEqual(r.status, 0, `exit ${r.status} for --sprite ${JSON.stringify(bad)}`);
    assert.ok(/no sprite for id/.test(r.stdout) || /\x1b\[38;2;/.test(r.stdout),
      `unexpected output for --sprite ${JSON.stringify(bad)}: ${r.stdout.slice(0, 80)}`);
  }
});

test('--dry-run rolls without touching the collection', () => {
  const dir = freshDir('dryrun');
  writeConfig(dir, ALWAYS);
  const r = run(HOOK, ['--dry-run', '5000'], { dir });
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(/5,000 tokens/.test(parsed.systemMessage), `token count wrong: ${parsed.systemMessage}`);
  assert.strictEqual(readCollection(dir), null, '--dry-run wrote to the collection');
});

console.log('\nstats.js: /pokedex views');

test('an empty collection renders the encouraging summary', () => {
  const dir = freshDir('stats-empty');
  const r = run(STATS, [], { dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(/No Pokemon caught yet/.test(r.stdout), r.stdout.slice(0, 200));
  assert.ok(/POKEDEX/.test(r.stdout));
});

test('the summary header reflects the real dex, not a hardcoded range', () => {
  const dir = freshDir('stats-header');
  const r = run(STATS, [], { dir });
  const gens = Array.from(new Set(dex.pokemon.map((p) => p.gen))).sort((a, b) => a - b);
  const expected = `Gen ${gens[0]}-${gens[gens.length - 1]}`;
  assert.ok(r.stdout.includes(expected), `header lacks ${expected}: ${r.stdout.split('\n')[0]}`);
  assert.ok(/1,025 species/.test(r.stdout), `species count wrong: ${r.stdout.split('\n')[0]}`);
});

test('every view runs cleanly on a populated collection', () => {
  const dir = freshDir('stats-full');
  const catches = [
    { id: 1, name: 'Bulbasaur', gen: 1, tier: 'common' },
    { id: 1, name: 'Bulbasaur', gen: 1, tier: 'common' },
    { id: 150, name: 'Mewtwo', gen: 1, tier: 'legendary' },
    { id: 151, name: 'Mew', gen: 1, tier: 'mythical' },
    { id: 384, name: 'Rayquaza', gen: 3, tier: 'legendary' },
    { id: 1007, name: 'Koraidon', gen: 9, tier: 'legendary' },
  ].map((c, i) => Object.assign({
    tokens: 5000, chance: 0.01, roll: 0.005,
    caughtAt: `2026-01-0${i + 1}T12:30:00.000Z`, sessionId: 's', cwd: '/tmp',
  }, c));
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'),
    JSON.stringify({ version: 1, catches, stats: { turns: 500, tokens: 2500000, pulls: catches.length } }));

  const views = ['', 'odds', 'stats', 'missing', 'common', 'rare', 'legendary', 'mythical',
    'legendaries', 'gen1', 'gen 1', '1', 'gen9', 'GEN1', '  gen1  '];
  for (const v of views) {
    const r = run(STATS, v === '' ? [] : [v], { dir });
    assert.strictEqual(r.status, 0, `view ${JSON.stringify(v)} exited ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, `view ${JSON.stringify(v)} produced nothing`);
    const leak = r.stdout.match(/.*(undefined|NaN|\[object).*/);
    assert.strictEqual(leak, null,
      `view ${JSON.stringify(v)} leaked a placeholder: ${leak ? leak[0].trim() : ''}`);
  }
});

test('the summary counts unique species, not raw catches', () => {
  const dir = freshDir('stats-unique');
  const catches = [1, 1, 1, 25].map((id, i) => ({
    id, name: `M${id}`, gen: 1, tier: 'common', tokens: 100, chance: 1, roll: 0,
    caughtAt: `2026-01-0${i + 1}T00:00:00.000Z`, sessionId: 's', cwd: '/tmp',
  }));
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'),
    JSON.stringify({ version: 1, catches, stats: { turns: 10, tokens: 400, pulls: 4 } }));
  const r = run(STATS, [], { dir });
  assert.ok(/Caught 4 total - 2 unique species/.test(r.stdout),
    `unique count wrong: ${r.stdout.match(/Caught.*/)[0]}`);
});

test('4-digit and 3-digit dex ids stay column-aligned', () => {
  const dir = freshDir('stats-align');
  const catches = [
    { id: 6, name: 'Charizard', gen: 1, tier: 'legendary' },
    { id: 1007, name: 'Koraidon', gen: 9, tier: 'legendary' },
  ].map((c, i) => Object.assign({
    tokens: 100, chance: 1, roll: 0, caughtAt: `2026-01-0${i + 1}T00:00:00.000Z`, sessionId: 's', cwd: '/tmp',
  }, c));
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'),
    JSON.stringify({ version: 1, catches, stats: { turns: 2, tokens: 200, pulls: 2 } }));
  const r = run(STATS, [], { dir });
  const rows = r.stdout.split('\n').filter((l) => /#\d/.test(l));
  assert.ok(rows.length >= 2, 'expected at least two id rows');
  const widths = new Set(rows.map((l) => (l.match(/#(\d+)/) || [, ''])[1].length));
  assert.strictEqual(widths.size, 1, `id widths differ: ${Array.from(widths).join(', ')}`);
});

test('an out-of-range generation is reported, not crashed on', () => {
  const dir = freshDir('stats-badgen');
  for (const arg of ['gen0', 'gen99', '0', '42']) {
    const r = run(STATS, [arg], { dir });
    assert.strictEqual(r.status, 0, `exit ${r.status} for ${arg}`);
    assert.ok(/No generation/.test(r.stdout), `no friendly message for ${arg}: ${r.stdout.slice(0, 120)}`);
  }
});

test('unknown arguments fall back to the summary', () => {
  const dir = freshDir('stats-unknown');
  for (const arg of ['nonsense', '--help', '../../etc/passwd', '{}', 'gen', 'legendaryy']) {
    const r = run(STATS, [arg], { dir });
    assert.strictEqual(r.status, 0, `exit ${r.status} for ${JSON.stringify(arg)}`);
    assert.ok(/POKEDEX/.test(r.stdout), `no summary for ${JSON.stringify(arg)}`);
  }
});

test('odds reports the configured rate, and survives a rate of 1', () => {
  const dir = freshDir('stats-odds');
  writeConfig(dir, { ratePerToken: 1 });
  const r = run(STATS, ['odds'], { dir });
  assert.strictEqual(r.status, 0);
  assert.ok(/1% per under 1 tokens|under 1/.test(r.stdout),
    `degenerate rate not handled: ${r.stdout.match(/Rate.*/)}`);
  assert.ok(!/per 0 tokens/.test(r.stdout), 'reported "per 0 tokens"');
});

test('missing caps names per generation and stays under the systemMessage cap', () => {
  // Worst case: an empty collection is missing every species. Naming all ~1025
  // would blow past the ~10KB cap the report is relayed through, so each gen
  // shows a slice, its true total, and a "+N more" tail.
  const dir = freshDir('stats-missing');
  const r = run(STATS, ['missing'], { dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}`);
  assert.ok(Buffer.byteLength(r.stdout) < 10000,
    `missing view is ${Buffer.byteLength(r.stdout)}B, over the ~10KB cap`);
  assert.ok(/Gen 1 - 151 missing/.test(r.stdout), 'lost the true per-gen total');
  assert.ok(/\.\.\. and \d+ more/.test(r.stdout), 'no "+N more" tail for a capped generation');
});

test('a corrupt collection yields a message, not a stack trace', () => {
  const dir = freshDir('stats-corrupt');
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'), 'totally not json');
  const r = run(STATS, [], { dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}`);
  assert.ok(!/at Object\.|at Module\./.test(r.stdout + r.stderr), 'leaked a stack trace');
  assert.ok(/POKEDEX|Could not read/.test(r.stdout), r.stdout.slice(0, 150));
});

console.log('\nstats.js: species lookup');

/** Seeds a collection and returns its dir. */
function seed(label, catches, stats) {
  const dir = freshDir(label);
  const rows = catches.map((c, i) => Object.assign({
    tokens: 5000, chance: 0.01, roll: 0.005,
    caughtAt: `2026-01-0${(i % 9) + 1}T12:30:00.000Z`, sessionId: 's', cwd: '/tmp',
  }, c));
  fs.writeFileSync(path.join(dir, 'poke-token', 'collection.json'), JSON.stringify({
    version: 1,
    catches: rows,
    stats: stats || { turns: 500, tokens: 2500000, pulls: rows.length },
  }));
  return dir;
}

test('a species name shows its detail card with the catch history', () => {
  const dir = seed('detail', [
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common' },
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common' },
  ]);
  const out = run(STATS, ['pikachu'], { dir }).stdout;
  assert.ok(/#0025 PIKACHU/.test(out), out.slice(0, 200));
  assert.ok(/Generation\s+1/.test(out), 'no generation row');
  assert.ok(/Rarity\s+Common/.test(out), 'no rarity row');
  assert.ok(/Caught\s+2 times/.test(out), `wrong count: ${out.match(/Caught.*/)}`);
  assert.ok(/CATCH HISTORY/.test(out), 'no catch history');
});

test('a unique name prefix resolves, an ambiguous one falls back to the summary', () => {
  const dir = seed('prefix', [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }]);
  assert.ok(/#0025 PIKACHU/.test(run(STATS, ['pikach'], { dir }).stdout), 'unique prefix did not resolve');
  // `gen` matches Gengar and Genesect, so it is not a species query.
  assert.ok(/POKEDEX/.test(run(STATS, ['gen'], { dir }).stdout), 'ambiguous prefix resolved to a species');
});

test('#id addresses a species, while a bare number stays a generation', () => {
  const dir = seed('byid', [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }]);
  assert.ok(/#0025 PIKACHU/.test(run(STATS, ['#25'], { dir }).stdout), '#25 did not resolve');
  assert.ok(/#0025 PIKACHU/.test(run(STATS, ['#025'], { dir }).stdout), 'zero-padded #025 did not resolve');
  // The long-standing meaning of a bare number must not change under it.
  const bare = run(STATS, ['3'], { dir }).stdout;
  assert.ok(/GENERATION 3/.test(bare), `bare 3 stopped meaning Gen 3: ${bare.slice(0, 120)}`);
});

test('an out-of-range #id is reported, not crashed on', () => {
  const dir = seed('badid', [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }]);
  for (const arg of ['#0', '#99999']) {
    const r = run(STATS, [arg], { dir });
    assert.strictEqual(r.status, 0, `exit ${r.status} for ${arg}`);
    assert.ok(/No species/.test(r.stdout), `no friendly message for ${arg}: ${r.stdout.slice(0, 120)}`);
  }
});

test('an uncaught species still shows its card, with art and encouragement', () => {
  const dir = seed('uncaught', [{ id: 1, name: 'Bulbasaur', gen: 1, tier: 'common' }]);
  const out = run(STATS, ['mewtwo'], { dir }).stdout;
  assert.ok(/#0150 MEWTWO/.test(out), out.slice(0, 200));
  assert.ok(/Caught\s+0 times/.test(out), `wrong count: ${out.match(/Caught.*/)}`);
  assert.ok(/Not yet caught/.test(out), 'no encouragement for an uncaught species');
  assert.ok(!/CATCH HISTORY/.test(out), 'showed a history for a species never caught');
  // Default mode is plain, so the art is block glyphs rather than escapes.
  const { PLAIN_RAMP, PLAIN_QUADRANT } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
  const drawn = new Set([...PLAIN_RAMP, ...PLAIN_QUADRANT.slice(1)]);
  assert.ok(out.split('').some((c) => drawn.has(c)), 'no art on the detail card');
});

test('the detail card honours sprites:false', () => {
  const dir = seed('detail-nosprite', [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }]);
  writeConfig(dir, { sprites: false });
  const out = run(STATS, ['pikachu'], { dir }).stdout;
  assert.strictEqual(out.indexOf('\x1b'), -1, 'art rendered with sprites disabled');
  assert.ok(/#0025 PIKACHU/.test(out), 'lost the card itself');
});

test('a long catch history is truncated with a count of the rest', () => {
  const many = [];
  for (let i = 0; i < 14; i++) many.push({ id: 25, name: 'Pikachu', gen: 1, tier: 'common' });
  const dir = seed('detail-many', many);
  const out = run(STATS, ['pikachu'], { dir }).stdout;
  assert.ok(/Caught\s+14 times/.test(out), out.match(/Caught.*/));
  assert.ok(/\.\.\. and 4 more/.test(out), `no truncation notice: ${out.match(/\.\.\..*/)}`);
});

console.log('\nstats.js: shiny surfaces');

test('the summary reports a shiny count and lists it in the hall of fame', () => {
  const dir = seed('shiny-summary', [
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common', shiny: true },
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common' },
    { id: 1, name: 'Bulbasaur', gen: 1, tier: 'common' },
  ]);
  const out = run(STATS, [], { dir }).stdout;
  assert.ok(/1 SHINY - 1 unique/.test(out), `no shiny tally: ${out.slice(0, 400)}`);
  // A shiny common belongs in the hall of fame even with no legendary present:
  // at 1/128 it is rarer than the legendary that would normally earn the slot.
  assert.ok(/HALL OF FAME/.test(out), 'no hall of fame for a shiny common');
  assert.ok(/#0025 Pikachu.*SHINY/.test(out), `shiny not marked in the hall: ${out.match(/#0025.*/)}`);
  assert.ok(!/#0001 Bulbasaur/.test(out.slice(out.indexOf('HALL OF FAME'), out.indexOf('MOST RECENT'))),
    'a plain common got into the hall of fame');
});

test('a collection with no shinies says nothing about them', () => {
  const dir = seed('noshiny-summary', [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }]);
  const out = run(STATS, [], { dir }).stdout;
  assert.ok(!/SHINY/i.test(out), `mentioned shinies with none caught: ${out.match(/.*[Ss]hiny.*/)}`);
});

test('the detail card marks the species shiny and flags the shiny catches', () => {
  const dir = seed('shiny-detail', [
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common' },
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common', shiny: true },
  ]);
  const out = run(STATS, ['pikachu'], { dir }).stdout;
  assert.ok(/#0025 PIKACHU\s+\* SHINY \*/.test(out), `no shiny badge: ${out.match(/#0025.*/)}`);
  assert.ok(/Shiny\s+1 of those/.test(out), `no shiny count: ${out.match(/Shiny.*/)}`);
  // Exactly the shiny row is flagged, not the whole history.
  const history = out.slice(out.indexOf('CATCH HISTORY')).split('\n').filter((l) => /\d tokens/.test(l));
  assert.strictEqual(history.length, 2, `expected 2 history rows, got ${history.length}`);
  assert.strictEqual(history.filter((l) => /SHINY/.test(l)).length, 1, 'wrong number of flagged rows');
});

test('owning a shiny makes the detail card render the shiny art', () => {
  // Pinned to colour art: a shiny is a recolour, and the plain renderer keeps the
  // silhouette identical by design, so only colour can tell the two apart.
  const rows = [{ id: 25, name: 'Pikachu', gen: 1, tier: 'common' }];
  const colourCfg = { spriteMode: 'color' };
  const normalDir = seed('art-normal', rows);
  writeConfig(normalDir, colourCfg);
  const shinyDir = seed('art-shiny', [Object.assign({ shiny: true }, rows[0])]);
  writeConfig(shinyDir, colourCfg);
  const normal = run(STATS, ['pikachu'], { dir: normalDir }).stdout;
  const shiny = run(STATS, ['pikachu'], { dir: shinyDir }).stdout;

  const { renderSpriteFit } = require(path.join(PLUGIN_ROOT, 'lib', 'sprite.js'));
  const { DEFAULTS } = require(path.join(PLUGIN_ROOT, 'lib', 'config.js'));
  // The detail view draws each species as wide as its byte size allows under the
  // systemMessage cap, with the configured spriteWidth as the ceiling -- so the
  // expected art is the fit render at that ceiling.
  const opts = { maxWidth: DEFAULTS.spriteWidth };
  assert.ok(normal.includes(renderSpriteFit(25, opts)), 'normal card lost the normal art');
  assert.ok(shiny.includes(renderSpriteFit(25, Object.assign({ shiny: true }, opts))),
    'shiny card did not render the shiny art');
  assert.ok(!shiny.includes(renderSpriteFit(25, opts)), 'shiny card rendered the normal art');
});

test('a hand-written non-boolean shiny value is ignored, not half-trusted', () => {
  // The collection is documented as user-editable, so `"shiny": "yes"` is reachable.
  const dir = seed('shiny-junk', [
    { id: 25, name: 'Pikachu', gen: 1, tier: 'common', shiny: 'yes' },
    { id: 1, name: 'Bulbasaur', gen: 1, tier: 'common', shiny: 1 },
  ]);
  const out = run(STATS, [], { dir }).stdout;
  assert.strictEqual(run(STATS, [], { dir }).status, 0);
  assert.ok(!/SHINY/i.test(out), `a truthy non-boolean counted as shiny: ${out.match(/.*[Ss]hiny.*/)}`);
});

console.log('\nintegration: hook then pokedex');

test('a catch made by the hook shows up in /pokedex', () => {
  const dir = freshDir('integration');
  writeConfig(dir, Object.assign({}, ALWAYS, { gens: [1] }));
  const p = transcript(dir, [{ prompt: 'hi' }, { assistant: 'ok', id: 'm1', in: 2500, out: 2500 }]);
  const hookRun = run(HOOK, [], { input: payload(p), dir });
  const caught = readCollection(dir).catches[0];

  const r = run(STATS, [], { dir });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes(caught.name),
    `${caught.name} missing from the pokedex: ${r.stdout.slice(0, 300)}`);
  assert.ok(/Caught 1 total - 1 unique species/.test(r.stdout), r.stdout.match(/Caught.*/));

  // And the banner the user saw agrees with what was stored.
  const msg = JSON.parse(hookRun.stdout).systemMessage;
  assert.ok(msg.includes(caught.name.toUpperCase()), 'banner name disagrees with the stored catch');
  assert.ok(/5,000 tokens/.test(msg), 'banner token count disagrees');
});

test('repeated hook runs accumulate turns and tokens honestly', () => {
  const dir = freshDir('accumulate');
  writeConfig(dir, NEVER);
  for (let i = 0; i < 5; i++) {
    const p = transcript(dir, [{ prompt: `q${i}` }, { assistant: 'a', id: `m${i}`, in: 100, out: 100 }]);
    run(HOOK, [], { input: payload(p), dir });
  }
  const data = readCollection(dir);
  assert.strictEqual(data.stats.turns, 5);
  assert.strictEqual(data.stats.tokens, 1000);
  assert.strictEqual(data.stats.pulls, 0);
  const r = run(STATS, ['odds'], { dir });
  assert.ok(/Turns\s+5/.test(r.stdout), `odds view lost the turn count: ${r.stdout.match(/Turns.*/)}`);
});

console.log('\nshow.js: the PostToolUse relay');

/** A PostToolUse payload carrying the /pokedex Bash command and its captured stdout. */
function showPayload(stdout, over) {
  return JSON.stringify(Object.assign({
    hook_event_name: 'PostToolUse',
    tool_input: { command: 'node "/x/poke-token/scripts/stats.js" -- rayquaza' },
    tool_response: { stdout, stderr: '', interrupted: false },
  }, over || {}));
}

test('an escape-free /pokedex report is relayed, not left to collapse', () => {
  // The core regression: a plain (no-escape) report -- the bare grid, a filter,
  // or an uncaught detail -- must still reach the systemMessage channel. Left
  // un-relayed the UI collapses it as "+N lines" and the user sees nothing.
  const plain = 'POKEDEX  #0384\n\n#0384 RAYQUAZA\nGeneration 3\nNot yet caught.';
  const r = run(SHOW, [], { input: showPayload(plain) });
  assert.strictEqual(r.status, 0, `show.js exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.systemMessage, plain, 'the plain report was not relayed verbatim');
  assert.strictEqual(parsed.suppressOutput, true, 'the raw tool output was not suppressed');
});

test('a colour report is still relayed', () => {
  const colour = 'POKEDEX  #0025\n\x1b[38;2;255;0;0m▀\x1b[0m\n#0025 PIKACHU';
  const r = run(SHOW, [], { input: showPayload(colour) });
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.systemMessage, colour, 'the colour report was not relayed');
  assert.strictEqual(parsed.suppressOutput, true);
});

test('empty stdout stands down rather than emitting an empty systemMessage', () => {
  const r = run(SHOW, [], { input: showPayload('   \n\n') });
  assert.strictEqual(r.status, 0, `show.js exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '', 'empty output should produce no systemMessage');
});

test('a command that is not the stats script is ignored', () => {
  const r = run(SHOW, [], { input: showPayload('anything', { tool_input: { command: 'ls -la' } }) });
  assert.strictEqual(r.stdout.trim(), '', 'show.js relayed output for an unrelated command');
});

test('an oversized or truncated capture stands down', () => {
  const huge = 'x'.repeat(60001);
  assert.strictEqual(run(SHOW, [], { input: showPayload(huge) }).stdout.trim(), '',
    'show.js relayed an over-limit capture');
  const persisted = 'POKEDEX\n<persisted-output>file preview</persisted-output>';
  assert.strictEqual(run(SHOW, [], { input: showPayload(persisted) }).stdout.trim(), '',
    'show.js relayed a persisted-output preview');
});

process.on('exit', () => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

console.log(`\n${passed} tests passed\n`);
