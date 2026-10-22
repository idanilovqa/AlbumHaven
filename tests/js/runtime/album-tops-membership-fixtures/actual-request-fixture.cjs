// Independent whole-source owner composition. Transport and unrelated paint are
// ordinary unit seams; fetchAndRender, queue/currentness, preference admission,
// Settings/mobile guards and the Top bridge are loaded unchanged from ROOT.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {harness, deferred, settle, F, plain} = require('./navigation-owner-fixture.cjs');
const abort = () => Object.assign(new Error('Synthetic intent retired'), {name: 'AbortError'});
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
const topPayload = (ref = F.OTHER) => ({ok: true, surface: {active: 'album_tops'}, top_ref: ref, context_ref: 'a'.repeat(64)});
const row = (id = 11, tier = 'off') => ({track_id: id, path: `/synthetic/request-start/${id}.flac`, title: `Loose ${id}`, artist: 'Fixture',
  canonical_track_ref: `track:start-${id}`, inventory_track_ref: `inventory-track:9:${id}`, track_preference_state: 'available',
  track_preference: {rating: null, love_tier: tier, allowed_actions: {can_rate: true, can_set_love_tier: true}},
  source_readable: true, allowed_actions: {can_read: true}, playback_state: {can_start_here: true}});
const browsePayload = (rows = [], patch = {}) => ({ok: true, surface: {active: 'albums'}, context_ref: 'a'.repeat(64),
  query: '', selected_artist: '', artist_groups: [], artists_sidebar: [], artist_count: 0, album_count: 0,
  non_album_tracks: rows, non_album_track_count: rows.length, visible_library_categories: [], gallery_scope: '', payload_tier: 'full', ...patch});
function fixture(testContext) {
  const h = harness(), c = h.context, requests = [], applied = [], events = [], frames = [];
  Object.assign(h.shell.dataset, {nativeAccountId: '7', nativeLibraryId: '9', privateUiContext: 'a'.repeat(64)});
  const host = h.document.createElement('div'); host.id = 'album-tops-root'; h.shell.appendChild(host);
  const scroll = h.document.createElement('div'); scroll.id = 'albums-scroll';
  Object.assign(scroll, {clientHeight: 800, scrollHeight: 800, scrollTop: 0}); h.shell.appendChild(scroll);
  c.state.ui.activeViewRequestId = 0;
  Object.assign(c.state, {status: {inventory_mutation_revision: 1}, gallery: {albumIndex: new Map()}, player: {}, busy: false});
  let uuid = 900;
  Object.assign(c, {
    crypto: {randomUUID: () => F.id(uuid++)}, getLibrarySidebarMode: () => 'album_tops', selectLibrarySidebarMode: () => true,
    AlbumHavenHomeRuntime: {}, activeAppConfirmDialog: null, activeAppFormDialog: null,
    closeArtistsDrawer() {events.push('drawer');},
    startupMetrics: {markOnce() {}, schedulePaintMark() {}, completeInitialRefresh() {}, completeVisibleInitialRefresh() {}},
    appBootstrap: {}, getTrackModalElements: () => ({overlay: null}),
    getAlbumRequestKey: value => value?.key || '', getAlbumIdentity: value => value?.key || '',
    getIndexedAlbum: key => c.state.gallery.albumIndex.get(key) || null,
    buildApiUrl: () => '/view-data?surface=albums&gallery_page_size=50', parseUrlStateFromUrl: () => ({}),
    buildUrl: value => '/?' + new URLSearchParams({surface: value.surface?.active || 'albums', ...(value.top_ref ? {top_ref: value.top_ref} : {})}),
    scheduleBrowserAnimationFrame(callback) {frames.push(callback); return frames.length;}, cancelBrowserAnimationFrame() {},
    scheduleBrowserTimeout() {return 1;}, clearBrowserTimeout() {},
    renderRelated() {events.push('related');}, hideGalleryOptionsMenu() {}, renderLibraryLoader() {}, showToast() {},
    fetch(url, options = {}) {
      let resolve, reject;
      const promise = new Promise((done, fail) => {resolve = done; reject = fail;});
      const request = {url, options, settled: false, requestId: c.state.ui.activeViewRequestId,
        resolve(value) {if (!request.settled) {request.settled = true; resolve(value);}},
        reject(error) {if (!request.settled) {request.settled = true; reject(error);}}};
      requests.push(request); events.push('fetch');
      options.signal?.addEventListener('abort', () => request.reject(abort()), {once: true});
      return promise;
    },
  });
  const load = file => vm.runInContext(fs.readFileSync(path.join(F.ROOT, 'music_app/static/js', file), 'utf8'), c, {filename: file});
  for (const file of ['runtime/private-ui-transport.js', 'runtime/browser-navigation-helpers.js', 'runtime/track-actions.js',
    'runtime/track-modal-lightbox-helpers.js', 'runtime/gallery-refresh-and-status.js']) load(file);
  // Preserve the genuine response admission and ownership decisions. Isolate
  // final paint and the view sink, as in the existing Loose authority fixture.
  Object.assign(c, {
    cancelTrackModalAlbumDetailsPrewarms() {},
    applyViewPayload(payload, options) {applied.push({payload, options}); c.state.view = payload;},
    renderView() {events.push('paint');}, renderArtistGroups() {events.push('groups');}, resumeScanPageGalleryCoverLoads() {},
  });
  load('runtime/album-tops-react-bridge.js');
  const tracks = vm.runInContext('TrackActionsRuntime', c);
  const respond = (index, payload = topPayload(), status = 200) => {
    assert.ok(requests[index], `Actual fetch ${index} was not dispatched`);
    requests[index].resolve({ok: status >= 200 && status < 300, status, json: async () => payload});
  };
  const read = (url, options = {}) => outcome(c.fetchAndRender(url, false, {skipPendingViewTransition: true, ...options}));
  const source = value => c.getTrackModalPreferenceSource(value);
  const runtime = c.AlbumHavenAlbumTopsRuntime;
  // Observe the unchanged promise immediately so failed early assertions cannot
  // turn teardown cancellation into an unhandled rejection. Return it unchanged.
  const navigate = options => {const pending = runtime.navigate(options); pending.catch(() => {}); return pending;};
  const cleanup = () => {for (const request of requests) if (!request.settled) request.reject(abort());};
  testContext?.after(cleanup);
  return {...h, requests, applied, events, frames, scroll, tracks, respond, read, source, runtime, navigate, cleanup};
}
module.exports = {fixture, topPayload, browsePayload, row, abort, outcome, deferred, settle, F, plain};
