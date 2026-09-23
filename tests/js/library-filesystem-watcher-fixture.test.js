const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const helperPath = path.resolve(__dirname, '../e2e/helpers/libraryFilesystemWatcherFixture.js');
const load = () => import(pathToFileURL(helperPath).href);

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-cleanup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const mediaRoot = path.join(temp, 'media');
  const ownedRoot = path.join(mediaRoot, 'cases', 'watcher-reconciliation');
  fs.mkdirSync(ownedRoot, { recursive: true });
  fs.writeFileSync(path.join(ownedRoot, 'owned.mp3'), 'owned');
  fs.writeFileSync(path.join(mediaRoot, 'unrelated.mp3'), 'untouched');
  return { mediaRoot, ownedRoot };
}

test('watcher cleanup drains writers before deleting only its scoped inventory', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  assert.equal(typeof cleanupWatchedAlbumFixture, 'function');
  const paths = fixture(t);
  const calls = [];
  let release;
  const stopped = new Promise((resolve) => { release = resolve; });
  const cleanup = cleanupWatchedAlbumFixture({ ...paths,
    context: { async close() { calls.push('context'); } },
    managedAppLifecycle: { async cleanupWatcherFixture() { calls.push('restart'); await stopped; calls.push('drained'); calls.push('inventory'); } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(paths.ownedRoot), false);
  assert.deepEqual(calls, ['context', 'restart']);
  release();
  await cleanup;
  assert.deepEqual(calls, ['context', 'restart', 'drained', 'inventory']);
  assert.equal(fs.readFileSync(path.join(paths.mediaRoot, 'unrelated.mp3'), 'utf8'), 'untouched');
});

test('watcher cleanup preserves original failure and refuses database mutation after failed drain', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  assert.equal(typeof cleanupWatchedAlbumFixture, 'function');
  const paths = fixture(t);
  const original = new Error('acceptance assertion failed');
  const drain = new Error('owned app did not drain');
  let reported = 0;
  await assert.rejects(cleanupWatchedAlbumFixture({ ...paths, originalFailure: original,
    context: { async close() {} },
    managedAppLifecycle: { async cleanupWatcherFixture() { throw drain; }, async reportFailure() { reported += 1; } },
  }),
  (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === drain);
  assert.equal(reported, 1);
});

test('watcher cleanup retains all reporting failures and rejects ownership prefix collisions', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  assert.equal(typeof cleanupWatchedAlbumFixture, 'function');
  const paths = fixture(t);
  const cleanupError = new Error('inventory transaction failed');
  const reportError = new Error('terminal acknowledgment failed');
  await assert.rejects(cleanupWatchedAlbumFixture({ ...paths,
    context: { async close() {} }, managedAppLifecycle: {
      async cleanupWatcherFixture() { throw cleanupError; }, async reportFailure() { throw reportError; },
    },
  }),
  (error) => error instanceof AggregateError && error.errors[0] === cleanupError && error.errors[1] === reportError);
  const collision = `${paths.ownedRoot}-other`;
  fs.mkdirSync(collision);
  await assert.rejects(cleanupWatchedAlbumFixture({ ...paths, ownedRoot: collision }, {
    async removeInventory() { assert.fail('invalid ownership must not reach the database'); },
  }), /owned directory/i);
  assert.equal(fs.existsSync(collision), true);
});

test('Linux native watcher scenario is skipped before it touches the app; Windows acceptance remains registered', async () => {
  const specPath = path.resolve(__dirname, '../e2e/specs/libraryFilesystemWatcher.functional.spec.js');
  const source = fs.readFileSync(specPath, 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
  for (const platform of ['linux', 'win32']) {
    let body;
    let touchedApp = false;
    let skipped = false;
    const skippedSignal = new Error('skipped by platform contract');
    const touchedSignal = new Error('first unchanged scenario step');
    const register = (_title, _options, callback) => { body = callback; };
    register.setTimeout = () => {};
    register.skip = (condition, reason) => {
      if (condition) { assert.match(reason, /Linux.*(manual|Full Rescan)|native.*Linux/i); skipped = true; throw skippedSignal; }
    };
    vm.runInNewContext(source, { test: register, process: { platform }, console });
    assert.equal(typeof body, 'function');
    await assert.rejects(body({
      stepLogger: { async step() { touchedApp = true; throw touchedSignal; } },
      testArtifacts: { queueJsonAttachment() {} },
    }), (error) => error === (platform === 'linux' ? skippedSignal : touchedSignal));
    assert.equal(skipped, platform === 'linux');
    assert.equal(touchedApp, platform !== 'linux');
  }
});

test('watcher fixture creation failure cleans partial ownership before returning the original error', async (t) => {
  const { createWatchedAlbumFixture } = await load();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-create-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'media'));
  fs.writeFileSync(path.join(temp, 'media', 'source.mp3'), 'playable source stand-in for copy failure');
  const originalFailure = new Error('copy interrupted after first owned file');
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (...args) => { originalCopy(...args); throw originalFailure; });
  const prior = { root: process.env.ALBUM_HAVEN_E2E_TEMP_ROOT, profile: process.env.ALBUM_HAVEN_FIXTURE_PROFILE };
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = temp;
  delete process.env.ALBUM_HAVEN_FIXTURE_PROFILE;
  t.after(() => {
    for (const [key, value] of [['ALBUM_HAVEN_E2E_TEMP_ROOT', prior.root], ['ALBUM_HAVEN_FIXTURE_PROFILE', prior.profile]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const calls = [];
  await assert.rejects(createWatchedAlbumFixture({
    context: { async close() { calls.push('context'); } },
    managedAppLifecycle: { async cleanupWatcherFixture() { calls.push('drained'); calls.push('inventory'); } },
  }), (error) => error === originalFailure);
  assert.equal(fs.existsSync(path.join(temp, 'media', 'cases', 'watcher-reconciliation')), false);
  assert.deepEqual(calls, ['context', 'drained', 'inventory']);
});
