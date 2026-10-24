'use strict';
// Additive synthetic wire/platform support. Product ESM is imported unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const load = name => import(pathToFileURL(path.join(ROOT, 'music_app/static/js/foobar-import', name)).href);
const STAMP = 'a'.repeat(64), SOURCE = '00000000-0000-4000-8000-000000000001';
const JOBREF = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const JOB = 'foobar_account_job_v3', REVIEW = 'foobar_account_review_v4';
const SCOPE = 'account-foobar-v1', MAPPING = 'foobar_text_tools_snapshot_v1';
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = async () => {for (let n = 0; n < 40; n++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve));};
const clone = value => JSON.parse(JSON.stringify(value));
const file = (name = 'original.tsv', bytes = 'path\tplay_count\n/music/a.flac\t2\n') => Object.defineProperty(new Blob([bytes], {type: 'text/tab-separated-values'}), 'name', {value: name});
const response = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const envelope = (protocol, operation, result) => ({protocol, operation, result, context_ref: STAMP, context_scope: SCOPE});
const source = () => envelope('foobar_account_import_v4', 'source', {source_ref: SOURCE, generation: 1, source_revision: 0, ownership_protocol: 'foobar_account_source_v2'});
const command = patch => ({source_ref: SOURCE, job_ref: JOBREF, upload_sha256: 'b'.repeat(64), parser_version: MAPPING, mapping_name: MAPPING, original_matching_library_id: null, original_generation: 1, total_rows: 4, ...patch});
const accepted = (protocol, operation, identity = {}) => ({protocol, operation, source_ref: SOURCE, job_ref: JOBREF, phase: protocol === REVIEW ? 'accepted_for_review' : 'accepted_for_validation', durable_start_confirmed: false, context_ref: STAMP, context_scope: SCOPE, ...identity});
const proposal = patch => ({command: command(), inventory_sha256: 'c'.repeat(64), resume: false, review_sha256: 'd'.repeat(64), checked_rows: 4, start_offset: 0, planned_batches: 1, proposed_counts: [1, 2, 0, 1, 1, 0, 2], review_counts: [4, 1, 1, 1, 1, 1], problems: [{row: 1, code: 'protected_rating', field: 'rating'}], problems_truncated: false, advisory_not_reservation: true, conflicts: [], conflict_count: 0, conflict_after: 0, conflict_next: null, conflict_remaining: 0, problem_items: [{cursor: ((patch?.start_offset || 0) + 1) * 32, row: (patch?.start_offset || 0) + 1, code: 'protected_rating', field: 'rating', source_artist: 'Source artist', source_title: 'Source song', source_album: 'Source album'}], problem_count: 1, problem_after: 0, problem_next: null, problem_remaining: 0, ...patch});
const review = (patch = {}, operation = 'status') => envelope(REVIEW, operation, {phase: 'review_ready', error: null, review: proposal(), source_ref: SOURCE, job_ref: JOBREF, ...patch});
const job = (patch = {}, operation = 'status') => envelope(JOB, operation, {phase: 'paused', snapshot_kind: 'durable', uncertain: false, cancel_pending: false, error: null, command: command(), confirmed_rows: 2, remaining_rows: 2, confirmed_counts: [0, 1, 0, 1, 1, 0, 1], disposition: 'paused', cancel_requested: false, pending_attempt: null, ...patch});
function wire({initialList = true} = {}) {
  const calls = [], queues = new Map();
  const enqueue = (route, ...items) => {const queue = queues.get(route) || []; queue.push(...items); queues.set(route, queue); return api;};
  const api = {calls, queues, enqueue, fetch(url, init) {
    const route = url.replace('/integrations/foobar/account', '');
    calls.push({url, route, init});
    assert.equal(url, '/integrations/foobar/account' + route);
    const queue = queues.get(route); assert.ok(queue?.length, `Explicit synthetic response required for ${route}`);
    const next = queue.shift(); return typeof next === 'function' ? next(url, init) : Promise.resolve(response(next));
  }, remaining() {return [...queues.values()].reduce((sum, queue) => sum + queue.length, 0);}};
  if (initialList) enqueue('/job/list', envelope('foobar_account_job_list_v1', 'list', {unfinished: true, snapshot_kind: 'durable_page', busy: false, items: [], next_cursor: null}));
  return api;
}
// This scheduler never advances by elapsed wall-clock time. A test must name the
// exact pending delay. Import/controller code, cancellation, and callbacks stay real.
function clock() {
  const originals = new Map(), tasks = new Map(); let next = 0;
  for (const name of ['setTimeout', 'clearTimeout']) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'setTimeout', {configurable: true, writable: true, value(callback, delay, ...args) {const id = ++next; tasks.set(id, {callback, delay, args}); return id;}});
  Object.defineProperty(globalThis, 'clearTimeout', {configurable: true, writable: true, value(id) {tasks.delete(id);}});
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {configurable: true, value: {randomUUID: () => JOBREF}});
  return {tasks, async tick(delay = 1000) {const row = [...tasks].find(([, task]) => task.delay === delay); assert.ok(row, `A ${delay} ms task must be scheduled`); tasks.delete(row[0]); row[1].callback(...row[1].args); await settle();},
    restore() {for (const [name, descriptor] of originals) Object.defineProperty(globalThis, name, descriptor); if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto; tasks.clear();}};
}
async function controller(t, transport = wire(), options = {}) {
  const {createImportController} = await load('controller.mjs');
  const time = clock(), publications = [];
  const root = {isConnected: true, dataset: {accountFoobarContext: STAMP, accountFoobarScope: SCOPE, accountFoobarMatchingLibraryId: options.library || ''}};
  let allowed = true, current = true;
  const owner = createImportController({fetch: transport.fetch, contextRoot: root, allows: action => allowed && action === 'account.self.foobar.write', isCurrent: () => current, onChange: state => publications.push(state)});
  t.after(() => {try {owner.dispose(); assert.equal(time.tasks.size, 0, 'All controller timers retired');} finally {time.restore();}});
  return {owner, root, time, wire: transport, publications, allow(value) {allowed = value;}, current(value) {current = value;}};
}
async function ready(f, options = {}) {
  f.wire.enqueue('/ui/source', source()); await f.owner.initialize();
  const selected = options.file || file(); f.owner.choose(selected);
  if (options.matching) f.owner.setMatching(true);
  f.wire.enqueue('/review/start', accepted(REVIEW, 'start'));
  f.wire.enqueue('/review/status', review({review: proposal({command: command({original_matching_library_id: options.matching ? Number(f.root.dataset.accountFoobarMatchingLibraryId) : null})})}));
  await f.owner.preview(); await f.time.tick();
  assert.equal(f.owner.getState().phase, 'review_ready'); return selected;
}
module.exports = {ROOT, read, load, STAMP, SOURCE, JOBREF, OTHER, JOB, REVIEW, SCOPE, MAPPING, deferred, settle, clone, file, response, envelope, source, command, accepted, proposal, review, job, wire, clock, controller, ready, vm};
