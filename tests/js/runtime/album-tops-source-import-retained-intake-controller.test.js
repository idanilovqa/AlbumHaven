'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./album-tops-source-match-fixtures/session.cjs');
const {F, JOB, REQUEST} = M;
const INPUT = {title: 'Admitted source', description: '  Private notes  ', kind: 'text', filename: null, content: '  1. Artist - Album\n'};
const fields = ['content', 'description', 'filename', 'kind', 'title'];
let createSourceImportController, createSourceImportProviders;
test.before(async () => {
  ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));
  ({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));
});
const rejected = () => Object.assign(new Error('Definitive refusal'), {status: 422, responseRejected: true});
function wire(command, patch = {}) {return M.job({request_key: command.request_key, title: command.title,
  kind: command.kind, source: F.clone(command), ...patch});}
function fixture(t, {key} = {}) {
  const requests = [], live = {current: true}; let keys = 0, publications = 0;
  const providers = createSourceImportProviders({request(path, options, body) {
    const gate = F.deferred(), row = {path, options, body: body === undefined ? undefined : F.clone(body), ...gate};
    requests.push(row); return gate.promise;
  }});
  const controller = createSourceImportController({providers, scopeKey: F.SCOPE, isCurrent: () => live.current,
    key() {keys++; return key ? key() : REQUEST;}});
  controller.subscribe(() => {publications++;}); t.after(() => controller.dispose());
  return {controller, requests, live, keys: () => keys, publications: () => publications,
    last() {const row = requests.at(-1); assert.ok(row); return row;}};
}
function projection(h, expected) {
  const snapshot = h.controller.getSnapshot(), counts = [h.keys(), h.requests.length, h.publications()];
  const first = h.controller.getSubmittedSource(), second = h.controller.getSubmittedSource();
  assert.deepEqual(first, expected); assert.deepEqual(second, expected);
  if (expected !== null) {
    assert.notEqual(first, second, 'each read is a detached view-only copy');
    assert.equal(Object.getPrototypeOf(first), Object.prototype); assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(Reflect.ownKeys(first).sort(), fields);
    for (const name of fields) assert.equal(Object.getOwnPropertyDescriptor(first, name).get, undefined);
  }
  assert.equal(h.controller.getSnapshot(), snapshot); assert.deepEqual([h.keys(), h.requests.length, h.publications()], counts);
  return first;
}

test('unsubmitted projection is null without allocating keys, requests or publications', t => {
  const h = fixture(t); projection(h, null); assert.equal(h.keys(), 0); assert.equal(h.requests.length, 0);
});
for (const patch of [{title: ''}, {content: '\ud800'}]) test(`locally rejected ${patch.title === '' ? 'title' : 'Unicode'} has no admitted source projection`, async t => {
  const h = fixture(t); assert.equal(await h.controller.submit({...INPUT, ...patch}), false);
  assert.equal(h.controller.canSubmit(), true); projection(h, null); assert.equal(h.requests.length, 0); assert.equal(h.keys(), 1);
  assert.equal(await h.controller.retry(), false); projection(h, null);
});
for (const kind of ['url', 'text', 'pasted_html', 'uploaded_html']) test(`pending ${kind} projects exactly normalized frozen source scalars and never its request key`, async t => {
  const h = fixture(t), input = {...INPUT, title: '\u0085\u001c  A 🪄 Top \u3000', kind,
    filename: kind === 'uploaded_html' ? 'private-source.html' : null,
    content: kind === 'url' ? 'https://example.test/source?private=kept' : '  <b>Original private evidence</b>\n'};
  const expected = {...input, title: 'A 🪄 Top'}, work = h.controller.submit(input); await F.drain();
  const request = h.last(), copy = projection(h, expected); assert.equal(h.keys(), 1); assert.equal(h.requests.length, 1);
  assert.notEqual(copy, request.body); input.title = 'Replacement'; input.content = 'Replacement';
  assert.throws(() => {copy.content = 'Replacement';}, TypeError);
  assert.throws(() => {delete copy.filename;}, TypeError);
  assert.throws(() => Object.defineProperty(copy, 'request_key', {value: REQUEST}), TypeError);
  projection(h, expected); request.resolve(wire(request.body)); assert.equal(await work, true);
  projection(h, null); assert.deepEqual(copy, expected, 'old copies are inert immutable data after acknowledgment');
});
for (const outcome of ['uncertain', 'definitive']) test(`${outcome} submitted projection cannot alter the exact admitted retry`, async t => {
  const h = fixture(t), work = h.controller.submit(INPUT); await F.drain(); const first = h.last();
  first.reject(outcome === 'uncertain' ? new TypeError('Lost response') : rejected()); assert.equal(await work, false);
  const copy = projection(h, INPUT); assert.throws(() => {copy.kind = 'url';}, TypeError);
  assert.equal(await h.controller.submit({...INPUT, content: 'Changed source'}), false); assert.equal(h.requests.length, 1);
  const retry = h.controller.retry(); await F.drain(); projection(h, INPUT);
  assert.deepEqual(h.last().body, first.body); assert.equal(h.last().path, first.path); assert.equal(h.keys(), 1);
  h.last().resolve(wire(first.body)); assert.equal(await retry, true); projection(h, null);
});
for (const status of ['queued', 'completed', 'saved']) test(`${status} acknowledgment removes the transient submitted projection`, async t => {
  const h = fixture(t), work = h.controller.submit(INPUT); await F.drain(); const request = h.last(); projection(h, INPUT);
  const patch = status === 'queued' ? {status, phase: 'source_processing', review: null}
    : status === 'saved' ? {top_ref: M.SAVED_TOP, phase: 'top_created'} : {};
  request.resolve(wire(request.body, patch)); assert.equal(await work, true); projection(h, null);
  assert.equal(h.controller.getSnapshot().job.source.content, INPUT.content);
});
for (const outcome of ['pending', 'uncertain']) test(`a refused changed-job read preserves ${outcome} admitted projection and exact command ownership`, async t => {
  const h = fixture(t), submitting = h.controller.submit(INPUT); await F.drain(); const first = h.last(), old = projection(h, INPUT);
  if (outcome === 'uncertain') {first.reject(new TypeError('Lost response')); assert.equal(await submitting, false);}
  assert.equal(await h.controller.open(M.OTHER_JOB), false); assert.equal(h.requests.length, 1); projection(h, INPUT);
  assert.equal(first.options.signal.aborted, false); assert.deepEqual(old, INPUT);
  if (outcome === 'pending') {first.resolve(wire(first.body)); assert.equal(await submitting, true);}
  else {
    const retry = h.controller.retry(); await F.drain(); assert.deepEqual(h.last().body, first.body); projection(h, INPUT);
    h.last().resolve(wire(first.body)); assert.equal(await retry, true);
  }
  projection(h, null); assert.equal(h.keys(), 1); assert.equal(h.requests.length, outcome === 'pending' ? 1 : 2);
});
test('an admitted changed-job read after definitive rejection clears the submitted projection', async t => {
  const h = fixture(t), submitting = h.controller.submit(INPUT); await F.drain(); const first = h.last(), old = projection(h, INPUT);
  first.reject(rejected()); assert.equal(await submitting, false); projection(h, INPUT);
  const reading = h.controller.open(M.OTHER_JOB); await F.drain(); const read = h.last();
  assert.notEqual(read, first); projection(h, null);
  const command = {request_key: F.id(997), ...INPUT, title: 'Another acknowledged source', content: 'Other private evidence'};
  read.resolve(wire(command, {job_ref: M.OTHER_JOB})); assert.equal(await reading, true); projection(h, null);
  assert.equal(h.controller.getSnapshot().job.job_ref, M.OTHER_JOB); assert.deepEqual(old, INPUT); projection(h, null);
  assert.equal(h.keys(), 1); assert.equal(h.requests.length, 2);
});
for (const retirement of ['scope', 'dispose']) test(`${retirement} hides submitted evidence and fences its late acknowledgment`, async t => {
  const h = fixture(t), work = h.controller.submit(INPUT); await F.drain(); const request = h.last(), old = projection(h, INPUT);
  if (retirement === 'scope') h.live.current = false; else h.controller.dispose();
  assert.equal(h.controller.getSubmittedSource(), null); assert.equal(h.controller.getSnapshot().status, 'retired');
  assert.equal(request.options.signal.aborted, true); request.resolve(wire(request.body)); assert.equal(await work, false);
  projection(h, null); assert.deepEqual(old, INPUT); assert.equal(h.keys(), 1); assert.equal(h.requests.length, 1);
});
for (const operation of ['process', 'cancel', 'finalize']) test(`acknowledged ${operation} work never projects an old submitted command`, async t => {
  const h = fixture(t), work = h.controller.submit(INPUT); await F.drain(); const submitted = h.last();
  submitted.resolve(wire(submitted.body, operation === 'finalize' ? {} : {status: 'queued', phase: 'source_processing', review: null}));
  assert.equal(await work, true); projection(h, null);
  if (operation === 'finalize') assert.equal(h.controller.select('2', {kind: 'local_catalog', album_ref: F.C}), true);
  const pending = h.controller[operation](); await F.drain(); const request = h.last(); assert.notEqual(request, submitted); projection(h, null);
  request.resolve(operation === 'finalize' ? M.receipt(request.body) : wire(submitted.body,
    operation === 'cancel' ? {status: 'canceled', phase: 'source_processing', review: null} : {}));
  assert.equal(await pending, true); projection(h, null); assert.equal(h.keys(), 1);
});
for (const callback of ['key', 'input getter']) test(`admission ${callback} sees no projection before normalized intent is admitted`, async t => {
  let h, observed = false; const observe = () => {observed = true; assert.equal(h.controller.getSubmittedSource(), null); return REQUEST;};
  h = fixture(t, callback === 'key' ? {key: observe} : {}); const input = {...INPUT};
  if (callback === 'input getter') Object.defineProperty(input, 'content', {enumerable: true, get() {observe(); return INPUT.content;}});
  const work = h.controller.submit(input); await F.drain(); assert.equal(observed, true); projection(h, INPUT);
  h.last().resolve(wire(h.last().body)); assert.equal(await work, true); projection(h, null);
});
