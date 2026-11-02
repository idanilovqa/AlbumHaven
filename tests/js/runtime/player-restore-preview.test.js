'use strict';
// Simulated browser/audio platforms; complete served playback owners and markup.
// These are contract tests, not browser, decoder or LS09 acceptance evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, world, track, start, displayMessages} = require('./search-native-fixtures/ownership-platform.cjs');
const SAVED = 'albumhaven.playerState.v1';
const LEASE = 'albumhaven.playbackOwnership.v1';
const plain = value => JSON.parse(JSON.stringify(value));
const saved = () => ({track: {...track('Preview'), durationSeconds: 181}, playbackQueue: null,
  currentTime: 33, paused: false, loop: {active: true, start: 0, end: 30}});

async function previewFixture(t, {media = true, fixtureWorld = world()} = {}) {
  let h;
  const work = [];
  // Registered first: retire exact owned work before the inherited platform closes.
  t.after(async () => {
    if (!h) return;
    h.c.retirePlayerRestoreAttempt('preview-test-teardown');
    const handle = h.c.getActivePlaybackOwnershipHandle();
    const attempt = h.c.captureStreamingPlaybackAttempt();
    if (handle) h.c.releasePlaybackOwnership('stopped', handle);
    if (attempt) await h.c.stopStreamingPlayback('preview-test-teardown', {expectedAttempt: attempt});
    if (h.engine().stopPromise) await h.engine().stopPromise;
    await Promise.all(work);
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    assert.equal(h.engine().roles.current, null);
    h.c.disposePlaybackOwnershipCoordinator();
  });
  h = await fixture(t, fixtureWorld, {media, readyState: 'loading'});
  h.c.innerWidth = 1200;
  const actualStart = h.c.startStreamingTrack;
  h.c.startStreamingTrack = (...args) => {
    const result = actualStart(...args);
    work.push(Promise.resolve(result).then(value => ({value}), error => ({error})));
    return result;
  };
  const data = saved();
  function seed(value = data) {
    h.c.localStorage.setItem(SAVED, JSON.stringify(value));
    // Startup input for this isolated invocation, not a fabricated selection owner.
    h.state.player.restoredFromStorage = false;
  }
  seed();
  const cache = h.state.player.lastPersistedSnapshot;
  const baseline = h.world.writes.length;
  const writes = () => h.world.writes.slice(baseline).filter(row => row.key === SAVED);
  return Object.assign(h, {data, seed, cache, writes, startupWork: work});
}

function assertNoStartup(h) {
  assert.equal(h.platform.contexts.length, 0);
  assert.equal(h.platform.nodes.length, 0);
  assert.equal(h.platform.sockets.length, 0);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.world.local.has(LEASE), false);
  assert.equal(h.state.player.listenSession, null);
  assert.equal(displayMessages(h.world).length, 0);
}

function assertPreview(h) {
  assert.ok(h.state.player.current, 'cached metadata publishes synchronously before pageshow');
  assert.equal(h.state.player.current.path, h.data.track.path);
  assert.equal(h.state.player.current.durationSeconds, 181);
  const full = h.c.getPlayerElements(), compact = h.c.compactPlayerElements();
  assert.equal(full.title.textContent, `${h.data.track.artist} - ${h.data.track.title} /`);
  assert.equal(compact.titleText.textContent, h.data.track.title);
  assert.equal(full.timeline.value, '33');
  assert.equal(full.timeline.max, '181');
  assert.equal(full.time.textContent, `${h.c.formatLoopTime(33)} / ${h.c.formatLoopTime(181)}`);
  assert.equal(full.play.getAttribute('aria-label'), 'Play');
  assert.equal(compact.play.getAttribute('aria-label'), 'Play');
  assert.equal(h.state.player.loopActive, false);
  assert.equal(h.state.player.loopStart, 0);
  assert.equal(h.state.player.loopEnd, 30);
}

test('preview436: real setter and full/compact presentation publish synchronously without startup authority', async t => {
  const h = await previewFixture(t);
  const scope = h.c.capturePlaybackOwnershipScope();
  assert.equal(h.c.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(h.c.AlbumHavenCapabilities.allows('library.media.read'), true);
  const before = plain(h.c.getPlayerPlaybackSnapshot());
  h.c.restorePlayerState();
  assertPreview(h);
  assertNoStartup(h);
  assert.deepEqual(plain(h.c.getPlayerPlaybackSnapshot()), before, 'display projection never replaces engine snapshot');
  assert.deepEqual(h.writes(), []);
  assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
  assert.ok(h.owner('playerRestoreAttempt').pageshow, 'saved-playing keeps the event gate');
  assert.equal(h.requests.some(row => new URL(row.url, h.location).pathname === '/playback/waveform'), false,
    'cached waveform publication is deferred until this publication is admitted');
  assert.ok(h.platform.images.length > 0, 'authorized existing artwork remains enabled');
});

for (const save of ['implicit-ui', 'forced', 'visibility', 'unload', 'retired']) {
  test(`preview436: ${save} cannot serialize unadmitted preview over saved 33 seconds`, async t => {
    const h = await previewFixture(t), original = h.c.localStorage.getItem(SAVED);
    h.c.restorePlayerState();
    assertPreview(h);
    if (save === 'implicit-ui') h.c.updatePlayerUi();
    if (save === 'forced') assert.equal(h.c.persistPlayerState(true), false);
    if (save === 'visibility') {
      // Bootstrap is intentionally absent from this owner fixture. Exercise
      // its exact hidden-save call contract, not an unregistered DOM event.
      assert.equal(h.c.persistPlayerState(true, {preservePlayingState: true}), false);
    }
    if (save === 'unload') assert.equal(h.c.persistPlayerStateForUnload('pagehide'), true);
    if (save === 'retired') {
      h.c.retirePlayerRestoreAttempt('explicit-test-retirement');
      h.c.updatePlayerUi();
      assert.equal(h.c.persistPlayerState(true), false);
    }
    assert.equal(h.c.localStorage.getItem(SAVED), original);
    assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
    assert.deepEqual(h.writes(), []);
    assertNoStartup(h);
    if (save === 'unload' || save === 'retired') {
      h.c.dispatchEvent(new h.c.Event('pageshow'));
      await h.flush();
      assertNoStartup(h);
    }
  });
}

for (const replacement of ['same-object', 'same-path-object']) {
  test(`preview436: successful ${replacement} setter replaces publication and restores ordinary forced writes`, async t => {
    const h = await previewFixture(t);
    h.c.restorePlayerState();
    assertPreview(h);
    const previous = h.state.player.current;
    const successor = replacement === 'same-object' ? previous : {...previous, title: 'New same-path publication'};
    h.c.setCurrentPlayerTrack(successor, {persist: false});
    assert.strictEqual(h.state.player.current, successor);
    assert.equal(h.owner('playerRestoreAttempt'), null);
    assert.equal(h.c.persistPlayerState(true), true);
    assert.equal(JSON.parse(h.c.localStorage.getItem(SAVED)).track.title, successor.title);
    const count = h.writes().length;
    h.c.dispatchEvent(new h.c.Event('pageshow'));
    await h.flush();
    assert.strictEqual(h.state.player.current, successor);
    assert.equal(h.writes().length, count);
    assert.equal(h.platform.contexts.length, 0);
  });
}

test('preview436: failed same-object setter leaves exact preview serialization fence intact', async t => {
  const h = await previewFixture(t), original = h.c.localStorage.getItem(SAVED);
  h.c.restorePlayerState();
  assertPreview(h);
  const preview = h.state.player.current, attempt = h.owner('playerRestoreAttempt');
  h.c.setCurrentPlayerTrack(preview, {persist: false, isCurrent: () => false});
  assert.strictEqual(h.state.player.current, preview);
  assert.strictEqual(h.owner('playerRestoreAttempt'), attempt);
  assert.equal(h.c.persistPlayerState(true), false);
  assert.equal(h.c.localStorage.getItem(SAVED), original);
  assert.deepEqual(h.writes(), []);
});

for (const exclusion of ['media-denied', 'scope-retired', 'existing-current', 'existing-listen']) {
  test(`preview436: ${exclusion} cannot steal queue or metadata through cached startup`, async t => {
    const h = await previewFixture(t, {media: exclusion !== 'media-denied'});
    if (exclusion === 'scope-retired') { h.change('actor', ''); h.c.capturePlaybackOwnershipScope(); }
    if (exclusion === 'existing-current') h.c.setCurrentPlayerTrack(track('Existing'), {persist: false});
    if (exclusion === 'existing-listen') h.c.startListenSession(track('ExistingListen'));
    const current = h.state.player.current, session = h.state.player.listenSession;
    const queue = {tracks: [track('OwnedQueue')], currentIndex: 0};
    h.state.player.playbackQueue = queue;
    const stored = h.c.localStorage.getItem(SAVED), count = h.writes().length;
    h.c.restorePlayerState();
    assert.strictEqual(h.state.player.current, current);
    assert.strictEqual(h.state.player.listenSession, session);
    assert.strictEqual(h.state.player.playbackQueue, queue);
    assert.equal(h.c.localStorage.getItem(SAVED), stored);
    assert.equal(h.writes().length, count);
    assert.equal(h.platform.contexts.length, 0);
    assert.equal(h.owner('playerRestoreAttempt'), null);
  });
}

test('preview436: real pending manual selection with unpublished current keeps its queue and admission', async t => {
  const h = await previewFixture(t);
  h.platform.holds.module = true;
  const payload = track('PendingManual');
  const work = h.c.playTrackFromPayload(payload, {autoplay: false});
  await h.flush();
  assert.ok(h.owner('playerSelectionOwnership'));
  assert.equal(h.state.player.current, null);
  const queue = {tracks: [payload], currentIndex: 0};
  h.state.player.playbackQueue = queue;
  try {
    h.c.restorePlayerState();
    assert.strictEqual(h.state.player.playbackQueue, queue);
    assert.equal(h.state.player.current, null);
    assert.equal(h.owner('playerRestoreAttempt'), null);
  } finally {
    h.platform.contexts[0].module.resolve();
    await work;
  }
  assert.equal(h.state.player.current.path, payload.path);
});

test('preview436: real canonical cover decoration is the retained publication through admission', async t => {
  const h = await previewFixture(t);
  h.data.track.coverPath = '';
  const album = {key: 'preview-decoration', name: h.data.track.album, artist: h.data.track.artist,
    cover_path: '/library/preview-decorated.jpg', tracks: [h.data.track]};
  h.state.modalReleases = [album];
  h.seed();
  let supplied, returned;
  const setter = h.c.setCurrentPlayerTrack;
  h.c.setCurrentPlayerTrack = (value, options) => {
    supplied = value;
    returned = setter(value, options);
    return returned;
  };
  h.c.restorePlayerState();
  assertPreview(h);
  const canonical = h.state.player.current;
  assert.notStrictEqual(canonical, supplied, 'real setter decorates a new canonical object');
  assert.strictEqual(returned, canonical, 'successful actual setter returns its exact publication');
  assert.equal(canonical.coverPath, album.cover_path);
  h.c.dispatchEvent(new h.c.Event('pageshow'));
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await Promise.all(h.startupWork);
  await h.flush();
  assert.strictEqual(h.state.player.current, canonical, 'admission must not re-call setter or recreate decoration');
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 33);
  assert.equal(h.c.persistPlayerState(true), true);
  assert.equal(JSON.parse(h.c.localStorage.getItem(SAVED)).track.coverPath, album.cover_path);
});

for (const sameObject of [false, true]) {
  test(`preview436: queue callback ${sameObject ? 'same-object' : 'same-path'} successor cannot inherit preview loops or fence`, async t => {
    const h = await previewFixture(t);
    let successor;
    const off = h.queue.subscribe(() => {
      const current = h.state.player.current;
      if (successor || current?.path !== h.data.track.path) return;
      successor = sameObject ? current : {...current, title: 'Queue callback successor'};
      h.c.setCurrentPlayerTrack(successor, {persist: false});
      h.state.player.loopStart = 7;
      h.state.player.loopEnd = 19;
    });
    try {
      h.c.restorePlayerState();
      assert.ok(successor, 'real queue notification observes synchronous preview assignment');
      assert.strictEqual(h.state.player.current, successor);
      assert.equal(h.state.player.loopStart, 7);
      assert.equal(h.state.player.loopEnd, 19);
      assert.equal(h.owner('playerRestoreAttempt'), null);
      assert.equal(h.c.persistPlayerState(true), true);
      const persisted = JSON.parse(h.c.localStorage.getItem(SAVED));
      assert.equal(persisted.loop.start, 7);
      assert.equal(persisted.loop.end, 19);
      h.c.dispatchEvent(new h.c.Event('pageshow'));
      await h.flush();
      assert.strictEqual(h.state.player.current, successor);
      assert.equal(h.platform.contexts.length, 0);
    } finally { off(); }
  });
}

test('preview436: real setter partial-assignment void abort is not accepted as legacy isolated success', async t => {
  const h = await previewFixture(t), original = h.c.localStorage.getItem(SAVED);
  h.state.player.loopStart = 7;
  h.state.player.loopEnd = 19;
  let assigned;
  const off = h.queue.subscribe(() => {
    if (assigned || h.state.player.current?.path !== h.data.track.path) return;
    assigned = h.state.player.current;
    h.c.retirePlayerRestoreAttempt('queue-notification-abort');
  });
  try {
    h.c.restorePlayerState();
    assert.ok(assigned, 'actual setter reached assignment before abort');
    assert.strictEqual(h.state.player.current, assigned, 'exact input identity alone is not a successful receipt');
    assert.equal(h.owner('playerRestoreAttempt'), null);
    assert.equal(h.state.player.loopStart, 7);
    assert.equal(h.state.player.loopEnd, 19);
    assert.equal(h.c.persistPlayerState(true), false);
    assert.equal(h.c.localStorage.getItem(SAVED), original);
    h.c.dispatchEvent(new h.c.Event('pageshow'));
    await h.flush();
    assertNoStartup(h);
  } finally { off(); }
});

test('preview436: unclaimed paused prepared transport remains cold eligible without early replacement', async t => {
  const h = await previewFixture(t);
  const preparedWork = h.c.startStreamingTrack(track('PreparedOnly'), {startSeconds: 9, autoplay: false});
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  const prepared = await preparedWork;
  assert.ok(prepared);
  assert.equal(h.state.player.current, null);
  assert.equal(h.owner('playerSelectionOwnership'), null);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  const snapshot = plain(h.c.getPlayerPlaybackSnapshot()), context = h.engine().context;
  h.c.restorePlayerState();
  assertPreview(h);
  assert.strictEqual(h.engine().roles.current, prepared, 'preview cannot replace a prepared transport before pageshow');
  assert.strictEqual(h.engine().context, context);
  assert.deepEqual(plain(h.c.getPlayerPlaybackSnapshot()), snapshot);
  assert.equal(h.c.getPlayerDuration(), 181, 'prepared predecessor duration cannot contaminate cached metadata');
  h.c.dispatchEvent(new h.c.Event('pageshow'));
  await h.flush();
  await Promise.all(h.startupWork);
  await h.flush();
  assert.notStrictEqual(h.engine().roles.current, prepared);
  assert.equal(h.engine().roles.current.track.path, h.data.track.path);
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 33);
});

test('preview436: admitted manual playback and real listen owner survive stale cached startup', async t => {
  const h = await previewFixture(t), next = await start(h, track('ActiveManual'));
  assert.equal(await next.work, true);
  const current = h.state.player.current, role = h.engine().roles.current, handle = h.c.getActivePlaybackOwnershipHandle();
  const session = h.state.player.listenSession;
  assert.ok(session, 'real manual startup owns listening');
  const queue = {tracks: [current], currentIndex: 0};
  h.state.player.playbackQueue = queue;
  h.seed();
  const stored = h.c.localStorage.getItem(SAVED), baseline = h.writes().length;
  h.c.restorePlayerState();
  assert.strictEqual(h.state.player.current, current);
  assert.strictEqual(h.state.player.listenSession, session);
  assert.strictEqual(h.state.player.playbackQueue, queue);
  assert.strictEqual(h.engine().roles.current, role);
  assert.strictEqual(h.c.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(h.c.localStorage.getItem(SAVED), stored);
  assert.equal(h.writes().length, baseline);
  assert.equal(h.owner('playerRestoreAttempt'), null);
});

test('preview436: real foreign lock refuses preview publication rather than granting artwork or playback authority', async t => {
  const h = await previewFixture(t);
  h.c.localStorage.setItem(LEASE, JSON.stringify({tab_id: 'foreign-preview-owner', claim_revision: 91,
    status: 'playing', reason: 'manual_start', updated_at_ms: h.world.now(), expires_at_ms: h.world.now() + 15000}));
  assert.equal(h.c.isPlaybackLockedByAnotherTab(), true);
  const stored = h.c.localStorage.getItem(SAVED), lease = h.c.localStorage.getItem(LEASE);
  h.c.restorePlayerState();
  assert.equal(h.state.player.current, null);
  assert.equal(h.c.localStorage.getItem(SAVED), stored);
  assert.equal(h.c.localStorage.getItem(LEASE), lease);
  assert.equal(h.platform.contexts.length, 0);
  assert.equal(h.platform.images.length, 0);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
});

for (const lookup of ['album', 'setter-cover']) {
  test(`preview436: reentrant ${lookup} lookup preserves exact same-path successor and its loops`, async t => {
    const h = await previewFixture(t);
    h.data.track.coverPath = '';
    h.state.modalReleases = [{key: 'preview-lookup', name: h.data.track.album, artist: h.data.track.artist,
      cover_path: '/library/preview-art.jpg', tracks: [h.data.track]}];
    h.seed();
    const resolve = h.c.resolveAlbumForPlayerTrack;
    let calls = 0, successor;
    h.c.resolveAlbumForPlayerTrack = (...args) => {
      const album = resolve(...args);
      if (++calls === (lookup === 'album' ? 1 : 2)) {
        successor = {...h.data.track, title: 'Lookup successor', coverPath: '/library/successor-art.jpg'};
        h.c.setCurrentPlayerTrack(successor, {persist: false});
        h.state.player.loopStart = 7;
        h.state.player.loopEnd = 19;
      }
      return album;
    };
    try {
      h.c.restorePlayerState();
      assert.ok(successor, 'actual lookup crosses selected reentry boundary');
      assert.strictEqual(h.state.player.current, successor);
      assert.equal(h.state.player.loopStart, 7);
      assert.equal(h.state.player.loopEnd, 19);
      assert.equal(h.owner('playerRestoreAttempt'), null);
      assert.equal(h.c.persistPlayerState(true), true);
      h.c.dispatchEvent(new h.c.Event('pageshow'));
      await h.flush();
      assert.strictEqual(h.state.player.current, successor);
      assert.equal(h.platform.contexts.length, 0);
    } finally { h.c.resolveAlbumForPlayerTrack = resolve; }
  });
}

test('preview436: real setter void failure cannot become legacy success when restore guards recover', async t => {
  const h = await previewFixture(t), original = h.c.localStorage.getItem(SAVED);
  h.state.player.loopStart = 7;
  h.state.player.loopEnd = 19;
  const setter = h.c.setCurrentPlayerTrack, failures = [];
  const foreign = JSON.stringify({tab_id: 'transient-post-assignment-refusal', claim_revision: 91,
    status: 'playing', reason: 'manual_start', updated_at_ms: h.world.now(), expires_at_ms: h.world.now() + 15000});
  let assigned = null;
  const off = h.queue.subscribe(() => {
    if (assigned || h.state.player.current?.path !== h.data.track.path) return;
    assigned = h.state.player.current;
    // Real storage changes the real setter's post-assignment lock predicate;
    // do not retire restore, alter its guard, or replace the publication owner.
    h.c.localStorage.setItem(LEASE, foreign);
  });
  h.c.setCurrentPlayerTrack = (input, options) => {
    const attempt = h.owner('playerRestoreAttempt');
    const result = setter(input, options);
    if (assigned === input && h.c.localStorage.getItem(LEASE) === foreign) {
      h.c.localStorage.removeItem(LEASE);
      failures.push({result, input, installed: h.state.player.current,
        sameAttempt: h.owner('playerRestoreAttempt') === attempt,
        restoreCurrent: h.c.currentPlayerRestoreAttempt(attempt),
        setterGuardCurrent: options.isCurrent()});
    }
    return result;
  };
  try {
    h.c.restorePlayerState();
    assert.equal(failures.length, 1, 'actual setter reached transient post-assignment refusal');
    assert.equal(failures[0].result, undefined, 'failed actual setter produced no canonical receipt');
    assert.strictEqual(failures[0].input, assigned);
    assert.strictEqual(failures[0].installed, assigned, 'exact original input remains installed');
    assert.equal(failures[0].sameAttempt, true);
    assert.equal(failures[0].restoreCurrent, true, 'restore guard was current when actual void result returned');
    assert.equal(failures[0].setterGuardCurrent, true);
    assert.strictEqual(h.state.player.current, assigned);
    assert.equal(h.state.player.loopStart, 7);
    assert.equal(h.state.player.loopEnd, 19);
    assert.equal(h.c.persistPlayerState(true), false, 'failed publication remains unadmitted and serialization-protected');
    assert.equal(h.c.localStorage.getItem(SAVED), original);
    assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
    assert.deepEqual(h.writes(), []);
    h.c.dispatchEvent(new h.c.Event('pageshow'));
    await h.flush();
    assertNoStartup(h);
  } finally {
    off();
    h.c.setCurrentPlayerTrack = setter;
    if (h.c.localStorage.getItem(LEASE) === foreign) h.c.localStorage.removeItem(LEASE);
  }
});

for (const invalidation of ['restore-retirement', 'scope-invalidation']) {
  test(`preview436: preassignment lock reentry ${invalidation} cannot publish a stale preview`, async t => {
    const h = await previewFixture(t), original = h.c.localStorage.getItem(SAVED);
    const setter = h.c.setCurrentPlayerTrack, elements = h.c.getPlayerElements;
    const locked = h.c.isPlaybackLockedByAnotherTab;
    const observations = [], publications = [];
    let insideSetter = false, armed = false, injected = false, result;
    const off = h.queue.subscribe(() => {
      if (h.state.player.current?.path === h.data.track.path) publications.push(h.state.player.current);
    });
    h.c.setCurrentPlayerTrack = (input, options) => {
      insideSetter = true;
      try { result = setter(input, options); return result; }
      finally { insideSetter = false; armed = false; }
    };
    h.c.getPlayerElements = (...args) => {
      const value = elements(...args);
      // The actual setter reads its elements after its entry guard. Arm the
      // next real lock evaluation, rather than choosing an incidental ordinal.
      if (insideSetter && !injected) armed = true;
      return value;
    };
    h.c.isPlaybackLockedByAnotherTab = (...args) => {
      const value = locked(...args);
      if (insideSetter && armed && !injected) {
        injected = true;
        armed = false;
        const attempt = h.owner('playerRestoreAttempt');
        const before = h.c.currentPlayerRestoreAttempt(attempt);
        if (invalidation === 'restore-retirement') {
          h.c.retirePlayerRestoreAttempt('lock-predicate-reentry');
        } else {
          h.change('actor', '');
          h.c.capturePlaybackOwnershipScope();
        }
        observations.push({locked: value, before, after: h.c.currentPlayerRestoreAttempt(attempt)});
      }
      return value;
    };
    try {
      h.c.restorePlayerState();
      assert.equal(injected, true, 'actual setter reached the post-entry lock predicate');
      assert.deepEqual(observations, [{locked: false, before: true, after: false}],
        'same unlocked result now belongs to a retired caller; no successor setter ran');
      assert.equal(result, undefined);
      assert.equal(h.state.player.current, null, 'lock callback invalidation prevents the original assignment');
      assert.deepEqual(publications, [], 'no stale currentChanged notification may escape');
      assert.equal(h.owner('playerRestoreAttempt'), null);
      assert.equal(h.c.localStorage.getItem(SAVED), original);
      assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
      assert.deepEqual(h.writes(), []);
      assert.equal(h.platform.images.length, 0);
      h.c.dispatchEvent(new h.c.Event('pageshow'));
      await h.flush();
      assertNoStartup(h);
    } finally {
      off();
      h.c.setCurrentPlayerTrack = setter;
      h.c.getPlayerElements = elements;
      h.c.isPlaybackLockedByAnotherTab = locked;
    }
  });
}

for (const invalidation of ['restore-retirement', 'scope-invalidation']) {
  test(`preview436: final preassignment lock reentry ${invalidation} cannot publish a stale preview`, async t => {
    const h = await previewFixture(t);
    h.data.track.coverPath = '';
    h.state.modalReleases = [{key: 'final-lock-cover', name: h.data.track.album, artist: h.data.track.artist,
      cover_path: '/library/final-lock-cover.jpg', tracks: [h.data.track]}];
    h.seed();
    const original = h.c.localStorage.getItem(SAVED), writeCount = h.writes().length;
    const setter = h.c.setCurrentPlayerTrack, resolve = h.c.resolveAlbumForPlayerTrack;
    const locked = h.c.isPlaybackLockedByAnotherTab;
    const observations = [], publications = [];
    let insideSetter = false, armed = false, injected = false, lookupReturned = false, result;
    const off = h.queue.subscribe(() => {
      if (h.state.player.current?.path === h.data.track.path) publications.push(h.state.player.current);
    });
    h.c.setCurrentPlayerTrack = (input, options) => {
      insideSetter = true;
      try { result = setter(input, options); return result; }
      finally { insideSetter = false; armed = false; }
    };
    h.c.resolveAlbumForPlayerTrack = (...args) => {
      const value = resolve(...args);
      // Restore also resolves albums before calling setter. Only the actual
      // setter's cover lookup arms its final preassignment currentness check.
      if (insideSetter && !injected) { lookupReturned = true; armed = true; }
      return value;
    };
    h.c.isPlaybackLockedByAnotherTab = (...args) => {
      const value = locked(...args);
      if (insideSetter && armed && !injected) {
        injected = true;
        armed = false;
        const attempt = h.owner('playerRestoreAttempt');
        const before = h.c.currentPlayerRestoreAttempt(attempt);
        if (invalidation === 'restore-retirement') h.c.retirePlayerRestoreAttempt('final-lock-reentry');
        else { h.change('actor', ''); h.c.capturePlaybackOwnershipScope(); }
        observations.push({locked: value, before, after: h.c.currentPlayerRestoreAttempt(attempt),
          installedAtLock: h.state.player.current});
      }
      return value;
    };
    try {
      h.c.restorePlayerState();
      assert.equal(lookupReturned, true, 'actual setter cover lookup completed before final guard');
      assert.equal(injected, true);
      assert.deepEqual(observations, [{locked: false, before: true, after: false, installedAtLock: null}],
        'final lock callback retires a still-unpublished caller without a replacement setter');
      assert.equal(result, undefined);
      assert.equal(h.state.player.current, null, 'final guard must recheck caller after lock callback before assignment');
      assert.deepEqual(publications, [], 'stale preview must never reach currentChanged subscribers');
      assert.equal(h.owner('playerRestoreAttempt'), null);
      assert.equal(h.c.localStorage.getItem(SAVED), original);
      assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
      assert.equal(h.writes().length, writeCount);
      assert.equal(h.platform.images.length, 0);
      h.c.dispatchEvent(new h.c.Event('pageshow'));
      await h.flush();
      assertNoStartup(h);
    } finally {
      off();
      h.c.setCurrentPlayerTrack = setter;
      h.c.resolveAlbumForPlayerTrack = resolve;
      h.c.isPlaybackLockedByAnotherTab = locked;
    }
  });
}

for (const lifecycle of ['pending', 'admitted', 'active-editor', 'retired', 'same-object-successor']) {
  test(`preview436 range: ${lifecycle} publication selects only its owned absolute-range reconciliation`, async t => {
    const fixtureWorld = world();
    if (lifecycle === 'active-editor') {
      const createTab = fixtureWorld.createTab;
      fixtureWorld.createTab = (...args) => {
        const platform = createTab(...args), install = platform.install;
        platform.install = environment => {
          // Actual server bootstrap input before core state initializes. Do not
          // overwrite the permission owner or force loopActive in runtime.
          environment.c.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__ = {'library.loops.create': true};
          install(environment);
        };
        return platform;
      };
    }
    const h = await previewFixture(t, {fixtureWorld});
    if (lifecycle === 'admitted' || lifecycle === 'active-editor') {
      h.data.paused = true;
      h.seed();
    }
    h.c.restorePlayerState();
    assertPreview(h);
    if (lifecycle === 'admitted' || lifecycle === 'active-editor') {
      await h.flush();
      for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
      await Promise.all(h.startupWork);
      await h.flush();
      assert.ok(h.engine().roles.current);
      assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
    }
    if (lifecycle === 'active-editor') {
      assert.equal(h.state.loopCreateAllowed, true, 'actual bootstrap grants editing before owner initialization');
      h.c.setLoopActive(true);
      assert.equal(h.state.player.loopActive, true, 'enter editing through the actual owner');
    }
    if (lifecycle === 'retired') h.c.retirePlayerRestoreAttempt('range-policy-retirement');
    if (lifecycle === 'same-object-successor') {
      const same = h.state.player.current;
      h.c.setCurrentPlayerTrack(same, {persist: false});
      assert.strictEqual(h.state.player.current, same);
      assert.equal(h.owner('playerRestoreAttempt'), null);
    }
    const controller = h.c.getPlayerElements().loopRange._loopRangeController;
    const render = controller.render, observed = [];
    controller.render = (range, options) => {
      observed.push(options?.preserveAbsoluteRange === true);
      return render(range, options);
    };
    try {
      h.c.updatePlayerUi();
      assert.deepEqual(observed, [lifecycle === 'pending' || lifecycle === 'admitted'],
        'only exact live inactive restore publication may bypass ordinary fractional scaling');
    } finally { controller.render = render; }
  });
}
