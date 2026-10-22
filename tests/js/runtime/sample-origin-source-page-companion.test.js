'use strict';
// Additive section-C contract tests. The unchanged R3 one-VM fixture supplies
// real modal, Settings, Sample facade, runtime and restoreTrackModalSourcePage.
// Observers forward the actual lease, history continuation and guarded open;
// they never synthesize a source owner, registry or restore state machine.
const test = require('node:test'), assert = require('node:assert/strict');
const {modalOwner, A} = require('./sample-origin-integration-fixture.cjs');

async function sourcePage(t, options = {}) {
  let h, sourceCurrent = true, freshCurrent = true;
  const events = [], leases = [], restores = [], opens = [], continuations = [], operations = [];
  const fallback = [], historyAttempts = [];
  let revalidations = 0, suppliedCalls = 0;
  const injected = new Error('injected source-page companion failure');
  const sourcePageOwner = {
    isCurrent: () => sourceCurrent,
    async revalidate({signal, albumKey}) {
      revalidations++; events.push('revalidate');
      assert.ok(signal, 'the actual adapter supplies its AbortController signal');
      assert.equal(typeof signal.addEventListener, 'function'); assert.equal(signal.aborted, false);
      assert.equal(albumKey, h.c.getAlbumRequestKey(h.retainedAlbum));
      if (options.gate) await options.gate.promise;
      if (options.revalidation === 'throw') throw injected;
      events.push('validated');
      if (options.revalidation === 'false') return false;
      return {album: {...h.retainedAlbum, name: 'Authoritatively revalidated album'}, isCurrent: () => freshCurrent,
        presentationRestrictions: {can_open_album_page: true, can_play_album: false, can_view_artwork: false}};
    },
    retainNavigation(handoff) {
      events.push('owner-handoff');
      if (options.retireFreshAtHandoff) freshCurrent = false;
      return handoff();
    },
  };
  h = await modalOwner(t, {kind: 'physical', sourcePageOwner});
  const initial = {...h.counts}, originalAlbum = h.retainedAlbum;
  const capture = h.c.captureTrackModalSampleOrigin, restore = h.c.restoreTrackModalSourcePage;
  const open = h.c.openTrackModal, go = h.c.history.go, close = h.runtime.closeDraft;
  h.c.captureTrackModalSampleOrigin = function (...args) {
    const lease = capture.apply(this, args); leases.push(lease); return lease;
  };
  h.c.restoreTrackModalSourcePage = function (descriptor, settings) {
    assert.equal(typeof settings?.isCurrent, 'function'); assert.equal(settings.isCurrent(), true);
    assert.equal(typeof settings?.present, 'function', 'the accepted companion supplies the real restore presentation hook');
    restores.push({descriptor, signal: settings.signal, isCurrent: settings.isCurrent});
    return restore.call(this, descriptor, {...settings, present(guardedOpen) {
      events.push('present'); opens.push(guardedOpen);
      return settings.present(guardedOpen); // Identical real-owner open, no observer-generated reopen.
    }});
  };
  h.c.openTrackModal = function (...args) {events.push('reopen'); return open.apply(this, args);};
  h.c.history.go = function (delta) {
    historyAttempts.push(delta); events.push('history');
    if (options.throwHistory) throw injected;
    return go.call(this, delta);
  };
  h.c.fetchAndRender = async (...args) => {fallback.push(args); return false;};
  h.runtime.closeDraft = function (token, returnToOrigin, guard) {
    const operation = close.call(this, token, continuation => {
      continuations.push(continuation);
      assert.equal(h.c.history.state.playlistDraft, undefined, 'actual Settings discarded only the child before return');
      assert.equal(h.runtime.snapshot().retainedDraftToken, null);
      return returnToOrigin(continuation); // No wrapper or replacement for the supplied history function.
    }, guard);
    operations.push(Promise.resolve(operation).then(value => ({value}), error => ({error})));
    return operation;
  };
  return Object.assign(h, {events, leases, restores, opens, continuations, operations, fallback, historyAttempts,
    initial, originalAlbum, injected,
    revalidations: () => revalidations,
    suppliedCalls: () => suppliedCalls,
    retireOriginal() {sourceCurrent = false;}, retireFresh() {freshCurrent = false;},
    suppliedContinuation(mode) {
      return function suppliedParentHistoryContinuation() {
        suppliedCalls++;
        assert.equal(opens.length, 1, 'the supplied function is invoked from actual restore present(open)');
        assert.deepEqual(events, ['revalidate', 'validated', 'present']);
        if (mode === 'throw') throw injected;
        return false;
      };
    },
  });
}
async function launch(h) {
  h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  assert.equal(h.leases.length, 1); assert.ok(h.leases[0]);
  assert.equal(h.leases[0].isCurrent(), true); assert.equal(h.hidden(h.sourceSurface), true);
}
function closeThroughActualOwners(h) {
  const lease = h.leases[0], token = h.runtime.snapshot().retainedDraftToken;
  return h.runtime.closeDraft(token, continuation => {
    assert.equal(continuation, h.continuations.at(-1), 'forward the identical one-shot runtime continuation to the actual captured lease');
    return lease.back(continuation);
  }, lease.isCurrent);
}
function noReopen(h) {
  assert.equal(h.counts.opens, h.initial.opens);
  assert.equal(h.events.includes('reopen'), false); assert.equal(h.fallback.length, 0);
  assert.equal(h.counts.fetches, 0); h.noWrites();
}
async function assertSettledCannotAct(h) {
  const before = {history: [...h.history.traversals], attempts: [...h.historyAttempts], opens: h.counts.opens,
    revalidations: h.revalidations(), fallback: h.fallback.length};
  for (const continuation of h.continuations) {
    assert.equal(continuation(), false, 'late/consumed retained history callback cannot navigate');
    assert.equal(continuation(), false, 'repeated late callback remains inert');
  }
  for (const open of h.opens) assert.equal(await open(), false, 'settled real restore cannot reopen through a retained open callback');
  await h.settle();
  assert.deepEqual(h.history.traversals, before.history); assert.deepEqual(h.historyAttempts, before.attempts);
  assert.equal(h.counts.opens, before.opens); assert.equal(h.revalidations(), before.revalidations);
  assert.equal(h.fallback.length, before.fallback);
}
async function falseOrInjectedRejection(operation, error) {
  try {assert.equal(await operation, false, 'an exceptional return must never report success');}
  catch (actual) {assert.equal(actual, error, 'only the injected failure may propagate');}
}

test('actual source-page Back orders revalidation identical one-shot history and existing guarded reopen', async t => {
  const h = await sourcePage(t), mark = h.history.mark(), token = h.c.getTrackModalSourcePageToken();
  await launch(h); h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(h.operations.length, 1); assert.deepEqual(await h.operations[0], {value: true});
  assert.equal(h.continuations.length, 1); assert.equal(h.restores.length, 1); assert.equal(h.revalidations(), 1);
  assert.equal(h.restores[0].descriptor.sourcePageToken, token);
  assert.deepEqual(h.events, ['revalidate', 'validated', 'present', 'history', 'owner-handoff', 'reopen']);
  assert.equal(h.opens.length, 1); assert.equal(h.counts.opens, h.initial.opens + 1);
  assert.notEqual(h.c.getCurrentTrackModalAlbum(), h.originalAlbum);
  assert.equal(h.c.getCurrentTrackModalAlbum().name, 'Authoritatively revalidated album');
  assert.equal(h.c.getTrackModalSourcePageToken(), token); assert.equal(h.hidden(h.sourceSurface), false);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null, 'discarded Sample is not required to stay current after lawful return');
  assert.deepEqual(h.history.traversals, [-1]); assert.deepEqual(h.historyAttempts, [-1]);
  assert.equal(h.history.index(), mark.index); assert.equal(h.c.location.href, mark.url);
  assert.equal(h.fallback.length, 0); assert.equal(h.counts.fetches, 0); h.noWrites();
  await assertSettledCannotAct(h);
});

for (const mode of ['false', 'throw']) test(`actual source-page restore cannot reopen after its supplied continuation returns ${mode}`, async t => {
  const h = await sourcePage(t); await launch(h);
  const supplied = h.suppliedContinuation(mode);
  // Deliberately exercise the exact captured production lease, not a fake
  // return owner. This lower-level fault injection complements native Back.
  const operation = h.leases[0].back(supplied);
  if (mode === 'throw') await falseOrInjectedRejection(operation, h.injected);
  else assert.equal(await operation, false);
  assert.equal(h.suppliedCalls(), 1); assert.equal(h.revalidations(), 1); assert.equal(h.restores.length, 1);
  assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []); noReopen(h);
  await assertSettledCannotAct(h); assert.equal(h.suppliedCalls(), 1, 'no exception-authorized continuation retry');
});

test('actual source-page lease without its supplied continuation cannot reopen navigate or fall back', async t => {
  const h = await sourcePage(t); await launch(h);
  assert.equal(await h.leases[0].back(), false);
  await h.settle();
  assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []); noReopen(h);
  await assertSettledCannotAct(h);
});

test('actual source-page missing captured parent position returns false without reopen fallback or late navigation', async t => {
  const h = await sourcePage(t), state = {...h.c.history.state}; delete state.albumHavenNavigationPosition;
  h.c.history.replaceState(state, '', h.c.location.href);
  assert.equal(h.runtime.snapshot().entryKey, null); await launch(h);
  assert.equal(await closeThroughActualOwners(h), false); await h.settle();
  assert.equal(h.revalidations(), 1); assert.equal(h.opens.length, 1, 'failure is inside the actual supplied history continuation');
  assert.equal(h.continuations.length, 1); assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []);
  noReopen(h); await assertSettledCannotAct(h);
});

for (const changed of ['history position', 'history URL']) test(`actual source-page ${changed} change during revalidation fences its one-shot continuation`, async t => {
  const gate = A.F.deferred(), h = await sourcePage(t, {gate}); await launch(h);
  const returning = closeThroughActualOwners(h); await h.settle();
  assert.equal(h.revalidations(), 1); assert.equal(h.opens.length, 0); assert.deepEqual(h.historyAttempts, []);
  const state = {...h.c.history.state};
  if (changed === 'history position') state.albumHavenNavigationPosition += 1;
  h.c.history.replaceState(state, '', changed === 'history URL' ? '/?surface=playlists&newer=1' : h.c.location.href);
  assert.equal(h.leases[0].isCurrent(), true, 'independent source remains current; stale departure must still fail closed');
  gate.resolve(); assert.equal(await returning, false); await h.settle();
  assert.equal(h.opens.length, 1, 'real restore reached present(open), which must respect the false history continuation');
  assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []); noReopen(h);
  await assertSettledCannotAct(h);
});

test('actual source-page throwing history continuation cannot reopen fall back retry or navigate late', async t => {
  const h = await sourcePage(t, {throwHistory: true}); await launch(h);
  await falseOrInjectedRejection(closeThroughActualOwners(h), h.injected); await h.settle();
  assert.equal(h.revalidations(), 1); assert.equal(h.opens.length, 1);
  assert.deepEqual(h.historyAttempts, [-1], 'only the one original continuation tried its browser operation');
  assert.deepEqual(h.history.traversals, []); noReopen(h); await assertSettledCannotAct(h);
});

for (const stale of ['original source', 'fresh result']) test(`actual source-page ${stale} retirement during revalidation prevents both history and reopen`, async t => {
  const gate = A.F.deferred(), h = await sourcePage(t, {gate}); await launch(h);
  const returning = closeThroughActualOwners(h); await h.settle(); assert.equal(h.revalidations(), 1);
  if (stale === 'original source') h.retireOriginal(); else h.retireFresh();
  gate.resolve(); assert.equal(await returning, false); await h.settle();
  assert.equal(h.opens.length, 0, 'stale source/fresh result is rejected before present(open)');
  assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []); noReopen(h);
  await assertSettledCannotAct(h);
});

for (const revalidation of ['false', 'throw']) test(`actual source-page ${revalidation} revalidation never reaches history or reopen`, async t => {
  const h = await sourcePage(t, {revalidation}); await launch(h);
  const returning = closeThroughActualOwners(h);
  if (revalidation === 'throw') await falseOrInjectedRejection(returning, h.injected);
  else assert.equal(await returning, false);
  await h.settle(); assert.equal(h.revalidations(), 1); assert.equal(h.opens.length, 0);
  assert.deepEqual(h.historyAttempts, []); assert.deepEqual(h.history.traversals, []); noReopen(h);
  await assertSettledCannotAct(h);
});

test('actual source-page fresh-result retirement after history still fences the existing guarded reopen', async t => {
  const h = await sourcePage(t, {retireFreshAtHandoff: true}); await launch(h);
  assert.equal(await closeThroughActualOwners(h), false); await h.settle();
  assert.deepEqual(h.events, ['revalidate', 'validated', 'present', 'history', 'owner-handoff']);
  assert.equal(h.revalidations(), 1); assert.deepEqual(h.historyAttempts, [-1]); assert.deepEqual(h.history.traversals, [-1]);
  noReopen(h); await assertSettledCannotAct(h);
});
