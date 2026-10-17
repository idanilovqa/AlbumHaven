'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const {withPlaylistDomPlatform} = require('./playlist-dom-platform.cjs');
const {installAttributeObservers} = require('./library-mix-observers.cjs');
const {id} = require('./library-mix-fixtures.cjs');
const root = path.resolve(__dirname, '../../..');
let entrySequence = 0;
// Traverse the delivered native owners without freezing their implementation
// bytes. Reviewed source hashes are external packet staging evidence only.
const nativeEntries = [
  "music_app/static/js/playlists/native-library-mix.mjs",
  "music_app/static/js/playlists/native-app.mjs",
  "music_app/static/js/playlists/library-mix.mjs",
  "music_app/static/js/playlists/model.mjs",
  "music_app/static/js/home-friends/index-native.mjs"
];
function verifyNativeClosure() {
  const visited = new Set();
  function visit(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    assert.ok(relative.startsWith('music_app/static/js/') && relative.endsWith('.mjs'), 'native module stays in the delivery root');
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:react(?:-dom)?(?:\/|['"])|esbuild(?:\/|['"]))/);
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/, 'native closure uses statically traversable ES module imports');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\1/g)) {
      const specifier = match[2];
      assert.ok(specifier.startsWith('.'), `SETUP_FAILURE: bare dependency ${specifier}`);
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
  nativeEntries.forEach(visit);
  for (const relative of [
    'playlists/native.mjs', 'playlists/native-library-mix.mjs', 'playlists/native-app.mjs',
    'playlists/native-track-table.mjs', 'playlists/library-mix.mjs', 'playlists/model.mjs',
    'home-friends/index-native.mjs', 'home-friends/native-dialog.mjs',
    'home-friends/native-controls.mjs', 'home-friends/shared-header.mjs',
  ]) assert.ok(visited.has(`music_app/static/js/${relative}`), `SETUP_FAILURE: actual native dependency ${relative}`);
}
const load = relative => import(pathToFileURL(path.join(root, 'music_app/static/js', relative)).href);
async function nativeMixFixture(t) {
  verifyNativeClosure();
  const h = withPlaylistDomPlatform(nativeFixture()), {context: c, document} = h;
  // Browser platform only. Product forms, menus, tables and owner lifetimes
  // are always the delivered native implementations.
  const tasks = [], frames = new Map(); let frameId = 0;
  c.MessageChannel = class {
    constructor() {this.port1 = {onmessage: null}; this.port2 = {postMessage: data => tasks.push(() => this.port1.onmessage?.({data}))};}
  };
  Object.defineProperty(c.Node.prototype, 'nodeName', {configurable: true, get() {return this.nodeType === 3 ? '#text' : this.nodeType === 9 ? '#document' : this.tagName;}});
  Object.defineProperty(c.Node.prototype, 'nodeValue', {configurable: true, get() {return this.nodeType === 3 ? this.data : null;},
    set(value) {if (this.nodeType === 3) {const before = this.data; this.data = String(value); h.characterDataChanged?.(this, before);}}});
  Object.defineProperty(c.Element.prototype, 'namespaceURI', {configurable: true, get() {return this.__namespace || 'http://www.w3.org/1999/xhtml';}});
  document.createElementNS = (ns, name) => {const node = document.createElement(name); node.__namespace = ns; return node;};
  for (const name of ['min', 'max', 'step', 'type', 'name', 'inputMode']) {
    const attribute = name.toLowerCase();
    Object.defineProperty(c.Element.prototype, name, {configurable: true,
      get() {return this.getAttribute(attribute) || '';}, set(value) {this.setAttribute(attribute, value);}});
  }
  Object.defineProperty(c.Element.prototype, 'tabIndex', {configurable: true,
    get() {return Number(this.getAttribute('tabindex') || 0);}, set(value) {this.setAttribute('tabindex', value);}});
  c.Element.prototype.select = function () {this.selectionStart = 0; this.selectionEnd = String(this.value || '').length;};
  c.Element.prototype.blur = function () {if (document.activeElement === this) document.activeElement = document.body;};
  document.defaultView = c; document.oninput = null;
  c.HTMLIFrameElement = class {static [Symbol.hasInstance](node) {return node?.tagName === 'IFRAME';}};
  c.navigator = {userAgent: 'bounded actual native Library Mix fixture'}; c.crypto = {randomUUID: () => id(95)};
  c.innerWidth = 1600; c.innerHeight = 1000;
  c.getComputedStyle = node => ({direction: 'ltr', display: 'block', columnGap: '8px', zIndex: node.style.zIndex || 'auto',
    backgroundColor: 'rgb(255, 255, 255)', getPropertyValue: key => node.style.getPropertyValue(key)});
  c.Element.prototype.focus = function () {if (this.isConnected && !this.disabled && !this.closest('[hidden],[inert]')) document.activeElement = this;};
  c.Element.prototype.scrollIntoView = function () {};
  c.Element.prototype.getBoundingClientRect = function () {const width = this.hasAttribute('data-shared-header') ? 1500 : this.tagName === 'BUTTON' ? 90 : 100;
    return {x: 0, y: 0, left: 0, top: 0, width, height: 32, right: width, bottom: 32};};
  c.Element.prototype.getClientRects = function () {return this.isConnected && !this.closest('[hidden]') ? [this.getBoundingClientRect()] : [];};
  c.requestAnimationFrame = callback => {const id = ++frameId; frames.set(id, callback); return id;};
  c.cancelAnimationFrame = id => frames.delete(id);
  const observers = installAttributeObservers(h);
  for (const file of ['compact-data-table.js', 'trigger-anchor.js', 'library-settings.js', 'browser-dialog-helpers.js']) h.load(`runtime/${file}`);
  const template = h.add('navigation-tree-item-template', 'script');
  template.textContent = fs.readFileSync(path.join(root, 'music_app/templates/components/navigation-tree-item.html'), 'utf8'); h.load('navigation-tree.js');
  const form = h.add('app-form-modal'); form.hidden = true; form.className = 'confirm-modal';
  form.innerHTML = '<div class="confirm-modal-dialog" role="dialog" aria-modal="true"><h2 id="app-form-title"></h2><button id="app-form-close" hidden></button><div id="app-form-content"></div><p id="app-form-error"></p><div class="confirm-modal-actions"><button id="app-form-cancel"></button><button id="app-form-submit"></button></div></div>';
  const renderers = {
    buttonHtml: value => c.ButtonComponent.renderButton(value), actionHtml: value => c.ButtonComponent.renderActionButton(value),
    iconHtml: (name, options) => c.ButtonComponent.renderIconSvg(name, options),
    tableHtml: value => c.buildCompactDataTable(value), artboxHtml: value => c.buildAlbumArtboxHtml(value),
    albumTrackRow: (row, index) => c.buildAlbumTrackTableRow({...row, duration: row.duration_display}, index, {readOnly: true}),
    escapeHtml: c.escapeHtml, alertHtml: value => c.buildOnPageAlertHtml(value),
    navigationItemHtml: value => c.NavigationTree.renderItem(value),
    openChoice: c.openUtilityChoiceDropdown, openForm: options => c.openReactFormDialog(options, () => true),
  };
  const runtime = {...h.runtime, ...renderers, createPlaytableSource: undefined, trackPreference: () => null, setTrackLove: undefined};
  runtime.createLibraryMixRuntime = options => ({...h.runtime.createLibraryMixRuntime(options), ...renderers});
  const errors = []; c.reportError = error => errors.push(error);
  const savedGlobals = new Map();
  for (const [name, value] of Object.entries({window: c, document, Event: c.Event, crypto: c.crypto})) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  const roots = [], controllers = [];
  let booted = false;
  function drain() {
    let turns = 0;
    while (tasks.length || frames.size) {
      assert.ok(turns++ < 100, 'SETUP_FAILURE: platform queue failed to quiesce');
      while (tasks.length) tasks.shift()();
      const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0);
    }
    assert.deepEqual(errors, [], 'SETUP_FAILURE: no swallowed native errors');
  }
  const flush = action => {const value = action(); drain(); return value;};
  async function settle() {for (let n = 0; n < 16; n++) {await Promise.resolve(); await observers.flush(); flush(() => {});} assert.deepEqual(errors, []);}
  t.after(async () => {
    try {
      for (const owner of roots.reverse()) owner.unmount();
      if (booted) {
        c.AlbumHavenPlaylistUI.configureProviders({});
        h.shell.dataset.nativeAccountId = ''; h.shell.dataset.nativeLibraryId = ''; h.runtime.sync();
      }
      for (const controller of controllers.reverse()) controller.dispose();
      await settle();
    } finally {
      try {observers.dispose();} finally {
        for (const [name, descriptor] of savedGlobals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
        }
      }
    }
  });
  const mix = await load('playlists/native-library-mix.mjs');
  const app = await load('playlists/native-app.mjs');
  const domain = await load('playlists/library-mix.mjs');
  const model = await load('playlists/model.mjs');
  const api = {
    createLibraryMixController(options) {const value = domain.createLibraryMixController(options); controllers.push(value); return value;},
    createPlaylistController(options) {const value = model.createPlaylistController(options); controllers.push(value); return value;},
  };
  for (const [name, owner] of Object.entries({
    mountLibraryMixSetup: mix.mountLibraryMixSetup, mountLibraryMixPage: mix.mountLibraryMixPage,
    mountSavedLibraryMixOrder: mix.mountSavedLibraryMixOrder, mountPlaylistsView: app.mountPlaylistsView,
    createLibraryMixController: domain.createLibraryMixController, createPlaylistController: model.createPlaylistController,
  })) assert.equal(typeof owner, 'function', `actual native export ${name}`);
  function mount(component, props) {
    const host = h.add(`native-mix-${roots.length}`);
    let current = {runtime, ...props}, disposed = false, stop = null, owner;
    const mountOwner = {setup: mix.mountLibraryMixSetup, page: mix.mountLibraryMixPage,
      order: mix.mountSavedLibraryMixOrder, saved: app.mountPlaylistsView}[component];
    assert.equal(typeof mountOwner, 'function', `actual native owner for ${component}`);
    const complete = () => component === 'saved' ? {...current, state: current.controller.getSnapshot()} : current;
    owner = mountOwner(host, current.runtime, complete());
    function subscribe() {
      if (component !== 'saved') return;
      const controller = current.controller;
      stop = controller.subscribe(() => {if (!disposed && current.controller === controller) owner.update(complete());});
      owner.update(complete());
    }
    subscribe();
    const result = {host, render(next) {
      if (disposed) return;
      const before = current.controller; current = {runtime, ...next};
      if (component === 'saved' && before !== current.controller) {stop?.(); stop = null; subscribe();}
      owner.update(complete()); drain();
    }, unmount() {if (disposed) return; disposed = true; stop?.(); stop = null; owner.dispose();}};
    roots.push(result); drain(); return result;
  }
  function click(node) {assert.ok(node, 'activation target exists'); assert.equal(node.disabled, false, 'enabled native activation');
    return flush(() => node.dispatchEvent(new c.MouseEvent('click', {bubbles: true, cancelable: true})));}
  function choose(label, value) {
    const trigger = document.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || '').startsWith(label + ':'));
    click(trigger); const option = document.querySelector(`[data-foobar-format="${value}"]`); click(option); return trigger;
  }
  function installNavigation() {
    const location = c.location, entries = [{url: location.href, state: {...c.history.state}}]; let index = 0;
    c.history = {get state() {return entries[index].state;},
      replaceState(value, _title, url) {location.href = new URL(url || location.href, location).href; entries[index] = {url: location.href, state: structuredClone(value)};},
      pushState(value, _title, url) {location.href = new URL(url, location).href; entries.splice(++index, Infinity, {url: location.href, state: structuredClone(value)});},
      go() {throw new Error('Use the independently exercised native-history fixture for Back/Forward');}};
    for (const attribute of ['data-settings-host', 'data-settings-outlet', 'data-settings-nav']) {const node = h.add(attribute); node.setAttribute(attribute, ''); if (attribute === 'data-settings-host') node.hidden = true;}
    c.DOMParser = class {}; c.structuredClone = structuredClone;
    h.load('runtime/mobile-home.js'); h.load('settings-navigation.js');
    return {entries};
  }
  return {...h, c, runtime, api, form, errors, flush, settle, mount, click, choose,
    installNavigation,
    async boot(providers) {
      assert.equal(booted, false, 'one entry owner per fixture');
      c.AlbumHavenPlaylistRuntime = runtime;
      await import(`${pathToFileURL(path.join(root, 'music_app/static/js/home-friends/index-native.mjs')).href}?library-mix-test=${++entrySequence}`);
      booted = true; flush(() => c.AlbumHavenPlaylistUI.configureProviders(providers));
    },
    mixRuntime(controller) {return {...h.runtime.createLibraryMixRuntime({scopeKey: controller.getSnapshot().scopeKey,
      source: () => controller.source(), order: () => controller.getSnapshot().playbackOrder, isCurrent: () => true}), ...renderers};},
    named(label, parent = document) {return parent.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);}};
}
module.exports = {nativeMixFixture};
