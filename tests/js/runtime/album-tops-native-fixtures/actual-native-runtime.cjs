'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime, readRepo} = require('../native-home-harness.cjs');
const {withDomPlatform} = require('../artist-host-fixtures/dom-platform.cjs');
const root = path.resolve(__dirname, '../../../..');
const load = name => import(pathToFileURL(path.join(root, 'music_app/static/js', name)).href);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), ALBUM = id(11), SCOPE = 'tops-native:account:session:library';
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
// This is a bounded microtask drain, not a wait for external work. Deferred
// providers and navigation must be explicitly resolved by each test.
async function drain() {for (let n = 0; n < 20; n++) await Promise.resolve();}
const permissions = () => ({'library.browse.read': true, 'library.album_tops.create': true,
  'library.album_tops.items.manage': true, can_create: true, can_read: true, can_edit: true,
  can_add: true, can_remove: true, can_reorder: true, can_delete: true, can_view_sharing: true,
  can_share: true, can_copy: true, can_request_edit: true, can_manage_own_progress: true});
const detail = patch => ({top_ref: TOP, revision: '7', title: 'Curated Top', description: 'Subtitle',
  visibility: 'private', allowed_actions: permissions(), items: [], ...patch});
const sharing = patch => ({top_ref: TOP, revision: '7', visibility: 'private', can_manage: true,
  can_request_edit: true, can_copy: true, request_status: 'none', pending_requests: [], next_pending_cursor: null, ...patch});
function service(overrides = {}) {
  const calls = [], data = {detail: detail(), directory: null};
  const record = (method, args, fallback) => {calls.push({method, args}); return overrides[method] ? overrides[method](...args) : fallback();};
  const providers = {
    list: options => record('list', [options], () => Promise.resolve(data.directory || {tops: [data.detail], allowed_actions: permissions()})),
    read: (ref, options) => record('read', [ref, options], () => Promise.resolve({...data.detail, top_ref: ref})),
    readSharing: (ref, options) => record('readSharing', [ref, options], () => Promise.resolve(sharing({top_ref: ref, revision: data.detail.revision}))),
    readAccessGrants: (ref, options) => record('readAccessGrants', [ref, options], () => Promise.resolve({top_ref: ref, revision: data.detail.revision, grants: [], next_cursor: null})),
    readAccessCandidates: (ref, options) => record('readAccessCandidates', [ref, options], () => Promise.resolve({top_ref: ref, revision: data.detail.revision, candidates: [], next_cursor: null})),
    searchAlbums: options => record('searchAlbums', [options], () => Promise.resolve({albums: [{local_album_id: 11, album_ref: ALBUM, title: 'Found album', artist: 'Artist', year: 2001}], next_cursor: null})),
    admitAlbum: (local, options) => record('admitAlbum', [local, options], () => Promise.resolve({album_ref: id(local)})),
    execute: (action, command, options) => record('execute', [action, command, options], () => Promise.resolve({action, request_key: command.request_key, top_ref: command.top_ref || OTHER, revision: '8'})),
    dispose: () => calls.push({method: 'dispose', args: []}),
  };
  return {providers, calls, data, count: method => calls.filter(call => call.method === method).length};
}
async function preparedController(service, {selected = TOP} = {}) {
  const {createAlbumTopController} = await load('album-tops/model.mjs'); let key = 100;
  const controller = createAlbumTopController({providers: service.providers, requestKey: () => id(++key)});
  controller.setScope(SCOPE); await controller.load(); if (selected) await controller.open(selected); return controller;
}
function nativeEnvironment() {
  const env = withDomPlatform(createNativeHomeRuntime()), {document, context} = env;
  const frames = new Map(), observers = [], windowListeners = []; let sequence = 0;
  // Browser platform only: no consumer/domain/native helper is replaced.
  const platform = {
    innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({display: 'block', columnGap: '8', overflowY: 'visible'}),
    requestAnimationFrame(callback) {frames.set(++sequence, callback); return sequence;}, cancelAnimationFrame: key => frames.delete(key),
    addEventListener(type, callback, capture = false) {windowListeners.push({type, callback, capture});},
    removeEventListener(type, callback, capture = false) {const index = windowListeners.findIndex(row => row.type === type && row.callback === callback && row.capture === capture); if (index >= 0) windowListeners.splice(index, 1);},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}},
    ResizeObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}},
  };
  Object.assign(context, platform); document.defaultView = context; document.documentElement.clientWidth = 1000;
  const proto = context.Element.prototype;
  proto.focus = function () {if (this.disabled || !this.isConnected) return; document.activeElement = this; this.dispatchEvent(new context.Event('focusin'));};
  proto.scrollIntoView = function () {};
  // Geometry signals focus eligibility only. These tests make no layout claim.
  proto.getClientRects = function () {return this.isConnected && !this.closest('[hidden],[inert]') ? [{width: 10, height: 10}] : [];};
  for (const name of ['name', 'type']) Object.defineProperty(proto, name, {configurable: true, get() {return this.getAttribute(name) || '';}, set(value) {this.setAttribute(name, value);}});
  Object.defineProperty(proto, 'tabIndex', {configurable: true, get() {return Number(this.getAttribute('tabindex') || 0);}, set(value) {this.setAttribute('tabindex', value);}});
  // Instantiate the exact default branch of the server SearchInput macro; no
  // independent fixture control markup or behavior is supplied.
  const macro = readRepo('music_app/templates/partials/search-input.html').match(/{% macro search_input\([\s\S]*?-\s*%}([\s\S]*?){%- endmacro %}/);
  assert.ok(macro, 'canonical search_input macro exists');
  const substitutions = {name: 'q', input_id: 'native-top-search', value: '', placeholder: 'Search', label: 'Search', button_type: 'button', button_label: 'Search'};
  const searchHtml = macro[1].replace(/{% if [\s\S]*?{% endif %}/g, '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => {assert.ok(Object.hasOwn(substitutions, key), `known macro field ${key}`); return substitutions[key];});
  assert.doesNotMatch(searchHtml, /{%|{{/);
  const searchTemplate = document.createElement('template'); searchTemplate.id = 'native-search-field-template'; searchTemplate.innerHTML = searchHtml; document.body.append(searchTemplate);
  const navigationTemplate = document.createElement('script'); navigationTemplate.id = 'navigation-tree-item-template';
  navigationTemplate.textContent = readRepo('music_app/templates/components/navigation-tree-item.html'); document.body.append(navigationTemplate);
  const buttons = context.ButtonComponent;
  const modalSource = readRepo('music_app/templates/partials/confirm-modals.html');
  const formInclude = '{% include "partials/app-form-modal.html" %}';
  const formImport = "{% from 'partials/button.html' import action_button %}";
  const formSource = readRepo('music_app/templates/partials/app-form-modal.html');
  assert.equal(modalSource.split(formInclude).length, 2, 'one canonical form partial include');
  assert.equal(formSource.split(formImport).length, 2, 'one canonical form macro import');
  const modals = modalSource.replace(formInclude, formSource.replace(formImport, ''));
  const marker = '<div class="confirm-modal" id="app-confirm-modal" hidden>';
  assert.ok(modals.includes(marker));
  const modalHtml = modals.slice(modals.indexOf(marker)).replace("{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}",
    buttons.renderActionButton({attributes: {id: 'app-form-close'}, icon: 'close', ariaLabel: 'Close dialog', hidden: true}));
  assert.doesNotMatch(modalHtml, /{%|{{/); document.body.insertAdjacentHTML('beforeend', modalHtml);
  for (const file of ['search-input.js', 'in-page-tabs.js', 'browser-dialog-helpers.js']) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
  vm.runInContext(readRepo('music_app/static/js/navigation-tree.js'), context, {filename: 'navigation-tree.js'});
  const host = document.createElement('section'); document.body.append(host);
  const opens = [], runtime = {
    buttonHtml: buttons.renderButton, actionHtml: buttons.renderActionButton, iconHtml: buttons.renderIconSvg,
    alertHtml: env.owner('buildOnPageAlertHtml'), galleryCardHtml: env.owner('buildGalleryCardHtml'), artboxHtml: env.owner('buildAlbumArtboxHtml'),
    tabsHtml: env.owner('buildInPageTabsHtml'), mountTabs: env.owner('mountInPageTabs'), searchHtml: env.owner('buildSearchInputHtml'),
    navigationItemHtml: context.NavigationTree.renderItem,
    openForm(options) {opens.push(options); return env.owner('openReactFormDialog')(options, () => true);},
    confirm(message, options = {}) {return env.owner('showAppConfirmDialog')({...options, message});},
    confirmRetryOriginal() {return env.owner('showAppConfirmDialog')({message: 'Retry exact original request?', acceptLabel: 'Retry'});},
  };
  const baselineListeners = env.listeners().length;
  const input = (node, value) => {assert.ok(node, 'input exists'); node.value = value; node.dispatchEvent(new context.Event('input'));};
  const button = (root, label) => {const result = root.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label && !node.closest('[hidden]')); assert.ok(result, `visible button ${label}`); return result;};
  const modal = () => document.getElementById('app-form-modal');
  const content = () => document.getElementById('app-form-content');
  function assertClean() {
    assert.equal(windowListeners.length, 0, 'native global header/gesture listeners retired');
    assert.equal(frames.size, 0, 'native scheduled frames cancelled');
    assert.ok(observers.every(owner => owner.retired), 'native observers disconnected');
    // Native tabs own listeners on detached tablists. Assert no extra connected
    // listeners rather than claiming their garbage collection has been observed.
    assert.equal(env.listeners().filter(row => row.target.isConnected).length, baselineListeners, 'connected listeners restored');
  }
  return {...env, host, runtime, opens, input, button, modal, content, frames, observers, assertClean};
}
async function connectedView(env, service, controller, extra = {}) {
  const {mountAlbumTopsView} = await load('album-tops/app.mjs');
  let view, props = {controller, providers: service.providers, state: controller.getSnapshot(), onOpen() {}, ...extra};
  const unsubscribe = controller.subscribe(() => {props = {...props, state: controller.getSnapshot()}; view?.update(props);});
  view = mountAlbumTopsView(env.host, env.runtime, props);
  return {view, update(patch) {props = {...props, ...patch, state: controller.getSnapshot()}; view.update(props);}, dispose() {unsubscribe(); view.dispose(); controller.dispose();}};
}
function shell(env, patch = {}) {
  let snapshot = {authenticated: true, inLibrary: true, scopeKey: SCOPE, active: true, visible: true,
    sidebarMode: 'album_tops', topRef: TOP, viewVersion: 1, viewRequestId: 10, ...patch};
  const listeners = new Set(), navigations = [];
  Object.assign(env.runtime, {snapshot: () => snapshot, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    acceptsPrivateScope: value => value === snapshot.scopeKey && snapshot.authenticated,
    navigate(options) {navigations.push(options); options.onStart?.(); options.onSettled?.({opened: true}); return Promise.resolve(true);}});
  return {navigations, listeners, change(patch) {snapshot = {...snapshot, ...patch}; for (const listener of [...listeners]) listener();}};
}
module.exports = {load, id, TOP, OTHER, ALBUM, SCOPE, deferred, drain, detail, sharing, permissions, service, preparedController, nativeEnvironment, connectedView, shell};
