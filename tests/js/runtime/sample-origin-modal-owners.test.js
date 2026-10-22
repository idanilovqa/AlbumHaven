'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const F = require('./sample-origin-fixtures.cjs');
const {modalFixture} = require('./sample-origin-modal-fixtures.cjs');
const row = (ref, patch = {}) => ({inventory_track_ref: ref, title: 'Canonical track', path: `/test-only/${ref}.flac`,
  artist: 'Artist A', album_artist: 'Artist A', exception_type: '', allowed_actions: {can_read: true, can_play: false}, ...patch});
const album = (patch = {}) => ({key: 'alpha', request_key: 'actual:alpha', name: 'Canonical album', source_readable: true,
  allowed_actions: {can_read: true, can_play_album: false}, tracks: F.refs.map(ref => row(ref)), ...patch});
function physical(options = {}, value = album()) {
  const h = modalFixture(); h.c.openTrackModal(value, options);
  assert.equal(h.c.getCurrentTrackModalAlbum().request_key, value.request_key);
  return h;
}
test('actual openTrackModal owner captures canonical current release tracks before DOM sort or media filtering', () => {
  const h = physical(); h.c.playableTracks = []; h.c.displayedTracks = [h.c.getCurrentTrackModalAlbum().tracks[2]];
  const lease = h.capturePhysical(); assert.ok(lease);
  assert.deepEqual(F.plain(lease.origin), F.origins.album_details()); assert.equal(lease.isCurrent(), true);
  assert.equal(Object.hasOwn(lease.origin, 'album_ref'), false); assert.equal(Object.hasOwn(lease.origin, 'revision'), false);
  assert.doesNotMatch(JSON.stringify(lease.origin), /actual:alpha|Canonical|test-only|path/);
});
test('current release selection is not a union of alternate releases', () => {
  const h = physical(), other = album({key: 'beta', request_key: 'actual:beta', tracks: [row('inventory-track:5:44')]});
  h.c.openTrackModal(other, {releaseSet: {releases: [h.c.getCurrentTrackModalAlbum(), other], selectedIndex: 1}});
  assert.deepEqual(F.plain(h.capturePhysical().origin), {kind: 'album_details', track_refs: ['inventory-track:5:44']});
});
test('explicit duplicate source uses the existing duplicate resolver and only that source canonical tracks', () => {
  const value = album({duplicate_sources: [{tracks: [row(F.refs[0])]}, {tracks: [row(F.refs[1]), row(F.refs[2])]}]});
  const h = physical({}, value), button = h.button(1), resolved = h.c.resolveTrackModalDuplicateSourceAlbum(button);
  assert.deepEqual(F.plain(resolved.tracks.map(track => track.inventory_track_ref)), [F.refs[1], F.refs[2]]);
  const lease = h.capturePhysical({duplicateButton: button});
  assert.deepEqual(F.plain(lease.origin), {kind: 'album_details', track_refs: [F.refs[1], F.refs[2]]});
});
for (const ref of [undefined, 9007199254740992, 'inventory-track:5:01', 'inventory-album:5:3', 'inventory-track:6:3',
  'inventory-track:5:9223372036854775808']) test(`physical canonical row invalid ref ${String(ref)} rejects whole selection`, () => {
  const h = physical({}, album({tracks: [row(F.refs[0]), row(ref)]})); assert.equal(h.capturePhysical(), null);
});
test('duplicate canonical track refs reject instead of silently deduping the declared details selection', () => {
  assert.equal(physical({}, album({tracks: [row(F.refs[0]), row(F.refs[0])]})).capturePhysical(), null);
});
test('no-open-album restriction cannot gain a Sample navigation escape but media-only denial permits Browse preview', () => {
  const restricted = physical({presentationRestrictions: {can_open_album_page: false, can_play_album: true}});
  assert.equal(restricted.capturePhysical(), null);
  const browseOnly = physical({presentationRestrictions: {can_open_album_page: true, can_play_album: false}});
  assert.ok(browseOnly.capturePhysical()); assert.equal(browseOnly.c.getTrackModalPresentationRestrictions().can_play_album, false);
  browseOnly.denyBrowse(); assert.equal(browseOnly.capturePhysical(), null);
});
for (const change of ['close', 'release', 'request_key', 'hydration', 'scope', 'source_owner', 'artist_sheet', 'source_unreadable'])
  test(`actual modal ${change} retires the captured selection permanently`, () => {
    let ownerCurrent = true; const h = physical({sourcePageOwner: {isCurrent: () => ownerCurrent, revalidate: async () => null}});
    const lease = h.capturePhysical(); assert.ok(lease); const original = h.c.getCurrentTrackModalAlbum();
    if (change === 'close') h.c.closeTrackModal();
    else if (change === 'release') {h.c.state.modalReleases.push(album({request_key: 'other'})); h.c.state.modalReleaseIndex = h.c.state.modalReleases.length - 1;}
    else if (change === 'request_key') original.request_key = 'other';
    else if (change === 'hydration') h.c.invalidatePendingTrackModalLoad();
    else if (change === 'scope') h.setScope('other:scope');
    else if (change === 'source_owner') ownerCurrent = false;
    else if (change === 'artist_sheet') vm.runInContext('artistSheetGeneration += 1;', h.c);
    else original.source_readable = false;
    assert.equal(lease.isCurrent(), false);
    h.c.state.modalReleases = [original]; h.c.state.modalReleaseIndex = 0; ownerCurrent = true;
    assert.equal(lease.isCurrent(), false);
  });
test('retired search presentation attempt cannot be sampled even while old modal rows remain', () => {
  let current = true; const attempt = {isCurrent: () => current, commit: () => true, isCommitted: () => true, dispose: () => {current = false;}};
  const h = physical({searchPresentationAttempt: attempt}); const lease = h.capturePhysical(); assert.ok(lease);
  current = false; assert.equal(lease.isCurrent(), false); assert.equal(h.capturePhysical(), null);
});
for (const phase of ['acquisition', 'capture']) test(`actual modal close fences late ${phase} in the shared controller`, async t => {
  const h = physical(), lease = h.capturePhysical(); assert.ok(lease);
  const waiting = F.deferred(), entered = F.deferred(); let submitted;
  const method = phase === 'acquisition' ? 'readSamplePlaylistRepresentatives' : 'captureSamplePlaylist';
  const controller = await F.typedController('album_details', {[method]: async input => {submitted = input; entered.resolve(); return waiting.promise;}},
    {isCurrent: () => lease.isCurrent()}); t.after(() => controller.controller.dispose());
  const operation = controller.generateOrigin({origin: lease.origin});
  await Promise.race([entered.promise, operation.then(() => {throw new Error('Missing expected asynchronous boundary');})]);
  h.c.closeTrackModal(); waiting.resolve(phase === 'acquisition' ? F.v2Representatives(submitted) : F.v2Capture(submitted)); await operation;
  assert.equal(controller.controller.source(), null); assert.equal(controller.typedCalls.save.length, 0);
  if (phase === 'acquisition') assert.equal(controller.typedCalls.capture.length, 0);
});
function loose() {
  const h = modalFixture();
  h.c.state.gallery.mainState = {categories: ['main_library']};
  h.c.state.view = {selected_artist: 'Artist A', related_artists: ['Family Alias'], non_album_library_categories: ['main_library'],
    artist_family_filters: [{display_name: 'Artist A', variation_names: ['Family A']}, {display_name: 'Other', variation_names: ['Not Family']}],
    non_album_tracks: [row(F.refs[0], {artist: 'Artist A', album_artist: 'Artist A', exception_type: 'Interview'}),
      row(F.refs[1], {artist: 'Family A', album_artist: 'Family A', exception_type: 'Non-album rarity'}),
      row(F.refs[2], {artist: 'Unrelated', album_artist: 'Unrelated', display_path: 'Family_Alias/loose.flac'}),
      row('inventory-track:5:99', {artist: 'Other', album_artist: 'Other'})]};
  h.c.openNonAlbumModal(); return h;
}
test('actual loose modal captures current category/selected-artist/family scope, not every library loose track', () => {
  const h = loose(), canonical = Array.from(h.c.getVisibleNonAlbumTracks(), track => track.inventory_track_ref);
  assert.deepEqual(canonical, F.refs); assert.ok(h.prepared.get('loose-tracks'));
  const lease = h.captureLoose(); assert.ok(lease);
  assert.deepEqual(F.plain(lease.origin), {kind: 'album_details', track_refs: canonical});
  assert.equal(Object.hasOwn(lease.origin, 'inventory_album_ref'), false);
});
test('loose Sample canonical order survives different presentation grouping and display sort', () => {
  const h = loose(), prepared = h.prepared.get('loose-tracks');
  assert.notDeepEqual(Array.from(prepared.privateRows, item => item.inventory_track_ref), F.refs,
    'Fixture intentionally places rarity before interview in presentation while canonical source order differs');
  h.c.displayedTracks = [...prepared.privateRows].reverse();
  assert.deepEqual(F.plain(h.captureLoose().origin.track_refs), F.refs);
});
for (const change of ['close', 'view_replacement', 'category_replacement', 'artist_replacement', 'scope', 'detachment'])
  test(`actual loose ${change} retires pending Sample and cannot resurrect the old view`, async t => {
    const h = loose(), lease = h.captureLoose(); assert.ok(lease); const source = h.c.state.view;
    const waiting = F.deferred(), entered = F.deferred(); let submitted;
    const controller = await F.typedController('album_details', {captureSamplePlaylist: async input => {submitted = input; entered.resolve(); return waiting.promise;}},
      {isCurrent: () => lease.isCurrent()}); t.after(() => controller.controller.dispose());
    const operation = controller.generateOrigin({origin: lease.origin, options: F.options('most_listened')});
    await Promise.race([entered.promise, operation.then(() => {throw new Error('Missing capture boundary');})]);
    if (change === 'close') h.c.closeNonAlbumModal();
    else if (change === 'view_replacement') h.c.state.view = F.plain(source);
    else if (change === 'category_replacement') h.c.state.gallery.mainState.categories = ['hoard'];
    else if (change === 'artist_replacement') h.c.state.view = {...source, selected_artist: 'Other'};
    else if (change === 'scope') h.setScope('other:scope'); else h.extra.get('non-album-modal').remove();
    assert.equal(lease.isCurrent(), false); h.c.state.view = source; assert.equal(lease.isCurrent(), false);
    waiting.resolve(F.v2Capture(submitted)); await operation; assert.equal(controller.controller.source(), null);
  });
test('loose currentness permits a retained mobile page but close still retires its playtable owner', () => {
  const h = loose(), lease = h.captureLoose(); assert.ok(lease);
  h.c.mobilePageState = {pages: [{kind: 'non-album'}]}; h.extra.get('non-album-modal').hidden = true;
  assert.equal(h.prepared.get('loose-tracks').isCurrent(), true);
  assert.equal(h.captureLoose(), null, 'retained playtable currentness does not authorize fresh hidden Sample capture');
  h.c.closeNonAlbumModal(); assert.equal(h.prepared.has('loose-tracks'), false); assert.equal(lease.isCurrent(), false);
});
test('missing scoped ref anywhere in loose canonical selection rejects instead of shrinking the view', () => {
  const h = loose(); delete h.c.state.view.non_album_tracks[1].inventory_track_ref;
  assert.equal(h.captureLoose(), null);
});
test('physical Back delegates actual source-page token/request key to the existing return owner and revalidates', async () => {
  let revalidations = 0; const fresh = album();
  const h = physical({sourcePageOwner: {isCurrent: () => true, revalidate: async () => {
    revalidations++; return {album: fresh, isCurrent: () => true, presentationRestrictions: {can_open_album_page: true, can_play_album: false}};
  }}});
  const lease = h.capturePhysical(); assert.ok(lease); const token = h.c.getTrackModalSourcePageToken(), calls = [];
  const restore = h.c.restoreTrackModalSourcePage;
  h.c.restoreTrackModalSourcePage = async (descriptor, options) => {calls.push(descriptor); return restore(descriptor, options);};
  let returns = 0;
  assert.equal(await lease.back(() => {returns++; assert.equal(revalidations, 1); return true;}), true);
  assert.equal(returns, 1); assert.equal(revalidations, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].sourcePageToken, token); assert.equal(calls[0].albumKey, 'actual:alpha');
  assert.equal(h.c.getCurrentTrackModalAlbum(), fresh);
});
test('physical Back cannot revive a deleted/revoked source using the retained cached album', async () => {
  let revalidations = 0;
  const h = physical({sourcePageOwner: {isCurrent: () => true, revalidate: async () => {revalidations++; return null;}}});
  const lease = h.capturePhysical(); assert.ok(lease); const renders = h.c.renderTrackModalReleaseCalls.length;
  let returns = 0;
  assert.equal(await lease.back(() => {returns++; return true;}), false);
  assert.equal(returns, 0, 'revoked source does not navigate before rejection');
  assert.equal(revalidations, 1); assert.equal(h.c.renderTrackModalReleaseCalls.length, renders);
});
