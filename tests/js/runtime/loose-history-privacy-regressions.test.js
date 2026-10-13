// Additive R3 regression coverage of actual history-writing owners. These are
// focused JS units with synthetic network/DOM and a structured-cloning history
// seam, not browserfixture, Playwright, production, authentication or DB proof.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {
  browsePayload, looseRow, overlay, outcome, settle,
} = require('./loose-authority-harness.cjs');
const {
  createHistoryFixture, historyPayload, captureLiveReceipt,
  assertNoPrivatePreferenceMetadata, assertDisplayPreserved,
} = require('./loose-history-privacy-harness.cjs');

function assertSerializedView(write, payload, mode) {
  assert.equal(write.mode, mode);
  assertNoPrivatePreferenceMetadata(write.snapshot);
  assertDisplayPreserved(write.snapshot, payload);
  assert.notEqual(write.snapshot.non_album_tracks[0], payload.non_album_tracks[0],
    'the native history seam must store a structured clone');
}

for (const settings of [false, true]) {
  test(`R3 foreground browse pushes only display history through ${settings ? 'installed Settings' : 'the real browser fallback'}`, async () => {
    const f = createHistoryFixture({settings}), payload = historyPayload(301);
    await f.browseAndPush(payload);
    assert.equal(f.historyWrites.length, 1, 'the actual foreground browse must reach the real history owner once');
    assert.equal(f.state.view, payload);
    assert.equal(f.state.view.non_album_tracks[0], payload.non_album_tracks[0]);
    assert.equal(f.batches.length, 1);
    assert.equal(f.source(payload.non_album_tracks[0]), f.batches[0].sources[0],
      'history serialization must preserve the exact receipt admitted before the history write');
    assert.equal(f.preference(payload.non_album_tracks[0]).love_tier, 'obsessed');
    assert.equal(f.preference(payload.non_album_tracks[0]).allowed_actions.can_set_love_tier, true);
    assert.ok(Object.isFrozen(payload.non_album_tracks[0]));
    assertSerializedView(f.historyWrites[0], payload, 'push');
    if (settings) assert.equal(f.historyWrites[0].snapshot.albumHavenNavigationPosition, 1);
  });
}

for (const mode of ['push', 'replace']) {
  test(`R3 installed Settings ${mode} handles nested and aliased snapshots without touching live receipts`, async () => {
    const f = createHistoryFixture({settings: true}), payload = historyPayload(302);
    await f.load(payload);
    const unchanged = captureLiveReceipt(f, payload);
    const snapshot = {view: payload, restored: {view: payload}, selection: payload.selection,
      navigation: payload.navigation, scroll: {top: 144, left: 9}};
    const before = structuredClone(snapshot);
    f.browser.AlbumHavenSettingsNavigation.instance.writeLibraryHistory('/?surface=albums', snapshot, {mode});
    unchanged();
    assert.deepEqual(structuredClone(snapshot), before, 'the caller-owned snapshot is not mutated');
    assert.equal(f.historyWrites.length, 1);
    const write = f.historyWrites[0];
    assert.equal(write.mode, mode);
    assertNoPrivatePreferenceMetadata(write.snapshot);
    assertDisplayPreserved(write.snapshot.view, payload);
    assertDisplayPreserved(write.snapshot.restored.view, payload);
    assert.deepEqual(write.snapshot.selection, structuredClone(payload.selection));
    assert.deepEqual(write.snapshot.navigation, structuredClone(payload.navigation));
    assert.deepEqual(write.snapshot.scroll, {top: 144, left: 9});
    assert.equal(write.snapshot.albumHavenNavigationPosition, mode === 'push' ? 1 : 0);
  });
}

test('R3 Settings initialization replaces legacy history without reserializing private preference metadata', async () => {
  const f = createHistoryFixture(), payload = historyPayload(303);
  await f.load(payload);
  f.seedHistoryState(payload);
  const unchanged = captureLiveReceipt(f, payload);
  f.installSettings();
  unchanged();
  assert.equal(f.historyWrites.length, 1);
  assertSerializedView(f.historyWrites[0], payload, 'replace');
  assert.equal(f.historyWrites[0].snapshot.albumHavenNavigationPosition, 0);
});

for (const settings of [false, true]) {
  for (const mode of ['push', 'replace']) {
    test(`R3 mobile ${mode}, Settings=${settings}, strips nested private rows and preserves existing page descriptors`, async () => {
      const f = createHistoryFixture({settings}), payload = historyPayload(304);
      await f.load(payload);
      f.seedHistoryState({...payload, albumHavenNavigationPosition: 4});
      f.installMobile();
      const unchanged = captureLiveReceipt(f, payload);
      const descriptor = {
        kind: 'non-album', albumKey: '', title: 'Non-album tracks', subtitle: 'Fixture Artist',
        sourcePageToken: 'existing-source-page-navigation-token',
        selection: {rowKeys: ['existing-mobile-row'], anchor: 'existing-mobile-row'},
        retainedView: payload,
      };
      assert.equal(f.context.presentMobilePage(descriptor), true, 'the actual mobile presentation owner must install its descriptor');
      if (mode === 'replace') {
        // Model an older persisted entry returned by the native browser. A
        // replacement must sanitize it even after a prior clean mobile push.
        f.seedHistoryState({...payload, albumHavenNavigationPosition: 4});
        f.historyWrites.length = 0;
        f.context.writeMobilePageHistory('replace');
      }
      unchanged();
      assert.equal(descriptor.retainedView, payload, 'the live mobile descriptor retains the original view');
      assert.equal(f.historyWrites.length, 1);
      const write = f.historyWrites[0];
      assertSerializedView(write, payload, mode);
      assert.equal(new URL(write.url).searchParams.get('mobile_page'), 'non-album');
      const storedPage = write.snapshot.mobilePages[0];
      assert.equal(storedPage.kind, 'non-album');
      assert.equal(storedPage.title, descriptor.title);
      assert.equal(storedPage.subtitle, descriptor.subtitle);
      assert.equal(storedPage.sourcePageToken, descriptor.sourcePageToken,
        'existing page navigation tokens are not personal preference receipts');
      assert.deepEqual(storedPage.selection, descriptor.selection);
      assert.equal(storedPage.parentPosition, 4);
      assert.equal(storedPage.parentViewUrl, descriptor.parentViewUrl);
      assertDisplayPreserved(storedPage.retainedView, payload);
    });
  }
}

test('R3 the real tag-save search restoration replacement sanitizes merged history after its genuine browse refresh', async () => {
  const f = createHistoryFixture(), first = historyPayload(305, {query: 'split search'});
  await f.load(first);
  f.seedHistoryState({...first, scroll: {top: 72}, albumHavenNavigationPosition: 8});
  f.loadRuntime('tag-editor-and-optimistic-updates.js');
  f.loadRuntime('utility-list-builders.js');
  const fresh = historyPayload(305, {query: 'split search', selected_artist: '', all_artists_active: true});
  const initialRequests = f.requests.length, initialBatches = f.batches.length;
  const originalAlbum = {key: 'original-release', name: 'Release', album_artist: 'Original Artist',
    tracks: [{path: '/synthetic/history/original.flac'}]};
  const pending = outcome(f.context.watchSaveTask('history-privacy-save-task', {
    originalAlbum,
    problematicMutationOriginKey: '',
    originatingViewRequestUrl: '/view-data?surface=albums&query=split%20search',
    originatingSearchContext: {selected_artist_source: 'auto_top_match', artist_name_match_artists: []},
    optimisticAlbums: [{album_artist: 'Original Artist'}, {album_artist: 'Split Artist'}],
    tagEdits: {'/synthetic/history/original.flac': {album_artist: 'Split Artist'}},
    terminalPayload: {ok: true, task_id: 'history-privacy-save-task', status: 'completed',
      requires_view_refresh: true, updated_albums: []},
  }));
  await settle();
  assert.equal(f.requests.length, initialRequests + 1, 'the real watch owner must dispatch its canonical browse refresh');
  f.respond(initialRequests, fresh);
  const result = await pending;
  assert.ifError(result.error);
  assert.deepEqual(f.warnings, [], 'the intended owner path must not succeed via a caught setup or refresh failure');
  assert.equal(f.historyWrites.length, 1, 'the direct utility replacement branch must actually execute');
  assert.equal(f.batches.length, initialBatches + 1, 'only the genuine replacement browse read admits a batch');
  assert.equal(f.state.view, fresh);
  assert.equal(f.source(fresh.non_album_tracks[0]), f.batches.at(-1).sources[0]);
  assert.equal(f.preference(fresh.non_album_tracks[0]).love_tier, 'obsessed');
  assertSerializedView(f.historyWrites[0], fresh, 'replace');
  assert.deepEqual(f.historyWrites[0].snapshot.scroll, {top: 72});
  assert.equal(f.historyWrites[0].snapshot.albumHavenNavigationPosition, 8);
});

test('R3 stored history is unknown and unwritable until a genuine fresh read, while the exact live row keeps its receipt', async () => {
  const f = createHistoryFixture({settings: true}), payload = historyPayload(306);
  await f.load(payload);
  const liveAdapter = f.prepare(payload);
  assert.equal(liveAdapter.runtime.trackPreference(liveAdapter.rows[0], liveAdapter.context).love_tier, 'obsessed');
  const unchanged = captureLiveReceipt(f, payload);
  f.context.pushBrowserViewState(payload, payload);
  unchanged();
  assert.equal(liveAdapter.runtime.trackPreference(liveAdapter.rows[0], liveAdapter.context).allowed_actions.can_set_love_tier, true);
  const stored = f.historyWrites[0].snapshot, restoredRow = stored.non_album_tracks[0];
  assert.notEqual(restoredRow, payload.non_album_tracks[0]);
  assert.equal(f.source(restoredRow), null, 'structured cloning never copies the private exact-object receipt');
  const restoredAdapter = f.prepare(stored), before = f.requests.length, batches = f.batches.length;
  assert.equal(restoredAdapter.runtime.trackPreference(restoredAdapter.rows[0], restoredAdapter.context), null);
  await assert.rejects(restoredAdapter.runtime.setTrackLove({row: restoredAdapter.rows[0],
    context: restoredAdapter.context, love_tier: 'loved'}));
  assert.equal(f.requests.length, before, 'history restore must never send a preference command');
  assert.equal(f.batches.length, batches, 'history restore must never mint admission');
  const freshRow = looseRow(306, {track_preference: overlay('loved')});
  await f.load(browsePayload([freshRow]));
  const freshAdapter = f.prepare();
  assert.equal(freshAdapter.runtime.trackPreference(freshAdapter.rows[0], freshAdapter.context).love_tier, 'loved');
  assert.equal(freshAdapter.runtime.trackPreference(freshAdapter.rows[0], freshAdapter.context).allowed_actions.can_set_love_tier, true);
  assert.equal(f.batches.length, batches + 1);
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.source(restoredRow), null, 'fresh authority belongs to the fresh row, never to the old history copy');
});
