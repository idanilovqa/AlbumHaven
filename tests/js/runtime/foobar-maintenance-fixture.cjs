'use strict';
// Synthetic DOM/event/time and HTTP boundaries only. Whole genuine maintenance,
// import/controller/contract, shared controls and session-CSRF owners execute.
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const I = require('./foobar-account-import-native-fixture.cjs');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const VERSION = 'foobar_account_maintenance_v1';
const cursor = patch => ({expires_at: '2026-10-22T01:02:03.123456+00:00', generation: 1, receipt_ref: F.JOBREF, ...patch});
const result = patch => ({source_ref: F.SOURCE, inspected: 0, removed_receipts: 0, protected_receipts: 0, removed_keys: 0, retired_through: 0, next_cursor: null, more_retired_keys: false, history_deleted: false, job_reconciled: false, ...patch});
const payload = (patch, envelope) => ({protocol: VERSION, context_ref: F.STAMP, context_scope: F.SCOPE, result: result(patch), ...envelope});
const idle = patch => ({phase: 'idle', source: {source_ref: F.SOURCE}, submitted: false, discoveryLoading: false, ...patch});
const controls = host => {
  const section = host.querySelectorAll('details').find(node => node.querySelector('summary')?.textContent === 'Expired import replay metadata');
  assert.ok(section, 'Genuine maintenance details mounted');
  const buttons = section.querySelectorAll('button'); assert.equal(buttons.length, 2);
  return {section, start: buttons[0], more: buttons[1], status: section.querySelector('[role="status"]')};
};
const body = call => JSON.parse(call.init.body);
const calls = f => f.wire.calls.filter(call => call.route === '/maintenance');
function installFetch(c, document, wire) {
  c.Headers = Headers; c.location = {href: 'https://albumhaven.invalid/settings', origin: 'https://albumhaven.invalid'};
  document.cookie = '__Host-album_haven_csrf=synthetic-maintenance-csrf'; c.fetch = (...args) => wire.fetch(...args);
  F.vm.runInContext(F.read('music_app/static/js/runtime/session-csrf-fetch.js'), c, {filename: 'session-csrf-fetch.js'});
}
async function standalone(t, {state = idle()} = {}) {
  const module = await F.load('maintenance.mjs'), env = createNativeHomeRuntime(), {document, context: c} = env;
  const time = F.clock(), wire = F.wire({initialList: false}); document.defaultView = c;
  c.setTimeout = (...args) => globalThis.setTimeout(...args); c.clearTimeout = (...args) => globalThis.clearTimeout(...args);
  c.Element.prototype.focus = function () {if (this.isConnected && !this.disabled) document.activeElement = this;};
  const root = document.createElement('main'), host = document.createElement('section'); document.body.append(root, host);
  Object.assign(root.dataset, {accountFoobarContext: F.STAMP, accountFoobarScope: F.SCOPE});
  installFetch(c, document, wire);
  let current = true, allowed = true;
  const baseline = env.listeners();
  const owner = module.mountMaintenance(host, {fetch: (...args) => c.fetch(...args), contextRoot: root,
    allows: action => allowed && action === 'account.self.foobar.write', isCurrent: () => current});
  if (state !== null) owner.update(state);
  const nodes = controls(host);
  t.after(async () => {try {owner.dispose(); await F.settle(); assert.deepEqual(env.listeners(), baseline); assert.equal(time.tasks.size, 0); assert.equal(env.forbiddenCalls.length, 0);} finally {time.restore();}});
  return {...env, ...nodes, c, root, host, wire, time, owner, module,
    allow(value) {allowed = value;}, current(value) {current = value;}};
}
async function native(t, options = {}) {
  const wire = options.wire || F.wire(); let transport = (...args) => wire.fetch(...args);
  const facade = {...wire, fetch: (...args) => transport(...args)};
  const f = await I.native(t, facade, {...options, sibling: true});
  f.c.setTimeout = (...args) => globalThis.setTimeout(...args); f.c.clearTimeout = (...args) => globalThis.clearTimeout(...args);
  installFetch(f.c, f.document, wire); transport = (...args) => f.c.fetch(...args);
  return {...f, ...controls(f.host), wire};
}
const dispatch = f => {f.click(f.start); return F.settle();};
const complete = async (f, value = payload()) => {f.wire.enqueue('/maintenance', value); await dispatch(f);};
const uncertain = f => {
  assert.match(f.status.textContent, /outcome was not confirmed and may have committed/);
  assert.match(f.status.textContent, /No automatic retry was sent/);
  assert.match(f.status.textContent, /explicitly start a new current-state pass/);
  assert.doesNotMatch(f.status.textContent, /This pass inspected|was rolled back|nothing was deleted/);
  assert.equal(f.more.disabled, true);
};
module.exports = {F, I, VERSION, cursor, result, payload, idle, controls, body, calls, standalone, native, dispatch, complete, uncertain};

async function settings(t, {deferAsset = false, allowed = true, initialize = true} = {}) {
  const module = await F.load('index.mjs'), env = createNativeHomeRuntime(), {context: c, document} = env;
  const time = F.clock(), wire = F.wire(), observers = [], intervals = new Map(), windowListeners = [], imports = [], assetLoads = [];
  const gate = deferAsset ? F.deferred() : null; let next = 0;
  document.defaultView = c;
  c.setTimeout = (...args) => globalThis.setTimeout(...args); c.clearTimeout = (...args) => globalThis.clearTimeout(...args);
  c.setInterval = callback => {const id = ++next; intervals.set(id, callback); return id;}; c.clearInterval = id => intervals.delete(id);
  c.addEventListener = (type, callback) => {windowListeners.push({type, callback});};
  c.removeEventListener = (type, callback) => {const n = windowListeners.findIndex(row => row.type === type && row.callback === callback); if (n >= 0) windowListeners.splice(n, 1);};
  c.dispatchEvent = event => {for (const row of [...windowListeners]) if (row.type === event.type && windowListeners.includes(row)) row.callback(event);};
  c.MutationObserver = class {
    constructor(callback) {this.callback = callback; this.active = false; observers.push(this);}
    observe() {this.active = true;} disconnect() {this.active = false;}
  };
  const proto = c.Element.prototype, queryAll = proto.querySelectorAll;
  proto.querySelectorAll = function (selector) {
    if (!selector.includes('>')) return queryAll.call(this, selector);
    const match = /^(\.[a-zA-Z_][\w-]*)\s*>\s*(\[role="row"\])$/.exec(selector);
    if (!match) throw new Error('Unsupported Settings platform selector: ' + selector);
    return queryAll.call(this, match[2]).filter(node => node.parentElement?.matches(match[1]));
  };
  proto.querySelector = function (selector) {return this.querySelectorAll(selector)[0] || null;};
  proto.focus = function () {if (this.isConnected && !this.disabled && !this.closest('[hidden],[inert]')) document.activeElement = this;};
  proto.click = function () {if (!this.disabled) this.dispatchEvent(new c.Event('click'));};
  for (const property of ['type', 'value']) Object.defineProperty(proto, property, {configurable: true, get() {return this['_' + property] || '';}, set(value) {this['_' + property] = String(value);}});
  const add = (tag, id, parent = document.body) => {const node = document.createElement(tag); if (id) node.id = id; parent.append(node); return node;};
  const root = add('main', 'app-shell'), overlay = add('section', 'utility-modal'), detail = add('section', 'utility-detail', overlay);
  overlay.hidden = false; Object.assign(root.dataset, {accountFoobarContext: F.STAMP, accountFoobarScope: F.SCOPE, accountFoobarMatchingLibraryId: ''});
  const els = {overlay, detail}; c.state = {utility: {activeTab: 'integrations', selectedIntegrationKey: 'foobar'}};
  // This is the surrounding synthetic DOM getter, not a product authority receipt.
  c.getUtilityModalElements = () => els;
  c.AlbumHavenCapabilities = {allows: action => allowed && action === 'account.self.foobar.write'};
  c.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ = 'maintenance fixture version'; installFetch(c, document, wire);
  for (const name of ['compact-data-table.js', 'utility-list-builders.js', 'utility-renderers-and-actions.js'])
    F.vm.runInContext(F.read('music_app/static/js/runtime/' + name), c, {filename: name});
  assert.equal(typeof c.loadUtilityFoobarImportModule, 'function');
  // Reviewed C1 seam: native import above loads the complete genuine module.
  // Only browser asset resolution is controlled; no implementation is replaced.
  c.loadUtilityFoobarImportModule = version => {
    imports.push(version); const promise = gate ? gate.promise.then(() => module) : Promise.resolve(module); assetLoads.push(promise); return promise;
  };
  detail.innerHTML = c.buildUtilityIntegrationDetail({key: 'foobar', title: 'Foobar2000'});
  const host = detail.querySelector('[data-foobar-import-host]'), baseline = env.listeners();
  if (initialize) wire.enqueue('/ui/source', F.source());
  c.mountUtilityFoobarPreview(els); await F.settle();
  t.after(async () => {try {
    c.disposeUtilityFoobarPreview(); gate?.resolve(); await Promise.allSettled(assetLoads); await F.settle();
    assert.equal(intervals.size, 0); assert.equal(time.tasks.size, 0); assert.ok(observers.every(observer => !observer.active));
    assert.equal(windowListeners.length, 0); assert.deepEqual(env.listeners(), baseline); assert.equal(env.forbiddenCalls.length, 0);
  } finally {time.restore();}});
  const mutation = (target, attributeName) => {for (const observer of [...observers]) if (observer.active) observer.callback([{type: 'attributes', target, attributeName}]);};
  return {...env, c, root, overlay, detail, host, els, wire, time, observers, intervals, imports, gate,
    nodes: () => controls(host), mounted: () => env.owner('utilityFoobarPreviewOwner')?.mounted,
    action: name => {const node = host.querySelector(`[data-foobar-import-action="${name}"]`); assert.ok(node); return node;},
    mutation, allow(value) {allowed = value;}, idleCheck() {for (const callback of [...intervals.values()]) callback();},
    close() {c.disposeUtilityFoobarPreview();}, async releaseAsset() {assert.ok(gate); gate.resolve(); await F.settle();},
  };
}
module.exports.settings = settings;
