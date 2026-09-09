#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ACTION_VERSION = '86365089eb2b84e0a8fb0717b304f8bdcb13b20e';
const ACTION_YAML_SHA256 = '448852e9e59565440bf25174b54bbf661bd66102be295af2e526fa09eaaf3bd7';

function prepareActionSource(actionYaml) {
  if (typeof actionYaml !== 'string'
      || crypto.createHash('sha256').update(actionYaml).digest('hex') !== ACTION_YAML_SHA256) {
    throw new Error('Codex action does not match the reviewed upstream source.');
  }
  const stepMarker = '    - name: Run codex exec\n';
  const bodyMarker = '      run: |\n';
  const stepStart = actionYaml.indexOf(stepMarker);
  const bodyStart = actionYaml.indexOf(bodyMarker, stepStart) + bodyMarker.length;
  const originalCommand = actionYaml.slice(bodyStart);
  if (stepStart < 0 || !originalCommand.startsWith('        exec env -u NODE_OPTIONS ')
      || !originalCommand.endsWith('            --codex-user "$CODEX_USER"\n')) {
    throw new Error('Codex execution block does not match the reviewed upstream source.');
  }
  // Keep every upstream input, safety step and execution argument unchanged.
  // umask is scoped to file creation so Codex keeps its original process umask.
  const replacement = [
    '        if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then',
    '          echo "Private Codex output capture unavailable." >&2',
    '          exit 1',
    '        fi',
    '        if ! private_output="$(umask 077; mktemp "$RUNNER_TEMP/album-haven-codex-output.XXXXXX" 2>/dev/null)"; then',
    '          echo "Private Codex output capture unavailable." >&2',
    '          exit 1',
    '        fi',
    '        if ! chmod 600 "$private_output" 2>/dev/null; then',
    '          echo "Private Codex output capture unavailable." >&2',
    '          exit 1',
    '        fi',
    '        if ! CODEX_ARGS="$(env -u NODE_OPTIONS node --disable-sigusr1 "${GITHUB_WORKSPACE:-}/scripts/ci/codex-failure-category.cjs" --json-args "$CODEX_ARGS" 2>>"$private_output")"; then',
    '          echo "Codex review failed: unknown" >&2',
    '          exit 1',
    '        fi',
    '        export CODEX_ARGS',
    '        if (',
    ...originalCommand.trimEnd().split('\n').map(line => '  ' + line),
    '        ) >"$private_output" 2>&1; then',
    '          exit 0',
    '        else',
    '          private_status=$?',
    '          private_category="$(env -u NODE_OPTIONS node --disable-sigusr1 "${GITHUB_WORKSPACE:-}/scripts/ci/codex-failure-category.cjs" --input "$private_output" 2>/dev/null)" || private_category=unknown',
    '          case "$private_category" in',
    '            provider_quota_reported|authentication_failed|rate_limited|context_limit|transport_failure|unknown) ;;',
    '            *) private_category=unknown ;;',
    '          esac',
    '          echo "Codex review failed: $private_category" >&2',
    '          exit "$private_status"',
    '        fi',
    '',
  ].join('\n');
  return actionYaml.slice(0, bodyStart) + replacement;
}

function runGit(args, { cwd }) {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Unable to verify the pinned Codex action checkout.');
  return result.stdout;
}

function preparePrivateCodexAction({ actionDirectory, runGit: inspectGit = runGit }) {
  if (typeof actionDirectory !== 'string' || !actionDirectory) throw new Error('Missing Codex action directory.');
  const directory = path.resolve(actionDirectory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Codex action directory.');
  const inspect = args => inspectGit(args, { cwd: directory }).trim();
  if (path.resolve(inspect(['rev-parse', '--show-toplevel'])) !== directory
      || inspect(['rev-parse', 'HEAD']) !== ACTION_VERSION
      || inspect(['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('Codex action checkout must be pristine at the reviewed upstream commit.');
  }
  const filename = path.join(directory, 'action.yml');
  const actionStat = fs.lstatSync(filename);
  if (!actionStat.isFile() || actionStat.isSymbolicLink()) throw new Error('Invalid Codex action source.');
  const prepared = prepareActionSource(fs.readFileSync(filename, 'utf8'));
  fs.writeFileSync(filename, prepared);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--action-dir' || !argv[1]) throw new Error('Invalid private action preparation arguments.');
  preparePrivateCodexAction({ actionDirectory: argv[1] });
  process.stdout.write('Prepared private Codex execution from the verified upstream action.\n');
}
if (require.main === module) {
  try { main(); }
  catch { process.stderr.write('Private Codex action preparation failed; review cannot start.\n'); process.exitCode = 1; }
}
module.exports = { prepareActionSource, preparePrivateCodexAction, ACTION_VERSION, ACTION_YAML_SHA256 };
