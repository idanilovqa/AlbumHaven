const {installPrivateContext, STAMP} = require('./private-context-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const root = path.resolve(__dirname, '../../../music_app/static/js');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

function harness() {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = (id, attribute) => {
    const node = document.createElement('div'); if (id) node.id = id;
    if (attribute) node.setAttribute(attribute, ''); document.body.appendChild(node); return node;
  };
  const shell = add('app-shell'); shell.dataset.privateUiContext = 'a'.repeat(64); shell.dataset.nativeAccountId = 'account:one'; shell.dataset.nativeLibraryId = 'library:one';
  add('playlists-root'); add('shell-main-surface'); add('mobile-home');
  const settings = add(null, 'data-settings-host'); settings.hidden = true;
  add(null, 'data-settings-outlet'); add(null, 'data-settings-nav');
  const location = new URL('https://albumhaven.test/?surface=playlists&playlist_id=source');
  const entries = [{url: location.href, state: {albumHavenNavigationPosition: 0}}], listeners = [];
  let index = 0;
  const calls = {fetch: [], gallery: 0, discard: 0, confirm: 0};
  const dispatch = () => {
    const event = {state: entries[index].state, stopped: false, stopImmediatePropagation() {this.stopped = true;}};
    for (const capture of [true, false]) for (const listener of listeners.filter(value => value.name === 'popstate' && value.capture === capture)) {
      if (!event.stopped) listener.callback(event);
    }
    if (!event.stopped) context.handleGalleryBootstrapPopState();
  };
  const history = {
    get state() {return entries[index].state;},
    pushState(value, title, url) {location.href = new URL(url, location).href; entries.splice(++index, Infinity, {url: location.href, state: structuredClone(value)});},
    replaceState(value, title, url) {location.href = new URL(url || location.href, location).href; entries[index] = {url: location.href, state: structuredClone(value)};},
    go(delta) {queueMicrotask(() => {if (index + delta < 0 || index + delta >= entries.length) return; index += delta; location.href = entries[index].url; dispatch();});},
  };
  const view = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'source', items: []},
    playlist_detail: {playlist_id: 'source', title: 'Real source', track_rows: []}};
  Object.assign(context, {URL, URLSearchParams, AbortController, location, history, innerWidth: 1200,
    state: {view, ui: {}}, AlbumHavenHomeRuntime: {}, DOMParser: class {},
    addEventListener: (name, callback, capture = false) => listeners.push({name, callback, capture: capture === true}),
    removeEventListener() {}, dispatchEvent() {},
    fetch: (...args) => {calls.fetch.push(args); return Promise.reject(new Error('No transport expected'));},
    buildUrl: value => value.url || '/?artist=Retained',
    NavigationTree: {setSelection() {}},
  });
  installPrivateContext(context);
  for (const file of ['runtime/mobile-home.js', 'settings-navigation.js', 'runtime/mobile-navigation.js', 'runtime/browser-navigation-helpers.js',
    'runtime/gallery-refresh-and-status.js', 'runtime/bootstrap-gallery-event-handlers.js', 'runtime/track-actions.js', 'runtime/playlists-react-bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const nativePop = context.handleGalleryBootstrapPopState;
  context.handleMobilePagePopState = () => false;
  context.handleGalleryBootstrapPopState = () => {
    calls.gallery++;
    if (context.AlbumHavenPlaylistRuntime.restoreDraftFromHistory()) return;
    context.syncMobileHome();
  };
  const runtime = context.AlbumHavenPlaylistRuntime, navigation = context.AlbumHavenSettingsNavigation.instance;
  let current = true, decision = true;
  const open = () => runtime.openDraft({token: 'draft:one', scopeKey: runtime.snapshot().scopeKey,
    isCurrent: () => current, confirmLeave: () => {calls.confirm++; return decision;}, onDiscard: () => {calls.discard++; current = false;}});
  return {...native, runtime, navigation, shell, settings, location, history, entries, view, calls, open, nativePop,
    decision(value) {decision = value;}, invalidate() {current = false;}, index: () => index};
}


module.exports = {harness, settle, plain};
