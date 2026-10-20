'use strict';
// Whole native index, transport, foreground navigation, history, form and registry.
// Only browser platform and deterministic wire responses are test inputs.
const assert = require('node:assert/strict'), vm = require('node:vm');
const N = require('../search-native-fixtures/actual-runtime.cjs');
const V = require('../album-tops-source-import-view-fixtures/view.cjs');
const {measure} = require('../album-tops-native-fixtures/shared-header-driver.cjs');
const {installSearchValuePlatform} = require('../album-tops-native-fixtures/search-value-platform.cjs');
const {F, JOB, REQUEST, SAVED_TOP, SOURCE, job, review, receipt, button, click, search, settle} = V;
const {installTemplateFragmentPlatform} = require('../template-fragment-platform.cjs');
const SOURCE_NAME = 'album-top-source-imports';
const route = (top_ref = null) => ({...N.ordinary(), context_ref: N.A, surface: {active: 'album_tops'},
  surface_request: 'album_tops', top_ref, shell_layout: {slots: {navigation_rail: {content_kind: 'album_tops'}}}});
const detail = ref => ({top_ref: ref, revision: '1', title: 'Saved native Top', description: '', visibility: 'private',
  items: [], edit_draft: {items: [], publication_preview_required: false},
  allowed_actions: {can_read: true, can_edit: true, can_rename: true, can_add: true, can_remove: true, can_reorder: true,
    [F.BROWSE]: true, [F.MANAGE]: true, [F.ITEMS]: true}});
const summary = value => Object.fromEntries(['job_ref','request_key','status','revision','title','kind','created_at','updated_at','phase','error','top_ref'].map(key => [key, value[key]]));
const kindOf = (url, options) => {
  const path = new URL(url, 'https://albumhaven.test').pathname;
  if (path === '/view-data') return 'navigate';
  if (path === '/utilities/cover-lookup/tasks') return 'cover-tasks';
  if (path === '/album-tops/source-imports') return options.method === 'POST' ? 'submit' : 'feed';
  if (path.startsWith('/album-tops/source-imports/')) return path.endsWith('/cancel') ? 'cancel' : path.endsWith('/process') ? 'process' : 'read';
  if (path === '/album-tops') return options.method === 'POST' ? 'finalize' : 'directory';
  if (path === '/album-tops/edit-requests') return 'edit-feed';
  if (path === '/album-top-catalog/search') return 'search';
  if (path === '/album-top-catalog/inventory') return 'admit';
  if (path.startsWith('/album-tops/')) return 'detail';
  return 'unexpected';
};
let mountAlbumTops, createAlbumTopBackendProviders;
async function load() {
  ({mountAlbumTops} = await F.load('album-tops/index.mjs'));
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
}
function formPlatform(c, document, listeners) {
  // Same bounded DOM/event primitives as the retained advanced-search fixture.
  // Mobile form docking must use a real Comment node and the actual history
  // owner, never a placeholder object with a no-op before().
  installSearchValuePlatform(c);
  installTemplateFragmentPlatform(document);
  const before = c.Element.prototype.before;
  class Comment extends c.Node {
    constructor(data) {super(8); this.data = String(data);}
    get textContent() {return this.data;}
    set textContent(value) {this.data = String(value);}
    get outerHTML() {return `<!--${this.data}-->`;}
    before(...nodes) {return before.apply(this, nodes);}
    replaceWith(...nodes) {if (!this.parentNode) return; for (const node of nodes) this.parentNode.insertBefore(node, this); this.remove();}
  }
  document.createComment = value => new Comment(value);
  const parent = document.createElement('div'), marker = document.createComment('form origin'), sibling = document.createElement('i');
  parent.append(marker); marker.before(sibling); assert.equal(parent.firstChild, sibling); assert.equal(marker.nodeType, 8);
  assert.equal(parent.children.length, 1); assert.equal(marker.parentNode, parent); marker.remove(); assert.equal(marker.parentNode, null);
  c.CustomEvent = class extends c.Event {constructor(type, options = {}) {super(type, options); this.detail = options.detail ?? null;}};
  const node = Object.getPrototypeOf(c.Element.prototype), dispatch = node.dispatchEvent;
  const phase = (event, capture) => {event.currentTarget = c; for (const row of [...listeners]) {
    if (row.type === event.type && row.capture === capture && !event.immediate && listeners.includes(row)) row.callback(event);
  }};
  node.dispatchEvent = function(event) {
    event.target = this; const path = event.composedPath(), connected = path.includes(document), original = event.composedPath;
    event.composedPath = () => [...path];
    try {if (connected) phase(event, true); if (!event.stopped) dispatch.call(this, event);
      if (connected && event.bubbles && !event.stopped) phase(event, false); return !event.defaultPrevented;
    } finally {event.currentTarget = null; event.composedPath = original;}
  };
}
function mobileShell(c, document) {
  const source = N.read('music_app/templates/index.html');
  let html = source.match(/<section class="mobile-page-header[\s\S]*?<div class="mobile-page-outlet" id="mobile-page-outlet" hidden><\/div>/)?.[0];
  assert.ok(html, 'the served mobile header/outlet are present');
  html = html.replace(/{% call action_button\('Back'[\s\S]*?{% endcall %}/,
    c.ButtonComponent.renderActionButton({attributes: {id: 'mobile-back-button', 'data-mobile-back': '1'}, ariaLabel: 'Back', icon: 'back', hidden: true}));
  html = html.replace(/{% call action_button\('Settings sections'[\s\S]*?%}(<svg[\s\S]*?<\/svg>){% endcall %}/, (_macro, svg) => {
    const button = c.ButtonComponent.renderActionButton({attributes: {id: 'mobile-settings-button', 'data-mobile-settings-menu': '1', 'aria-controls': 'mobile-settings-drawer', 'aria-expanded': 'false'}, ariaLabel: 'Settings sections', className: 'mobile-bar-action', hidden: true});
    const placeholder = '<span class="action-button__icon" aria-hidden="true"></span>';
    assert.ok(button.includes(placeholder), 'actual shared ActionButton has its empty icon slot');
    return button.replace(placeholder, svg);
  });
  assert.doesNotMatch(html, /{%|{{/, 'only the two explicit served button macros are expanded');
  document.getElementById('shell-main-surface').insertAdjacentHTML('beforeend', html);
  const library = document.createElement('button'); library.id = 'mobile-library-button'; document.body.append(library);
}
async function fixture(t, {topRef = null, allowed = true, registry = true, feed = [], width = 1200} = {}) {
  let topHost, sidebarHost, windowListeners, platformObservers; const nativeCleanup = [];
  const h = N.fixture({after: callback => nativeCleanup.push(callback)}, {url: 'https://albumhaven.test/?surface=album_tops' + (topRef ? '&top_ref=' + topRef : ''), initial: route(topRef),
    beforeRuntimePlatform({c, document, listeners, observers}) {
      windowListeners = listeners; platformObservers = observers; c.innerWidth = width;
      document.documentElement.clientWidth = width;
      formPlatform(c, document, listeners);
      mobileShell(c, document);
      topHost = document.createElement('section'); topHost.id = 'album-tops-root';
      document.getElementById('shell-main-surface').append(topHost);
      sidebarHost = document.createElement('div'); document.body.append(sidebarHost);
    }});
  const {c, document} = h, bridge = c.AlbumHavenAlbumTopsRuntime;
  // The retained advanced-runtime fixture uses this same actual initializer
  // for anchored-surface and generic Escape ownership, without bootstrap I/O.
  c.initGalleryMain();
  // These one-time pointer-origin listeners belong to the persistent shell,
  // not a form/confirmation lease. Acquire both real owners before baseline.
  for (const id of ['app-form-modal', 'app-confirm-modal']) {
    h.owner('bindOverlayPointerOrigin')(document.getElementById(id));
  }
  assert.equal(typeof bridge.navigate, 'function');
  assert.equal(bridge.snapshot().visible, true); assert.equal(bridge.snapshot().topRef, topRef);
  const registrations = [], navigations = [], forms = [], queues = new Map(), subscriptions = new Set();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), crypto = c.crypto, keys = [];
  const random = Object.freeze({randomUUID() {const value = crypto.randomUUID(); keys.push(value); return value;},
    getRandomValues: value => crypto.getRandomValues(value), subtle: crypto.subtle});
  c.crypto = random; Object.defineProperty(globalThis, 'crypto', {value: random, configurable: true});
  let nativeRegistry = c.AlbumHavenNotifications, activeRegistry = null, registryRealm = c;
  const realms = [c];
  function observeRegistry(owner) {
    return Object.freeze({registerSource(options) {
      const actual = owner.registerSource(options), record = {options, disposed: false, disposals: 0, replacements: []}; registrations.push(record);
      return Object.freeze({replace(rows, state) {record.replacements.push({rows: N.plain(rows), state: N.plain(state)}); return actual.replace(rows, state);},
        dispose() {record.disposed = true; record.disposals++; return actual.dispose();}});
    }});
  }
  activeRegistry = registry ? observeRegistry(nativeRegistry) : null;
  // Observe each genuine owner at its publication boundary, before its own
  // synchronous notifications-ready event. No duplicate synthetic replacement.
  Object.defineProperty(c, 'AlbumHavenNotifications', {configurable: true,
    get: () => activeRegistry,
    set(owner) {nativeRegistry = owner; activeRegistry = owner ? observeRegistry(owner) : null;}});
  // The real registry's rendered list handles click/keyboard delegation. Browser
  // DOM is supplied here, with no substitute registry or source action owner.
  const drawer = document.createElement('aside'); drawer.id = 'cover-lookup-drawer';
  const drawerBody = document.createElement('div'); drawerBody.id = 'cover-lookup-drawer-body'; drawer.append(drawerBody);
  const drawerSummary = document.createElement('div'); drawerSummary.id = 'cover-lookup-drawer-summary'; drawer.append(drawerSummary);
  const drawerButton = document.createElement('button'); drawerButton.id = 'cover-lookup-drawer-button';
  drawerButton.setAttribute('data-toggle-cover-lookup-drawer', '1');
  const badge = document.createElement('span'); badge.id = 'cover-lookup-drawer-badge'; drawerButton.append(badge);
  document.body.append(drawer, drawerButton); h.state.coverLookup.drawerOpen = true;
  const renderDrawer = () => vm.runInContext('renderCoverLookupDrawer({preserveInteraction:false})', registryRealm);
  renderDrawer();
  const runtime = {...bridge,
    subscribe(listener) {const off = bridge.subscribe(listener); subscriptions.add(listener); let live = true;
      return () => {if (live) {live = false; subscriptions.delete(listener); off();}};},
    navigate(options) {const promise = bridge.navigate(options), row = {options, promise}; navigations.push(row); return promise;},
    openForm(options) {const result = bridge.openForm(options); forms.push({options, result}); return result;},
  };
  const connectedConsumers = () => h.listeners().filter(row => row.target.isConnected && row.target !== drawerBody
    && !(row.target === document && row.type === 'selectionchange'));
  // The real shell Search owner is lazy on the first document click. Establish
  // its persistent observer before measuring consumer cleanup.
  h.owner('syncRecentSearchScope')();
  // Mobile history replay can activate this persistent legacy Gallery owner.
  // Establish it through its actual owner before measuring import cleanup.
  h.owner('virtualGrid').activateGalleryCoverImages();
  const before = {listeners: windowListeners.length, connected: connectedConsumers().length,
    observers: platformObservers.filter(row => !row.retired).length, resizers: h.resizers.filter(row => !row.retired).length};
  const fetch = c.fetch;
  c.fetch = function(url, options = {}) {
    const result = fetch(url, options), request = h.requests.at(-1);
    request.kind = kindOf(String(url), options); request.body = options.body === undefined ? undefined : JSON.parse(options.body);
    const respond = (data, status = 200) => request.resolve(request.kind === 'navigate' || request.kind === 'cover-tasks' || status >= 400 ? data
      : {status: 'ready', context_ref: N.A, data}, status);
    request.reply = respond;
    const queue = queues.get(request.kind);
    if (queue?.length) {
      const next = queue.shift(); if (next !== HOLD) Promise.resolve().then(() => typeof next === 'function' ? next(request) : next)
        .then(value => respond(value), error => request.reject(error));
    } else if (request.kind === 'directory') queueMicrotask(() => respond({tops: [], next_cursor: null,
      allowed_actions: {[F.BROWSE]: true, [F.CREATE]: allowed, can_create: allowed}}));
    else if (request.kind === 'cover-tasks') queueMicrotask(() => respond({ok: true, tasks: []}));
    else if (request.kind === 'edit-feed') queueMicrotask(() => respond({requests: [], next_cursor: null}));
    else if (request.kind === 'feed') queueMicrotask(() => respond({jobs: N.plain(feed), next_cursor: null}));
    else if (request.kind === 'detail') queueMicrotask(() => respond(detail(new URL(url, h.location).pathname.split('/').at(-1))));
    else if (request.kind === 'search') queueMicrotask(() => respond({albums: [F.album(13, {title: 'Found local album'})], next_cursor: null}));
    else if (request.kind === 'admit') queueMicrotask(() => respond({album_ref: F.C}));
    return result;
  };
  const providers = createAlbumTopBackendProviders({transport: c.AlbumHavenPrivateUITransport, acceptsScope: bridge.acceptsPrivateScope});
  const index = mountAlbumTops({host: topHost, sidebarHost, runtime, providers});
  await settle(); h.flushFrames(); await settle();
  const calls = kind => h.requests.filter(row => row.kind === kind);
  const last = kind => {const row = calls(kind).at(-1); assert.ok(row, `actual ${kind} transport request`); return row;};
  const allCards = () => vm.runInContext('getRequestNotificationCards()', registryRealm);
  const cards = () => Array.from(allCards()).filter(row => !row.status && row.source.name === SOURCE_NAME);
  const currentSource = () => registrations.filter(row => !row.disposed && row.options.name === SOURCE_NAME).at(-1);
  const formHost = () => {assert.ok(h.owner('activeAppFormDialog'), 'actual native form owner is live'); return document.getElementById('app-form-content');};
  let disposed = false;
  const dispose = async () => {if (disposed) return; disposed = true; index.dispose(); await settle();};
  t.after(async () => {
    try {
    await dispose();
    for (const request of h.requests) if (!request.settled) request.reject(Object.assign(new Error('fixture teardown'), {name: 'AbortError'}));
    await settle();
    assert.equal(subscriptions.size, 0, 'index, tasks and child controller shell subscriptions are released');
    assert.ok(registrations.every(row => row.disposed), 'all index-owned registry source handles are retired');
    assert.ok(registrations.every(row => row.disposals === 1), 'captured registry handles retire exactly once');
    assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.owner('activeAppConfirmDialog'), null);
    assert.equal(topHost.children.length, 0); assert.equal(sidebarHost.children.length, 0);
    for (const realm of realms) assert.equal(vm.runInContext('getRequestNotificationCards().length', realm), 0);
    assert.equal(windowListeners.length, before.listeners, 'no index or dialog window listener remains');
    assert.equal(platformObservers.filter(row => !row.retired).length, before.observers, 'shared shell observers survive and consumer observers retire');
    assert.equal(h.resizers.filter(row => !row.retired).length, before.resizers, 'consumer header/gallery measurement owners retire');
    assert.equal(connectedConsumers().length, before.connected, 'connected native consumer listeners are cleaned; persistent registry delegation is shell-owned');
    } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto;
    for (const cleanup of nativeCleanup) await cleanup();
    }
  });
  const api = {...h, observers: h.resizers, context: c, host: topHost, sidebarHost, runtime, providers, index, registrations, navigations, forms, keys,
    calls, last, count: kind => calls(kind).length, cards, currentSource, formHost, dispose,
    header: () => {const result = topHost.querySelectorAll('[data-shared-header]'); assert.equal(result.length, 1); return result[0];},
    queue(kind, value) {if (!queues.has(kind)) queues.set(kind, []); queues.get(kind).push(value);},
    hold(kind) {this.queue(kind, HOLD);}, setFeed(value) {feed = value;}, setAllowed(value) {allowed = value;},
    async showNotifications() {const current = currentSource(); assert.ok(current); await current.options.onShow(); await settle(); renderDrawer();},
    activate(id, key = null) {
      if (!h.state.coverLookup.drawerOpen) h.dispatch(drawerButton, 'click');
      renderDrawer(); assert.equal(drawer.hidden, false, 'actual notification toggle opens the drawer');
      const card = cards().find(row => row.id === id); assert.ok(card, `current source card ${id}`);
      const target = [...drawerBody.querySelectorAll('[data-open-request-notification]')].find(node => node.getAttribute('data-open-request-notification') === card.key);
      assert.ok(target, 'actual registry rendered the activation target');
      assert.equal(target.closest('[hidden], [inert]'), null, 'only a visible registry action is activated'); h.dispatch(target, key ? 'keydown' : 'click', key ? {key} : {}); return target;},
    async replaceRegistry(available = true) {
      if (available) {
        registryRealm = vm.createContext({...c, state: h.state, window: c});
        realms.push(registryRealm);
        vm.runInContext(N.read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js'), registryRealm);
      } else {c.AlbumHavenNotifications = null; c.dispatchEvent(new c.Event('albumhaven:notifications-ready'));}
      await settle();
    },
    async change(kind) {if (kind === 'logout') h.shell.dataset.nativeAccountId = ''; else h.change(kind); bridge.sync(); await settle();},
    async navigate(top_ref = null) {const start = calls('navigate').length, work = runtime.navigate({top_ref}); await settle();
      assert.equal(calls('navigate').length, start + 1); last('navigate').reply(route(top_ref)); assert.equal(await work, true); await settle();},
    async settleNavigation(top_ref = null) {last('navigate').reply(route(top_ref)); await navigations.at(-1).promise; await settle();},
  };
  return api;
}
const HOLD = Symbol('deferred network response');
async function open(h) {click(button(h.host, 'Import Album Top')); await settle();
  assert.equal(h.forms.at(-1).options.pageId, 'album-top-import'); assert.equal(h.forms.at(-1).options.title, 'Import Album Top'); return h.formHost();}
async function close(h, accept = null) {click(button(h.formHost(), 'Close')); await settle();
  if (accept !== null) {answer(h, accept); await settle();} return h.owner('activeAppFormDialog');}
function answer(h, accepted) {const modal = h.document.getElementById('app-confirm-modal'); assert.equal(modal.hidden, false);
  click(h.document.getElementById(accepted ? 'app-confirm-accept' : 'app-confirm-cancel'));}
function fill(root, {title = 'A new source Top', description = 'Private source notes', kind = 'text', content = '1. Artist - Album'} = {}) {
  V.input(root, 'Album Top title', title); V.input(root, 'Album Top description', description); V.choose(root, kind);
  if (kind !== 'uploaded_html') V.input(root, kind === 'url' ? 'Source URL' : 'Source content', content);
}
async function submit(h, patch = {}) {const root = await open(h); fill(root, patch); click(button(root, 'Save source')); await settle(); return h.last('submit');}
async function acknowledge(h, request, patch = {}) {const value = job({...patch, request_key: request.body.request_key,
  title: request.body.title, kind: request.body.kind, source: F.clone(request.body)}); request.reply(value); await settle(); return value;}
async function match(h, ref = '2') {const root = h.formHost(), row = root.querySelector(`[data-source-row-ref="${ref}"]`); assert.ok(row);
  click(button(row, `Match album for source row ${ref}`)); await settle(); const picker = h.formHost().querySelector(`[aria-label="Match source row ${ref}"]`);
  search(picker, 'Found'); await settle(); click(picker.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle();
  click(button(picker, 'Confirm match')); await settle();}
async function saved(h) {const request = await submit(h); await acknowledge(h, request); await match(h);
  click(button(h.formHost(), 'Save Album Top')); await settle(); const save = h.last('finalize'); save.reply(receipt(save.body)); await settle(); return save;}
function privateFree(h, strings = [SOURCE.content, SOURCE.description, 'SECRET_SOURCE_BODY']) {
  const serialized = JSON.stringify({history: h.entries, storage: h.storageCalls, urls: h.navigations.map(row => row.options.top_ref),
    notifications: h.registrations.flatMap(row => row.replacements)});
  for (const value of strings) assert.equal(serialized.includes(value), false, `private evidence ${value} stays outside route/storage/cards`);
}
module.exports = {...V, N, SOURCE_NAME, route, detail, summary, load, fixture, open, close, answer, fill, submit, acknowledge, match, saved, privateFree, measure};
