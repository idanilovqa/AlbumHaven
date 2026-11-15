#!/usr/bin/env node
'use strict';

// The local bounded-interaction gate: validate the full inventory, then run
// the deterministic contracts of the selected interactions, serially, one
// stage at a time. With --changed-paths <file> only contracts whose owners
// changed are run (the validator still checks every entrypoint). No browser
// suites and no complete pytest run.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { interactionsForPaths, loadRegistry } = require('./ci/validate-bounded-interactions.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD_SELF_TESTS = [
  'tests/js/bounded-interaction-discovery.test.js',
  'tests/js/bounded-interaction-registry.test.js',
  'tests/js/bounded-interaction-counter.test.js',
  'tests/js/bounded-interaction-seeded-defects.test.js',
  'tests/js/run-bounded-interactions.test.js',
  'tests/py/test_bounded_interaction_discovery.py',
  'tests/py/test_bounded_interaction_counter.py',
];
const GUARD_OWNERS = /^(scripts\/ci\/(bounded[-_]interaction|validate-bounded-interactions)|scripts\/run-bounded-interactions\.cjs|tests\/ci\/bounded-interactions\.json|tests\/(js|py)\/(helpers\/)?(test_|run-)?bounded[-_]interaction)/;

function testFiles(command) {
  return String(command || '').split(/\s+/)
    .map(token => token.split('::')[0].replaceAll('\\', '/'))
    .filter(token => /^tests\/.+\.(js|cjs|py)$/.test(token));
}

function selectedTestFiles(registry, changedPaths) {
  const ids = changedPaths
    ? new Set(interactionsForPaths(registry, changedPaths))
    : null;
  const files = registry.interactions
    .filter(entry => entry.proof === 'contract' && (!ids || ids.has(entry.id)))
    .flatMap(entry => testFiles(entry.command));
  const guardChanged = !changedPaths || changedPaths.some(file => GUARD_OWNERS.test(file.replaceAll('\\', '/')));
  return [...new Set([...(guardChanged ? GUARD_SELF_TESTS : []), ...files])].sort();
}

function buildCommands({ registry, changedPaths = null, python = process.env.PYTHON || 'python' }) {
  const files = selectedTestFiles(registry, changedPaths);
  const nodeFiles = files.filter(file => !file.endsWith('.py'));
  const pythonFiles = files.filter(file => file.endsWith('.py'));
  const commands = [[process.execPath, ['scripts/ci/validate-bounded-interactions.cjs']]];
  if (nodeFiles.length) commands.push([process.execPath, ['--test', '--test-concurrency=1', ...nodeFiles]]);
  if (pythonFiles.length) commands.push([python, ['-m', 'pytest', '-q', ...pythonFiles]]);
  return commands;
}

function runCommands(commands, spawn = spawnSync) {
  for (const [command, args] of commands) {
    process.stdout.write(`\n> ${[path.basename(command), ...args].join(' ')}\n`);
    const result = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`${path.basename(command)} stopped by ${result.signal}`);
    if (result.status !== 0) return result.status;
  }
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const changedIndex = argv.indexOf('--changed-paths');
  const changedPaths = changedIndex >= 0
    ? fs.readFileSync(argv[changedIndex + 1], 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : null;
  return runCommands(buildCommands({ registry: loadRegistry(REPO_ROOT), changedPaths }));
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildCommands, runCommands, selectedTestFiles };
