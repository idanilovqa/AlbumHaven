'use strict';
const assert = require('node:assert/strict');
const M = require('../album-tops-source-match-fixtures/session.cjs');
const {actualChoiceEnvironment, settle} = require('../album-tops-native-fixtures/actual-choice-runtime.cjs');
const {button, click, choice, choiceOptions, selectChoice, search} = require('../album-tops-sharing-harness.cjs');
const {F, JOB, REQUEST, SAVED_TOP, SOURCE, job, review, receipt} = M;
let createAlbumTopController, createSourceImportController, createSourceImportProviders, mountSourceImportView;
async function load() {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: require('node:crypto').webcrypto, configurable: true});
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
  ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));
  ({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));
  ({mountSourceImportView} = await F.load('album-tops/source-import-view.mjs'));
}
function field(root, label) {
  const labels = [...root.querySelectorAll('label')];
  const result = [...root.querySelectorAll('input,textarea')].find(node => node.getAttribute('aria-label') === label
    || node.closest('label')?.textContent.trim() === label
    || labels.some(owner => owner.getAttribute('for') === node.id && owner.textContent.trim() === label));
  assert.ok(result, `native field ${label}`); return result;
}
function input(root, label, value) {
  const node = field(root, label); node.value = value; node.dispatchEvent(new node.ownerDocument.defaultView.Event('input')); return node;
}
function choose(root, kind) {const node = choice(root, 'Source type'); assert.ok(node); return selectChoice(node, kind);}
function file(root, value) {
  const node = field(root, 'HTML file'); Object.defineProperty(node, 'files', {value: value ? [value] : [], configurable: true});
  node.dispatchEvent(new node.ownerDocument.defaultView.Event('change')); return node;
}
function fakeFile({name = 'source.html', content = '<p>Private album source</p>', size = content.length, promise, error} = {}) {
  let reads = 0;
  return {value: {name, size, type: 'text/html', webkitRelativePath: '/PRIVATE/LOCAL/PATH/source.html', text() {
    reads++; if (error) return Promise.reject(error); return promise || Promise.resolve(content);
  }}, reads: () => reads};
}
async function fixture(t, {opened = false, wire = job(), handlers = {}, onOpenTop = () => true} = {}) {
  const env = actualChoiceEnvironment(), api = F.service({handlers}), requests = [], controls = new Map();
  const calls = {close: 0, open: [], importDispose: 0, topMutate: [], confirms: []};
  const storage = [], descriptors = new Map();
  for (const name of ['localStorage', 'sessionStorage']) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = {getItem: key => {storage.push([name, 'get', key]); return null;},
      setItem: (...args) => storage.push([name, 'set', ...args]), removeItem: key => storage.push([name, 'remove', key]),
      clear: () => storage.push([name, 'clear'])};
    Object.defineProperty(globalThis, name, {value, configurable: true}); env.context[name] = value;
  }
  const live = {view: true, auth: true}, subscriptions = {top: 0, imported: 0};
  const sourceProviders = createSourceImportProviders({request(path, options, body) {
    const kind = path === '/album-tops' ? 'finalize' : path === '/album-tops/source-imports' ? 'submit'
      : path.endsWith('/cancel') ? 'cancel' : path.endsWith('/process') ? 'process' : 'read';
    const gate = F.deferred(), request = {kind, path, options, body: body === undefined ? undefined : F.clone(body),
      resolve: gate.resolve, reject: gate.reject}; requests.push(request);
    const queue = controls.get(kind);
    if (queue?.length) Promise.resolve(queue.shift()).then(gate.resolve, gate.reject);
    else if (kind === 'read') gate.resolve(F.clone(wire));
    return gate.promise;
  }});
  const providers = {...api.providers, ...sourceProviders};
  const topController = createAlbumTopController({providers, requestKey: () => F.id(934)});
  const topSubscribe = topController.subscribe, mutate = topController.mutate;
  topController.subscribe = listener => {subscriptions.top++; const off = topSubscribe(listener); let active = true;
    return () => {if (active) {active = false; subscriptions.top--; off();}};};
  topController.mutate = (...args) => {calls.topMutate.push(args); return mutate(...args);};
  topController.setScope(F.SCOPE); assert.equal(await topController.load(), true);
  let keyCalls = 0;
  const actual = createSourceImportController({providers, scopeKey: F.SCOPE,
    isCurrent: () => live.auth && topController.getSnapshot().scopeKey === F.SCOPE, key: () => {keyCalls++; return REQUEST;}});
  const controller = Object.freeze({...actual,
    subscribe(listener) {subscriptions.imported++; const off = actual.subscribe(listener); let active = true;
      return () => {if (active) {active = false; subscriptions.imported--; off();}};},
    dispose() {calls.importDispose++; return actual.dispose();}});
  if (opened) assert.equal(await actual.open(wire.job_ref), true);
  // Observe, but execute, the existing native confirmation owner.
  const confirm = env.runtime.confirm;
  env.runtime.confirm = (...args) => {calls.confirms.push(args); return confirm(...args);};
  const props = {controller, topController, providers, isCurrent: () => live.view && live.auth,
    onClose() {calls.close++;}, onOpenTop(top, current) {calls.open.push({top, current}); return onOpenTop(top, current);}};
  const view = mountSourceImportView(env.host, env.runtime, props);
  t.after(async () => {
    try {
      view.dispose(); await settle();
      assert.equal(calls.importDispose, 0, 'surface never disposes its task-owned import controller');
      assert.equal(subscriptions.top, 0); assert.equal(subscriptions.imported, 0);
      actual.dispose(); topController.dispose(); env.assertClean(); assert.deepEqual(env.forbiddenCalls, []);
      assert.deepEqual(storage, [], 'private source content and review intent never use browser storage');
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
      env.host.remove();
    }
  });
  const count = kind => requests.filter(row => row.kind === kind).length;
  const last = kind => {const value = requests.filter(row => row.kind === kind).at(-1); assert.ok(value, `actual ${kind} request`); return value;};
  return {...env, api, providers, topController, actual, controller, view, props, calls, requests, count, last, live, subscriptions,
    keyCalls: () => keyCalls,
    queue(kind, value) {if (!controls.has(kind)) controls.set(kind, []); controls.get(kind).push(value);},
    setWire(value) {wire = value;},
    depart() {live.view = false; view.update();},
    scope() {live.auth = false; topController.setScope(`${F.SCOPE}:retired`); view.update();},
    row(ref) {const node = env.host.querySelector(`[data-source-row-ref="${ref}"]`); assert.ok(node, `source row ${ref}`); return node;},
    answer(accepted) {const modal = env.document.getElementById('app-confirm-modal'); assert.equal(modal.hidden, false);
      click(env.document.getElementById(accepted ? 'app-confirm-accept' : 'app-confirm-cancel'));},
  };
}
function commandJob(command, patch = {}) {return job({request_key: command.request_key, title: command.title, kind: command.kind,
  source: F.clone(command), ...patch});}
function fill(h, kind = 'text', content = '1. Artist - Album') {
  input(h.host, 'Album Top title', 'A new source Top'); input(h.host, 'Album Top description', 'Private source notes');
  choose(h.host, kind); if (kind !== 'uploaded_html') input(h.host, kind === 'url' ? 'Source URL' : 'Source content', content);
}
function noSave(h) {
  assert.equal(h.count('finalize'), 0); assert.equal(h.calls.open.length, 0); assert.equal(h.calls.topMutate.length, 0);
  assert.equal(h.api.count('execute'), 0); assert.equal(h.count('process'), 0);
}
async function localMatch(h, ref = '2') {
  click(button(h.row(ref), `Match album for source row ${ref}`)); await settle();
  const region = h.host.querySelector(`[aria-label="Match source row ${ref}"]`); assert.ok(region);
  search(region, 'Found'); await settle();
  click(region.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle();
  click(button(region, 'Confirm match')); await settle(); return region;
}
module.exports = {F, JOB, REQUEST, SAVED_TOP, SOURCE, job, review, receipt, load, fixture, field, input, choose, file,
  fakeFile, commandJob, fill, noSave, localMatch, button, click, choice, choiceOptions, selectChoice, search, settle};
