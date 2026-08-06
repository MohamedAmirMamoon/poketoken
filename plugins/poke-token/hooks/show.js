#!/usr/bin/env node
/**
 * PostToolUse hook: re-emits a /pokedex report through the systemMessage channel
 * so its colour art survives.
 *
 * Why this exists: text the assistant relays into its reply is treated as
 * content, and Claude Code strips VT escapes from content -- so truecolour
 * sprite art comes out as literal `[38;2;...m` noise. A hook's systemMessage is
 * the one channel that is painted with the ANSI escapes and Unicode half-blocks
 * intact (the catch banner in pull.js already relies on this). So when the
 * /pokedex bash command produces coloured output, we intercept its stdout here
 * and re-emit it verbatim as a systemMessage; the command file tells the
 * assistant to stay silent, so this is the only copy the user sees.
 *
 * Hard rule, shared with pull.js: a hook must never disturb the session. Every
 * failure path exits 0 with no output. When there is nothing worth rescuing --
 * plain (escape-free) output, empty output, or something too large -- we also
 * print nothing and let the normal relay path handle it.
 */

'use strict';

// Only rescue output from this plugin's report script. Both markers must be
// present: `stats.js` is the script, and `poke-token` (the plugin dir, which
// survives ${CLAUDE_PLUGIN_ROOT} expansion in the command string) confirms it
// is ours and not, say, a grep/cat of a file that merely mentions stats.js.
const SCRIPT_MARKER = 'stats.js';
const PLUGIN_MARKER = 'poke-token';

// Backstop against re-emitting a truncated sprite, which looks worse than the
// plain relay. The harness caps captured output; past this we stand down.
const MAX_OUTPUT = 60000;

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

/** Pull the command's stdout out of the tool_response, whatever shape it takes. */
function extractOutput(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    if (typeof response.stdout === 'string') return response.stdout;
    if (typeof response.output === 'string') return response.output;
  }
  return '';
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    // Unparseable payload: nothing we can safely act on.
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string') return;
  if (!command.includes(SCRIPT_MARKER) || !command.includes(PLUGIN_MARKER)) return;

  let out = extractOutput(payload.tool_response);
  if (typeof out !== 'string') return;
  // Trailing newlines only -- interior spacing carries the silhouette.
  out = out.replace(/\n+$/, '');

  // Plain output relays fine on its own; only colour (escape-bearing) output
  // needs the systemMessage channel. `\x1b[` is the CSI that begins every SGR.
  if (!out || out.indexOf('\x1b[') === -1) return;

  // Something truncated or oversized: re-emitting a broken sprite is worse than
  // letting the plain relay path handle it.
  if (out.length > MAX_OUTPUT
    || out.indexOf('<persisted-output>') !== -1
    || out.indexOf('Output too large') !== -1) {
    return;
  }

  process.stdout.write(JSON.stringify({ systemMessage: out, suppressOutput: true }));
}

main().then(
  () => process.exit(0),
  (err) => {
    // Surface the reason only when explicitly debugging; otherwise stay silent.
    if (process.env.POKE_TOKEN_DEBUG) {
      process.stderr.write(`poke-token: ${err && err.stack ? err.stack : err}\n`);
    }
    process.exit(0);
  }
);
