// Whole-source unit fixture. Real browse ownership, read epoch, shared receipt,
// and TrackActionsRuntime code; only transport and unrelated paint endpoints are
// isolated. This is not an HTTP server, authentication, database or browser test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repositoryRoot = process.env.LOOSE_AUTHORITY_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');
const runtimeRoot = path.join(repositoryRoot, 'music_app/static/js/runtime');
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
const overlay = (tier = 'off', writable = true) => ({rating: null, love_tier: tier,
  allowed_actions: {can_rate: writable, can_set_love_tier: writable}});
const looseRow = (id = 11, patch = {}) => ({track_id: id, path: `/synthetic/loose-authority/${id}.flac`,
  title: `Loose ${id}`, artist: 'Fixture Artist', filename: `${id}.flac`, duration_seconds: 120,
  canonical_track_ref: `track:loose-authority-${id}`, inventory_track_ref: `inventory-track:9:${id}`,
  track_preference_state: 'available', track_preference: overlay(), source_readable: true,
  allowed_actions: {can_read: true}, playback_state: {can_start_here: true}, ...patch});
const browsePayload = (rows = [looseRow()], patch = {}) => ({ok: true, surface: {active: 'albums'},
  query: '', selected_artist: '', artist_groups: [], artists_sidebar: [], artist_count: 0,
  album_count: 0, non_album_tracks: rows, non_album_track_count: rows.length,
  visible_library_categories: [], gallery_scope: '', payload_tier: 'full', ...patch});
const settle = async () => {for (let step = 0; step < 12; step++) await Promise.resolve();};

function createLooseAuthorityFixture() {
  const requests = [], batches = [], directReads = [], epochReads = [], applied = [], frames = [], paint = [], redirects = [];
  const shell = {dataset: {nativeAccountId: '7', nativeLibraryId: '9'}};
  const scroll = {clientHeight: 800, scrollHeight: 800, scrollTop: 0};
  const nodes = new Map([['app-shell', shell], ['albums-scroll', scroll]]);
  const document = {documentElement: {getAttribute: () => null},
    getElementById: id => nodes.get(id) || null, querySelectorAll: () => []};
  const state = {ui: {}, status: {inventory_mutation_revision: 1}, gallery: {albumIndex: new Map()},
    view: browsePayload([]), player: {}};
  const window = {location: {href: 'https://albumhaven.test/', assign: value => redirects.push(value)},
    history: {state: {}}, addEventListener() {}, removeEventListener() {}};
  let generation = 1;
  const bindings = {window, document, state, URL, URLSearchParams, AbortController, console,
    PrivateUITransport: {generation: () => generation},
    fetch: (url, options = {}) => new Promise((resolve, reject) => {
      requests.push({url, options, resolve, reject, dispatchEpoch: runtime.readEpoch(), dispatchBatchCount: batches.length});
    }),
    getAlbumRequestKey: value => value?.key || '', getAlbumIdentity: value => value?.key || '',
    getIndexedAlbum: key => state.gallery.albumIndex.get(key) || null,
    albumRequiresHydration: value => Boolean(value && !Array.isArray(value.tracks)),
    // This focused browse fixture has no Album modal DOM. Keep the real
    // attachModalEvents owner and provide its ordinary empty DOM lookup.
    getTrackModalElements: () => ({overlay: document.getElementById('track-modal')}),
    startupMetrics: {markOnce() {}, schedulePaintMark() {}, completeInitialRefresh() {}, completeVisibleInitialRefresh() {}},
    buildApiUrl: value => typeof value === 'string' ? value : '/view-data?surface=albums&gallery_page_size=50',
    parseBrowserUrlState: () => ({}),
    scheduleBrowserAnimationFrame: callback => {frames.push(callback); return frames.length;},
    cancelBrowserAnimationFrame() {}, scheduleBrowserTimeout: () => 1,
    renderRelated() {}, hideGalleryOptionsMenu() {}, renderLibraryLoader() {},
    pushBrowserViewState() {}, showToast() {},
    appBootstrap: {},
  };
  // The actions file runs whole and unchanged in its own lexical context. A
  // forwarding observer lets tests count readBatch calls without mutating the
  // frozen product runtime or substituting its admission decisions.
  const actionContext = vm.createContext(bindings);
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, 'track-actions.js'), 'utf8'), actionContext,
    {filename: 'track-actions.js'});
  const runtime = vm.runInContext('TrackActionsRuntime', actionContext);
  const observed = Object.freeze({...runtime,
    readEpoch() {const epoch = runtime.readEpoch(); epochReads.push(epoch); return epoch;},
    acceptRead(...args) {directReads.push(args); return runtime.acceptRead(...args);},
    readBatch(epoch) {
      const batch = runtime.readBatch(epoch), record = {epoch, sources: [], results: []}; batches.push(record);
      return Object.freeze({get epoch() {return batch.epoch;}, accept(source) {
        record.sources.push(source); const accepted = batch.accept(source); record.results.push(accepted); return accepted;
      }});
    },
  });
  const context = vm.createContext({...bindings, TrackActionsRuntime: observed});
  const loadRuntime = file => vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), context, {filename: file});
  loadRuntime('track-modal-lightbox-helpers.js');
  loadRuntime('gallery-refresh-and-status.js');
  // Keep fetchAndRender, readGalleryResponse, currentness, pagination and
  // refresh collection genuine. Paint and the final view sink are unit seams.
  Object.assign(context, {
    cancelTrackModalAlbumDetailsPrewarms() {},
    applyViewPayload(payload, options) {applied.push({payload, options}); state.view = payload;},
    renderView: options => paint.push({kind: 'view', options}),
    renderArtistGroups: options => paint.push({kind: 'groups', options}),
    resumeScanPageGalleryCoverLoads() {},
  });
  const read = (url = '/view-data?surface=albums', options = {}) => outcome(context.fetchAndRender(url, false,
    {skipPendingViewTransition: true, ...options}));
  const respond = (index, payload, status = 200) => {
    assert.ok(requests[index], `No request ${index} was dispatched`);
    requests[index].resolve({ok: status >= 200 && status < 300, status, json: async () => payload});
  };
  async function load(payload = browsePayload(), url, options) {
    const index = requests.length, pending = read(url, options); respond(index, payload);
    const result = await pending;
    assert.ifError(result.error); assert.equal(result.value, true, 'The genuine browse fetch must apply successfully');
    return payload;
  }
  const source = row => context.getTrackModalPreferenceSource(row);
  const preference = row => {const value = source(row); return value && runtime.preference(value);};
  return {context, actionContext, runtime, observed, requests, batches, directReads, epochReads, state, shell, scroll, nodes, document,
    applied, frames, paint, redirects, read, respond, load, source, preference, loadRuntime,
    changeSession: () => {generation++;}};
}
module.exports = {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome, settle, repositoryRoot, runtimeRoot};
