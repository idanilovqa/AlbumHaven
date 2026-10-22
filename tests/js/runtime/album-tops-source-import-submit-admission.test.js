'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const JOB = F.id(971), REQUEST = F.id(972), TIME = '2026-10-19T12:00:00Z';
const INPUT = {title: 'Imported Top', description: 'Private notes', kind: 'text', filename: null, content: '1. Artist - Album'};
let createSourceImportController, createSourceImportProviders, sourceImportCommand;
test.before(async () => {
  ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));
  ({createSourceImportProviders, sourceImportCommand} = await F.load('album-tops/source-import-provider.mjs'));
});
async function drain() {for (let n = 0; n < 24; n++) await Promise.resolve();}
function job(command = {request_key: REQUEST, ...INPUT}) {
  return {job_ref: JOB, request_key: command.request_key, status: 'queued', revision: '1', title: command.title, kind: command.kind,
    created_at: TIME, updated_at: TIME, phase: 'source_processing', error: null, top_ref: null, source: F.clone(command), review: null};
}
function fixture(t, {key} = {}) {
  const transport = [], providerCalls = [], live = {current: true}; let keys = 0;
  const real = createSourceImportProviders({request(path, options, body) {
    const gate = F.deferred(), row = {path, options, body: body === undefined ? undefined : F.clone(body), ...gate};
    transport.push(row); return gate.promise;
  }});
  // Observe actual public provider calls without replacing validation/transport.
  const providers = Object.fromEntries(Object.entries(real).map(([name, call]) => [name, (...args) => {
    providerCalls.push({name, args}); return call(...args);
  }]));
  const controller = createSourceImportController({providers, scopeKey: F.SCOPE, isCurrent: () => live.current,
    key() {keys++; return key ? key(keys) : REQUEST;}});
  t.after(() => controller.dispose());
  return {controller, providers, transport, providerCalls, live, keys: () => keys,
    last() {const row = transport.at(-1); assert.ok(row, 'real request boundary was reached'); return row;}};
}
const validCommand = patch => ({request_key: REQUEST, ...INPUT, ...patch});
const localFailure = error => error?.status === 400 && error?.responseRejected === true;
const invalid = [
  ['empty title', {title: ''}], ['Unicode-only whitespace title', {title: '\u0085\u001c\u3000'}],
  ['101-codepoint title', {title: '🪄'.repeat(101)}], ['overlong description', {description: 'x'.repeat(1001)}],
  ['unknown kind', {kind: 'playlist'}], ['non-upload filename', {filename: 'private.html'}],
  ['missing upload filename', {kind: 'uploaded_html', filename: null}],
  ['upload path', {kind: 'uploaded_html', filename: '/PRIVATE/PATH/source.html'}],
  ['upload traversal', {kind: 'uploaded_html', filename: '..'}],
  ['empty content', {content: ''}], ['blank content', {content: '\u0085\u001c\u3000'}],
  ['NUL content', {content: 'a\0b'}], ['content surrogate', {content: '\ud800'}],
  ['title surrogate', {title: '\udfff'}], ['description surrogate', {description: '\ud800'}],
  ['upload filename surrogate', {kind: 'uploaded_html', filename: '\ud800.html'}],
  ['serialized UTF8 overflow', {content: '🪄'.repeat(128 * 1024)}],
  ['extra field', {private_path: '/PRIVATE/PATH'}], ['missing description', {description: undefined}],
];

for (const [label, patch] of invalid) test(`local ${label} is editable, dispatches nothing and retains its key for correction`, async t => {
  const h = fixture(t), c = h.controller;
  assert.equal(await c.submit({...INPUT, ...patch}), false);
  const error = c.getSnapshot(); assert.equal(error.status, 'error'); assert.equal(error.operation, 'submit');
  assert.equal(localFailure(error.error), true); assert.equal(h.providerCalls.length, 0); assert.equal(h.transport.length, 0);
  assert.equal(await c.retry(), false); assert.equal(h.providerCalls.length, 0); assert.equal(h.keys(), 1);
  const work = c.submit({...INPUT}); await drain();
  assert.equal(h.providerCalls.length, 1); assert.equal(h.providerCalls[0].name, 'submitSourceImport');
  assert.equal(h.transport.length, 1); assert.equal(h.keys(), 1);
  assert.deepEqual(h.last().body, validCommand()); h.last().resolve(job(h.last().body)); assert.equal(await work, true);
  assert.equal(c.getSnapshot().job.job_ref, JOB); assert.equal(c.getSnapshot().error, null);
});

test('the exported exact command validator normalizes once and returns detached frozen scalar evidence', () => {
  const input = validCommand({title: '\u0085\u001c  A 🪄 Top \u3000', content: '<script>inertPrivateContent()</script>'});
  const value = sourceImportCommand(input);
  assert.deepEqual(value, {...input, title: 'A 🪄 Top'}); assert.equal(Object.isFrozen(value), true);
  input.content = 'Changed'; assert.equal(value.content, '<script>inertPrivateContent()</script>');
  assert.throws(() => {value.title = 'Changed';}, TypeError);
  for (const [, patch] of invalid) assert.throws(() => sourceImportCommand(validCommand(patch)), localFailure);
});

test('exact serialized 512KiB boundary and astral title length are shared by export and real submit provider', async t => {
  const h = fixture(t), base = validCommand({title: '🪄'.repeat(100), content: ''});
  const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const command = {...base, content: 'x'.repeat(512 * 1024 - overhead)};
  assert.equal(new TextEncoder().encode(JSON.stringify(command)).byteLength, 512 * 1024);
  assert.deepEqual(sourceImportCommand(command), command);
  assert.throws(() => sourceImportCommand({...command, content: command.content + 'x'}), localFailure);
  const work = h.providers.submitSourceImport({command, scopeKey: F.SCOPE, signal: new AbortController().signal}); await drain();
  assert.deepEqual(h.last().body, command); h.last().resolve(job(command)); assert.equal((await work).job_ref, JOB);
});

test('corrected normalized command remains byte-identical across uncertain retry and caller mutation', async t => {
  const h = fixture(t), c = h.controller; assert.equal(await c.submit({...INPUT, title: ''}), false);
  const input = {...INPUT, title: '\u0085 Imported Top \u3000', content: '<b>Original private evidence</b>'};
  const first = c.submit(input); await drain(); const sent = h.last();
  input.title = 'Changed'; input.content = 'Changed'; sent.reject(new TypeError('Acknowledgment lost'));
  assert.equal(await first, false); assert.equal(c.getSnapshot().status, 'uncertain');
  assert.equal(await c.submit(INPUT), false); assert.equal(h.transport.length, 1);
  const retry = c.retry(); await drain(); const repeated = h.last();
  assert.deepEqual(repeated.body, sent.body); assert.equal(repeated.body.title, 'Imported Top');
  assert.equal(repeated.body.content, '<b>Original private evidence</b>'); assert.equal(h.keys(), 1);
  assert.notEqual(repeated.options.signal, sent.options.signal);
  repeated.resolve(job(repeated.body)); assert.equal(await retry, true); assert.equal(h.transport.length, 2);
});

test('key allocation reserves admission before recursively invoked submit can allocate or dispatch', async t => {
  let h, nested;
  h = fixture(t, {key() {nested = h.controller.submit({...INPUT, title: 'Nested'}); return REQUEST;}});
  const work = h.controller.submit(INPUT); await drain();
  assert.equal(await nested, false); assert.equal(h.keys(), 1); assert.equal(h.transport.length, 1);
  assert.equal(h.last().body.title, INPUT.title); h.last().resolve(job(h.last().body)); assert.equal(await work, true);
});

for (const action of ['dispose', 'scope', 'read']) test(`key callback ${action} makes the outer submission inert`, async t => {
  let h, reading;
  h = fixture(t, {key() {
    if (action === 'dispose') h.controller.dispose();
    else if (action === 'scope') h.live.current = false;
    else reading = h.controller.open(JOB);
    return REQUEST;
  }});
  assert.equal(await h.controller.submit(INPUT), false); await drain(); assert.equal(h.keys(), 1);
  if (action === 'read') {
    assert.deepEqual(h.providerCalls.map(row => row.name), ['readSourceImport']); assert.equal(h.last().body, undefined);
    h.last().resolve(job()); assert.equal(await reading, true); assert.equal(h.controller.getSnapshot().job.job_ref, JOB);
  } else {assert.equal(h.providerCalls.length, 0); assert.equal(h.controller.getSnapshot().status, 'retired');}
});

test('a throwing key allocator produces only a generic local error and no retry intent', async t => {
  const h = fixture(t, {key() {throw new Error('PRIVATE_KEY_ALLOCATOR_DETAILS');}});
  assert.equal(await h.controller.submit(INPUT), false);
  const state = h.controller.getSnapshot(); assert.equal(state.status, 'error'); assert.equal(state.operation, 'submit');
  assert.equal(localFailure(state.error), true); assert.doesNotMatch(state.error.message, /PRIVATE_KEY_ALLOCATOR_DETAILS/);
  assert.equal(typeof state.error.message, 'string'); assert.ok(state.error.message.length > 0); assert.equal(await h.controller.retry(), false);
  assert.equal(h.providerCalls.length, 0); assert.equal(h.transport.length, 0);
});

for (const action of ['dispose', 'scope', 'read']) test(`input normalization callback ${action} cannot leave a stale submit behind`, async t => {
  const h = fixture(t); let reading, touched = false;
  const input = {...INPUT}; Object.defineProperty(input, 'title', {enumerable: true, get() {
    if (!touched) {touched = true;
      if (action === 'dispose') h.controller.dispose(); else if (action === 'scope') h.live.current = false;
      else reading = h.controller.open(JOB);
    }
    return INPUT.title;
  }});
  assert.equal(await h.controller.submit(input), false); await drain(); assert.equal(touched, true);
  if (action === 'read') {
    assert.deepEqual(h.providerCalls.map(row => row.name), ['readSourceImport']); h.last().resolve(job());
    assert.equal(await reading, true); assert.equal(h.controller.getSnapshot().job.job_ref, JOB);
  } else {assert.equal(h.providerCalls.length, 0); assert.equal(h.controller.getSnapshot().status, 'retired');}
});

test('normalization getter recursion cannot dispatch or allocate a second admitted intent', async t => {
  const h = fixture(t); let nested, touched = false;
  const input = {...INPUT}; Object.defineProperty(input, 'content', {enumerable: true, get() {
    if (!touched) {touched = true; nested = h.controller.submit({...INPUT, title: 'Recursive'});} return INPUT.content;
  }});
  const work = h.controller.submit(input); await drain(); assert.equal(await nested, false);
  assert.equal(h.keys(), 1); assert.equal(h.transport.length, 1); assert.equal(h.last().body.title, INPUT.title);
  h.last().resolve(job(h.last().body)); assert.equal(await work, true);
});

for (const action of ['dispose', 'scope']) test(`local-error publication subscriber ${action} cannot revive rejected intake`, async t => {
  const h = fixture(t); h.controller.subscribe(() => {
    if (h.controller.getSnapshot().status !== 'error') return;
    if (action === 'dispose') h.controller.dispose(); else h.live.current = false;
  });
  assert.equal(await h.controller.submit({...INPUT, content: ''}), false);
  assert.equal(h.controller.getSnapshot().status, 'retired'); assert.equal(h.providerCalls.length, 0);
  assert.equal(await h.controller.retry(), false);
});

test('local-error subscriber may submit a corrected successor without old rejection overwriting it', async t => {
  const h = fixture(t); let armed = true, corrected;
  h.controller.subscribe(() => {
    if (armed && h.controller.getSnapshot().status === 'error') {armed = false; corrected = h.controller.submit(INPUT);}
  });
  assert.equal(await h.controller.submit({...INPUT, title: ''}), false); await drain();
  assert.equal(armed, false); assert.equal(h.controller.getSnapshot().status, 'loading');
  assert.equal(h.keys(), 1); assert.equal(h.providerCalls.length, 1); assert.deepEqual(h.last().body, validCommand());
  h.last().resolve(job(h.last().body)); assert.equal(await corrected, true);
  assert.equal(h.controller.getSnapshot().status, 'ready'); assert.equal(h.controller.getSnapshot().error, null);
});

test('a dispatched definitive server rejection keeps the existing exact-retry rule', async t => {
  const h = fixture(t), work = h.controller.submit(INPUT); await drain(); const first = h.last();
  first.reject(Object.assign(new Error('Definitive server refusal'), {status: 409, responseRejected: true}));
  assert.equal(await work, false); assert.equal(await h.controller.submit({...INPUT, title: 'Different command'}), false);
  const retry = h.controller.retry(); await drain(); const next = h.last();
  assert.deepEqual(next.body, first.body); assert.equal(h.keys(), 1);
  next.resolve(job(next.body)); assert.equal(await retry, true);
});

test('a later explicit submit may allocate a key after an allocator exception admitted nothing', async t => {
  const h = fixture(t, {key(calls) {if (calls === 1) throw new Error('PRIVATE_TRANSIENT_KEY_FAILURE'); return REQUEST;}});
  assert.equal(await h.controller.submit(INPUT), false); assert.equal(h.keys(), 1); assert.equal(h.providerCalls.length, 0);
  assert.equal(await h.controller.retry(), false); assert.equal(h.keys(), 1);
  const work = h.controller.submit(INPUT); await drain();
  assert.equal(h.keys(), 2); assert.equal(h.providerCalls.length, 1); assert.deepEqual(h.last().body, validCommand());
  h.last().resolve(job(h.last().body)); assert.equal(await work, true);
});
