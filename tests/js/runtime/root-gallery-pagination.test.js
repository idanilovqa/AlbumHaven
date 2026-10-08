const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8');
function fixture() {
  const pending = [], renders = [], timers = [];
  const scroll = { scrollTop: 0, clientHeight: 500, scrollHeight: 1000 };
  const state = { ui: {}, busy: false, view: { query: '', selected_artist: '', surface_request: 'albums', artist_count: 6045, album_count: 20000, artists_sidebar: [{ artist: 'A', count: 5 }], artist_groups: [{ artist: 'A', albums: [{ key: 'a1' }] }], gallery_page: { next_cursor: 'page-1', revision: 'r1', has_more: true, page_size: 8 } } };
  const context = vm.createContext({ state, URL, URLSearchParams, AbortController, console, window: { location: { href: 'https://localhost/', assign() {} } }, document: { getElementById: id => id === 'albums-scroll' ? scroll : null }, buildApiUrl: () => '/view-data?surface=albums', getAlbumCardRenderKey: album => album.key, applyViewPayload: data => { state.view = { ...state.view, ...data }; }, renderArtistGroups: options => renders.push(options), scheduleBrowserAnimationFrame: callback => timers.push(callback), showToast() {}, fetch: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve: data => resolve({ ok: true, status: 200, json: async () => data }), reject })) });
  vm.runInContext(source, context);
  return { context, state, scroll, pending, renders, timers };
}
const page = (groups, extra = {}) => ({ artist_groups: groups, gallery_page: { next_cursor: null, revision: 'r1', has_more: false, page_size: 50 }, ...extra });
test('root page appends split artist albums without duplicates and preserves authoritative sidebar/totals', async () => {
  const f = fixture(); const sidebar = f.state.view.artists_sidebar;
  const promise = f.context.loadNextRootGalleryPage();
  assert.equal(f.pending.length, 1); assert.match(f.pending[0].url, /gallery_cursor=page-1/); assert.match(f.pending[0].url, /gallery_page_size=50/); assert.match(f.pending[0].url, /omit_sidebar=1/);
  f.pending[0].resolve(page([{ artist: 'A', albums: [{ key: 'a1' }, { key: 'a2' }] }, { artist: 'B', albums: [{ key: 'a1' }] }]));
  assert.equal(await promise, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.view.artist_groups)), [{ artist: 'A', albums: [{ key: 'a1' }, { key: 'a2' }] }, { artist: 'B', albums: [{ key: 'a1' }] }]);
  assert.equal(f.state.view.artists_sidebar, sidebar); assert.equal(f.state.view.artist_count, 6045); assert.equal(f.state.view.album_count, 20000);
  assert.equal(f.renders[0].preserveScroll, true); assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
});
test('root page loads only near end, with one in-flight owner', async () => {
  const f = fixture(); f.scroll.scrollHeight = 5000;
  assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 0);
  f.scroll.scrollTop = 3500; const first = f.context.loadNextRootGalleryPage();
  assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 1);
  f.pending[0].resolve(page([])); await first;
});
test('short initial page fills viewport but full buffer does not idle-drain', async () => {
  const f = fixture(); f.scroll.scrollHeight = 300; const first = f.context.loadNextRootGalleryPage();
  f.scroll.scrollHeight = 5000;
  f.pending[0].resolve(page([{ artist: 'B', albums: [{ key: 'b' }] }], { gallery_page: { next_cursor: 'page-2', revision: 'r1', has_more: true } })); await first;
  for (const callback of f.timers.splice(0)) await callback();
  assert.equal(f.pending.length, 1);
});
for (const change of ['query', 'selected_artist', 'revision']) test(`stale root continuation cannot replace new ${change}`, async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  if (change === 'revision') f.state.ui.viewStateRevision = 1; else f.state.view[change] = 'new';
  f.pending[0].resolve(page([{ artist: 'stale', albums: [{ key: 'stale' }] }]));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.state.view.artist_groups[0].artist, 'A');
});
test('catalog revision mismatch keeps mounted page and refuses mixed snapshots', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve(page([{ artist: 'stale', albums: [] }], { gallery_page: { next_cursor: null, revision: 'r2', has_more: false } }));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.state.view.artist_groups[0].artist, 'A');
});
test('failed continuation keeps cards and releases request for later user retry', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage(); f.pending[0].reject(new Error('offline'));
  assert.equal(await first, false); assert.equal(f.renders.length, 0);
  const second = f.context.loadNextRootGalleryPage(); assert.equal(f.pending.length, 2); f.pending[1].resolve(page([])); await second;
});
test('explicit navigation aborts continuation without taking foreground request slot', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage(); assert.equal(f.state.busy, false);
  f.context.claimLocalViewStateNavigation(); assert.equal(f.pending[0].options.signal.aborted, true);
  f.pending[0].resolve(page([])); assert.equal(await first, false);
});

test('search and selected artist views never fetch a root continuation', async () => {
  for (const field of ['query', 'selected_artist']) {
    const f = fixture(); f.state.view[field] = 'Neal Morse';
    assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 0);
  }
});
test('nonadvancing cursor cannot idle-loop or duplicate mounted albums', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve(page([{ artist: 'A', albums: [{ key: 'a2' }] }], { gallery_page: { next_cursor: 'page-1', revision: 'r1', has_more: true } }));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.timers.length, 0);
});

test('stale cursor restarts one bounded page without clearing mounted cards', async () => {
  const f = fixture(); const old = f.state.view;
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({ url, options, resolve }));
  f.context.renderView = options => f.renders.push(options);
  const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.length, 2); assert.equal(f.state.view, old);
  assert.equal(new URL(f.pending[1].url, 'https://localhost').searchParams.has('gallery_cursor'), false);
  assert.equal(new URL(f.pending[1].url, 'https://localhost').searchParams.has('omit_sidebar'), false);
  f.pending[1].resolve({ status: 200, ok: true, json: async () => page([{ artist: 'New', albums: [{ key: 'new' }] }], { artists_sidebar: [{ artist: 'New', count: 1 }], artist_count: 1, album_count: 1, gallery_page: { revision: 'r2', has_more: false, next_cursor: null } }) });
  assert.equal(await first, true); assert.equal(f.state.view.artist_groups[0].artist, 'New'); assert.equal(f.state.view.artist_count, 1);
});

test('continuation uses the loaded source scope rather than retained browser scope', async () => {
  const f = fixture(); f.state.view.gallery_scope = 'main'; f.state.view.visible_library_categories = ['main_library'];
  f.state.view.gallery_page_scope = { gallery_scope: 'all', visible_library_categories: ['hoard'] };
  f.context.buildApiUrl = view => '/view-data?surface=albums&gallery_scope=' + view.gallery_scope + '&category=' + view.visible_library_categories[0];
  const result = f.context.loadNextRootGalleryPage();
  assert.match(f.pending[0].url, /gallery_scope=all&category=hoard/);
  f.pending[0].resolve(page([])); await result;
});

function retainNativeAlbumSource(f) {
  const nativeSource = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/playtable-source.js'), 'utf8');
  const token = {};
  f.context.TrackActionsRuntime = {scope: () => ({actor: 'synthetic-actor', library: 'synthetic-library', token})};
  Object.assign(f.context.window, {addEventListener() {}, removeEventListener() {},
    AlbumHavenPlaylistRuntime: {snapshot: () => ({scopeKey: 'synthetic-scope'})}});
  vm.runInContext(nativeSource, f.context);
  const native = vm.runInContext('NativePlaytables', f.context);
  const album = {key: 'retained-album'}, groups = [{tracks: [{}]}];
  f.state.modalReleases = [album]; f.state.modalReleaseIndex = 0;
  const owner = native.prepare('album-tracks', album, groups, [{track_ref: '/synthetic/retained-track'}],
    () => f.state.modalReleases[0] === album);
  return {native, adapter: owner.source, rowKey: groups[0].tracks[0].rowKey,
    close() {f.state.modalReleases = []; native.retire('album-tracks');}};
}
test('an in-flight root continuation cannot retire an opened native Album source; release resumes root paging', async () => {
  const f = fixture(), original = f.state.view, pending = f.context.loadNextRootGalleryPage();
  const child = retainNativeAlbumSource(f);
  assert.equal(child.native.hasActiveSource(), true);
  f.pending[0].resolve(page([{artist: 'Later', albums: [{key: 'later'}]}]));
  assert.equal(await pending, false); assert.equal(f.state.view, original);
  assert.equal(child.adapter.resolveRows([child.rowKey]).rows[0].track_ref, '/synthetic/retained-track');
  assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 1);
  child.close(); for (const callback of f.timers.splice(0)) callback();
  assert.equal(f.pending.length, 2, 'release rechecks the current root buffer');
  f.pending[1].resolve(page([{artist: 'Later', albums: [{key: 'later'}]}]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.view.artist_groups.at(-1).artist, 'Later');
});
for (const openedAt of ['conflict', 'restart']) test(`native child source rejects a root revision restart opened at ${openedAt}`, async () => {
  const f = fixture(), original = f.state.view;
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({url, options, resolve}));
  f.context.renderView = options => f.renders.push(options);
  const pending = f.context.loadNextRootGalleryPage();
  let child;
  if (openedAt === 'conflict') child = retainNativeAlbumSource(f);
  f.pending[0].resolve({status: 409, ok: false, json: async () => ({restart_required: true})});
  if (openedAt === 'restart') {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.pending.length, 2);
    child = retainNativeAlbumSource(f);
    f.pending[1].resolve({status: 200, ok: true, json: async () => page([], {gallery_page: {revision: 'r2', has_more: false, next_cursor: null}})});
  }
  assert.equal(await pending, false); assert.equal(f.state.view, original); assert.equal(f.renders.length, 0);
  assert.ok(child.adapter.resolveRows([child.rowKey]), 'same native source still authorizes table selection/actions');
  child.close();
});
