'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const F = require('../album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {createNativeHomeRuntime, readRepo} = require('../native-home-harness.cjs');
const JOB = F.id(901), OTHER_JOB = F.id(902), REQUEST = F.id(903), SAVED_TOP = F.id(904);
const TIME = '2026-10-19T12:00:00Z';
const INPUT = {title: 'A source title', description: 'Private source description', kind: 'pasted_html', filename: null,
  content: '<script>neverRunPrivateSource()</script>\n1. Private Artist - Private Album'};
const summary = (patch = {}) => ({job_ref: JOB, request_key: REQUEST, status: 'completed', revision: '4', title: INPUT.title,
  kind: INPUT.kind, created_at: TIME, updated_at: TIME, phase: 'review_evidence', error: null, top_ref: null, ...patch});
function job(patch = {}) {
  const value = summary(patch);
  return {...value, source: {request_key: value.request_key, ...INPUT, title: value.title, kind: value.kind},
    review: ['completed', 'canceled'].includes(value.status) ? {parser_version: 2, state: 'review_required',
      rows: [{row_ref: '1', candidate_line: 2, raw_text: INPUT.content, explicit_rank: 1, catalog_ref: null, match_state: 'unresolved'}],
      ordered_row_refs: ['1'], issues: ['Private parser evidence']} : null};
}
const page = (jobs = [], next_cursor = null) => ({jobs, next_cursor});
const receipt = command => ({action: 'create', request_key: command.request_key, top_ref: SAVED_TOP, revision: '1',
  source_job_ref: command.source_review.job_ref, source_locked: true, source_derived: true,
  source_report: command.source_review.rows.map((row, index) => ({row_ref: row.row_ref, position: index + 1,
    original_explicit_rank: 1, catalog_ref: row.selection?.album_ref || null,
    outcome: row.selection ? 'matched' : 'unresolved', retained_row_ref: null}))});
async function drain() {for (let n = 0; n < 24; n++) await Promise.resolve();}
let createSourceImportTasks, createSourceImportProviders;
async function load() {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: require('node:crypto').webcrypto, configurable: true});
  ({createSourceImportTasks} = await F.load('album-tops/source-import-tasks.mjs'));
  ({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));
}
function fixture(t, {feed = [], initial = {}, key, open = () => true, denied} = {}) {
  const env = createNativeHomeRuntime(), storage = [], requests = [], registrations = [], openings = [], denials = [];
  // Load the complete existing registry unchanged. No drawer is mounted in this
  // scope-owner suite; its registry, card projection and source callbacks are real.
  vm.runInContext(readRepo('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js'), env.context,
    {filename: 'cover-lookup-modal-and-drawer.js'});
  const registry = env.context.AlbumHavenNotifications;
  assert.equal(typeof registry.registerSource, 'function');
  const notifications = {registerSource(options) {
    const real = registry.registerSource(options), record = {options, replacements: [], disposed: false};
    registrations.push(record);
    return Object.freeze({replace(rows, status) {
      record.replacements.push({rows: F.clone(rows), status: status === undefined ? undefined : F.clone(status)}); return real.replace(rows, status);
    }, dispose() {record.disposed = true; return real.dispose();}});
  }};
  const descriptors = new Map();
  for (const name of ['localStorage', 'sessionStorage']) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = {getItem: value => {storage.push([name, 'get', value]); return null;},
      setItem: (...values) => storage.push([name, 'set', ...values]), removeItem: value => storage.push([name, 'remove', value])};
    Object.defineProperty(globalThis, name, {value, configurable: true}); env.context[name] = value;
  }
  let shell = {authenticated: true, scopeKey: F.SCOPE, visible: true, active: true, viewVersion: 1, ...initial};
  const listeners = new Set(), queues = new Map(), providersCreated = []; let accepted = true, sequence = 0, keyCalls = 0;
  const runtime = {snapshot: () => shell, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    acceptsPrivateScope: scope => accepted && shell.authenticated === true && scope === shell.scopeKey};
  const change = patch => {shell = {...shell, ...patch}; for (const fn of [...listeners]) if (listeners.has(fn)) fn();};
  function makeProviders() {
    const providerId = providersCreated.length;
    const providers = createSourceImportProviders({request(path, options, body) {
      const kind = path === '/album-tops' ? 'finalize' : path.includes('/source-imports?') ? 'list'
        : path === '/album-tops/source-imports' ? body === undefined ? 'list' : 'submit'
          : path.endsWith('/cancel') ? 'cancel' : path.endsWith('/process') ? 'process' : 'read';
      const gate = F.deferred(), request = {kind, path, options, body: body === undefined ? undefined : F.clone(body), providerId,
        settled: false, resolve(value) {request.settled = true; gate.resolve(value);}, reject(error) {request.settled = true; gate.reject(error);}};
      requests.push(request);
      const queue = queues.get(kind);
      if (queue?.length) {
        const result = queue.shift();
        if (typeof result === 'function') Promise.resolve().then(() => result(request)).then(request.resolve, request.reject);
        else Promise.resolve(result).then(request.resolve, request.reject);
      } else if (kind === 'list') request.resolve(F.clone(page(feed)));
      return gate.promise;
    }});
    providersCreated.push(providers); return providers;
  }
  const providers = makeProviders();
  const options = {runtime, notifications, providers, key() {keyCalls++; return key ? key(keyCalls) : F.id(1100 + ++sequence);},
    onOpen(value, isCurrent) {openings.push({value, isCurrent}); return open(value, isCurrent);},
    onDenied(scope, error) {denials.push({scope, error}); denied?.(scope, error);}};
  const tasks = createSourceImportTasks(options);
  t.after(async () => {
    tasks.dispose(); await drain(); assert.equal(listeners.size, 0); assert.ok(registrations.every(row => row.disposed));
    assert.equal(env.owner('getRequestNotificationCards')().length, 0);
    assert.deepEqual(storage, [], 'private tasks never read or persist browser storage');
    assert.deepEqual(env.forbiddenCalls, [], 'task owner creates no timer, navigation or playback side effects');
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  const calls = kind => requests.filter(row => row.kind === kind);
  const last = kind => {const value = calls(kind).at(-1); assert.ok(value, `actual ${kind} request exists`); return value;};
  const currentRegistration = () => registrations.filter(row => !row.disposed).at(-1);
  const cards = () => env.owner('getRequestNotificationCards')().filter(row => !row.status);
  const rows = () => currentRegistration()?.replacements.at(-1)?.rows || [];
  return {env, tasks, runtime, providers, providersCreated, makeProviders, requests, registrations, listeners, openings, denials,
    storage, options, change, calls, last, cards, rows, currentRegistration, keyCalls: () => keyCalls,
    setFeed(value) {feed = value;}, rejectScope() {accepted = false; change({});},
    queue(kind, value) {if (!queues.has(kind)) queues.set(kind, []); queues.get(kind).push(value);},
    hold(kind) {const gate = F.deferred(); if (!queues.has(kind)) queues.set(kind, []); queues.get(kind).push(gate.promise); return gate;},
    activate(id) {const card = cards().find(row => row.id === id); assert.ok(card, `actual registry card ${id}`); return card.source.onOpen(card.id);},
    show() {const record = currentRegistration(); assert.ok(record); return record.options.onShow();}};
}
async function ready(t, options) {const h = fixture(t, options); await drain(); return h;}
async function submit(h, controller = h.tasks.create(), patch = {}) {
  assert.ok(controller); const work = controller.submit(INPUT); await drain(); const request = h.last('submit');
  const value = job({request_key: request.body.request_key, ...patch}); request.resolve(value);
  assert.equal(await work, true); await drain(); return {controller, value, request};
}
async function resume(h, value = job()) {
  const work = h.tasks.resume(value.job_ref); await drain(); h.last('read').resolve(value);
  const controller = await work; assert.ok(controller); await drain(); return controller;
}
function noImplicitActions(h) {
  assert.equal(h.calls('process').length, 0); assert.equal(h.calls('cancel').length, 0);
  assert.equal(h.calls('finalize').length, 0); assert.equal(h.openings.length, 0);
}
module.exports = {F, JOB, OTHER_JOB, REQUEST, SAVED_TOP, TIME, INPUT, summary, job, page, receipt,
  load, fixture, ready, submit, resume, drain, noImplicitActions};
