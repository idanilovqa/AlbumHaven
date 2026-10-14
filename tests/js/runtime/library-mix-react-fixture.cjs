'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createRequire} = require('node:module');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const {installAttributeObservers} = require('./library-mix-observers.cjs');
const {id} = require('./library-mix-fixtures.cjs');
const root = path.resolve(__dirname, '../../..');
let compiled;
function compile() {
  if (compiled) return compiled;
  const local = createRequire(path.join(root, 'package.json'));
  const built = local('esbuild').buildSync({absWorkingDir: root,
    stdin: {resolveDir: root, sourcefile: 'library-mix-mounted-test-entry.jsx', loader: 'jsx', contents: `
      import React, {useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import {LibraryMixSetup, LibraryMixPage, SavedLibraryMixOrder} from './music_app/static/js/playlists/library-mix.jsx';
      import {mountPlaylists} from './music_app/static/js/playlists/index.jsx';
      import {PlaylistsView} from './music_app/static/js/playlists/app.jsx';
      export {mountPlaylists};
      export {createLibraryMixController} from './music_app/static/js/playlists/library-mix.mjs';
      export {createPlaylistController} from './music_app/static/js/playlists/model.mjs';
      export const flush = flushSync;
      export function boot() {require('./music_app/static/js/home-friends/index.jsx');}
      function Saved(props) {const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
        return <PlaylistsView {...props} state={state}/>;}
      export function mount(host, component, props) {
        const root = createRoot(host), Component = {setup: LibraryMixSetup, page: LibraryMixPage, order: SavedLibraryMixOrder, saved: Saved}[component];
        const render = next => flushSync(() => root.render(<Component {...next}/>)); render(props);
        return {render, unmount: () => flushSync(() => root.unmount())};
      }
    `}, bundle: true, platform: 'browser', target: ['es2020'], format: 'iife', globalName: '__libraryMixTest',
    define: {'process.env.NODE_ENV': '"production"'}, write: false, metafile: true});
  const inputs = Object.keys(built.metafile.inputs);
  for (const suffix of ['playlists/library-mix.jsx', 'playlists/track-table.jsx', 'playlists/index.jsx',
    'home-friends/index.jsx', 'home-friends/native-dialog.jsx', 'home-friends/native-choice.jsx', 'home-friends/shared-header.jsx',
    'react-dom-client.production.js', 'react.production.js'])
    assert.ok(inputs.some(name => name.endsWith(suffix)), `SETUP_FAILURE: actual dependency ${suffix}`);
  return compiled = built.outputFiles[0].text;
}
function reactFixture(t) {
  const h = withDomPlatform(nativeFixture()), {context: c, document} = h;
  // Platform support follows the frozen real React fixtures. No hook, component,
  // portal, table, Choice or form lifecycle is replaced with a successful stub.
  const tasks = [], frames = new Map(); let frameId = 0;
  c.MessageChannel = class {
    constructor() {this.port1 = {onmessage: null}; this.port2 = {postMessage: data => tasks.push(() => this.port1.onmessage?.({data}))};}
  };
  Object.defineProperty(c.Node.prototype, 'nodeName', {configurable: true, get() {return this.nodeType === 3 ? '#text' : this.nodeType === 9 ? '#document' : this.tagName;}});
  Object.defineProperty(c.Node.prototype, 'nodeValue', {configurable: true, get() {return this.nodeType === 3 ? this.data : null;},
    set(value) {if (this.nodeType === 3) {const before = this.data; this.data = String(value); h.characterDataChanged?.(this, before);}}});
  Object.defineProperty(c.Element.prototype, 'namespaceURI', {configurable: true, get() {return this.__namespace || 'http://www.w3.org/1999/xhtml';}});
  document.createElementNS = (ns, name) => {const node = document.createElement(name); node.__namespace = ns; return node;};
  document.defaultView = c; document.oninput = null;
  c.HTMLIFrameElement = class {static [Symbol.hasInstance](node) {return node?.tagName === 'IFRAME';}};
  c.navigator = {userAgent: 'bounded actual React Library Mix fixture'}; c.crypto = {randomUUID: () => id(95)};
  c.innerWidth = 1600; c.innerHeight = 1000;
  c.getComputedStyle = node => ({direction: 'ltr', display: 'block', columnGap: '8px', zIndex: node.style.zIndex || 'auto',
    backgroundColor: 'rgb(255, 255, 255)', getPropertyValue: key => node.style.getPropertyValue(key)});
  c.Element.prototype.focus = function () {if (this.isConnected && !this.disabled && !this.closest('[hidden],[inert]')) document.activeElement = this;};
  c.Element.prototype.scrollIntoView = function () {};
  c.Element.prototype.getBoundingClientRect = function () {const width = this.hasAttribute('data-shared-header') ? 1500 : this.tagName === 'BUTTON' ? 90 : 100;
    return {x: 0, y: 0, left: 0, top: 0, width, height: 32, right: width, bottom: 32};};
  c.Element.prototype.getClientRects = function () {return this.isConnected && !this.closest('[hidden]') ? [this.getBoundingClientRect()] : [];};
  c.Node.prototype.replaceWith = function (...nodes) {const parent = this.parentNode; if (!parent) return; for (const node of nodes) parent.insertBefore(node, this); parent.removeChild(this);};
  c.NodeFilter = {SHOW_TEXT: 4};
  document.createTreeWalker = node => {const nodes = []; const visit = parent => {for (const child of parent.childNodes) {if (child.nodeType === 3) nodes.push(child); visit(child);}};
    visit(node); let index = -1; return {currentNode: node, nextNode() {this.currentNode = nodes[++index] || null; return Boolean(this.currentNode);}};};
  document.createRange = () => ({selectNodeContents() {}, getBoundingClientRect() {return {width: 0};}});
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
  vm.runInContext(compile(), c, {filename: 'actual-library-mix-react-mount.js'});
  const api = c.__libraryMixTest, roots = [];
  function drain() {
    let turns = 0;
    while (tasks.length || frames.size) {
      assert.ok(turns++ < 100, 'SETUP_FAILURE: platform queue failed to quiesce');
      while (tasks.length) tasks.shift()();
      const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0);
    }
    assert.deepEqual(errors, [], 'SETUP_FAILURE: no swallowed React errors');
  }
  const flush = action => {const value = api.flush(action); drain(); return value;};
  async function settle() {for (let n = 0; n < 16; n++) {await Promise.resolve(); await observers.flush(); flush(() => {});} assert.deepEqual(errors, []);}
  t.after(async () => {for (const owner of roots) owner.unmount(); await settle(); observers.dispose();});
  function mount(component, props) {
    const host = h.add(`react-mix-${roots.length}`), owner = api.mount(host, component, {runtime, ...props}); roots.push(owner); drain();
    return {host, render: next => {owner.render({runtime, ...next}); drain();}, unmount: owner.unmount};
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
    boot(providers) {c.AlbumHavenPlaylistRuntime = runtime; flush(() => {api.boot(); c.AlbumHavenPlaylistUI.configureProviders(providers);});},
    mixRuntime(controller) {return {...h.runtime.createLibraryMixRuntime({scopeKey: controller.getSnapshot().scopeKey,
      source: () => controller.source(), order: () => controller.getSnapshot().playbackOrder, isCurrent: () => true}), ...renderers};},
    named(label, parent = document) {return parent.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);}};
}
module.exports = {reactFixture};
