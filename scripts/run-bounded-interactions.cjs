#!/usr/bin/env node
'use strict';

// The local bounded-interaction gate: validate the full inventory, then run
// the deterministic contracts of the selected interactions, serially, one
// stage at a time. With --changed-paths <file> only contracts whose owners or
// reachable hazards changed are run (the validator still checks every
// entrypoint). No browser suites and no complete pytest run.
//
// A contract that did not run is not evidence: Python contracts run by the
// exact node ids their commands name, and a stage fails when any selected test
// was skipped, marked todo, or (Python) not collected. A contract that ran is
// evidence only for what it measured: every measurement against the checked-in
// registry records its id and measuring test, and the run fails unless each
// selected entry's own test measured the entry's id (or every id it `measures`).
//
// --node-only runs just the JavaScript contract stage with the same skip, todo,
// and evidence checks. CI uses it in the portable JavaScript job, where the
// inventory is validated separately and Python contracts run in the Python job.
// --python-evidence <file> runs nothing: it checks that every Python contract
// was measured by its own test in a pytest run that recorded its evidence to
// <file>. CI uses it after the full Python suite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverRepository, interactionsForPaths, loadRegistry } = require('./ci/validate-bounded-interactions.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_ENV = 'BOUNDED_INTERACTION_EVIDENCE';
const EVIDENCE_PRELOAD = 'tests/js/helpers/bounded-interaction-evidence.js';
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
const TEST_SELECTION = /^tests\/.+\.(js|cjs|py)(::.+)?$/;

// Test files and pytest node ids (`file::test`) a contract command names.
function testSelections(command) {
  return String(command || '').split(/\s+/)
    .map(token => token.replaceAll('\\', '/'))
    .filter(token => TEST_SELECTION.test(token));
}

const fileOf = selection => selection.split('::')[0];

function selectedEntries(registry, changedPaths, discovery) {
  const ids = changedPaths
    ? new Set(interactionsForPaths(registry, changedPaths, discovery))
    : null;
  return registry.interactions.filter(entry => entry.proof === 'contract' && (!ids || ids.has(entry.id)));
}

function selectedTests(entries, changedPaths) {
  const selections = entries.flatMap(entry => testSelections(entry.command));
  const guardChanged = !changedPaths || changedPaths.some(file => GUARD_OWNERS.test(file.replaceAll('\\', '/')));
  const all = new Set([...(guardChanged ? GUARD_SELF_TESTS : []), ...selections]);
  // A whole file already covers its node ids.
  return [...all].filter(selection => !selection.includes('::') || !all.has(fileOf(selection))).sort();
}

const evidencePath = reportDir => path.join(reportDir, 'bounded-interactions-evidence.jsonl');

// Each selected entry's own test must have measured the entry's id, or every id
// in its explicit `measures` list.
function evidenceErrors(entries, file) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const measured = new Set(lines.map(({ id, test }) => JSON.stringify([id, test])));
  return entries.flatMap(entry => (entry.measures || [entry.id])
    .filter(id => !measured.has(JSON.stringify([id, entry.testIdentity])))
    .map(id => `${entry.id}: its test "${entry.testIdentity}" did not measure ${id}`));
}

const XML_ENTITIES ={ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function junitTestcases(xml) {
  const cases = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const [, attributes, , body = ''] of xml.matchAll(pattern)) {
    const attribute = name => (new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? '')
      .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => XML_ENTITIES[entity]);
    const skipped = /<skipped\b[^>]*\btype="([^"]*)"/.exec(body);
    cases.push({ classname: attribute('classname'), name: attribute('name'), skipped: skipped ? skipped[1] : null });
  }
  return cases;
}

function readReport(report) {
  try {
    return junitTestcases(fs.readFileSync(report, 'utf8'));
  } catch {
    return null;
  }
}

// Node test runs: every selected test must actually run.
function nodeReportErrors(report) {
  const cases = readReport(report);
  if (!cases) return [`node test report ${report} was not written`];
  if (!cases.length) return ['node test run reported no tests'];
  return cases.filter(test => test.skipped)
    .map(test => `node test "${test.name}" was ${test.skipped === 'todo' ? 'marked todo' : 'skipped'}`);
}

// Pytest runs: no selected test may be skipped, and each selection (file or
// node id) must match at least one collected test case.
function pytestReportErrors(report, selections) {
  const cases = readReport(report);
  if (!cases) return [`pytest report ${report} was not written`];
  const errors = cases.filter(test => test.skipped).map(test => `pytest ${test.classname}::${test.name} was skipped`);
  for (const selection of selections) {
    const [file, ...parts] = selection.split('::');
    const module = file.replace(/\.py$/, '').replaceAll('/', '.');
    const classname = [module, ...parts.slice(0, -1)].join('.');
    const name = parts.at(-1);
    const collected = cases.some(test => (name === undefined
      ? test.classname === module || test.classname.startsWith(`${module}.`)
      : test.classname === classname && (test.name === name || test.name.startsWith(`${name}[`))));
    if (!collected) errors.push(`pytest selection ${selection} was not collected`);
  }
  return errors;
}

const isPython = selection => fileOf(selection).endsWith('.py');

function buildCommands({
  registry, changedPaths = null, discovery, python = process.env.PYTHON || 'python', reportDir = os.tmpdir(), nodeOnly = false,
  pythonEvidence = null,
}) {
  const entries = selectedEntries(registry, changedPaths, discovery);
  if (pythonEvidence) {
    const pythonEntries = entries.filter(entry => testSelections(entry.command).some(isPython));
    return [[null, [], () => evidenceErrors(pythonEntries, pythonEvidence)]];
  }
  const selections = selectedTests(entries, changedPaths);
  const nodeFiles = [...new Set(selections.filter(selection => !isPython(selection)).map(fileOf))];
  const pythonSelections = selections.filter(isPython);
  const commands = nodeOnly ? [] : [[process.execPath, ['scripts/ci/validate-bounded-interactions.cjs']]];
  if (nodeFiles.length) {
    const report = path.join(reportDir, 'bounded-interactions-node.xml');
    commands.push([process.execPath, [
      '--test', '--test-concurrency=1', '--require', `./${EVIDENCE_PRELOAD}`,
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=junit', `--test-reporter-destination=${report}`,
      ...nodeFiles,
    ], () => nodeReportErrors(report)]);
  }
  if (pythonSelections.length && !nodeOnly) {
    const report = path.join(reportDir, 'bounded-interactions-pytest.xml');
    commands.push([python, ['-m', 'pytest', '-q', '-rs', `--junitxml=${report}`, ...pythonSelections],
      () => pytestReportErrors(report, pythonSelections)]);
  }
  // A check-only final stage: every selected contract measured its entry.
  const measured = nodeOnly
    ? entries.filter(entry => testSelections(entry.command).every(selection => !isPython(selection)))
    : entries;
  if (measured.length) commands.push([null, [], () => evidenceErrors(measured, evidencePath(reportDir))]);
  return commands;
}

function runCommands(commands, spawn = spawnSync) {
  for (const [command, args, check] of commands) {
    if (command !== null) {
      process.stdout.write(`\n> ${[path.basename(command), ...args].join(' ')}\n`);
      const result = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`${path.basename(command)} stopped by ${result.signal}`);
      if (result.status !== 0) return result.status;
    }
    const errors = check ? check() : [];
    if (errors.length) {
      const reason = command === null ? 'contracts did not measure their entries' : 'stage did not run every selected test';
      process.stderr.write(`${errors.join('\n')}\nbounded interaction ${reason}\n`);
      return 1;
    }
  }
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const changedIndex = argv.indexOf('--changed-paths');
  const changedPaths = changedIndex >= 0
    ? fs.readFileSync(argv[changedIndex + 1], 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : null;
  const evidenceIndex = argv.indexOf('--python-evidence');
  const pythonEvidence = evidenceIndex >= 0 ? path.resolve(argv[evidenceIndex + 1]) : null;
  const registry = loadRegistry(REPO_ROOT);
  const discovery = changedPaths ? await discoverRepository({ registry }) : undefined;
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-interactions-'));
  process.env[EVIDENCE_ENV] = evidencePath(reportDir);
  try {
    return runCommands(buildCommands({
      registry, changedPaths, discovery, reportDir, nodeOnly: argv.includes('--node-only'), pythonEvidence,
    }));
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildCommands, evidenceErrors, nodeReportErrors, pytestReportErrors, runCommands };
