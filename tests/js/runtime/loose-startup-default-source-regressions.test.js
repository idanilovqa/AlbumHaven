// R6: the actual startup URL omits server defaults that the real next-read
// URL builder emits from the accepted normalized response. Same population,
// same revocation lineage; genuine subsets/scopes stay separate.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {fixture, albumRead, readKnown, looseRow, browsePayload, overlay} = require('./loose-revocation-regression-harness.cjs');

// Static, source-verified wire fixtures; no Python import/extraction/bypass.
// routes/web_asgi.py:320-380 omits all/default categories in this startup URL.
// services/gallery_scope.py:9-34 and library_roots.py:18-22,224-229 resolve
// omitted scope/categories to these values; library_browse_postgres.py:679-684
// returns them, using its real state resolver at 4964-4978.
const startupUrl = '/view-data?surface=albums';
const defaultCategories = ['main_library', 'hoard', 'new_arrivals'];
const normalizedResponse = (rows, patch = {}) => browsePayload(rows, {
  all_artists_active: false, gallery_scope: 'all', gallery_display_mode: 'cards', gallery_scale_percent: 100,
  visible_library_categories: [...defaultCategories], related_filter_artists: [], primary_filter_active: false,
  artist_groups: [{artist: 'Fixture', albums: [{key: 'startup-default-album'}]}], album_count: 1, artist_count: 1,
  ...patch,
});
const actualUrl = (f, view = f.state.view) => f.context.buildApiUrl(view);

async function startupRead(f, rows = [looseRow(81)]) {
  const response = normalizedResponse(rows);
  await f.load(response, startupUrl, {startupRefresh: true});
  assert.equal(f.state.view, response, 'The actual fetch owner accepted this server-normalized response');
  assert.ok(f.source(rows[0]), 'Only the genuine startup dispatch establishes the exact receipt');
  const url = actualUrl(f), params = new URL(url, 'https://albumhaven.test').searchParams;
  assert.notEqual(url, startupUrl, 'The real next-read URL explicitly emits the formerly omitted defaults');
  assert.equal(params.get('surface'), 'albums'); assert.equal(params.get('gallery_scope'), 'all');
  assert.deepEqual(params.getAll('category'), defaultCategories);
  assert.equal(params.get('gallery_page_size'), '50');
  assert.equal(params.has('all_artists'), false, 'Do not introduce a different population parameter into this transition');
  f.context.rememberReusableRootBrowseView(response);
  assert.equal(f.state.gallery.reusableRootBrowseView.non_album_tracks[0], rows[0]);
  return {response, url, mounted: f.mount(response)};
}

async function assertOldCacheCannotWrite(f, original, mounted, requestCount) {
  original.non_album_tracks.forEach((row, index) => {
    assert.equal(f.source(row), null, 'The original omitted-default exact source must be retired');
    assert.equal(f.value(mounted, index), null, 'The already mounted adapter must observe retirement');
  });
  await assert.rejects(mounted.runtime.setTrackLove({row: mounted.rows[0], context: mounted.context, love_tier: 'loved'}));
  f.state.view = browsePayload([], {selected_artist: 'Away'});
  const restored = f.context.getReusableRootBrowseView(original);
  assert.ok(restored); assert.equal(restored.non_album_tracks[0], original.non_album_tracks[0]);
  f.state.view = restored;
  const adapter = f.mount(restored);
  assert.equal(f.value(adapter), null);
  await assert.rejects(adapter.runtime.setTrackLove({row: adapter.rows[0], context: adapter.context, love_tier: 'obsessed'}));
  assert.equal(f.requests.length, requestCount, 'Exact cache restore must not dispatch a preference command');
}

test('Default startup receipt and mounted/cache authority are revoked by current 403 from the real normalized-view refresh URL', async () => {
  const f = fixture(), album = await albumRead(f);
  const other = await readKnown(f, normalizedResponse([looseRow(89)], {selected_artist: 'Other'}));
  const {response, url, mounted} = await startupRead(f);
  const index = f.requests.length, before = f.batches.length; let notifications = 0;
  const unsubscribe = mounted.runtime.subscribeTrackPreferences(() => {notifications++;});
  const pending = f.read(url); f.respond(index, {ok: false, error: 'Current browse denial'}, 403);
  const result = await pending;
  assert.ok(result.error); assert.equal(f.batches.length, before);
  assert.ok(notifications > 0, 'The current explicit-default denial must reach the mounted startup source');
  await assertOldCacheCannotWrite(f, response, mounted, index + 1);
  assert.ok(f.source(other.non_album_tracks[0]), 'A different artist population must survive');
  assert.equal(f.preference(album).love_tier, 'obsessed', 'Album source namespace must survive');
  unsubscribe();
});

test('Same-population successful refresh retires omitted-default startup objects while fresh siblings keep their original epoch', async () => {
  const f = fixture(), album = await albumRead(f);
  const subset = normalizedResponse([looseRow(89)], {visible_library_categories: ['main_library']});
  await readKnown(f, subset, actualUrl(f, subset));
  const {response, url, mounted} = await startupRead(f, [looseRow(81), looseRow(82)]);
  const fresh = normalizedResponse([looseRow(82, {track_preference: overlay('loved')}), looseRow(83)]);
  const index = f.requests.length, before = f.batches.length, epoch = f.runtime.readEpoch();
  const pending = f.read(url); f.respond(index, fresh); const result = await pending;
  assert.ifError(result.error); assert.equal(result.value, true); assert.equal(f.state.view, fresh);
  assert.equal(f.batches.length, before + 1); assert.equal(f.batches.at(-1).epoch, epoch);
  assert.equal(f.requests[index].dispatchEpoch, epoch);
  assert.deepEqual(f.batches.at(-1).sources.map(source => source.track_ref), fresh.non_album_tracks.map(row => row.path));
  assert.equal(f.preference(fresh.non_album_tracks[0]).love_tier, 'loved');
  assert.ok(f.source(fresh.non_album_tracks[1]));
  await assertOldCacheCannotWrite(f, response, mounted, index + 1);
  assert.ok(f.source(fresh.non_album_tracks[0]), 'Restoring the old view cannot revoke the fresh exact sibling');
  assert.ok(f.source(subset.non_album_tracks[0]), 'A nondefault category subset stays distinct');
  assert.equal(f.preference(album).love_tier, 'obsessed');
});

test('A real nondefault main-library category denial does not revoke the omitted-default startup population', async () => {
  const f = fixture(), {response} = await startupRead(f);
  const subset = normalizedResponse([looseRow(84)], {visible_library_categories: ['main_library']});
  const url = actualUrl(f, subset);
  assert.deepEqual(new URL(url, 'https://albumhaven.test').searchParams.getAll('category'), ['main_library']);
  await readKnown(f, subset, url);
  const index = f.requests.length, pending = f.read(actualUrl(f));
  f.respond(index, {ok: false, error: 'Subset denied'}, 403); assert.ok((await pending).error);
  assert.equal(f.source(subset.non_album_tracks[0]), null);
  assert.ok(f.source(response.non_album_tracks[0]), 'Default canonicalization must not merge a proper category subset');
});

test('The actual new-arrivals scope remains distinct from all scope even with the same new-arrivals category', async () => {
  const f = fixture(), {response} = await startupRead(f);
  const allSubset = normalizedResponse([looseRow(85)], {visible_library_categories: ['new_arrivals']});
  await readKnown(f, allSubset, actualUrl(f, allSubset));
  const scoped = normalizedResponse([looseRow(86)], {gallery_scope: 'new_arrivals', visible_library_categories: ['new_arrivals']});
  const url = actualUrl(f, scoped), params = new URL(url, 'https://albumhaven.test').searchParams;
  assert.equal(params.get('gallery_scope'), 'new_arrivals'); assert.deepEqual(params.getAll('category'), ['new_arrivals']);
  await readKnown(f, scoped, url);
  const index = f.requests.length, pending = f.read(actualUrl(f));
  f.respond(index, {ok: false, error: 'New-arrivals scope denied'}, 403); assert.ok((await pending).error);
  assert.equal(f.source(scoped.non_album_tracks[0]), null);
  assert.ok(f.source(allSubset.non_album_tracks[0]), 'Actual nondefault gallery scope must not collapse into all scope');
  assert.ok(f.source(response.non_album_tracks[0]));
});

test('Superseded explicit-default refresh denial cannot revoke a newer same-population accepted response', async () => {
  const f = fixture(), {response, url} = await startupRead(f);
  const index = f.requests.length, obsolete = f.read(url);
  const fresh = normalizedResponse([looseRow(87, {track_preference: overlay('obsessed')})]);
  const replacement = f.read(actualUrl(f), {restartIfSameUrl: true});
  f.respond(index + 1, fresh); const accepted = await replacement;
  assert.ifError(accepted.error); assert.equal(accepted.value, true);
  assert.equal(f.source(response.non_album_tracks[0]), null, 'The accepted same-population replacement retires the startup lineage');
  const source = f.source(fresh.non_album_tracks[0]); assert.ok(source);
  f.respond(index, {ok: false, error: 'Late superseded denial'}, 403);
  const rejected = await obsolete; assert.ifError(rejected.error); assert.equal(rejected.value, false);
  assert.equal(f.state.view, fresh); assert.equal(f.source(fresh.non_album_tracks[0]), source);
  assert.equal(f.preference(fresh.non_album_tracks[0]).love_tier, 'obsessed');
});
