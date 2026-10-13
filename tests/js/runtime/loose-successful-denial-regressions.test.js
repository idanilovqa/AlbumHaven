// R2: current accepted replacement must retire stale denied row lineage. Actual
// response/cache/native owners, with isolated transport and mount output only.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {fixture, albumRead, readKnown, unavailable, looseRow, browsePayload, overlay} = require('./loose-revocation-regression-harness.cjs');
const rootPayload = rows => browsePayload(rows, {all_artists_active: true, gallery_scope: 'all',
  visible_library_categories: ['main_library'], artist_groups: [{artist: 'Fixture', albums: [{key: 'display-album'}]}]});

for (const [kind, denied] of [
  ['unavailable neutral receipt', () => unavailable(11)],
  ['explicit unreadable row', () => looseRow(11, {source_readable: false})],
  ['per-row browse denial', () => looseRow(11, {allowed_actions: {can_read: false}})],
  ['missing canonical proof', () => looseRow(11, {canonical_track_ref: null})],
]) {
  test(`Current successful ${kind} cannot revive cached old Loose authority`, async () => {
    const f = fixture(), album = await albumRead(f);
    const other = await readKnown(f, browsePayload([looseRow(902)], {selected_artist: 'Unrelated'}));
    const original = await readKnown(f, rootPayload([looseRow(11), looseRow(12)]));
    const originalRow = original.non_album_tracks[0], originalSource = f.source(originalRow);
    f.context.rememberReusableRootBrowseView(original);
    assert.equal(f.state.gallery.reusableRootBrowseView.non_album_tracks[0], originalRow);
    const oldAdapter = f.mount(); let notifications = 0;
    const unsubscribe = oldAdapter.runtime.subscribeTrackPreferences(() => {notifications++;});
    const freshSibling = looseRow(12, {track_preference: overlay('loved')}), replacement = rootPayload([denied(), freshSibling]);
    const before = f.batches.length, index = f.requests.length, epoch = f.runtime.readEpoch();
    const pending = f.read(f.url(replacement)); f.respond(index, replacement);
    const result = await pending; assert.ifError(result.error); assert.equal(result.value, true);
    assert.equal(f.batches.length, before + 1); assert.equal(f.batches.at(-1).epoch, epoch);
    assert.deepEqual(f.batches.at(-1).sources.map(source => source.track_ref), [freshSibling.path]);
    assert.equal(f.source(originalRow), null, 'successful per-row denial must revoke the old exact receipt');
    assert.equal(f.source(replacement.non_album_tracks[0]), null);
    assert.equal(f.preference(freshSibling).love_tier, 'loved');
    assert.equal(f.preference(freshSibling).allowed_actions.can_set_love_tier, true);
    assert.ok(notifications > 0, 'mounted listeners observe source revocation');
    assert.equal(f.preference(album).love_tier, 'obsessed'); assert.ok(f.source(other.non_album_tracks[0]));
    assert.equal(f.runtime.preference(originalSource).allowed_actions.can_set_love_tier, true,
      'source denial must not manufacture a shared personal preference denial');
    f.state.view = browsePayload([], {selected_artist: 'Elsewhere'});
    const restored = f.context.getReusableRootBrowseView(original);
    assert.ok(restored); assert.equal(restored.non_album_tracks[0], originalRow);
    f.state.view = restored;
    const restoredAdapter = f.mount(restored);
    assert.equal(f.value(restoredAdapter), null);
    await assert.rejects(restoredAdapter.runtime.setTrackLove({row: restoredAdapter.rows[0],
      context: restoredAdapter.context, love_tier: 'obsessed'}));
    assert.equal(f.requests.length, index + 1, 'cache restore may not dispatch a preference command');
    f.native.retire('loose-tracks');
    const rehosted = f.mount(restored, {querySelectorAll: () => []});
    assert.equal(f.value(rehosted), null, 'close/reopen/rehost cannot recreate a revoked receipt');
    assert.equal(f.batches.length, before + 1); unsubscribe();
  });
}

for (const discarded of ['shouldApplyResponse', 'superseded']) {
  test(`Discarded ${discarded} successful row denial cannot revoke the live source`, async () => {
    const f = fixture(), original = await readKnown(f, rootPayload([looseRow(21)]));
    const source = f.source(original.non_album_tracks[0]), before = f.batches.length;
    const denied = rootPayload([unavailable(21)]), index = f.requests.length;
    const pending = f.read(f.url(original), discarded === 'shouldApplyResponse' ? {shouldApplyResponse: () => false} : {});
    let fresh;
    if (discarded === 'superseded') {
      fresh = rootPayload([looseRow(21, {track_preference: overlay('obsessed')})]);
      const replacement = f.read(f.url(fresh), {restartIfSameUrl: true});
      f.respond(index + 1, fresh); assert.equal((await replacement).value, true);
    }
    f.respond(index, denied); const result = await pending;
    assert.equal(result.value, false); assert.equal(f.source(denied.non_album_tracks[0]), null);
    assert.equal(f.batches.length, before + (fresh ? 1 : 0));
    if (fresh) assert.equal(f.preference(fresh.non_album_tracks[0]).love_tier, 'obsessed');
    else assert.equal(f.source(original.non_album_tracks[0]), source);
    if (!fresh) assert.ok(f.source(original.non_album_tracks[0]), 'discarded response cannot retire a valid previously accepted exact object');
  });
}
