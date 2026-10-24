// New fixture: native bridge setup adapted from the pinned home-friends-bridge test.
// Existing tests and fixtures remain unchanged. Application code is not replaced.
const {installPrivateContext} = require('./private-context-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/home-friends-bridge.js'), 'utf8');
const local = (ref = 'album:one', patch = {}) => ({album_ref: ref, name: 'Album', row_kind: 'local_album',
  local_match_state: 'matched_local', allowed_actions: {can_open_album: true, can_play_album: true}, ...patch});
const recent = (rows = [local()]) => ({context_ref: 'a'.repeat(64),recent_local_albums: rows, recent_not_local_albums: []});
const album = (key = 'album:one') => ({key, name: 'Album', tracks: [{path: '/test-only/music/song.flac', src: '/track?test-only', title: 'Song'}]});
function setup(payload = recent(), {captureResourceRevalidator = false} = {}) {
  const home = {dataset: {homeAccountId: 'fallback-account', homeLibraryId: 'fallback-library', accountName: 'Listener'}};
  const shell = {dataset: {nativeAccountId: 'account:one', nativeLibraryId: 'library:one'}, hidden: false};
  const nodes = new Map([['mobile-home', home], ['app-shell', shell]]), events = new Map(), observers = [];
  const calls = {reads: [], details: [], opens: [], builds: [], queues: [], plays: [], confirms: []};
  const state = {view: payload, ui: {pendingTrackModalLoadToken: 0}, player: {playbackQueue: {owner: 'previous'}}};
  const window = {location: new URL('https://albumhaven.test/?surface=home'), history: {state: {albumHavenNavigationPosition: 4}},
    addEventListener: (name, listener) => events.set(name, listener), dispatchEvent() {},
    AlbumHavenCapabilities: {allows: capability => capability === 'library.media.read'}};
  const context = vm.createContext({window, document: {getElementById: id => nodes.get(id)}, state, URL, Event,
    AbortController,
    shouldShowMobileHome: () => !shell.hidden && !state.ui.pendingViewTransition,
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe(target, options) {this.target = target; this.options = options;}},
    fetch: async (...args) => {calls.reads.push(args); throw new Error('Unexpected Home network request');},
    fetchTrackModalAlbumDetails: async (...args) => {calls.details.push(args); return album(args[0]);},
    albumRequiresHydration: () => false, getTrackModalElements: () => ({overlay: {}}),
    openTrackModal: (...args) => calls.opens.push(args), playerTrackSelectionToken: 0,
    releaseTrackModalSelection() {},
    buildAlbumPlaybackQueueState: value => {calls.builds.push(value); return {tracks: value.tracks};},
    setAlbumPlaybackQueue: (value, selected) => {calls.queues.push([value, selected]); state.player.playbackQueue = {album: value, selected};},
    playTrackFromPayload: async value => {calls.plays.push(value); return true;},
    showAppConfirmDialog: value => {calls.confirms.push(value); return Promise.resolve(false);},
    escapeHtml: String,
  });
  installPrivateContext(context);
  for (const name of ['track-actions.js', 'resource-selection.js', 'playtable-source.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', name), 'utf8'), context, {filename: name});
  }
  let revalidateResource, retainResource;
  if (captureResourceRevalidator) {
    const nativeSelection = window.AlbumHavenResourceSelection;
    window.AlbumHavenResourceSelection = Object.freeze({...nativeSelection, create(options) {
      revalidateResource = options.revalidateResource;
      retainResource = options.retainResource;
      return nativeSelection.create(options);
    }});
  }
  vm.runInContext(source, context, {filename: 'home-friends-bridge.js'});
  return {bridge: window.AlbumHavenHomeRuntime, revalidateResource, retainResource, context, window, state, home, shell, nodes, observers, events, calls};
}

module.exports = {setup};

