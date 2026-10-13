// Genuine whole-source browse ownership units, with deferred network responses.
// No direct receipt injection and no renderer can manufacture read authority.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome, settle} = require('./loose-authority-harness.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const baseUrl = '/view-data?surface=albums&gallery_page_size=50';
const page = (rows, {start = 0, count = 50, revision = 'r1', cursor = 'next', hasMore = true} = {}) =>
  browsePayload(rows, {artist_groups: [{artist: 'Fixture Artist', albums: Array.from({length: count}, (_, i) => ({key: `album:${start + i}`}))}],
    gallery_page: {revision, next_cursor: cursor, has_more: hasMore}});
function loadedCoverage(f, count = 100) {f.state.view = page([], {count, cursor: 'loaded-next'});}
async function requireKnown(f, value = browsePayload()) {
  await f.load(value); assert.ok(f.source(value.non_album_tracks[0]), 'Only the real successful browse dispatch may establish the row receipt');
  return value;
}
async function advanceEpochThroughAlbumRead(f) {
  const value = looseRow(991, {track_preference: overlay('loved', false)});
  const before = f.runtime.readEpoch(), index = f.requests.length;
  const pending = f.context.fetchTrackModalAlbumDetails('independent-epoch-marker');
  f.respond(index, {ok: true, album: {key: 'independent-epoch-marker', tracks: [value]}});
  await pending;
  assert.ok(f.runtime.readEpoch() > before, 'A genuine independent read-only Album receipt advances authority epoch');
}

for (const [label, url, patch, options] of [
  ['initial startup', '/view-data?surface=albums&payload_tier=initial', {initial_view_partial: true, payload_tier: 'initial'}, {startupRefresh: true}],
  ['full root', '/view-data?surface=albums', {}, {}],
  ['selected artist', '/view-data?surface=albums&artist=Fixture', {selected_artist: 'Fixture'}, {}],
  ['search', '/view-data?surface=albums&q=Loose', {query: 'Loose'}, {}],
]) {
  test(`${label} browse admits surviving exact Loose objects once at its original dispatch epoch`, async () => {
    const f = createLooseAuthorityFixture(), rows = [looseRow(11), looseRow(12, {track_preference: overlay('obsessed')})];
    const data = browsePayload(rows, patch), epoch = f.runtime.readEpoch();
    const pending = f.read(url, options);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].dispatchEpoch, epoch);
    assert.equal(f.batches.length, 0); assert.equal(f.source(rows[0]), null);
    f.respond(0, data); const result = await pending;
    assert.ifError(result.error); assert.equal(result.value, true);
    assert.equal(f.applied.length, 1); assert.equal(f.state.view.non_album_tracks[0], rows[0]);
    assert.equal(f.batches.length, 1, 'The accepted browse response owns exactly one preference read batch');
    assert.equal(f.batches[0].epoch, epoch);
    assert.deepEqual(f.batches[0].sources.map(source => source.track_ref), rows.map(row => row.path));
    assert.deepEqual(rows.map(row => f.preference(row)?.love_tier), ['off', 'obsessed']);
    assert.equal(f.source(clone(rows[0])), null, 'JSON data copying cannot transfer a private receipt');
  });
}

for (const changed of ['actor', 'library', 'transport', 'inventory', 'tag edit', 'view revision', 'abort']) {
  test(`In-flight ${changed} replacement cannot admit returned Loose authority`, async () => {
    const f = createLooseAuthorityFixture(), data = browsePayload();
    const pending = f.read();
    if (changed === 'actor') f.shell.dataset.nativeAccountId = '8';
    if (changed === 'library') f.shell.dataset.nativeLibraryId = '10';
    if (changed === 'transport') f.changeSession();
    if (changed === 'inventory') f.state.status.inventory_mutation_revision++;
    if (changed === 'tag edit') f.state.ui.tagEditOptimisticMutationRevision = 1;
    if (changed === 'view revision') f.state.ui.viewStateRevision = 1;
    if (changed === 'abort') f.state.ui.activeViewRequestController.abort();
    f.respond(0, data); await pending;
    assert.equal(f.source(data.non_album_tracks[0]), null);
    assert.equal(f.preference(data.non_album_tracks[0]), null);
  });
}

for (const reject of [() => false, () => {throw new Error('Ownership lost');}]) {
  test(`shouldApplyResponse ${reject.toString().includes('throw') ? 'failure' : 'rejection'} never admits a discarded Loose response`, async () => {
    const f = createLooseAuthorityFixture(), data = browsePayload();
    const result = f.read(undefined, {shouldApplyResponse: reject}); f.respond(0, data);
    assert.equal((await result).value, false); assert.equal(f.applied.length, 0);
    assert.equal(f.batches.length, 0); assert.equal(f.source(data.non_album_tracks[0]), null);
  });
}

test('An obsolete retained Playlist draft rejects its completed ordinary browse response before admission', async () => {
  const f = createLooseAuthorityFixture(), draft = {}, data = browsePayload(); let current = true;
  f.context.window.AlbumHavenSettingsNavigation = {instance: {isPlaylistDraftCurrent: value => value === draft && current}};
  const pending = f.read(undefined, {retainedPlaylistDraft: draft}); current = false;
  f.respond(0, data); assert.equal((await pending).value, false);
  assert.equal(f.batches.length, 0); assert.equal(f.source(data.non_album_tracks[0]), null);
});

test('A completed pre-denial read cannot get a replacement epoch when its response is applied', async () => {
  const f = createLooseAuthorityFixture(), original = await requireKnown(f);
  const stale = browsePayload([looseRow(11)]), pending = f.read();
  const dispatchEpoch = f.requests[1].dispatchEpoch;
  await advanceEpochThroughAlbumRead(f);
  f.respond(1, stale); await pending;
  assert.equal(f.source(stale.non_album_tracks[0]), null);
  const looseBatches = f.batches.filter(batch => batch.sources.some(source => source.track_ref === stale.non_album_tracks[0].path));
  assert.ok(looseBatches.length >= 1);
  assert.equal(looseBatches.at(-1).epoch, dispatchEpoch, 'No completion-time epoch restamping');
  assert.ok(f.source(original.non_album_tracks[0]), 'Unrelated read-only Album change does not revoke an existing Loose source token');
});

test('Retained selected-view sidebar refresh neither admits discarded Loose rows nor restamps retained rows', async () => {
  const f = createLooseAuthorityFixture(), original = await requireKnown(f, browsePayload([looseRow(11)], {selected_artist: 'Fixture'}));
  const source = f.source(original.non_album_tracks[0]), before = f.batches.length;
  const replacement = browsePayload([looseRow(11, {track_preference: overlay('obsessed')}), looseRow(12)],
    {artists_sidebar: [{name: 'New sidebar entry'}], artist_count: 20});
  const pending = f.read('/view-data?surface=albums&root_sidebar=1', {retainMountedSelectedViewState: original});
  f.respond(1, replacement); const result = await pending;
  assert.ifError(result.error); assert.equal(result.value, true);
  assert.equal(f.state.view.non_album_tracks[0], original.non_album_tracks[0]);
  assert.equal(f.state.view.artists_sidebar, replacement.artists_sidebar);
  assert.equal(f.source(original.non_album_tracks[0]), source); assert.equal(f.preference(original.non_album_tracks[0]).love_tier, 'off');
  assert.equal(f.batches.length, before);
  assert.ok(replacement.non_album_tracks.every(row => f.source(row) === null));
});

test('Retained bootstrap/JSON rows remain unknown when a real response only contributes sidebar fields', async () => {
  const f = createLooseAuthorityFixture(), retained = browsePayload(); f.state.view = retained;
  const response = browsePayload([looseRow(22)]);
  const pending = f.read('/view-data?surface=albums&root_sidebar=1', {retainMountedSelectedViewState: retained});
  f.respond(0, response); assert.equal((await pending).value, true);
  assert.equal(f.batches.length, 0); assert.equal(f.source(retained.non_album_tracks[0]), null);
  assert.equal(f.source(response.non_album_tracks[0]), null);
});

for (const status of [401, 403]) {
  test(`Current HTTP ${status} revokes retained Loose receipts and notifies mounted subscribers`, async () => {
    const f = createLooseAuthorityFixture(), original = await requireKnown(f); let notifications = 0;
    const unsubscribe = f.context.subscribeTrackModalPreferences(() => {notifications++;});
    const pending = f.read(); f.respond(1, {ok: false, error: 'Denied'}, status);
    assert.ok((await pending).error); assert.equal(f.source(original.non_album_tracks[0]), null);
    assert.ok(notifications > 0); unsubscribe();
  });
}

test('Superseded delayed 403 cannot revoke a newer successfully applied Loose source', async () => {
  const f = createLooseAuthorityFixture(), original = await requireKnown(f);
  const obsolete = f.read('/view-data?surface=albums&artist=Old');
  const replacement = browsePayload([looseRow(12)], {selected_artist: 'New'});
  const fresh = f.read('/view-data?surface=albums&artist=New');
  f.respond(2, replacement); assert.equal((await fresh).value, true);
  assert.ok(f.source(replacement.non_album_tracks[0]));
  f.respond(1, {ok: false, error: 'Delayed denial'}, 403); await obsolete;
  assert.ok(f.source(replacement.non_album_tracks[0]), 'Only the still-current read owner may revoke its source');
  assert.equal(f.source(clone(original.non_album_tracks[0])), null);
});

for (const failure of ['network', 'server', 'abort']) {
  test(`${failure} failure creates no Off and preserves an unchanged valid retained Loose receipt`, async () => {
    const f = createLooseAuthorityFixture(), original = await requireKnown(f), source = f.source(original.non_album_tracks[0]);
    const pending = f.read();
    if (failure === 'server') f.respond(1, {ok: false, error: 'Temporary problem'}, 500);
    else f.requests[1].reject(Object.assign(new Error(failure), failure === 'abort' ? {name: 'AbortError'} : {}));
    await pending; assert.equal(f.source(original.non_album_tracks[0]), source);
    assert.equal(f.preference(original.non_album_tracks[0]).love_tier, 'off');
  });
}

for (const patch of [{read_only_subject: 'subject:other'}, {source_readable: false}, {allowed_actions: {can_read: false}},
  {surface: {active: 'playlists'}}, {surface: {active: 'album_tops'}}]) {
  test(`Subject, denied or separately owned payload cannot establish own Loose receipt: ${JSON.stringify(patch)}`, async () => {
    const f = createLooseAuthorityFixture(), data = browsePayload([looseRow()], patch);
    await f.load(data); assert.equal(f.source(data.non_album_tracks[0]), null);
  });
}

test('Current explicit source-read denial invalidates old receipt despite copied grant fields', async () => {
  const f = createLooseAuthorityFixture(), original = await requireKnown(f);
  const denied = browsePayload([looseRow()], {source_readable: false});
  await f.load(denied);
  assert.equal(f.source(original.non_album_tracks[0]), null); assert.equal(f.source(denied.non_album_tracks[0]), null);
});

test('Ordinary gallery continuation discards incoming Loose rows without any admission', async () => {
  const f = createLooseAuthorityFixture(), original = page([looseRow(11)]);
  await requireKnown(f, original); const source = f.source(original.non_album_tracks[0]), before = f.batches.length;
  const response = page([looseRow(22)], {start: 50, hasMore: false, cursor: null});
  const pending = f.context.loadNextRootGalleryPage(); assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /gallery_cursor=next/); f.respond(1, response);
  assert.equal(await pending, true); assert.equal(f.state.view.non_album_tracks[0], original.non_album_tracks[0]);
  assert.equal(f.batches.length, before); assert.equal(f.source(response.non_album_tracks[0]), null);
  assert.equal(f.source(original.non_album_tracks[0]), source);
});

test('409 continuation replacement uses its own pre-dispatch epoch and only replacement Loose rows', async () => {
  const f = createLooseAuthorityFixture(), original = page([looseRow(11)]); await requireKnown(f, original);
  const pending = f.context.loadNextRootGalleryPage(); const continuationEpoch = f.requests[1].dispatchEpoch;
  await advanceEpochThroughAlbumRead(f);
  f.respond(1, {ok: false, restart_required: true}, 409); await settle();
  assert.equal(f.requests.length, 4); const restart = f.requests[3];
  assert.ok(restart.dispatchEpoch > continuationEpoch); assert.doesNotMatch(restart.url, /gallery_cursor|omit_sidebar/);
  const replacement = page([looseRow(22)], {revision: 'r2', hasMore: false, cursor: null});
  f.respond(3, replacement); assert.equal(await pending, true);
  assert.equal(f.state.view.non_album_tracks[0], replacement.non_album_tracks[0]); assert.ok(f.source(replacement.non_album_tracks[0]));
  const accepted = f.batches.filter(batch => batch.sources.some(source => source.track_ref === replacement.non_album_tracks[0].path));
  assert.equal(accepted.length, 1); assert.equal(accepted[0].epoch, restart.dispatchEpoch);
});

test('Refresh collector preserves initial Loose packet and admits once only after all pages settle', async () => {
  const f = createLooseAuthorityFixture(); loadedCoverage(f);
  const initial = page([looseRow(11)]), continuation = page([looseRow(22)], {start: 50, hasMore: false, cursor: null});
  const pending = f.read(baseUrl, {preserveScroll: true}); const epoch = f.requests[0].dispatchEpoch;
  f.respond(0, initial); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.batches.length, 0); assert.equal(f.source(initial.non_album_tracks[0]), null);
  f.respond(1, continuation); assert.equal((await pending).value, true);
  assert.equal(f.state.view.artist_groups[0].albums.length, 100);
  assert.equal(f.state.view.non_album_tracks[0], initial.non_album_tracks[0]);
  assert.ok(f.source(initial.non_album_tracks[0])); assert.equal(f.source(continuation.non_album_tracks[0]), null);
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].epoch, epoch);
});

test('Refresh collector cannot stamp surviving initial rows with a post-continuation epoch', async () => {
  const f = createLooseAuthorityFixture(); loadedCoverage(f);
  const initial = page([looseRow(11)]), pending = f.read(baseUrl, {preserveScroll: true});
  const epoch = f.requests[0].dispatchEpoch; f.respond(0, initial); await settle();
  await advanceEpochThroughAlbumRead(f);
  f.respond(1, page([looseRow(22)], {start: 50, hasMore: false, cursor: null}));
  assert.equal((await pending).value, true); assert.equal(f.source(initial.non_album_tracks[0]), null);
  const attempted = f.batches.filter(batch => batch.sources.some(source => source.track_ref === initial.non_album_tracks[0].path));
  assert.ok(attempted.length <= 1);
  if (attempted.length) assert.equal(attempted[0].epoch, epoch, 'A rejected old epoch stays old; it cannot be refreshed at assembly');
});

test('Refresh collector restart discards initial/continuation Loose and preserves replacement provenance', async () => {
  const f = createLooseAuthorityFixture(); loadedCoverage(f);
  const initial = page([looseRow(11)]), pending = f.read(baseUrl, {preserveScroll: true});
  f.respond(0, initial); await settle(); await advanceEpochThroughAlbumRead(f);
  f.respond(1, {ok: false, restart_required: true}, 409); await settle();
  const replacement = page([looseRow(22)], {revision: 'r2'}), restartIndex = 3;
  const restartEpoch = f.requests[restartIndex].dispatchEpoch;
  f.respond(restartIndex, replacement); await settle();
  const discardedContinuation = page([looseRow(33)], {start: 50, revision: 'r2', hasMore: false, cursor: null});
  f.respond(4, discardedContinuation); assert.equal((await pending).value, true);
  assert.equal(f.state.view.non_album_tracks[0], replacement.non_album_tracks[0]);
  assert.ok(f.source(replacement.non_album_tracks[0])); assert.equal(f.source(initial.non_album_tracks[0]), null);
  assert.equal(f.source(discardedContinuation.non_album_tracks[0]), null);
  const accepted = f.batches.filter(batch => batch.sources.some(source => source.track_ref === replacement.non_album_tracks[0].path));
  assert.equal(accepted.length, 1); assert.equal(accepted[0].epoch, restartEpoch);
});

test('Refresh collector ownership loss after initial success prevents all Loose admission', async () => {
  const f = createLooseAuthorityFixture(); loadedCoverage(f);
  const initial = page([looseRow(11)]), pending = f.read(baseUrl, {preserveScroll: true});
  f.respond(0, initial); await settle(); f.state.ui.tagEditOptimisticMutationRevision = 1;
  f.respond(1, page([looseRow(22)], {start: 50, hasMore: false, cursor: null}));
  assert.equal((await pending).value, false); assert.equal(f.batches.length, 0);
  assert.equal(f.source(initial.non_album_tracks[0]), null); assert.equal(f.applied.length, 0);
});
