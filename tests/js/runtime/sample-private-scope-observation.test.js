'use strict';
// Read-only scope observation uses the real Playlist runtime and real private
// transport. Existing positive facade suites remain unchanged.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const {topOwner} = require('./sample-origin-integration-fixture.cjs');
function api(h) {
  const transport = h.owner('PrivateUITransport');
  assert.equal(typeof h.runtime.isCurrentPrivateScope, 'function');
  assert.equal(typeof transport.peekGeneration, 'function');
  assert.equal(transport, h.c.AlbumHavenPrivateUITransport);
  return transport;
}
function observe(t, h) {
  const counts = {runtime: 0, transport: 0};
  t.after(h.runtime.subscribe(() => {counts.runtime++;}));
  t.after(h.owner('PrivateUITransport').subscribe(() => {counts.transport++;}));
  return counts;
}
function draftCurrentnessTap(t, h) {
  const open = h.runtime.openDraft, seen = []; let calls = 0;
  h.runtime.openDraft = function (input) {
    const actual = input.isCurrent;
    assert.equal(typeof actual, 'function');
    const observed = {...input, isCurrent(...args) {calls++; return actual.apply(this, args);}};
    seen.push({actual, observed}); return open.call(this, observed);
  };
  t.after(() => {h.runtime.openDraft = open;});
  return {seen, count: () => calls};
}
function mark(h) {
  return {view: h.state.view, history: JSON.stringify(h.c.history.state), url: h.c.location.href,
    hidden: h.host.hidden, children: [...h.host.childNodes], focus: h.document.activeElement};
}
function unchanged(h, before) {
  assert.equal(h.state.view, before.view); assert.equal(JSON.stringify(h.c.history.state), before.history);
  assert.equal(h.c.location.href, before.url); assert.equal(h.host.hidden, before.hidden);
  assert.deepEqual([...h.host.childNodes], before.children); assert.equal(h.document.activeElement, before.focus);
}

test('private scope observation fails before Playlist initialization without initializing it', t => {
  // Obtain the equal-input token from a separate real initialized runtime rather
  // than guessing or parsing authority. It cannot initialize this fresh owner.
  const reference = nativeFixture(), supplied = reference.runtime.snapshot().scopeKey;
  const h = nativeFixture(), transport = api(h), counts = observe(t, h), before = mark(h), generation = transport.peekGeneration();
  assert.equal(generation, 0, 'valid generation zero is not an unavailable/null generation');
  assert.equal(h.runtime.isCurrentPrivateScope(supplied), false);
  assert.equal(h.runtime.isCurrentPrivateScope(null), false);
  assert.equal(h.runtime.isCurrentPrivateScope(supplied), false);
  assert.deepEqual(counts, {runtime: 0, transport: 0}); unchanged(h, before);
  assert.equal(transport.peekGeneration(), generation);
  const first = h.runtime.snapshot(); assert.equal(first.scopeKey, supplied);
  assert.equal(counts.runtime, 1, 'explicit first snapshot, not the accessor, initializes and notifies');
  assert.equal(h.runtime.isCurrentPrivateScope(first.scopeKey), true); assert.equal(counts.runtime, 1);
});

test('hidden shell and missing authenticated actor reject the retained scope without synchronization', t => {
  const h = nativeFixture(), transport = api(h), before = h.runtime.snapshot(), counts = observe(t, h), generation = transport.peekGeneration();
  h.shell.hidden = true;
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.deepEqual(counts, {runtime: 0, transport: 0});
  h.shell.hidden = false; const actor = h.shell.dataset.nativeAccountId;
  h.shell.dataset.nativeAccountId = '';
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.deepEqual(counts, {runtime: 0, transport: 0});
  h.shell.dataset.nativeAccountId = actor;
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), true);
  assert.equal(h.runtime.snapshot(), before, 'reads did not initialize a new scope or change local generation');
  assert.equal(transport.peekGeneration(), generation); assert.deepEqual(counts, {runtime: 0, transport: 0});
  h.shell.dataset.nativeAccountId = '';
  const anonymous = h.runtime.snapshot(), baseline = {...counts};
  assert.equal(anonymous.authenticated, false);
  assert.equal(h.runtime.isCurrentPrivateScope(anonymous.scopeKey), false, 'matching initialized identity is insufficient without an authenticated actor');
  assert.equal(h.runtime.snapshot(), anonymous); assert.deepEqual(counts, baseline);
});

for (const status of [401, 403]) test(`consumed actual Playlist ${status} denial rejects even its current denied scope`, async t => {
  const h = nativeFixture(), transport = api(h), before = h.runtime.snapshot(); let requests = 0;
  h.c.fetch = async () => {requests++; return {ok: false, status, json: async () => ({error: 'forbidden'})};};
  await assert.rejects(h.runtime.readPlaylists({scopeKey: before.scopeKey}), error => error.status === status);
  assert.equal(requests, 1);
  const denied = h.runtime.snapshot(); assert.equal(denied.authenticated, false); assert.notEqual(denied.scopeKey, before.scopeKey);
  const counts = observe(t, h), generation = transport.peekGeneration(), state = mark(h);
  assert.equal(h.runtime.isCurrentPrivateScope(denied.scopeKey), false);
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.equal(h.runtime.isCurrentPrivateScope(denied.scopeKey), false);
  assert.deepEqual(counts, {runtime: 0, transport: 0}); unchanged(h, state);
  assert.equal(h.runtime.snapshot(), denied); assert.equal(transport.peekGeneration(), generation); assert.equal(requests, 1);
});

for (const retirement of ['invalidate', 'dispose']) test(`actual transport ${retirement} remains unavailable to read-only scope observation`, t => {
  const h = nativeFixture(), transport = api(h), before = h.runtime.snapshot();
  const counts = observe(t, h);
  transport[retirement](); // Actual owner transition, before the observation interval.
  const retired = h.runtime.snapshot(), baseline = {...counts}, state = mark(h);
  assert.equal(transport.peekGeneration(), null);
  assert.equal(h.runtime.isCurrentPrivateScope(retired.scopeKey), false);
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.equal(transport.peekGeneration(), null);
  assert.deepEqual(counts, baseline); unchanged(h, state); assert.equal(h.runtime.snapshot(), retired);
});

test('raw malformed context and observed transport round trip never make old captured scope current', t => {
  const h = nativeFixture(), transport = api(h), first = h.runtime.snapshot(), counts = observe(t, h);
  const original = h.shell.dataset.privateUiContext, initial = transport.peekGeneration(), state = mark(h);
  h.shell.dataset.privateUiContext = 'not-a-valid-private-context';
  assert.equal(transport.peekGeneration(), null); assert.equal(h.runtime.isCurrentPrivateScope(first.scopeKey), false);
  h.shell.dataset.privateUiContext = 'b'.repeat(64);
  assert.equal(transport.peekGeneration(), null); assert.equal(h.runtime.isCurrentPrivateScope(first.scopeKey), false);
  assert.deepEqual(counts, {runtime: 0, transport: 0}); unchanged(h, state);
  // These explicit ordinary transport operations, unlike peek/accessor reads,
  // are allowed to synchronize and notify the actual runtime subscriber.
  assert.equal(transport.generation(), initial + 1);
  const second = h.runtime.snapshot(), observed = {...counts};
  assert.notEqual(second.scopeKey, first.scopeKey); assert.equal(transport.peekGeneration(), initial + 1);
  assert.equal(h.runtime.isCurrentPrivateScope(second.scopeKey), true);
  assert.equal(h.runtime.isCurrentPrivateScope(first.scopeKey), false); assert.deepEqual(counts, observed);
  h.shell.dataset.privateUiContext = original;
  assert.equal(transport.peekGeneration(), null); assert.equal(h.runtime.isCurrentPrivateScope(second.scopeKey), false);
  assert.deepEqual(counts, observed);
  assert.equal(transport.generation(), initial + 2);
  const third = h.runtime.snapshot(), returned = {...counts};
  assert.notEqual(third.scopeKey, first.scopeKey); assert.notEqual(third.scopeKey, second.scopeKey);
  assert.equal(transport.peekGeneration(), initial + 2); assert.equal(h.runtime.isCurrentPrivateScope(third.scopeKey), true);
  assert.equal(h.runtime.isCurrentPrivateScope(first.scopeKey), false); assert.equal(h.runtime.isCurrentPrivateScope(second.scopeKey), false);
  assert.deepEqual(counts, returned);
});

for (const change of ['actor', 'library', 'transport']) test(`active actual typed draft rejects unsynchronized ${change} loss without read-side reentry`, async t => {
  const h = await topOwner(t, {mode: 'saved'}), transport = api(h), tap = draftCurrentnessTap(t, h);
  h.click(h.sourceButton()); await h.settle(); h.assertSetup(); assert.equal(tap.seen.length, 1);
  const before = h.runtime.snapshot(), counts = observe(t, h), state = mark(h), checks = tap.count();
  const generation = transport.peekGeneration(), key = {actor: 'nativeAccountId', library: 'nativeLibraryId', transport: 'privateUiContext'}[change];
  const original = h.shell.dataset[key];
  h.shell.dataset[key] = change === 'transport' ? 'b'.repeat(64) : '999';
  // No await, observer flush, snapshot, sync, transport.context/generation, or
  // source guard between the actual input change and these accessor assertions.
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), false);
  assert.equal(tap.count(), checks, 'accessor cannot call active draft currentness or reenter its actual facade');
  assert.deepEqual(counts, {runtime: 0, transport: 0}); unchanged(h, state);
  assert.equal(transport.peekGeneration(), change === 'transport' ? null : generation);
  h.shell.dataset[key] = original;
  assert.equal(transport.peekGeneration(), generation);
  assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), true, 'observation does not itself mutate or retire authority');
  assert.equal(h.runtime.snapshot(), before, 'read-side rejection did not advance local generation or synchronize changed inputs');
  assert.deepEqual(counts, {runtime: 0, transport: 0});
  // Directly observing the real currentness callback is a separate, deliberate
  // retirement operation, not part of the read-only accessor interval.
  h.shell.dataset[key] = change === 'transport' ? 'b'.repeat(64) : '999';
  assert.equal(tap.seen[0].actual(), false);
  h.shell.dataset[key] = original;
  assert.equal(tap.seen[0].actual(), false, 'restored inputs cannot revive a retired typed origin wrapper');
  h.runtime.sync(); h.actual.sync(); await h.settle();
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.named('Generate', h.host), undefined);
  assert.deepEqual(h.history.traversals, []); h.noWrites(h.svc);
});

test('repeated valid and foreign scope observations leave an active actual typed draft untouched', async t => {
  const h = await topOwner(t, {mode: 'saved'}), transport = api(h), tap = draftCurrentnessTap(t, h);
  h.click(h.sourceButton()); await h.settle(); h.assertSetup(); assert.equal(tap.seen.length, 1);
  const before = h.runtime.snapshot(), counts = observe(t, h), checks = tap.count(), state = mark(h), generation = transport.peekGeneration();
  for (let n = 0; n < 4; n++) {
    assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey), true);
    assert.equal(h.runtime.isCurrentPrivateScope(before.scopeKey + ':foreign'), false);
  }
  assert.equal(tap.count(), checks); assert.deepEqual(counts, {runtime: 0, transport: 0}); unchanged(h, state);
  assert.equal(transport.peekGeneration(), generation);
  assert.equal(h.runtime.snapshot(), before, 'no new runtime snapshot or local generation was produced');
  assert.deepEqual(counts, {runtime: 0, transport: 0}); assert.equal(tap.seen[0].actual(), true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, tap.seen[0].observed.token); h.noWrites(h.svc);
});
