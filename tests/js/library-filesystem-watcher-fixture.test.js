const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { resolvePlaywrightPython } = require('../../scripts/playwright-python.cjs');
const helperPath = path.resolve(__dirname, '../e2e/helpers/libraryFilesystemWatcherFixture.js');
const load = () => import(pathToFileURL(helperPath).href);
const actionsPath = path.resolve(__dirname, '../e2e/actions/libraryFilesystemWatcherActions.js');
const loadActions = () => import(pathToFileURL(actionsPath).href);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function useTempRoot(t, tempRoot) {
  const priorRoot = process.env.ALBUM_HAVEN_E2E_TEMP_ROOT;
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = tempRoot;
  t.after(() => {
    if (priorRoot === undefined) delete process.env.ALBUM_HAVEN_E2E_TEMP_ROOT;
    else process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = priorRoot;
  });
}
const mediaRootHelperPath = path.resolve(__dirname, '../e2e/helpers/fixtureMediaRoot.js');

function fixture(t, ownedDirectoryName = 'watcher-reconciliation') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-cleanup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const mediaRoot = path.join(temp, 'media');
  const ownedRoot = path.join(mediaRoot, 'cases', ownedDirectoryName);
  fs.mkdirSync(ownedRoot, { recursive: true });
  fs.writeFileSync(path.join(ownedRoot, 'owned.mp3'), 'owned');
  fs.writeFileSync(path.join(mediaRoot, 'unrelated.mp3'), 'untouched');
  return { mediaRoot, ownedRoot, ownedDirectoryName };
}

function recoveryFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-recovery-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const ownedRoot = path.join(tempRoot, 'cases', 'watcher-recovery-contract');
  const failureRoot = path.join(ownedRoot, 'failure-root');
  const failureRootStaging = path.join(ownedRoot, 'failure-root-staging');
  const healthyRoot = path.join(ownedRoot, 'healthy-root');
  fs.mkdirSync(failureRoot, { recursive: true });
  fs.mkdirSync(healthyRoot, { recursive: true });
  fs.writeFileSync(path.join(failureRoot, 'failure.mp3'), 'failure inventory');
  fs.writeFileSync(path.join(healthyRoot, 'healthy.mp3'), 'healthy inventory');
  const manifestPath = path.join(tempRoot, 'app-data', 'watcher-recovery-fixture.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    failure_root_id: 'watcher-recovery-failure-contract',
    failure_root_path: failureRoot,
    failure_root_staging_path: failureRootStaging,
    healthy_root_id: 'watcher-recovery-healthy-contract',
    healthy_root_path: healthyRoot,
    viewer_username: 'watcher-recovery-viewer-contract',
    viewer_password: 'private fixture password',
  }));
  return {
    tempRoot, ownedRoot, failureRoot, failureRootStaging, healthyRoot, manifestPath,
  };
}

test('writable media-root resolver allows synthetic fixtures only when the caller opts in', async (t) => {
  const { resolveWritableFixtureMediaRoot } = await import(pathToFileURL(mediaRootHelperPath).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-media-root-'));
  const mediaRoot = path.join(temp, 'media');
  fs.mkdirSync(mediaRoot);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const environment = {
    ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
    ALBUM_HAVEN_FIXTURE_ROOT: temp,
    ALBUM_HAVEN_MEDIA_ROOT: mediaRoot,
  };

  assert.throws(() => resolveWritableFixtureMediaRoot(environment), /does not allow/i);
  assert.equal(
    resolveWritableFixtureMediaRoot(environment, {
      allowedProfiles: ['functional-core', 'synthetic-large-library'],
    }),
    fs.realpathSync(mediaRoot),
  );
});

test('writable media-root resolver accepts a contained target-owned override', async (t) => {
  const { resolveWritableFixtureMediaRoot } = await import(pathToFileURL(mediaRootHelperPath).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-owned-media-root-'));
  const fixtureRoot = path.join(temp, 'fixture');
  const fixtureMediaRoot = path.join(fixtureRoot, 'media');
  const sessionRoot = path.join(temp, 'session');
  const writableMediaRoot = path.join(sessionRoot, 'media', 'writable');
  fs.mkdirSync(fixtureMediaRoot, { recursive: true });
  fs.mkdirSync(writableMediaRoot, { recursive: true });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const environment = {
    ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: fixtureMediaRoot,
    ALBUM_HAVEN_E2E_TEMP_ROOT: sessionRoot,
    ALBUM_HAVEN_E2E_WRITABLE_MEDIA_ROOT: writableMediaRoot,
  };

  assert.equal(
    resolveWritableFixtureMediaRoot(environment, {
      allowedProfiles: ['synthetic-large-library'],
    }),
    fs.realpathSync(writableMediaRoot),
  );
  assert.throws(() => resolveWritableFixtureMediaRoot({
    ...environment,
    ALBUM_HAVEN_E2E_WRITABLE_MEDIA_ROOT: fixtureMediaRoot,
  }, {
    allowedProfiles: ['synthetic-large-library'],
  }), /inside.*temporary/i);
});

test('watcher fixture generates a decoder-valid MP3 source instead of accepting metadata stubs', async (t) => {
  const { generatePlayableMp3Source } = await load();
  assert.equal(typeof generatePlayableMp3Source, 'function');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-audio-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const destination = path.join(temp, 'source.mp3');

  await generatePlayableMp3Source(destination);

  const duration = Number(execFileSync(resolvePlaywrightPython(process.env), [
    '-c',
    'import sys; from mutagen.mp3 import MP3; print(MP3(sys.argv[1]).info.length)',
    destination,
  ], { encoding: 'utf8', windowsHide: true }).trim());
  assert.ok(duration > 0, `expected playable MP3 duration, received ${duration}`);
});

test('watched tracks become playable only after their tags are complete', async (t) => {
  const { materializeTaggedTrack } = await load();
  assert.equal(typeof materializeTaggedTrack, 'function');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-publish-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source.mp3');
  const destination = path.join(temp, 'published.mp3');
  fs.writeFileSync(source, 'source audio');
  let stagedPath = null;

  await materializeTaggedTrack({
    source,
    destination,
    metadata: { artist: 'Neal Morse', album: 'Gallery Refresh' },
    async retagTrack(trackPath) {
      stagedPath = trackPath;
      assert.equal(path.extname(trackPath), '.pending');
      assert.equal(fs.existsSync(trackPath), true);
      assert.equal(fs.existsSync(destination), false);
      fs.appendFileSync(trackPath, ' tagged');
    },
  });

  assert.notEqual(stagedPath, destination);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'source audio tagged');
});

test('watched albums become visible only after every track is complete', async (t) => {
  const { materializeTaggedAlbum } = await load();
  assert.equal(typeof materializeTaggedAlbum, 'function');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-watcher-album-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const stagingParent = path.join(temp, 'staging');
  const destination = path.join(temp, 'watched', 'artist', 'album');
  fs.mkdirSync(stagingParent, { recursive: true });

  await materializeTaggedAlbum({
    stagingParent,
    destination,
    async buildAlbum(stagedAlbum) {
      assert.equal(fs.existsSync(destination), false);
      fs.writeFileSync(path.join(stagedAlbum, '01.mp3'), 'tagged first');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fs.existsSync(destination), false);
      fs.writeFileSync(path.join(stagedAlbum, '02.mp3'), 'tagged second');
    },
  });

  assert.deepEqual(fs.readdirSync(destination).sort(), ['01.mp3', '02.mp3']);
  assert.deepEqual(fs.readdirSync(stagingParent), []);
});

test('watcher cleanup accepts a separately owned case directory', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  const paths = fixture(t, 'gallery-native-response-overlap');
  const cleanupOwners = [];

  await cleanupWatchedAlbumFixture({
    ...paths,
    context: { async close() {} },
    managedAppLifecycle: {
      async cleanupWatcherFixture(ownedDirectoryName) {
        cleanupOwners.push(ownedDirectoryName);
      },
    },
  });

  assert.deepEqual(cleanupOwners, ['gallery-native-response-overlap']);
  assert.equal(fs.existsSync(paths.ownedRoot), false);
  assert.equal(fs.readFileSync(path.join(paths.mediaRoot, 'unrelated.mp3'), 'utf8'), 'untouched');
});

test('watcher cleanup rejects an unknown case directory before filesystem mutation', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  const paths = fixture(t, 'not-runner-owned');
  let contextClosed = false;
  let lifecycleCalled = false;

  await assert.rejects(
    cleanupWatchedAlbumFixture({
      ...paths,
      context: { async close() { contextClosed = true; } },
      managedAppLifecycle: {
        async cleanupWatcherFixture() { lifecycleCalled = true; },
      },
    }),
    /runner-owned directory/i,
  );

  assert.equal(contextClosed, false);
  assert.equal(lifecycleCalled, false);
  assert.equal(fs.existsSync(path.join(paths.ownedRoot, 'owned.mp3')), true);
});

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

test('watcher cleanup removes scoped files and inventory when browser close fails', async (t) => {
  const { cleanupWatchedAlbumFixture } = await load();
  const paths = fixture(t);
  const closeFailure = new Error('browser close failed');
  const calls = [];

  await assert.rejects(cleanupWatchedAlbumFixture({
    ...paths,
    context: { async close() { throw closeFailure; } },
    managedAppLifecycle: {
      async cleanupWatcherFixture() { calls.push('inventory'); },
      async reportFailure() { calls.push('reported'); },
    },
  }), error => error === closeFailure);

  assert.equal(fs.existsSync(paths.ownedRoot), false);
  assert.equal(fs.readFileSync(path.join(paths.mediaRoot, 'unrelated.mp3'), 'utf8'), 'untouched');
  assert.deepEqual(calls, ['inventory', 'reported']);
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
    const bodies = new Map();
    let touchedApp = false;
    let skipped = false;
    const skippedSignal = new Error('skipped by platform contract');
    const touchedSignal = new Error('first unchanged scenario step');
    const register = (title, _options, callback) => { bodies.set(title, callback); };
    register.setTimeout = () => {};
    register.skip = (condition, reason) => {
      if (condition) { assert.match(reason, /Linux.*(manual|Full Rescan)|native.*Linux/i); skipped = true; throw skippedSignal; }
    };
    vm.runInNewContext(source, { test: register, process: { platform }, console });
    const body = bodies.get(
      'FTC-LIBROOTS-016 / 017 / 018 reconciles filesystem changes and confirms missing-album removal',
    );
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

test('watcher recovery fixture rejects a manifest outside the runner-owned temp root', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  assert.equal(typeof createWatcherRecoveryFixture, 'function');
  const paths = recoveryFixture(t);
  const outside = path.join(path.dirname(paths.tempRoot), `${path.basename(paths.tempRoot)}-outside.json`);
  fs.copyFileSync(paths.manifestPath, outside);
  t.after(() => fs.rmSync(outside, { force: true }));
  useTempRoot(t, paths.tempRoot);

  await assert.rejects(
    createWatcherRecoveryFixture({ manifestPath: outside, managedAppLifecycle: {} }),
    /manifest.*runner-owned temp root/i,
  );
  assert.equal(fs.existsSync(paths.failureRoot), true);
  assert.equal(fs.existsSync(paths.healthyRoot), true);
});

test('watcher recovery fixture rejects every owned-root path that escapes the allowed boundary', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  assert.equal(typeof createWatcherRecoveryFixture, 'function');
  const paths = recoveryFixture(t);
  useTempRoot(t, paths.tempRoot);
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
  for (const field of [
    'failure_root_path',
    'failure_root_staging_path',
    'healthy_root_path',
  ]) {
    await t.test(field, async () => {
      const escapedRoot = path.join(paths.tempRoot, 'media', `unowned-${field}`);
      fs.mkdirSync(escapedRoot, { recursive: true });
      fs.writeFileSync(paths.manifestPath, JSON.stringify({
        ...manifest,
        [field]: escapedRoot,
      }));

      await assert.rejects(
        createWatcherRecoveryFixture({
          manifestPath: paths.manifestPath,
          managedAppLifecycle: {},
        }),
        /root.*(?:escaped|owned boundary|watcher-recovery)/i,
      );
      assert.equal(fs.existsSync(escapedRoot), true);
    });
  }
  assert.equal(fs.existsSync(paths.healthyRoot), true);
});

test('watcher recovery failure and restoration use acknowledged stop rename restart sequences', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  assert.equal(typeof createWatcherRecoveryFixture, 'function');
  const paths = recoveryFixture(t);
  useTempRoot(t, paths.tempRoot);
  const calls = [];
  const stops = [deferred(), deferred()];
  const restarts = [deferred(), deferred()];
  let stopIndex = 0;
  let restartIndex = 0;
  const managedAppLifecycle = {
    async stop() {
      calls.push('stop');
      return stops[stopIndex++].promise;
    },
    async restart() {
      calls.push('restart');
      return restarts[restartIndex++].promise;
    },
  };
  const recovery = await createWatcherRecoveryFixture({
    manifestPath: paths.manifestPath,
    managedAppLifecycle,
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    calls.push(`rename:${path.basename(source)}>${path.basename(destination)}`);
    rename(source, destination);
  });

  let completed = false;
  const unavailable = recovery.makeFailureRootUnavailable().then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['stop']);
  assert.equal(fs.existsSync(paths.failureRoot), true);
  assert.equal(fs.existsSync(paths.failureRootStaging), false);
  stops[0].resolve({ nonce: 'stop-unavailable', status: 'stopped' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    'stop', 'rename:failure-root>failure-root-staging', 'restart',
  ]);
  assert.equal(completed, false);
  assert.equal(fs.existsSync(paths.failureRoot), false);
  assert.equal(fs.existsSync(paths.failureRootStaging), true);
  restarts[0].resolve({ nonce: 'restart-unavailable', status: 'ready' });
  await unavailable;
  calls.push(fs.existsSync(paths.failureRoot) ? 'failure-present' : 'failure-absent');
  calls.push(fs.existsSync(paths.failureRootStaging) ? 'staging-present' : 'staging-absent');

  completed = false;
  const restored = recovery.restoreFailureRoot().then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), 'stop');
  assert.equal(fs.existsSync(paths.failureRoot), false);
  assert.equal(fs.existsSync(paths.failureRootStaging), true);
  stops[1].resolve({ nonce: 'stop-restore', status: 'stopped' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-2), 'rename:failure-root-staging>failure-root');
  assert.equal(calls.at(-1), 'restart');
  assert.equal(completed, false);
  restarts[1].resolve({ nonce: 'restart-restore', status: 'ready' });
  await restored;
  calls.push(fs.existsSync(paths.failureRoot) ? 'failure-present' : 'failure-absent');
  calls.push(fs.existsSync(paths.failureRootStaging) ? 'staging-present' : 'staging-absent');

  assert.deepEqual(calls, [
    'stop', 'rename:failure-root>failure-root-staging', 'restart',
    'failure-absent', 'staging-present',
    'stop', 'rename:failure-root-staging>failure-root', 'restart',
    'failure-present', 'staging-absent',
  ]);
  assert.equal(fs.existsSync(paths.healthyRoot), true);
});

test('repeatBeforeResolution restores the failure root before polling the same incident occurrence', async () => {
  const { LibraryFilesystemWatcherActions } = await loadActions();
  const calls = [];
  const firstIncident = {
    incidentId: 'stable-incident',
    warningToken: 'stable-warning',
    occurrenceCount: 1,
  };
  const actions = new LibraryFilesystemWatcherActions({});
  actions._getRecovery = async () => ({
    async restoreFailureRoot() { calls.push('restore'); },
    async restartWhileFailureRootUnavailable() { calls.push('forbidden-restart'); },
  });
  actions._readRecoverySnapshot = async () => ({
    incidents: [{ ...firstIncident, resolved: false, occurrenceCount: 2 }],
  });
  actions._waitForRecoverySnapshot = async (predicate) => {
    calls.push('poll');
    assert.equal(predicate({
      incidents: [{ ...firstIncident, resolved: false, occurrenceCount: 2 }],
    }), true, 'the poll must retain the same incident and require a later occurrence');
  };
  actions._openStatusPage = async () => { calls.push('open-status'); };

  await actions.repeatBeforeResolution(firstIncident);

  assert.deepEqual(calls, ['restore', 'poll', 'open-status']);
});

test('watcher recovery helper surface omits the deadlocking unavailable-root restart', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  const paths = recoveryFixture(t);
  useTempRoot(t, paths.tempRoot);

  const recovery = await createWatcherRecoveryFixture({
    manifestPath: paths.manifestPath,
    managedAppLifecycle: {},
  });

  assert.equal(recovery.restartWhileFailureRootUnavailable, undefined);
  assert.equal(typeof recovery.restoreFailureRoot, 'function');
});

test('watcher recovery refuses a wrong stop acknowledgment before renaming', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  assert.equal(typeof createWatcherRecoveryFixture, 'function');
  const paths = recoveryFixture(t);
  useTempRoot(t, paths.tempRoot);
  let restarted = false;
  const recovery = await createWatcherRecoveryFixture({
    manifestPath: paths.manifestPath,
    managedAppLifecycle: {
      async stop() { return { nonce: 'wrong-operation', status: 'ready' }; },
      async restart() { restarted = true; },
    },
  });

  await assert.rejects(
    recovery.makeFailureRootUnavailable(),
    /stop acknowledgment/i,
  );
  assert.equal(restarted, false);
  assert.equal(fs.existsSync(paths.failureRoot), true);
  assert.equal(fs.existsSync(paths.failureRootStaging), false);
});

test('watcher recovery cleanup closes the viewer before destructive owned-root cleanup', async (t) => {
  const { createWatcherRecoveryFixture } = await load();
  assert.equal(typeof createWatcherRecoveryFixture, 'function');
  const paths = recoveryFixture(t);
  useTempRoot(t, paths.tempRoot);
  const calls = [];
  const recovery = await createWatcherRecoveryFixture({
    manifestPath: paths.manifestPath,
    managedAppLifecycle: {
      async cleanupWatcherFixture(...args) {
        calls.push('cleanup');
        assert.deepEqual(args, []);
      },
    },
  });

  await recovery.cleanup({
    viewerContext: { async close() { calls.push('viewer.close'); } },
  });

  assert.deepEqual(calls, ['viewer.close', 'cleanup']);
});

test('FTC-LIBROOTS-019 keeps the approved production sequence and excludes test-only success seams', () => {
  const specPath = path.resolve(__dirname, '../e2e/specs/libraryFilesystemWatcher.functional.spec.js');
  const source = fs.readFileSync(specPath, 'utf8');
  const title = 'FTC-LIBROOTS-019 repairs a stable watcher incident through its completion watermark';
  const start = source.indexOf(title);
  assert.notEqual(start, -1);
  const scenario = source.slice(start);
  const steps = [
    'Keep the unaffected root progressing while one root fails',
    'Acknowledge globally without removing Library Status repair',
    'Accept an event during repair and wait through final catch-up',
    'Show a later incident with a new identity and warning token',
  ];
  let previous = -1;
  for (const step of steps) {
    const position = scenario.indexOf(step);
    assert.ok(position > previous, `${step} must retain the approved scenario order`);
    previous = position;
  }
  for (const required of [
    'expectInventoryPreservedAndPathFreeWarning',
    'expectDestructiveChangeBlocked',
    'expectHealthyRootRevisionAdvance',
    'expectRepairAvailable',
    'expectRepairUnavailable',
    'createDuringRepair',
    'repeatBeforeResolution',
    'waitForRepairWatermark',
    'expectNewIncidentIdentity',
  ]) {
    assert.match(scenario, new RegExp(`\\b${required}\\b`));
  }
  const warningVisible = scenario.indexOf('healthWarning).toBeVisible()');
  const completionWatermark = scenario.indexOf('waitForRepairWatermark(duringRepairFence)');
  const warningHidden = scenario.indexOf('healthWarning).toBeHidden()');
  assert.ok(warningVisible >= 0 && warningVisible < completionWatermark);
  assert.ok(completionWatermark < warningHidden);
  assert.match(
    scenario,
    /expectNewIncidentIdentity\(\s*firstIncident\.incidentId,\s*firstIncident\.warningToken,/,
  );
  for (const forbidden of [
    'page.evaluate(',
    'page.route(',
    'waitForTimeout(',
    'storageState:',
    'insert into ',
    'update ',
    'delete from ',
  ]) {
    assert.equal(scenario.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('FTC-LIBROOTS-019 proves the during-repair event crossed its acceptance fence into inventory', () => {
  const specPath = path.resolve(__dirname, '../e2e/specs/libraryFilesystemWatcher.functional.spec.js');
  const actionsPath = path.resolve(__dirname, '../e2e/actions/libraryFilesystemWatcherActions.js');
  const spec = fs.readFileSync(specPath, 'utf8');
  const actions = fs.readFileSync(actionsPath, 'utf8');
  const title = 'FTC-LIBROOTS-019 repairs a stable watcher incident through its completion watermark';
  const scenario = spec.slice(spec.indexOf(title));

  assert.match(
    scenario,
    /const\s+duringRepairFence\s*=\s*await\s+libraryFilesystemWatcherActions\.createDuringRepair\(\)/,
    'The scenario must retain the accepted healthy-root event fence.',
  );
  assert.match(
    scenario,
    /waitForRepairWatermark\(duringRepairFence\)/,
    'Repair completion must prove the retained event fence, not only generic lane equality.',
  );

  const createDuringRepair = actions.slice(
    actions.indexOf('async createDuringRepair()'),
    actions.indexOf('async repeatBeforeResolution'),
  );
  assert.match(createDuringRepair, /acceptedSequence/);
  assert.match(createDuringRepair, /inventory(?:Path|Entry)/);
  assert.match(createDuringRepair, /return\s*\{/);

  const waitForRepairWatermark = actions.slice(
    actions.indexOf('async waitForRepairWatermark'),
    actions.indexOf('async waitForScanIdleAndHealthy'),
  );
  assert.match(waitForRepairWatermark, /duringRepairFence/);
  assert.match(
    waitForRepairWatermark,
    /appliedSequence[\s\S]*duringRepairFence\.acceptedSequence/,
    'Completion must prove appliedSequence reached the captured acceptance fence.',
  );
  assert.match(
    waitForRepairWatermark,
    /inventory(?:Files|Entries|Paths)[\s\S]*(?:includes|some)\(/,
    'Completion must prove the corresponding inventory entry exists.',
  );
});

test('watcher recovery diagnostics expose bounded read-only evidence only', () => {
  const diagnosticsPath = path.resolve(
    __dirname,
    '../e2e/helpers/postgresWatcherRecoveryHelpers.js',
  );
  assert.equal(
    fs.existsSync(diagnosticsPath),
    true,
    'postgresWatcherRecoveryHelpers.js must define the retained read-only diagnostics contract',
  );
  const source = fs.readFileSync(diagnosticsPath, 'utf8');
  assert.match(source, /readWatcherRecoverySnapshot/);
  assert.match(source, /waitForWatcherRecoverySnapshot/);
  assert.match(source, /expect\.poll/);
  assert.match(source, /resolveIsolatedE2ESetupConnection/);
  assert.doesNotMatch(
    source,
    /\b(?:insert\s+into|update\s+[a-z_][\w.]*|delete\s+from|call\s+[a-z_][\w.]*)\b/i,
  );
  assert.doesNotMatch(source, /waitForTimeout|setTimeout/);
});

test('watcher recovery viewer uses a guarded blank session and the visible production login', () => {
  const accountsPath = path.resolve(__dirname, '../e2e/support/watcherRecoveryAccounts.js');
  assert.equal(
    fs.existsSync(accountsPath),
    true,
    'watcherRecoveryAccounts.js must own the alternate viewer login lifecycle',
  );
  const source = fs.readFileSync(accountsPath, 'utf8');
  assert.match(source, /freshBrowserSession\.create\(\s*\{\s*authenticated:\s*false\s*\}\s*\)/);
  assert.match(source, /goto\(\s*['"]\/login['"]/);
  assert.match(source, /getByRole\(\s*['"]textbox['"]/);
  assert.match(source, /getByRole\(\s*['"]button['"][\s\S]*Sign in/i);
  assert.match(source, /waitForURL|toHaveURL/);
  assert.doesNotMatch(source, /\.newContext\s*\(|\.newPage\s*\(/);
  assert.doesNotMatch(source, /storageState|addCookies|document\.cookie/i);
  assert.doesNotMatch(source, /(?:page\.)?request\.(?:post|get|fetch)|\/api\/auth/i);
});
