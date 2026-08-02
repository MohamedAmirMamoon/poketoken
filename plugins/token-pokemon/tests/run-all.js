#!/usr/bin/env node
/**
 * Runs every test suite and prints one summary.
 *
 *   node tests/run-all.js          run all suites
 *   node tests/run-all.js store    run only suites whose name matches
 *
 * Each suite is a standalone script that exits non-zero on failure, so this
 * runner only has to spawn them and tally. Suites are discovered from the
 * directory rather than listed, so a new *.test.js file is picked up
 * automatically -- the previous hand-maintained list in package.json had
 * silently omitted config.test.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = __dirname;
const filter = (process.argv[2] || '').toLowerCase();

const suites = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.toLowerCase().includes(filter))
  .sort();

if (suites.length === 0) {
  process.stdout.write(filter ? `No suite matches "${filter}".\n` : 'No test suites found.\n');
  process.exit(1);
}

const results = [];
let failed = 0;

for (const suite of suites) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path.join(TEST_DIR, suite)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 300000,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const output = (r.stdout || '') + (r.stderr || '');

  // Suites report "N tests passed"; xfail counts are reported alongside.
  const count = Number((output.match(/(\d+) tests passed/) || [, 0])[1]);
  const xfail = Number((output.match(/(\d+) expected failure/) || [, 0])[1]);
  const ok = r.status === 0;
  if (!ok) failed++;

  results.push({ suite, ok, count, xfail, ms, output });

  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(18)} `
    + `${String(count).padStart(3)} tests`
    + `${xfail ? `, ${xfail} xfail` : ''}`
    + `  ${(ms / 1000).toFixed(1)}s\n`);

  // Only surface full output for failures; passing suites stay quiet.
  if (!ok) process.stdout.write(`\n${output}\n`);
}

const total = results.reduce((n, r) => n + r.count, 0);
const totalXfail = results.reduce((n, r) => n + r.xfail, 0);
const wall = results.reduce((n, r) => n + r.ms, 0) / 1000;

process.stdout.write('\n' + '-'.repeat(52) + '\n');
process.stdout.write(`${total} tests across ${results.length} suites in ${wall.toFixed(1)}s\n`);
if (totalXfail) {
  process.stdout.write(`${totalXfail} expected failure(s) documenting known bugs`
    + ' -- each xfail() call carries a comment explaining the defect\n');
}
process.stdout.write(failed === 0 ? 'all suites passed\n' : `${failed} suite(s) FAILED\n`);

process.exit(failed === 0 ? 0 : 1);
