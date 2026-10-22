'use strict';
// Additive reviewed source regressions. Actual classic helper is the only RNG
// algorithm; the injected ports below deliberately supply invalid outputs only.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const {id, plain, refs, options, representatives, controllerFixture} = require('./sample-native-fixtures.cjs');
const invalidShuffles = {
  null: () => null,
  object: () => ({0: refs[0], 1: refs[1], 2: refs[2], length: 3}),
  missing: values => values.slice(1),
  duplicate: values => [values[0], values[0], values[2]],
  foreign: values => [values[0], values[1], 'inventory-track:5:4'],
};
for (const [name, shuffleCopy] of Object.entries(invalidShuffles)) test(`Random rejects ${name} shuffle output before capture`, async t => {
  let calls = 0;
  const h = await controllerFixture({}, {shuffleCopy: (values, random) => {calls++; return shuffleCopy(values, random);}});
  t.after(() => h.controller.dispose()); await h.generate();
  assert.equal(h.calls.representatives.length, 1); assert.equal(calls, 1);
  assert.equal(h.calls.capture.length, 0); assert.equal(h.controller.source(), null);
  await h.controller.retryCapture(); await h.controller.recoverCapture();
  assert.equal(h.calls.capture.length, 0); assert.equal(h.calls.read.length, 0);
});

test('Random without the shared shuffle port fails before capture instead of implementing a fallback algorithm', async t => {
  const h = await controllerFixture({}, {shuffleCopy: undefined}); t.after(() => h.controller.dispose());
  await h.generate(); assert.equal(h.calls.capture.length, 0); assert.equal(h.controller.source(), null); assert.equal(h.draws(), 0);
});

test('Most-listened does not require or invoke the shared shuffle dependency', async t => {
  const h = await controllerFixture({}, {shuffleCopy: undefined}); t.after(() => h.controller.dispose());
  await h.generate({options: options('most_listened')});
  assert.equal(h.calls.representatives.length, 0); assert.equal(h.calls.capture.length, 1);
  assert.equal(h.calls.capture[0].random_order, null); assert.equal(h.draws(), 0);
  assert.ok(h.controller.source());
});

test('explicit quota5001 is not confused with the source-member bound5000', async t => {
  const h = await controllerFixture(); t.after(() => h.controller.dispose());
  const requested = options('random', {songs_per_group: 5001});
  await h.generate({options: requested});
  assert.equal(h.calls.representatives.length, 1); assert.equal(h.calls.representatives[0].options.songs_per_group, 5001);
  assert.equal(h.calls.capture.length, 1); assert.equal(h.calls.capture[0].options.songs_per_group, 5001);
  assert.deepEqual(h.calls.capture[0].random_order, [refs[1], refs[2], refs[0]]); assert.ok(h.controller.source());
});

test('failed new acquisition permanently retires the old capture intent from Retry and Check', async t => {
  let acquisitions = 0;
  const h = await controllerFixture({readSamplePlaylistRepresentatives: async input => {
    if (++acquisitions === 2) throw new Error('New representative acquisition failed');
    return representatives(input.scopeKey, {parent: {playlist_ref: input.playlist_ref, revision: input.revision}, options: input.options});
  }}); t.after(() => h.controller.dispose());
  await h.generate(); const original = plain({...h.calls.capture[0], signal: undefined}); assert.ok(h.controller.source());
  await h.generate({options: options('random', {songs_per_group: 3})});
  assert.equal(acquisitions, 2); assert.equal(h.keys(), 2); assert.equal(h.controller.source(), null);
  await h.controller.retryCapture(); await h.controller.recoverCapture();
  assert.equal(h.calls.capture.length, 1); assert.equal(h.calls.read.length, 0);
  assert.equal(h.keys(), 2); assert.equal(h.controller.source(), null);
  assert.deepEqual(plain({...h.calls.capture[0], signal: undefined}), original);
  // Only another deliberate Generate can acquire/capture again, with a new key.
  await h.generate({options: options('random', {songs_per_group: 3})});
  assert.equal(acquisitions, 3); assert.equal(h.calls.capture.length, 2); assert.equal(h.calls.capture[1].request_key, id(92));
  assert.notEqual(h.calls.capture[1].request_key, original.request_key); assert.ok(h.controller.source());
});

test('native runtime shuffle port delegates to the actual shared classic helper once', () => {
  const h = nativeFixture(), original = h.c.playlistQueueShuffleCopy, input = Object.freeze([...refs]); let calls = 0;
  h.c.playlistQueueShuffleCopy = (values, random) => {calls++; assert.equal(values, input); return original(values, random);};
  const result = h.runtime.shuffleSamplePlaylistRefs(input, () => 0);
  assert.equal(calls, 1); assert.deepEqual(Array.from(result), [refs[1], refs[2], refs[0]]);
  assert.notEqual(result, input); assert.deepEqual(input, refs);
});
