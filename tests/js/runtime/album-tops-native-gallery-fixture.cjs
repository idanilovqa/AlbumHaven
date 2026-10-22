'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withPlaylistDomPlatform} = require('./playlist-dom-platform.cjs');
const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const load = name => import(pathToFileURL(path.join(root, 'music_app/static/js', name)).href);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), A = id(11), B = id(12), IA = id(21), IB = id(22), SCOPE = 'native-gallery:account:session:library';
const progress = (completed = false) => ({progress_revision: completed ? '1' : '0', manual_completed_at: completed ? '2026-10-19T07:00:00Z' : null});
const row = (n = 11, patch = {}) => ({item_ref: id(n + 10), album_ref: id(n), title: `Album ${n}`, artist: 'Artist', year: 2001,
  position: n - 10, original_position: n + 1, native_album: {inventory_album_ref: `native-${n}`, artwork_url: `/library/album-artwork/native-${n}`, allowed_actions: {can_view_details: true}}, ...patch});
function detail(patch = {}) {
  const items = [row(), row(12)];
  return {top_ref: TOP, revision: '7', title: 'Saved Top', description: 'Curated order', visibility: 'private', items,
    allowed_actions: {'library.browse.read': true, can_read: true, can_manage_own_progress: true},
    top_viewer_overlay: {activity: {active: true, activity_revision: '0'}, item_progress: {[A]: progress(), [B]: progress(true)}},
    completion_summary: {completed: 1, total: 2}, ...patch};
}
const state = (data = detail(), patch = {}) => ({scopeKey: SCOPE, selectedTopRef: data.top_ref,
  directory: {status: 'ready', data: {tops: [data], allowed_actions: {'library.browse.read': true}}},
  detail: {status: 'ready', data}, mutation: {status: 'idle', refreshing: false}, ...patch});
function freeze(value) {if (value && typeof value === 'object' && !Object.isFrozen(value)) {Object.freeze(value); Object.values(value).forEach(freeze);} return value;}

function environment() {
  const env = withPlaylistDomPlatform(createNativeHomeRuntime()), {context: c, document: doc} = env;
  const frames = new Map(), timers = new Map(), observers = [], media = new Map(), windowEvents = doc.createElement('window');
  let sequence = 0;
  const enqueue = (queue, callback) => {const key = ++sequence; queue.set(key, callback); return key;};
  class Observer {
    constructor(callback) {this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this);}
    observe(node) {this.targets.add(node);}
    unobserve(node) {this.targets.delete(node);}
    disconnect() {this.targets.clear(); this.disconnected = true;}
  }
  Object.assign(c, {AbortController, URLSearchParams, innerWidth: 1200, innerHeight: 800,
    ResizeObserver: Observer, MutationObserver: Observer,
    addEventListener: (...args) => windowEvents.addEventListener(...args), removeEventListener: (...args) => windowEvents.removeEventListener(...args),
    dispatchEvent: event => windowEvents.dispatchEvent(event),
    requestAnimationFrame: callback => enqueue(frames, callback), cancelAnimationFrame: key => frames.delete(key),
    scheduleBrowserAnimationFrame: callback => enqueue(frames, callback), cancelBrowserAnimationFrame: key => frames.delete(key),
    scheduleBrowserTimeout: callback => enqueue(timers, callback), clearBrowserTimeout: key => timers.delete(key),
    getComputedStyle: () => ({display: 'block', columnGap: '8px'}),
    usesMobilePageLayout: () => c.innerWidth <= 900,
    matchMedia(query) {if (!media.has(query)) {const item = doc.createElement('media'); item.matches = query.includes('reduce') ? false : c.innerWidth <= 600; media.set(query, item);} return media.get(query);},
  });
  doc.defaultView = c;
  const proto = c.Element.prototype, removeChild = c.Node.prototype.removeChild;
  // Browser focus resets when a focused subtree is detached, including DOM moves.
  // This additive platform behavior is essential: otherwise reorder tests can
  // pass with document.activeElement pointing at a detached old button.
  c.Node.prototype.removeChild = function (node) {
    const focused = node.contains(doc.activeElement), result = removeChild.call(this, node);
    if (focused) doc.activeElement = doc.body;
    return result;
  };
  proto.focus = function () {if (this.disabled || !this.isConnected) return; doc.activeElement = this; this.dispatchEvent(new c.Event('focusin'));};
  Object.assign(proto, {clientWidth: 980, clientHeight: 600, scrollWidth: 0, scrollHeight: 0, offsetWidth: 100, offsetHeight: 100});
  Object.defineProperty(proto, 'offsetParent', {configurable: true, get() {return this.parentElement;}});
  Object.defineProperty(proto, 'tabIndex', {configurable: true, get() {return Number(this.getAttribute('tabindex') || 0);}, set(value) {this.setAttribute('tabindex', value);}});
  for (const key of ['albums-scroll', 'artist-groups', 'albums-spacer-top', 'albums-spacer-bottom', 'shell-navigation-rail']) {
    const node = doc.createElement('div'); node.id = key; doc.body.append(node);
  }
  const artistGallery = new Proxy({}, {get() {assert.fail('Top consumer must not read Artist gallery ownership');}, set() {assert.fail('Top consumer must not write Artist gallery ownership');}});
  const artistView = freeze({sentinel: 'untouched Artist view'});
  c.state = {gallery: artistGallery, view: artistView};
  for (const name of ['runtime/compact-player-helpers.js', 'runtime/modal-and-overlay-helpers.js', 'runtime/virtual-artist-grid.js', 'unfolding-action-button.js', 'client-device-preferences.js']) {
    vm.runInContext(read(`music_app/static/js/${name}`), c, {filename: name});
  }
  // The full shared script constructs Artist's idle grid. Its real destructor
  // retires that idle owner before scoped Top ownership begins.
  env.owner('virtualGrid').destroy();
  const host = doc.createElement('section'); doc.body.append(host);
  const selections = [], owners = [], writes = [], chosen = [];
  let shell = {scopeKey: SCOPE, authenticated: true, visible: true, active: true, inLibrary: true, topRef: TOP,
    viewVersion: 1, viewRequestId: 10, galleryDisplayMode: 'cards', galleryScalePercent: 100, mobileGalleryColumns: 3};
  const own = (kind, actual) => {if (!actual) return actual; const record = {kind, actual, disposals: 0}; owners.push(record); return new Proxy(actual, {get(target, key) {
    if (key === 'dispose') return () => {record.disposals++; return target.dispose();};
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  }});};
  const runtime = {snapshot: () => shell,
    galleryCardHtml: env.owner('buildGalleryCardHtml'), artboxHtml: env.owner('buildAlbumArtboxHtml'), escapeHtml: env.owner('escapeHtml'),
    buttonHtml: c.ButtonComponent.renderButton, actionHtml: c.ButtonComponent.renderActionButton, iconHtml: c.ButtonComponent.renderIconSvg,
    alertHtml: env.owner('buildOnPageAlertHtml'),
    viewChooserHtml: config => c.UnfoldingActionButton.render(config),
    mountViewChooser: (node, options) => {chosen.push(options); return c.UnfoldingActionButton.mount(node, options);},
    viewIconHtml(mode) {const holder = doc.createElement('div'); holder.innerHTML = env.owner('buildGalleryBarHtml')({}); return holder.querySelector(`[data-gallery-view-choice="${mode}"] svg`)?.outerHTML || '';},
    createGalleryHost: options => own('gallery', new (env.owner('ResourceGalleryHost'))(options)),
    createGalleryMetadataOwner: options => own('metadata', env.owner('createGalleryCardMetadataMotion')(options)),
    createGalleryFocusOwner: options => own('focus', env.owner('createGalleryFocusGlowOwner')(options)),
    createResourceSelection(options) {const record = {options, invalidations: 0, intents: []}; selections.push(record); return {
      invalidateResourceSelections() {record.invalidations++;}, resourceIntent(...args) {record.intents.push(args); return Promise.resolve(true);},
    };},
    setGalleryDisplayMode(mode) {writes.push(mode); shell = {...shell, galleryDisplayMode: mode}; return true;},
  };
  function flush() {let count = 0; while (frames.size) {assert.ok(++count < 30, 'animation work settles'); const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());}}
  const baseline = {listeners: env.listeners().length, windowListeners: windowEvents.listeners.length};
  return {...env, host, runtime, frames, timers, observers, media, selections, owners, writes, chosen, artistGallery, artistView, baseline, flush,
    setShell(patch) {shell = {...shell, ...patch};}, windowEvents,
    emitWindow(type) {windowEvents.dispatchEvent(new c.Event(type));},
    galleryRoot: () => host.querySelector('.album-row'), cards: () => host.querySelectorAll('.album-card'),
    choose(mode) {const active = host.querySelector('.unfolding-action-button button.is-active'); assert.ok(active); env.click(active); env.click(host.querySelector(`[data-action-value="${mode}"]`));},
  };
}
async function mounted(t, {data = detail(), initialState = state(data), shell = {}, providers = {}, app = false, toolsHost = false, resizeObserver = true} = {}) {
  const f = environment(); f.setShell({topRef: initialState.selectedTopRef, ...shell});
  if (!resizeObserver) f.context.ResizeObserver = undefined;
  const externalTools = toolsHost ? f.document.createElement('span') : null;
  if (externalTools) f.document.body.append(externalTools);
  let value = initialState, owner, currentProviders = providers;
  const calls = [], listeners = new Set();
  const controller = {getSnapshot: () => value, subscribe(callback) {listeners.add(callback); return () => listeners.delete(callback);}, mutate(action, payload) {calls.push({action, payload}); return Promise.resolve(true);},
    load() {}, open() {}, canRetryMutation: () => false};
  const props = () => ({controller, providers: currentProviders, state: value, onOpen: ref => calls.push({action: 'navigate', ref}), ...(externalTools ? {toolsHost: externalTools} : {})});
  const {mountAlbumTopGallery} = await load('album-tops/gallery.mjs');
  const mount = app ? (await load('album-tops/app.mjs')).mountAlbumTopsView : mountAlbumTopGallery;
  owner = mount(f.host, f.runtime, props()); f.flush();
  t.after(() => owner.dispose());
  return {...f, owner, controller, calls, externalTools, getState: () => value,
    setState(next, {render = true} = {}) {value = next; for (const listener of listeners) listener(); if (render) {owner.update(props()); f.flush();}},
    update() {owner.update(props()); f.flush();},
    replaceProviders(next) {currentProviders = next; owner.update(props()); f.flush();},
  };
}
const intent = (card, name) => card.querySelector(`[data-gallery-card-intent="${name}"]`);
module.exports = {root, read, load, id, TOP, OTHER, A, B, IA, IB, SCOPE, row, detail, state, progress, freeze, environment, mounted, intent};
