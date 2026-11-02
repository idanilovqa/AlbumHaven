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
const mediaRootHelperPath = path.resolve(__dirname, '../e2e/helpers/fixtureMediaRoot.js');

test('watcher fixture forwards custom titles artists and discs through atomic album materialization', () => {
  const source = fs.readFileSync(helperPath, 'utf8');

  assert.match(source, /trackTitles\s*=\s*\['Watcher First Signal', 'Watcher Second Signal'\]/);
  assert.match(source, /trackArtists\s*=\s*null/);
  assert.match(source, /discNumbers\s*=\s*null/);
  assert.match(source, /removeEmbeddedArtwork\s*=\s*false/);
  assert.match(source, /createLocalArt\s*=\s*false/);
  assert.match(source, /if \(createLocalArt\)[\s\S]*?CREATE_LOCAL_ART_SCRIPT/);
  assert.match(source, /async function retag\(trackPath,\s*\{[\s\S]*?trackArtist,[\s\S]*?albumArtist,[\s\S]*?discTag\s*=\s*'1\/1'/);
  assert.match(source, /trackTitles:\s*titles[\s\S]*?trackArtist:\s*defaultTrackArtist[\s\S]*?trackArtists:\s*albumTrackArtists[\s\S]*?albumArtist:\s*albumOwner[\s\S]*?discNumbers:\s*albumDiscNumbers/);
  assert.match(source, /trackArtist:\s*albumTrackArtists\?\.\[index\]\s*\|\|\s*defaultTrackArtist/);
  assert.match(source, /discTotal\s*>\s*1[\s\S]*?`CD\$\{discNumber\}`/);
});

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
