#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sealDiagnostic, openDiagnostic, diagnosticContext, DIAGNOSTIC_MAX_BYTES } = require('./private-review-usage.cjs');
const STATE_NAME = 'album-haven-codex-diagnostic.json';
function invalid() { throw new Error('Private diagnostic capture unavailable.'); }
function directory(value) {
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) invalid();
  return resolved;
}
function outputPath(value) {
  const resolved = path.resolve(value);
  return path.join(directory(path.dirname(resolved)), path.basename(resolved));
}
function readFile(value, limit) {
  const filename = outputPath(value), before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) invalid();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) invalid();
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs) invalid();
    return { bytes, stat };
  } finally { fs.closeSync(fd); }
}
function contextFromEnv(env = process.env) {
  return diagnosticContext({ repository: env.GITHUB_REPOSITORY, pullRequestNumber: Number(env.REVIEW_USAGE_PR_NUMBER),
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), headSha: env.REVIEW_USAGE_HEAD_SHA,
    reviewer: 'codex', reviewUnitId: env.REVIEW_USAGE_UNIT_ID, manifestDigest: env.REVIEW_USAGE_MANIFEST_DIGEST });
}
function capturePath(value, root) {
  const resolved = path.resolve(value);
  if (path.dirname(resolved) !== root || !/^album-haven-codex-output\.[A-Za-z0-9_-]+$/.test(path.basename(resolved))) invalid();
  return resolved;
}
function readState(root, context) {
  const filename = path.join(root, STATE_NAME), read = readFile(filename, 65536);
  const state = JSON.parse(read.bytes.toString('utf8'));
  const fields = ['schemaVersion', 'context', 'capturePath', 'captureDevice', 'captureInode', 'status', 'exitCode'];
  if (!state || Object.keys(state).length !== fields.length || fields.some(field => !Object.hasOwn(state, field))
      || state.schemaVersion !== 1 || !['running', 'complete'].includes(state.status)
      || (state.status === 'running' ? state.exitCode !== null
        : !Number.isInteger(state.exitCode) || state.exitCode < 0 || state.exitCode > 255)) invalid();
  const actualContext = diagnosticContext(state.context);
  if (Object.keys(context).some(field => context[field] !== actualContext[field])) invalid();
  capturePath(state.capturePath, root);
  return { state, filename, stat: read.stat };
}
function writeNew(filename, value) {
  fs.writeFileSync(outputPath(filename), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}
function run(command, options, env = process.env) {
  const context = contextFromEnv(env);
  if (command === 'open') {
    const envelope = JSON.parse(readFile(options['--input'], 32 * 1024 * 1024).bytes.toString('utf8'));
    const key = readFile(options['--private-key'], 65536).bytes;
    const report = openDiagnostic(envelope, key, context);
    writeNew(options['--output'], report);
    return;
  }
  const root = directory(options['--runner-temp']);
  if (command === 'start') {
    const filename = capturePath(options['--capture'], root), capture = readFile(filename, DIAGNOSTIC_MAX_BYTES);
    writeNew(path.join(root, STATE_NAME), { schemaVersion: 1, context, capturePath: filename,
      captureDevice: String(capture.stat.dev), captureInode: String(capture.stat.ino), status: 'running', exitCode: null });
    return;
  }
  const { state, filename, stat } = readState(root, context);
  if (command === 'finish') {
    const exitCode = Number(options['--exit-code']);
    if (state.status !== 'running' || !/^(?:0|[1-9][0-9]*)$/.test(options['--exit-code'])
        || !Number.isInteger(exitCode) || exitCode > 255) invalid();
    const fd = fs.openSync(filename, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    try {
      const current = fs.fstatSync(fd);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) invalid();
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, JSON.stringify({ ...state, status: 'complete', exitCode }) + '\n');
    } finally { fs.closeSync(fd); }
    return;
  }
  const capture = readFile(state.capturePath, DIAGNOSTIC_MAX_BYTES);
  if (String(capture.stat.dev) !== state.captureDevice || String(capture.stat.ino) !== state.captureInode) invalid();
  const actionOutcome = env.REVIEW_USAGE_ACTION_OUTCOME || 'unknown';
  const report = { schemaVersion: 1, type: 'codex-execution-diagnostic', context,
    execution: { status: state.status === 'complete' ? 'complete' : 'incomplete', exitCode: state.exitCode, actionOutcome },
    consoleBase64: capture.bytes.toString('base64') };
  const envelope = sealDiagnostic(report, readFile(options['--public-key'], 65536).bytes);
  writeNew(options['--output'], envelope);
}
function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const allowed = { start: ['--runner-temp', '--capture'], finish: ['--runner-temp', '--exit-code'],
    seal: ['--runner-temp', '--public-key', '--output'], open: ['--input', '--private-key', '--output'] }[command];
  if (!allowed || args.length !== allowed.length * 2) invalid();
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index]) || Object.hasOwn(options, args[index]) || !args[index + 1]) invalid();
    options[args[index]] = args[index + 1];
  }
  run(command, options);
}
if (require.main === module) {
  try { main(); } catch { process.stderr.write('Private Codex diagnostic unavailable; input, size, context, key, or path check failed.\n'); process.exitCode = 1; }
}
module.exports = { run, contextFromEnv };
