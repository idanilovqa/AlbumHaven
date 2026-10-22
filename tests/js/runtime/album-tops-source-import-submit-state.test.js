'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./album-tops-source-match-fixtures/session.cjs');
const {F, JOB, REQUEST, SOURCE} = M;
const INPUT = Object.fromEntries(Object.entries(SOURCE).filter(([key]) => key !== 'request_key'));
let createSourceImportController, createSourceImportProviders;
test.before(async () => {
  ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));
  ({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));
});
function fixture(t, {key} = {}) {
  const transport = [], providerCalls = [], live = {current: true}; let keys = 0, publications = 0;
  const real = createSourceImportProviders({request(path, options, body) {
    const gate = F.deferred(), value = {path, options, body: body === undefined ? undefined : F.clone(body), ...gate};
    transport.push(value); return gate.promise;
  }});
  const providers = Object.fromEntries(Object.entries(real).map(([name, call]) => [name, (...args) => {
    providerCalls.push({name, args}); return call(...args);
  }]));
  const controller = createSourceImportController({providers, scopeKey: F.SCOPE, isCurrent: () => live.current,
    key() {keys++; return key ? key(keys) : REQUEST;}});
  controller.subscribe(() => {publications++;}); t.after(() => controller.dispose());
  return {controller, transport, providerCalls, live, keys: () => keys, publications: () => publications,
    last() {const value = transport.at(-1); assert.ok(value); return value;}};
}
function pure(h, expected) {
  const snapshot = h.controller.getSnapshot(), counts = [h.keys(), h.providerCalls.length, h.transport.length, h.publications()];
  for (let count = 0; count < 4; count++) assert.equal(h.controller.canSubmit(), expected);
  assert.equal(h.controller.getSnapshot(), snapshot);
  assert.deepEqual([h.keys(), h.providerCalls.length, h.transport.length, h.publications()], counts);
}
const rejected = () => Object.assign(new Error('Definitive refusal'), {status: 409, responseRejected: true});

test('canSubmit is an observable pure initial predicate with no allocation, request or publication', t => {
  const h = fixture(t); pure(h, true); assert.equal(h.keys(), 0); assert.equal(h.transport.length, 0);
});

for (const [label, patch] of [['empty title', {title: ''}], ['Unicode', {content: '\ud800'}],
  ['body bound', {content: 'x'.repeat(512 * 1024)}]]) test(`canSubmit remains true after local ${label} rejection and its corrected dispatch uses one key`, async t => {
  const h = fixture(t); assert.equal(await h.controller.submit({...INPUT, ...patch}), false); pure(h, true);
  assert.equal(h.controller.getSnapshot().error.responseRejected, true); assert.equal(h.providerCalls.length, 0);
  assert.equal(await h.controller.retry(), false); pure(h, true); assert.equal(h.keys(), 1);
  const pending = h.controller.submit(INPUT); await F.drain(); pure(h, false); assert.equal(h.keys(), 1);
  h.last().resolve(M.job()); assert.equal(await pending, true); pure(h, false);
});

test('canSubmit is false inside the key callback and cannot recursively admit another command', async t => {
  let h, nested;
  h = fixture(t, {key() {pure(h, false); nested = h.controller.submit({...INPUT, title: 'Nested'}); return REQUEST;}});
  const pending = h.controller.submit(INPUT); await F.drain(); assert.equal(await nested, false);
  assert.equal(h.keys(), 1); assert.equal(h.transport.length, 1); pure(h, false);
  h.last().resolve(M.job()); assert.equal(await pending, true); pure(h, false);
});

test('canSubmit is false inside command getters while a later local-error subscriber sees correction admitted', async t => {
  const h = fixture(t); let getterObserved = false, published = false;
  h.controller.subscribe(() => {if (h.controller.getSnapshot().status === 'error') {published = true; assert.equal(h.controller.canSubmit(), true);}});
  const input = {...INPUT}; Object.defineProperty(input, 'content', {enumerable: true, get() {
    getterObserved = true; pure(h, false); return '';
  }});
  assert.equal(await h.controller.submit(input), false); assert.equal(getterObserved, true); assert.equal(published, true);
  pure(h, true); assert.equal(h.providerCalls.length, 0); assert.equal(h.keys(), 1);
});

test('a key allocator exception releases the admission predicate without creating a retry intent', async t => {
  const h = fixture(t, {key(count) {if (count === 1) throw new Error('PRIVATE_KEY_FAILURE'); return REQUEST;}});
  assert.equal(await h.controller.submit(INPUT), false); pure(h, true); assert.equal(await h.controller.retry(), false);
  assert.equal(h.providerCalls.length, 0); const pending = h.controller.submit(INPUT); await F.drain(); pure(h, false);
  assert.equal(h.keys(), 2); h.last().resolve(M.job()); assert.equal(await pending, true); pure(h, false);
});

for (const kind of ['definitive', 'uncertain']) test(`canSubmit stays false after a dispatched ${kind} outcome and across its exact retry`, async t => {
  const h = fixture(t), pending = h.controller.submit(INPUT); await F.drain(); const first = h.last(); pure(h, false);
  first.reject(kind === 'definitive' ? rejected() : new Error('Acknowledgment lost')); assert.equal(await pending, false); pure(h, false);
  assert.equal(h.controller.getSnapshot().status, kind === 'definitive' ? 'error' : 'uncertain');
  assert.equal(await h.controller.submit({...INPUT, title: 'Changed body'}), false); assert.equal(h.transport.length, 1);
  const retry = h.controller.retry(); await F.drain(); pure(h, false); assert.deepEqual(h.last().body, first.body);
  assert.equal(h.keys(), 1); h.last().resolve(M.job()); assert.equal(await retry, true); pure(h, false);
});

for (const status of ['queued', 'completed', 'saved']) test(`an acknowledged ${status} job permanently closes new submission admission on its controller`, async t => {
  const h = fixture(t), pending = h.controller.open(JOB); await F.drain(); pure(h, false); assert.equal(h.keys(), 0);
  const wire = status === 'queued' ? M.job({status: 'queued', phase: 'source_processing', review: null})
    : status === 'saved' ? M.job({top_ref: M.SAVED_TOP, phase: 'top_created'}) : M.job();
  h.last().resolve(wire); assert.equal(await pending, true); pure(h, false);
  assert.equal(await h.controller.submit(INPUT), false); assert.equal(h.keys(), 0); assert.equal(h.transport.length, 1);
});

test('a failed initial read with no acknowledged job restores exactly the existing submit admission', async t => {
  const h = fixture(t), pending = h.controller.open(JOB); await F.drain(); pure(h, false);
  h.last().reject(rejected()); assert.equal(await pending, false); assert.equal(h.controller.getSnapshot().job, null); pure(h, true);
  assert.equal(h.keys(), 0); const submitted = h.controller.submit(INPUT); await F.drain(); pure(h, false);
  assert.equal(h.keys(), 1); h.last().resolve(M.job()); assert.equal(await submitted, true); pure(h, false);
});

for (const action of ['dispose', 'scope']) test(`canSubmit stays false after ${action}, with no new key or provider side effects`, async t => {
  const h = fixture(t); if (action === 'dispose') h.controller.dispose(); else h.live.current = false;
  assert.equal(h.controller.canSubmit(), false); assert.equal(h.controller.getSnapshot().status, 'retired'); pure(h, false);
  assert.equal(await h.controller.submit(INPUT), false); assert.equal(h.keys(), 0); assert.equal(h.providerCalls.length, 0);
});

test('canSubmit consumes invalid scope through the existing lifetime fence and aborts pending work without dispatching again', async t => {
  const h = fixture(t), pending = h.controller.submit(INPUT); await F.drain(); const request = h.last(); h.live.current = false;
  assert.equal(h.controller.canSubmit(), false); assert.equal(request.options.signal.aborted, true);
  request.resolve(M.job()); assert.equal(await pending, false); pure(h, false);
  assert.equal(h.keys(), 1); assert.equal(h.transport.length, 1); assert.equal(h.controller.getSnapshot().status, 'retired');
});

test('a successor read entered from the key callback owns admission while the abandoned submit remains inert', async t => {
  let h, reading;
  h = fixture(t, {key() {assert.equal(h.controller.canSubmit(), false); reading = h.controller.open(JOB);
    assert.equal(h.controller.canSubmit(), false); return REQUEST;}});
  assert.equal(await h.controller.submit(INPUT), false); await F.drain(); pure(h, false);
  assert.deepEqual(h.providerCalls.map(row => row.name), ['readSourceImport']); h.last().resolve(M.job());
  assert.equal(await reading, true); pure(h, false); assert.equal(h.transport.length, 1);
});
