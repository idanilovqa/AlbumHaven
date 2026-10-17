// R2 supplement: an accepted full replacement retires the previous exact
// population even when no invalid row is present to trigger a per-row denial.
// Whole fetch/cache/native owners are real; transport and paint are unit seams.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {fixture, albumRead, readKnown, looseRow, browsePayload, overlay} = require('./shared-request-unit-fixture.cjs').looseRevocation();
const rootPayload = (rows, patch = {}) => browsePayload(rows, {all_artists_active: true, gallery_scope: 'all',
  visible_library_categories: ['main_library'], artist_groups: [{artist: 'Fixture', albums: [{key: 'display-album'}]}], ...patch});
const withoutRows = () => {
  const payload = rootPayload([]);
  delete payload.non_album_tracks;
  return payload;
};
const emptyShapes = [['empty row array', () => rootPayload([])], ['absent row property', withoutRows]];

async function seeded() {
  const f = fixture(), album = await albumRead(f);
  const unrelated = await readKnown(f, browsePayload([looseRow(902)], {selected_artist: 'Unrelated'}));
  const original = await readKnown(f, rootPayload([looseRow(41), looseRow(42)]));
  f.context.rememberReusableRootBrowseView(original);
  assert.equal(f.state.gallery.reusableRootBrowseView.non_album_tracks[0], original.non_album_tracks[0]);
  assert.equal(f.state.gallery.reusableRootBrowseView.non_album_tracks[1], original.non_album_tracks[1]);
  const mounted = f.mount(original), originalSources = original.non_album_tracks.map(row => f.source(row));
  return {f, album, unrelated, original, mounted, originalSources};
}

async function assertRetiredEveryOldObject({f, album, unrelated, original, mounted, originalSources}, requestCount) {
  for (let index = 0; index < original.non_album_tracks.length; index++) {
    assert.equal(f.source(original.non_album_tracks[index]), null, 'Every obsolete exact row must lose its replaced source receipt');
    assert.equal(f.value(mounted, index), null, 'An already mounted adapter cannot keep the obsolete receipt alive');
    await assert.rejects(mounted.runtime.setTrackLove({row: mounted.rows[index], context: mounted.context, love_tier: 'obsessed'}));
    assert.equal(f.runtime.preference(originalSources[index]).allowed_actions.can_set_love_tier, true,
      'Population replacement must not manufacture a shared personal-preference denial');
  }
  assert.equal(f.preference(album).love_tier, 'obsessed');
  assert.ok(f.source(unrelated.non_album_tracks[0]), 'A distinct Loose population remains authoritative');
  f.state.view = browsePayload([], {selected_artist: 'Elsewhere'});
  const restored = f.context.getReusableRootBrowseView(original);
  assert.ok(restored, 'The real retained cache remains restorable for presentation');
  original.non_album_tracks.forEach((row, index) => assert.equal(restored.non_album_tracks[index], row));
  f.state.view = restored;
  const restoredAdapter = f.mount(restored);
  for (let index = 0; index < restored.non_album_tracks.length; index++) {
    assert.equal(f.value(restoredAdapter, index), null, 'Exact cache restore cannot revive replaced authority');
    await assert.rejects(restoredAdapter.runtime.setTrackLove({row: restoredAdapter.rows[index],
      context: restoredAdapter.context, love_tier: 'loved'}));
  }
  f.native.retire('loose-tracks');
  const rehosted = f.mount(restored, {querySelectorAll: () => []});
  assert.equal(f.value(rehosted, 0), null); assert.equal(f.value(rehosted, 1), null);
  assert.equal(f.requests.length, requestCount, 'Retained and rehosted stale rows cannot send a preference command');
}

for (const [label, replacementPayload] of emptyShapes) {
  test(`Accepted full replacement with ${label} retires all old exact and cached Loose receipts`, async () => {
    const seededState = await seeded(), {f, original, mounted} = seededState;
    const replacement = replacementPayload(), before = f.batches.length;
    const index = f.requests.length, epoch = f.runtime.readEpoch(); let notifications = 0;
    const unsubscribe = mounted.runtime.subscribeTrackPreferences(() => {notifications++;});
    assert.equal(f.url(replacement), f.url(original), 'The replacement owns the same logical population');
    const pending = f.read(f.url(replacement));
    assert.ok(original.non_album_tracks.every(row => f.source(row)), 'Dispatch alone must not retire the displayed source');
    f.respond(index, replacement); const result = await pending;
    assert.ifError(result.error); assert.equal(result.value, true); assert.equal(f.state.view, replacement);
    if (label === 'empty row array') assert.equal(f.state.view.non_album_tracks.length, 0);
    else assert.equal(Object.hasOwn(f.state.view, 'non_album_tracks'), false);
    assert.ok(notifications > 0, 'Successful empty replacement notifies mounted source listeners');
    const replacementBatches = f.batches.slice(before);
    assert.ok(replacementBatches.length <= 1, 'No duplicate admission owner for an empty population');
    for (const batch of replacementBatches) {assert.equal(batch.epoch, epoch); assert.equal(batch.sources.length, 0);}
    await assertRetiredEveryOldObject(seededState, index + 1);
    assert.equal(f.directReads.length, 0); unsubscribe();
  });
}

test('Accepted all-readable full replacement retires every old object and gives fresh sibling objects only their dispatch epoch', async () => {
  const seededState = await seeded(), {f, original} = seededState;
  const freshRows = [looseRow(42, {track_preference: overlay('loved')}), looseRow(43, {track_preference: overlay('obsessed')})];
  const replacement = rootPayload(freshRows), before = f.batches.length, index = f.requests.length, epoch = f.runtime.readEpoch();
  assert.notEqual(freshRows[0], original.non_album_tracks[1]);
  assert.equal(freshRows[0].path, original.non_album_tracks[1].path, 'The surviving logical sibling is a genuinely fresh object');
  const pending = f.read(f.url(replacement));
  assert.ok(original.non_album_tracks.every(row => f.source(row)), 'An in-flight replacement is not an accepted one');
  f.respond(index, replacement); const result = await pending;
  assert.ifError(result.error); assert.equal(result.value, true);
  assert.equal(f.batches.length, before + 1); assert.equal(f.batches.at(-1).epoch, epoch);
  assert.equal(f.requests[index].dispatchEpoch, epoch);
  assert.deepEqual(f.batches.at(-1).sources.map(source => source.track_ref), freshRows.map(row => row.path));
  assert.deepEqual(freshRows.map(row => f.preference(row)?.love_tier), ['loved', 'obsessed']);
  assert.ok(freshRows.every(row => f.preference(row).allowed_actions.can_set_love_tier));
  await assertRetiredEveryOldObject(seededState, index + 1);
  assert.deepEqual(freshRows.map(row => f.preference(row)?.love_tier), ['loved', 'obsessed'],
    'Restoring an obsolete cached view must not revoke the newer exact sibling receipts');
  assert.equal(f.batches.length, before + 1); assert.equal(f.directReads.length, 0);
});

for (const [label, replacementPayload] of emptyShapes) {
  test(`Discarded full response with ${label} does not rotate the displayed Loose source`, async () => {
    const f = fixture(), original = await readKnown(f, rootPayload([looseRow(51)]));
    const source = f.source(original.non_album_tracks[0]), before = f.batches.length, index = f.requests.length;
    const pending = f.read(f.url(original), {shouldApplyResponse: () => false});
    f.respond(index, replacementPayload()); const result = await pending;
    assert.ifError(result.error); assert.equal(result.value, false); assert.equal(f.state.view, original);
    assert.equal(f.source(original.non_album_tracks[0]), source); assert.equal(f.batches.length, before);
  });

  test(`Retained sidebar-only response with ${label} does not rotate the mounted Loose source`, async () => {
    const f = fixture(), original = await readKnown(f, rootPayload([looseRow(52)]));
    const source = f.source(original.non_album_tracks[0]), before = f.batches.length, index = f.requests.length;
    const response = {...replacementPayload(), artists_sidebar: [{name: 'Sidebar updated'}], artist_count: 7};
    const pending = f.read(f.url(original), {retainMountedSelectedViewState: original});
    f.respond(index, response); const result = await pending;
    assert.ifError(result.error); assert.equal(result.value, true);
    assert.equal(f.state.view.non_album_tracks[0], original.non_album_tracks[0]);
    assert.equal(f.state.view.artists_sidebar, response.artists_sidebar);
    assert.equal(f.source(original.non_album_tracks[0]), source); assert.equal(f.batches.length, before);
  });

  test(`Ordinary continuation with ${label} does not rotate retained Loose authority`, async () => {
    const f = fixture(), original = rootPayload([looseRow(53)], {
      gallery_page: {revision: 'replacement-supplement-r1', next_cursor: 'next', has_more: true},
    });
    await readKnown(f, original);
    const source = f.source(original.non_album_tracks[0]), before = f.batches.length, index = f.requests.length;
    const pending = f.context.loadNextRootGalleryPage();
    assert.match(f.requests[index].url, /gallery_cursor=next/);
    f.respond(index, {...replacementPayload(), artist_groups: [{artist: 'Fixture', albums: [{key: 'next-album'}]}],
      gallery_page: {revision: 'replacement-supplement-r1', next_cursor: null, has_more: false}});
    assert.equal(await pending, true); assert.equal(f.state.view.non_album_tracks[0], original.non_album_tracks[0]);
    assert.equal(f.source(original.non_album_tracks[0]), source); assert.equal(f.batches.length, before);
  });
}
