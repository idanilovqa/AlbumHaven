'use strict';
// Actual SettingsNavigation owner and native history port. No replacement registry.
const test = require('node:test'), assert = require('node:assert/strict');
const {harness, settle, plain} = require('./library-mix-navigation-fixture.cjs');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function relationship(t, {childDecision = () => true, parentDecision = () => true} = {}) {
  const h = harness(), events = [], parentUrl = h.location.href;
  h.context.structuredClone = structuredClone; // Genuine browser primitive, before any relationship admission.
  const parentState = structuredClone(h.history.state), position = parentState.albumHavenNavigationPosition;
  let parentCurrent = true, childCurrent = true;
  const parent = {token: 'actual-top-parent', scopeKey: 'source-scope', isCurrent: () => parentCurrent,
    ownsHistoryEntry: (snapshot, url) => snapshot?.albumHavenNavigationPosition === position && url === parentUrl,
    confirmLeave: () => {events.push('confirm-parent'); return parentDecision();}, discard: () => {events.push('discard-parent'); parentCurrent = false;}};
  const registration = h.navigation.setCollectionDraftOwner(parent);
  assert.equal(typeof registration, 'function');
  assert.equal(typeof registration.registerPlaylistChild, 'function', 'R2 extends the real successful callable registration');
  const child = {token: 'sample-child', scopeKey: 'destination-scope', isCurrent: () => childCurrent,
    confirmLeave: () => {events.push('confirm-child'); return childDecision();}, discard: () => {events.push('discard-child'); childCurrent = false;}};
  const childRegistration = registration.registerPlaylistChild(child);
  assert.equal(typeof childRegistration, 'function');
  assert.equal(typeof childRegistration.deferParentDeparture, 'function');
  const marker = {token: child.token, scopeKey: child.scopeKey};
  h.navigation.pushLibraryHistory('/?surface=playlists&draft=sample', {...parentState, playlistDraft: marker});
  assert.equal(h.navigation.isPlaylistDraftCurrent(marker), true);
  t.after(() => h.navigation.destroy());
  return {...h, events, parent, child, registration, childRegistration, marker, parentUrl, parentState,
    retireParent() {parentCurrent = false;}, retireChild() {childCurrent = false;},
    returnParent() {return childRegistration.deferParentDeparture(() => {events.push('return-parent'); h.history.go(-1); return true;});}};
}
test('retained parent still rejects ordinary unrelated registrations while its only child is active', t => {
  const h = relationship(t);
  assert.equal(h.navigation.setCollectionDraftOwner({...h.parent, token: 'unrelated'}), false);
  assert.equal(h.navigation.setPlaylistDraftOwner({...h.child, token: 'unrelated'}), false);
  assert.deepEqual(h.events, []);
});
test('exact registration rejects a second or nested child without retiring either live owner', t => {
  const h = relationship(t);
  assert.equal(h.registration.registerPlaylistChild({...h.child, token: 'second'}), false);
  assert.equal(h.childRegistration.registerPlaylistChild?.({...h.child, token: 'nested'}) ?? false, false);
  assert.equal(h.navigation.isPlaylistDraftCurrent(h.marker), true); assert.deepEqual(h.events, []);
});
test('stale callable registration cannot admit a child under a different current parent', t => {
  const h = relationship(t); h.registration();
  assert.deepEqual(h.events, ['discard-child', 'discard-parent']);
  const successor = h.navigation.setCollectionDraftOwner({...h.parent, token: 'successor', isCurrent: () => true});
  assert.equal(typeof successor, 'function');
  assert.equal(h.registration.registerPlaylistChild({...h.child, isCurrent: () => true}), false);
  successor();
});
test('child-only retained parent departure discards child before return and preserves original parent registration', async t => {
  const h = relationship(t);
  assert.equal(await h.returnParent(), true); await settle();
  assert.deepEqual(h.events, ['confirm-child', 'discard-child', 'return-parent']);
  assert.equal(h.location.href, h.parentUrl); assert.deepEqual(plain(h.history.state), plain(h.parentState));
  assert.equal(h.navigation.setPlaylistDraftOwner({...h.child, token: 'foreign'}), false);
  assert.equal(await h.navigation.deferCollectionDraftNavigation(() => {h.events.push('external'); return true;}), true);
  assert.deepEqual(h.events, ['confirm-child', 'discard-child', 'return-parent', 'confirm-parent', 'discard-parent', 'external']);
});
test('ordinary deferred callback is external even if it happens to target the retained parent URL', async t => {
  const h = relationship(t);
  assert.equal(await h.navigation.deferCollectionDraftNavigation(() => {h.events.push('generic'); h.history.go(-1); return true;}), true);
  await settle();
  assert.deepEqual(h.events, ['confirm-child', 'confirm-parent', 'discard-child', 'discard-parent', 'generic']);
});
test('external two-confirmation departure keeps both owners intact until both accepted', async t => {
  const child = deferred(), parent = deferred(), h = relationship(t, {childDecision: () => child.promise, parentDecision: () => parent.promise});
  const leaving = h.navigation.deferCollectionDraftNavigation(() => {h.events.push('external'); return true;});
  await settle(); assert.deepEqual(h.events, ['confirm-child']);
  child.resolve(true); await settle(); assert.deepEqual(h.events, ['confirm-child', 'confirm-parent']);
  assert.equal(h.navigation.isPlaylistDraftCurrent(h.marker), true);
  assert.equal(h.registration.registerPlaylistChild({...h.child, token: 'second'}), false);
  parent.resolve(true); assert.equal(await leaving, true);
  assert.deepEqual(h.events, ['confirm-child', 'confirm-parent', 'discard-child', 'discard-parent', 'external']);
});
for (const decline of ['child', 'parent']) test(`external ${decline} cancellation cannot partially discard the relationship`, async t => {
  const h = relationship(t, {childDecision: () => decline !== 'child', parentDecision: () => decline !== 'parent'});
  const before = h.location.href;
  assert.equal(await h.navigation.deferCollectionDraftNavigation(() => assert.fail('cancelled navigation')), false);
  assert.deepEqual(h.events, decline === 'child' ? ['confirm-child'] : ['confirm-child', 'confirm-parent']);
  assert.equal(h.location.href, before); assert.equal(h.navigation.isPlaylistDraftCurrent(h.marker), true);
});
for (const changed of ['destination', 'parent identity', 'leave intent']) test(`awaited external ${changed} change cannot produce partial cleanup or navigation`, async t => {
  const decision = deferred(), h = relationship(t, {parentDecision: () => decision.promise});
  let intent = true; const outcomes = [];
  const leaving = h.navigation.deferCollectionDraftNavigation(() => assert.fail('stale callback'),
    {isCurrent: () => intent, onOutcome: value => outcomes.push(value)});
  await settle(); assert.deepEqual(h.events, ['confirm-child', 'confirm-parent']);
  if (changed === 'destination') h.history.replaceState({...h.history.state}, '', '/?surface=album_tops&newer=1');
  else if (changed === 'parent identity') h.retireParent(); else intent = false;
  decision.resolve(true); assert.equal(await leaving, false);
  assert.equal(h.events.includes('external'), false);
  if (changed !== 'parent identity') assert.deepEqual(h.events, ['confirm-child', 'confirm-parent']);
  else assert.equal(h.events.indexOf('discard-child') >= 0, true, 'true staleness must retire, never restore');
  assert.ok(outcomes.length <= 1);
});
for (const retire of ['unregister', 'destroy']) test(`${retire} retires retained parent and child once and stale handles cannot resurrect`, t => {
  const h = relationship(t);
  if (retire === 'unregister') {h.registration(); h.registration();} else {h.navigation.destroy(); h.navigation.destroy();}
  h.childRegistration();
  assert.deepEqual(h.events, ['discard-child', 'discard-parent']);
  assert.equal(h.registration.registerPlaylistChild({...h.child, isCurrent: () => true}), false);
});
test('launch rollback through child unregister restores active parent without any discard confirmation', async t => {
  const h = relationship(t); h.childRegistration(); h.childRegistration();
  assert.equal(h.events.includes('confirm-parent'), false); assert.equal(h.events.includes('discard-parent'), false);
  h.history.go(-1); await settle();
  assert.equal(h.index(), 0); assert.equal(h.location.href, h.parentUrl);
  assert.deepEqual(plain(h.history.state), plain(h.parentState));
  assert.deepEqual(h.events, ['discard-child'], 'rollback retires only the child, without asking or discarding the parent');
  const child = h.registration.registerPlaylistChild({...h.child, token: 'replacement-child', isCurrent: () => true});
  assert.equal(typeof child, 'function'); child();
});
test('native Back classifies exact original parent and confirms only the child', async t => {
  const h = relationship(t); h.history.go(-1); await settle();
  assert.deepEqual(h.events, ['confirm-child', 'discard-child']);
  assert.equal(h.location.href, h.parentUrl); assert.equal(h.index(), 0);
  assert.equal(h.navigation.setPlaylistDraftOwner({...h.child, token: 'foreign'}), false);
});
test('cancelled native Back restores child entry without discarding retained parent', async t => {
  const h = relationship(t, {childDecision: () => false}); const childUrl = h.location.href;
  h.history.go(-1); await settle();
  assert.deepEqual(h.events, ['confirm-child']); assert.equal(h.location.href, childUrl);
  assert.equal(h.index(), 1); assert.equal(h.navigation.isPlaylistDraftCurrent(h.marker), true);
});
test('same parent URL with a different history position is not a retained parent traversal', async t => {
  const h = relationship(t);
  h.entries[0].state.albumHavenNavigationPosition = 99;
  h.history.go(-1); await settle();
  assert.deepEqual(h.events, ['confirm-child', 'confirm-parent', 'discard-child', 'discard-parent']);
});
test('ordinary single-level Playlist registration keeps its existing confirmation and discard behavior', async t => {
  const h = harness(); t.after(() => h.navigation.destroy());
  assert.equal(h.open(), true); h.decision(false);
  assert.equal(await h.navigation.deferPlaylistDraftNavigation(() => assert.fail('declined')), false);
  assert.equal(h.calls.discard, 0); h.decision(true);
  assert.equal(await h.navigation.deferPlaylistDraftNavigation(() => true), true);
  assert.equal(h.calls.confirm, 2); assert.equal(h.calls.discard, 1);
});
