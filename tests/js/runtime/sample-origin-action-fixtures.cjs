'use strict';
// Bounded platform composition only. Actual initiating controls, capture adapters,
// PlaylistUI facade, mountPlaylists and Sample page are never substituted.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {installMouseEventDetail, installSampleStateDefaults} = require('./sample-browser-platform.cjs');
const {modalFixture} = require('./sample-origin-modal-fixtures.cjs');
const T = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./sample-origin-fixtures.cjs');
const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const row = (ref, patch = {}) => ({inventory_track_ref: ref, title: 'Canonical track', path: `/test-only/${ref}.flac`,
  artist: 'Artist A', album_artist: 'Artist A', exception_type: '', allowed_actions: {can_read: true, can_play: false}, ...patch});
const album = (patch = {}) => ({key: 'alpha', request_key: 'actual:alpha', name: 'Canonical album', album_artist: 'Artist A',
  source_readable: true, allowed_actions: {can_read: true, can_play_album: false}, tracks: F.refs.map(ref => row(ref)), ...patch});
async function shared(t, overrides = {}) {
  const h = await nativeMixFixture(t); h.installNavigation(); installMouseEventDetail(h.c);
  assert.equal(installSampleStateDefaults(h.state), h.state); assert.equal(h.c.state, h.state);
  let sequence = 3100;
  h.c.crypto.randomUUID = () => F.id(sequence++);
  h.c.AlbumHavenCapabilities = {allows: name => ['library.browse.read', 'library.media.read'].includes(name)};
  const calls = {representatives: [], capture: [], save: [], runtime: [], draft: [], source: []};
  const payload = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: null, items: []}, playlist_detail: null};
  h.state.view = payload; h.runtime.sync();
  const providers = {readPlaylists: async () => payload,
    readSamplePlaylistRepresentatives: async input => {calls.representatives.push(input); return F.v2Representatives(input);},
    captureSamplePlaylist: async input => {calls.capture.push(input); return F.v2Capture(input);},
    readSamplePlaylist: async input => F.v2Capture({...input, options: F.options()}),
    hasPendingPlaylistOperation: () => false,
    createPlaylistFromSelection: async input => {calls.save.push(input); return {status: 'ready', data: {scopeKey: input.scopeKey,
      ok: true, action: 'create', playlist_id: F.id(80), revision: '1', request_key: input.request_key}};}, ...overrides};
  const create = h.runtime.createSamplePlaylistRuntime, open = h.runtime.openDraft;
  h.runtime.createSamplePlaylistRuntime = input => {
    calls.runtime.push(input); const runtime = create(input);
    for (const key of ['buttonHtml', 'actionHtml', 'iconHtml', 'tableHtml', 'artboxHtml', 'albumTrackRow', 'escapeHtml', 'alertHtml', 'navigationItemHtml', 'openChoice']) runtime[key] = h.runtime[key];
    return runtime;
  };
  h.runtime.openDraft = input => {calls.draft.push(input); return open(input);};
  await h.boot(providers); await h.settle();
  const facade = h.c.AlbumHavenPlaylistUI;
  assert.equal(typeof facade.openSamplePlaylist, 'function', 'R3 extends the existing facade, never a test UI');
  assert.equal(Object.isFrozen(facade), true);
  const noAcquisition = () => {
    assert.equal(calls.representatives.length, 0); assert.equal(calls.capture.length, 0); assert.equal(calls.save.length, 0);
  };
  const setup = () => {
    assert.equal(calls.runtime.length, 1, 'one actual Sample runtime owner');
    assert.equal(calls.draft.length, 1, 'one actual shared retained page');
    assert.equal(calls.runtime[0].scopeKey, h.runtime.snapshot().scopeKey);
    assert.equal(calls.draft[0].scopeKey, h.runtime.snapshot().scopeKey);
    assert.equal(calls.runtime[0].isCurrent(), true); assert.equal(calls.draft[0].isCurrent(), true);
    assert.ok(h.named('Generate', h.host), 'actual Sample setup rendered in existing Playlist host'); noAcquisition();
  };
  return {...h, calls, providers, facade, noAcquisition, setup,
    forward(input) {calls.source.push(input.originOwner); return facade.openSamplePlaylist(input);},
    async generate() {
      // Real omitted-option controls are resolved explicitly by the user action.
      // Choices are intentionally not injected into the originating click.
      h.choose('Choose songs', 'per_album'); h.choose('Selection method', 'most_listened'); h.choose('Unknown duration', 'include');
      const count = h.host.querySelector('[aria-label="Songs per group"]');
      count.value = '1'; count.dispatchEvent(new h.c.Event('input'));
      h.click(h.named('Generate', h.host)); await h.settle();
    }};
}
async function top(t, {selected = T.TOP, detail = {}, providers = {}} = {}) {
  // Every action now uses the actual Top bridge, including its pure Sample
  // observer and presentation factory. Saved cases retain a real prepared
  // controller so their post-paint empty/restricted stimuli remain exact.
  const {topOwner} = require('./sample-origin-integration-fixture.cjs');
  assert.ok(selected === null || selected === T.TOP, 'bounded Top action selection');
  return topOwner(t, {mode: selected === null ? 'detached' : 'saved',
    deferDetachedOpen: selected === null, preparedActionView: selected !== null, detail, providers});
}
function physical(h, {value = album(), options = {}} = {}) {
  const m = modalFixture(), c = m.c;
  c.document = h.document; c.window = h.c; c.HTMLElement = h.c.HTMLElement; c.Element = h.c.Element; c.Event = h.c.Event;
  c.ButtonComponent = h.c.ButtonComponent; c.escapeHtml = h.c.escapeHtml;
  c.TrackActionsRuntime = h.owner('TrackActionsRuntime'); c.AlbumHavenPlaylistRuntime = h.runtime;
  c.AlbumHavenCapabilities = h.c.AlbumHavenCapabilities;
  c.scheduleBrowserTimeout = h.c.scheduleBrowserTimeout; c.clearBrowserTimeout = h.c.clearBrowserTimeout;
  c.scheduleBrowserAnimationFrame = h.c.scheduleBrowserAnimationFrame;
  c.cancelBrowserAnimationFrame = h.c.cancelBrowserAnimationFrame;
  const overlay = h.add('track-modal'); overlay.className = 'track-modal'; overlay.hidden = true;
  const keys = ['header', 'cover', 'missingWarning', 'duplicateWarning', 'duplicateTabs', 'list', 'footer', 'tabs'];
  const elements = {overlay};
  for (const key of keys) {const node = h.document.createElement('div'); node.id = `track-modal-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`; overlay.append(node); elements[key] = node;}
  c.getTrackModalElements = () => ({...elements, close: overlay.querySelector('#track-modal-close'),
    folder: overlay.querySelector('#track-modal-folder'), editTags: overlay.querySelector('#track-modal-edit-tags')});
  // Full production physical renderer and action renderers. Only cover/taste,
  // table visuals and shared-player decoration are outside this unit boundary.
  for (const file of ['runtime/utility-list-builders.js', 'runtime/album-details-components.js', 'runtime/tag-editor-and-optimistic-updates.js'])
    vm.runInContext(read(`music_app/static/js/${file}`), c, {filename: file});
  c.renderOwnTrackModalAlbumPreferences = () => {};
  c.buildTrackListHtml = () => '<table></table>';
  c.refreshTrackModalPlaybackState = () => {};
  c.buildOnPageAlertHtml = h.c.buildOnPageAlertHtml;
  const captured = [], original = c.captureTrackModalSampleOrigin;
  assert.equal(typeof original, 'function');
  c.captureTrackModalSampleOrigin = input => {const lease = original(input); captured.push({input, lease}); return lease;};
  c.attachModalEvents(); c.openTrackModal(value, {releaseSet: {releases: [value], selectedIndex: 0}, ...options});
  return {...m, c, elements, captured,
    button: index => index === undefined ? elements.header.querySelector('[data-create-sample-playlist="1"]')
      : elements.duplicateWarning.querySelector(`[data-create-sample-playlist="1"][data-duplicate-source-index="${index}"]`)};
}
async function loose(h) {
  const m = physical(h); m.c.closeTrackModal();
  // Complete the real two-frame physical cleanup before establishing loose
  // source identity. Idle compaction must not retire the newly acquired lease.
  await h.settle();
  const c = m.c;
  for (const id of ['non-album-modal', 'non-album-modal-header', 'non-album-modal-table']) {
    const node = h.add(id); if (id !== 'non-album-modal') h.document.getElementById('non-album-modal').append(node);
  }
  c.state.gallery.mainState = {categories: ['main_library']};
  c.state.view = {selected_artist: 'Artist A', related_artists: ['Family Alias'], non_album_library_categories: ['main_library'],
    artist_family_filters: [{display_name: 'Artist A', variation_names: ['Family A']}],
    non_album_tracks: [row(F.refs[0], {exception_type: 'Interview'}),
      row(F.refs[1], {artist: 'Family A', album_artist: 'Family A', exception_type: 'Non-album rarity'}),
      row(F.refs[2], {artist: 'Unrelated', album_artist: 'Unrelated', display_path: 'Family_Alias/loose.flac'}),
      row('inventory-track:5:99', {artist: 'Other', album_artist: 'Other'})]};
  const captured = [], original = c.captureNonAlbumSampleOrigin; assert.equal(typeof original, 'function');
  c.captureNonAlbumSampleOrigin = input => {const lease = original(input); captured.push({input, lease}); return lease;};
  c.openNonAlbumModal();
  return {...m, captured, button: () => h.document.querySelector('[data-create-non-album-sample-playlist="1"]')};
}
module.exports = {shared, top, physical, loose, row, album, T, F};
