const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const sqlPath = 'migrations/postgres/0001_checkout_probe.sql';
const sql = Buffer.from('-- Synthetic migration\nSELECT 1;\n', 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkoutBytes(t, attributes, fixturePath = sqlPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-checkout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  const home = path.join(directory, 'home');
  const empty = path.join(directory, 'empty');
  const config = path.join(directory, 'empty-config');
  for (const entry of [repo, home, empty]) fs.mkdirSync(entry);
  fs.writeFileSync(config, '');

  // Do not inherit Git redirects, injected config, hooks, or user attributes.
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(name)) env[name] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  function git(...args) {
    const result = spawnSync('git', [
      '-c', 'core.autocrlf=true',
      '-c', 'core.safecrlf=false',
      '-c', `core.hooksPath=${empty}`,
      '-c', `core.attributesFile=${config}`,
      '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Checkout Test',
      '-c', 'user.email=checkout-test@example.invalid',
      ...args,
    ], { cwd: repo, env, timeout: 30_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  }

  git('init', `--template=${empty}`);
  fs.mkdirSync(path.dirname(path.join(repo, fixturePath)), { recursive: true });
  fs.writeFileSync(path.join(repo, fixturePath), sql);
  fs.writeFileSync(path.join(repo, '.gitattributes'), attributes);
  git('add', '--', '.gitattributes', fixturePath);
  git('commit', '-m', 'Synthetic LF migration');
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const index = git('ls-files', '--stage');
  assert.deepEqual(git('show', `HEAD:${fixturePath}`), sql);
  assert.deepEqual(git('show', `:${fixturePath}`), sql);

  fs.unlinkSync(path.join(repo, fixturePath));
  git('checkout-index', '--force', '--index', '--', fixturePath);
  const working = fs.readFileSync(path.join(repo, fixturePath));
  assert.deepEqual(git('show', `HEAD:${fixturePath}`), sql, 'history retains LF bytes');
  assert.deepEqual(git('show', `:${fixturePath}`), sql, 'index retains LF bytes');
  assert.deepEqual(git('ls-files', '--stage'), index);
  assert.deepEqual(git('rev-parse', 'HEAD^{tree}'), tree);
  assert.deepEqual(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain').toString(), '');
  return working;
}

test('autocrlf changes raw SQL checkout hashes without an LF policy', (t) => {
  const working = checkoutBytes(t, '');
  assert.deepEqual(working, Buffer.from(sql.toString().replace(/\n/g, '\r\n')));
  assert.notEqual(sha256(working), sha256(sql));
});

test('repository attributes preserve raw migration hashes under autocrlf', (t) => {
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'));
  const working = checkoutBytes(t, attributes);
  assert.deepEqual(working, sql);
  assert.equal(sha256(working), sha256(sql));
});

test('autocrlf changes archived SQL checkout hashes without an LF policy', (t) => {
  const working = checkoutBytes(t, '', 'migrations/postgres/legacy/0001_checkout_probe.sql');
  assert.deepEqual(working, Buffer.from(sql.toString().replace(/\n/g, '\r\n')));
  assert.notEqual(sha256(working), sha256(sql));
});

test('repository attributes preserve raw archived migration hashes under autocrlf', (t) => {
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'));
  const working = checkoutBytes(t, attributes, 'migrations/postgres/legacy/0001_checkout_probe.sql');
  assert.deepEqual(working, sql);
  assert.equal(sha256(working), sha256(sql));
});
