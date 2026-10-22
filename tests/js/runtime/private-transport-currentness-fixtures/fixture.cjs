'use strict';
// I/O-only fixture. The existing native DOM/VM harness and complete production
// transport execute unchanged. No request, admission or currentness owner stub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../../..');
const {createNativeHomeRuntime} = require(path.join(ROOT, 'tests/js/runtime/native-home-harness.cjs'));
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const READ_URL = '/view-data?surface=albums&q=%3Aloved&search_detail_album_ref=inventory-album%3A1%3A11';
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
function deferred() {
  let done, fail, settled = false;
  const promise = new Promise((resolve, reject) => {done = resolve; fail = reject;});
  // Teardown may reject an undispatched/unread I/O gate after an assertion fails.
  // Observing it here prevents an unrelated unhandled-rejection test failure.
  promise.catch(() => {});
  return {promise, get settled() {return settled;},
    resolve(value) {if (!settled) {settled = true; done(value);}},
    reject(error) {if (!settled) {settled = true; fail(error);}}};
}
function fixture(t) {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const shell = document.createElement('div'); shell.id = 'app-shell';
  shell.dataset.privateUiContext = A; document.body.appendChild(shell);
  const requests = [], observers = [], notices = [];
  let phase = 'initial';
  Object.assign(context, {URLSearchParams, AbortController,
    MutationObserver: class {constructor(callback) {observers.push(callback);} observe() {} disconnect() {}},
    fetch(url, options = {}) {
      const network = deferred(), body = deferred(), started = deferred();
      const request = {url, options, network, body, started, jsonCalls: 0};
      requests.push(request);
      // Deliberately non-cooperative network: aborted callers can still receive
      // delayed responses. This fixture never performs real network requests.
      return network.promise;
    },
  });
  const sourcePath = path.join(ROOT, 'music_app/static/js/runtime/private-ui-transport.js');
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, {filename: sourcePath});
  const transport = context.AlbumHavenPrivateUITransport;
  assert.equal(typeof transport?.request, 'function', 'existing whole private transport loaded');
  assert.equal(transport.context(), A, 'fixture begins in an admitted private context');
  const unsubscribe = transport.subscribe(() => notices.push(shell.dataset.privateUiContext));
  t.after(() => {
    unsubscribe();
    const error = Object.assign(new Error('Fixture teardown'), {name: 'AbortError'});
    for (const request of requests) {
      request.network.reject(error); request.body.reject(error); request.started.resolve();
    }
  });
  function requestAt(index) {const r = requests[index]; assert.ok(r, `real fetch ${index} dispatched`); return r;}
  function headers(index, status = 200) {
    const r = requestAt(index); phase = 'headers';
    r.network.resolve({ok: status >= 200 && status < 300, status,
      json() {r.jsonCalls++; phase = 'json'; r.started.resolve(); return r.body.promise;}});
    return r;
  }
  function decoded(index, payload) {phase = 'decoded'; requestAt(index).body.resolve(payload);}
  function respond(index, payload, status = 200) {headers(index, status); decoded(index, payload);}
  function move(stamp = B) {
    shell.dataset.privateUiContext = stamp;
    for (const callback of observers) callback();
    // Real transport sync is also exercised when reading the generation.
    return transport.generation();
  }
  return {...native, shell, requests, notices, transport, move,
    get phase() {return phase;},
    read: (options = {}) => outcome(transport.request(READ_URL, options)),
    headers, decoded, respond, requestAt,
    valid: (label = 'accepted', stamp = A) => ({context_ref: stamp, label}),
    malformed: () => ({context_ref: 'wrong-context', label: 'must not poison current scope'}),
  };
}
function assertAbort(result) {
  assert.equal(result.error?.name, 'AbortError', 'lost ownership settles as AbortError');
  assert.equal(Object.hasOwn(result, 'value'), false, 'retired payload is never returned');
  assert.notEqual(result.error?.responseRejected, true, 'supersession is not a current server denial');
}
function assertAvailable(h, {stamp = A, generation = 0, notices = 0} = {}) {
  assert.equal(h.transport.context(), stamp, 'current scope remains available');
  assert.equal(h.transport.generation(), generation, 'no unexpected context generation advance');
  assert.equal(h.notices.length, notices, 'no unexpected scope retirement notification');
}
module.exports = {fixture, assertAbort, assertAvailable, outcome, A, B, READ_URL};
