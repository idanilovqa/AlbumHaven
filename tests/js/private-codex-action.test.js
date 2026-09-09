const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../../scripts/ci/prepare-private-codex-action.cjs');
const fixturePath = path.resolve(__dirname, '../fixtures/codex-action/action.yml');
const PIN = '86365089eb2b84e0a8fb0717b304f8bdcb13b20e';
const YAML_HASH = '448852e9e59565440bf25174b54bbf661bd66102be295af2e526fa09eaaf3bd7';
const original = fs.readFileSync(fixturePath, 'utf8');
function helper() {
  assert.ok(fs.existsSync(scriptPath), 'verified private action preparer must exist');
  return require(scriptPath);
}
function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'album-haven-private-action-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function runBody(source) {
  const marker = '    - name: Run codex exec\n';
  const step = source.slice(source.indexOf(marker));
  assert.ok(step.startsWith(marker));
  return step.slice(step.indexOf('      run: |\n') + '      run: |\n'.length)
    .split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n');
}
function fakeGit(directory, changes = {}) {
  return (args, options) => {
    assert.equal(path.resolve(options.cwd), path.resolve(directory));
    const values = { 'rev-parse --show-toplevel': directory,
      'rev-parse HEAD': PIN, 'status --porcelain=v1 --untracked-files=all': '', ...changes };
    const key = args.join(' ');
    assert.ok(Object.hasOwn(values, key), `unexpected Git operation: ${key}`);
    return values[key];
  };
}

test('private action changes only the reviewed Run codex exec output routing in exact pinned bytes', () => {
  const { prepareActionSource, ACTION_VERSION, ACTION_YAML_SHA256 } = helper();
  assert.equal(ACTION_VERSION, PIN);
  assert.equal(ACTION_YAML_SHA256, YAML_HASH);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), YAML_HASH);
  const prepared = prepareActionSource(original);
  const marker = '      run: |\n';
  const prefixEnd = original.indexOf(marker, original.indexOf('    - name: Run codex exec\n')) + marker.length;
  assert.equal(prepared.slice(0, prefixEnd), original.slice(0, prefixEnd));
  const command = /exec env -u NODE_OPTIONS NODE_OPTIONS=--disable-sigusr1 node --disable-sigusr1[\s\S]*?--codex-user "\$CODEX_USER"/;
  const normalize = text => text.split('\n').map(line => line.trim()).join('\n');
  assert.equal(normalize(runBody(prepared).match(command)[0]), normalize(runBody(original).match(command)[0]));
  assert.doesNotMatch(prepared, /upload-artifact|--dangerously|tee\s/);
  assert.match(runBody(prepared), /umask 077/);
  assert.match(runBody(prepared), /chmod 600/);
});

test('private action rejects changed source before modification and fails closed on a repeated patch', t => {
  const { prepareActionSource, preparePrivateCodexAction } = helper();
  assert.throws(() => prepareActionSource(original.replace('drop-sudo', 'unsafe')));
  assert.throws(() => prepareActionSource(original + '\n'));
  assert.throws(() => prepareActionSource(prepareActionSource(original)));
  const actionDirectory = temporary(t);
  const target = path.join(actionDirectory, 'action.yml');
  fs.writeFileSync(target, original);
  fs.mkdirSync(path.join(actionDirectory, 'dist'));
  const entry = path.join(actionDirectory, 'dist', 'main.js');
  fs.writeFileSync(entry, 'fixture entry remains unchanged\n');
  preparePrivateCodexAction({ actionDirectory, runGit: fakeGit(actionDirectory) });
  assert.equal(fs.readFileSync(target, 'utf8'), prepareActionSource(original));
  assert.equal(fs.readFileSync(entry, 'utf8'), 'fixture entry remains unchanged\n');
  assert.throws(() => preparePrivateCodexAction({ actionDirectory, runGit: fakeGit(actionDirectory) }));
});

test('private action rejects wrong pins dirty checkouts and repository-root mismatches without writing', t => {
  const { preparePrivateCodexAction } = helper();
  const actionDirectory = temporary(t);
  const target = path.join(actionDirectory, 'action.yml');
  fs.writeFileSync(target, original);
  for (const change of [
    { 'rev-parse HEAD': 'a'.repeat(40) },
    { 'rev-parse --show-toplevel': path.dirname(actionDirectory) },
    { 'status --porcelain=v1 --untracked-files=all': ' M dist/main.js\n' },
    { 'status --porcelain=v1 --untracked-files=all': '?? injected.js\n' },
  ]) {
    assert.throws(() => preparePrivateCodexAction({ actionDirectory, runGit: fakeGit(actionDirectory, change) }));
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  }
});

for (const scenario of [{ exitCode: 0 }, { exitCode: 37 }, { exitCode: 0, captureUnavailable: true },
  { exitCode: 37, nativeError: 'unexpected status 401 Unauthorized' }, { exitCode: 37, removeClassifier: true },
  { exitCode: 0, emptyArgs: true }]) {
  const { exitCode, captureUnavailable = false, nativeError = '', removeClassifier = false, emptyArgs = false } = scenario;
  test(captureUnavailable ? 'private action never launches the child when private capture cannot be created'
    : `private action retains stdout stderr and original exit ${exitCode} without publishing usage ${nativeError ? 'native category' : removeClassifier ? 'classifier failure' : emptyArgs ? 'integration defaults' : ''}`, t => {
    const { prepareActionSource } = helper();
    const directory = temporary(t);
    const actionDirectory = path.join(directory, 'action with spaces');
    const runnerTemp = path.join(directory, 'runner-private');
    fs.mkdirSync(path.join(actionDirectory, 'dist'), { recursive: true });
    if (!captureUnavailable) fs.mkdirSync(runnerTemp);
    const observed = path.join(directory, 'observed.json');
    const output = path.join(directory, 'result.json');
    const githubOutput = path.join(directory, 'github-output');
    const workspace = path.join(directory, 'workspace');
    const classifier = path.join(workspace, 'scripts/ci/codex-failure-category.cjs');
    fs.mkdirSync(path.dirname(classifier), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../scripts/ci/codex-failure-category.cjs'), classifier);
    fs.writeFileSync(path.join(actionDirectory, 'dist', 'main.js'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.OBSERVED_ARGS, JSON.stringify({ args: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS }));
console.log('PRIVATE_TRANSCRIPT_MARKER tokens used 123456');
console.error('PRIVATE_USAGE_MARKER model gpt-6-astra input_tokens 123456');
if (process.env.FIXTURE_NATIVE_ERROR) console.error(JSON.stringify({ type: 'turn.failed', error: { message: process.env.FIXTURE_NATIVE_ERROR } }));
if (process.env.FIXTURE_REMOVE_CLASSIFIER) fs.unlinkSync(process.env.FIXTURE_CLASSIFIER);
fs.writeFileSync(process.env.CODEX_OUTPUT_FILE, '{"structured":"result"}');
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'final-message=fixture-result\\n');
process.exit(Number(process.env.FIXTURE_EXIT));
`);
    const shellScript = path.join(directory, 'run.sh');
    fs.writeFileSync(shellScript, 'set -euo pipefail\numask 022\n' + runBody(prepareActionSource(original)));
    const bash = process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe') : 'bash';
    const posixPath = value => value.replaceAll('\\', '/');
    const commandPath = [path.dirname(process.execPath), process.platform === 'win32' ? path.dirname(bash) : null,
      process.env.PATH].filter(Boolean).join(path.delimiter);
    const env = { ...process.env, PATH: commandPath,
      RUNNER_TEMP: posixPath(runnerTemp), ACTION_PATH: posixPath(actionDirectory),
      GITHUB_WORKSPACE: workspace, FIXTURE_CLASSIFIER: classifier,
      FIXTURE_REMOVE_CLASSIFIER: removeClassifier ? '1' : '', FIXTURE_NATIVE_ERROR: nativeError,
      OBSERVED_ARGS: observed, FIXTURE_EXIT: String(exitCode), GITHUB_OUTPUT: githubOutput,
      NODE_OPTIONS: '--no-warnings', CODEX_PROMPT: 'fixture prompt', CODEX_PROMPT_FILE: 'prompt file.md',
      CODEX_OUTPUT_FILE: output, CODEX_HOME: 'fixture-home', CODEX_WORKING_DIRECTORY: 'fixture-workspace',
      CODEX_ARGS: emptyArgs ? '' : '["--image","image with spaces.png"]', CODEX_OUTPUT_SCHEMA: '', CODEX_OUTPUT_SCHEMA_FILE: 'schema.json',
      CODEX_SANDBOX: '', CODEX_PERMISSION_PROFILE: ':read-only', CODEX_MODEL: 'fixture-model',
      CODEX_EFFORT: 'high', CODEX_SAFETY_STRATEGY: 'drop-sudo', CODEX_USER: '' };
    const result = cp.spawnSync(bash, [posixPath(shellScript)], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (captureUnavailable) {
      assert.notEqual(result.status, 0);
      assert.ok(!fs.existsSync(observed), 'private capture failure must prevent the action child from starting');
      assert.ok(!fs.existsSync(output));
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|123456|gpt-6-astra/);
      return;
    }
    assert.equal(result.status, exitCode, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|123456|gpt-6-astra|input_tokens|fixture prompt/);
    if (exitCode === 0) assert.equal(result.stdout + result.stderr, '');
    const captures = fs.readdirSync(runnerTemp);
    assert.equal(captures.length, 1);
    assert.match(captures[0], /^album-haven-codex-output\./);
    const capturePath = path.join(runnerTemp, captures[0]);
    const capture = fs.readFileSync(capturePath, 'utf8');
    assert.match(capture, /PRIVATE_TRANSCRIPT_MARKER tokens used 123456/);
    assert.match(capture, /PRIVATE_USAGE_MARKER/);
    if (exitCode !== 0) assert.equal(result.stderr, `Codex review failed: ${nativeError ? 'authentication_failed' : 'unknown'}\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(capturePath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"structured":"result"}');
    if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o644,
      'private capture must not change the action child inherited umask');
    assert.equal(fs.readFileSync(githubOutput, 'utf8'), 'final-message=fixture-result\n');
    const actual = JSON.parse(fs.readFileSync(observed));
    assert.equal(actual.nodeOptions, '--disable-sigusr1');
    assert.equal(actual.args[0], 'run-codex-exec');
    assert.deepEqual(JSON.parse(actual.args[actual.args.indexOf('--extra-args') + 1]), [...(emptyArgs ? [] : JSON.parse(env.CODEX_ARGS)), '--json']);
    for (const [flag, expected] of [['--prompt', env.CODEX_PROMPT],
      ['--permission-profile', ':read-only'], ['--safety-strategy', 'drop-sudo'], ['--model', 'fixture-model'], ['--effort', 'high']]) {
      assert.equal(actual.args[actual.args.indexOf(flag) + 1], expected);
    }
  });
}
