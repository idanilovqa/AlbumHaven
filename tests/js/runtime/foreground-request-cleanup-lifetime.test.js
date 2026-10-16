'use strict';
// Connected candidate lifetime contracts. The published fixture loads complete
// current request, apply, render, utility, recovery and native Search owners.
// Transparent wrappers below delegate to those owners before injecting reentry;
// only the fixture's network/DOM platform is synthetic. No authentication, HTTP
// server or persistence acceptance is claimed by these JS tests.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {
  fixture, ready, ordinary, mainUrl, source, deferred,
} = require('./search-native-fixtures/actual-runtime.cjs');

const ordinaryUrl = '/view-data?surface=albums';
const startupOptions = {startupRefresh: true, startupHydrationTier: 'full', preserveScroll: true};
const abort = () => Object.assign(new Error('Synthetic transport observes the real aborted signal'), {name: 'AbortError'});

function rejectAborted(h, index) {
  assert.equal(h.requests[index].options.signal.aborted, true);
  // This fixture deliberately permits late network replies after abort. Deliver
  // the browser's AbortError explicitly rather than replacing its fetch owner.
  h.requests[index].reject(abort());
}

function startupMarker(h) {
  h.c.queueStartupHydrationFollowup('/view-data?surface=albums&payload_tier=full');
  return h.state.ui.pendingStartupHydrationFollowup;
}

function successorWithQueuedIntent(h) {
  const payload = ready({query: ':obsessed', presentation: 'tracks'});
  const index = h.requests.length, work = h.read(mainUrl(payload), {...startupOptions});
  const queuedPayload = ready({query: 'love:loved', presentation: 'tracks'});
  const queuedWork = h.read(mainUrl(queuedPayload), {...startupOptions, interruptCurrent: false});
  h.state.awaitingInitialDataRefresh = true;
  const followup = startupMarker(h);
  return {
    payload, queuedPayload, index, work, queuedWork, followup,
    id: h.state.ui.activeViewRequestId,
    controller: h.state.ui.activeViewRequestController,
    url: h.state.ui.activeViewRequestUrl,
    queue: h.state.ui.pendingViewRequest,
    view: h.state.view,
  };
}

function assertSuccessorOwnsState(h, next) {
  assert.ok(next, 'the real callback must claim a successor');
  assert.equal(h.state.ui.activeViewRequestId, next.id);
  assert.equal(h.state.ui.activeViewRequestController, next.controller);
  assert.equal(next.controller.signal.aborted, false);
  assert.equal(h.state.ui.activeViewRequestUrl, next.url);
  assert.equal(h.state.busy, true);
  assert.equal(h.state.view, next.view);
  assert.equal(h.state.ui.pendingViewRequest, next.queue, 'old cleanup cannot consume the successor queue');
  assert.ok(next.queue?.originatingReadScope, 'the queued intent came through the actual request owner');
  assert.equal(h.state.ui.pendingStartupHydrationFollowup, next.followup);
  assert.equal(h.state.awaitingInitialDataRefresh, true);
  assert.equal(h.state.ui.activeViewRequestStartupRefresh, true);
  assert.equal(h.state.ui.activeViewRequestStartupHydrationTier, 'full');
  assert.equal(h.requests.length, next.index + 1, 'old recovery cannot start another request');
}

async function finishSuccessorAndQueue(h, next) {
  assert.equal((await next.queuedWork).value, false);
  h.reply(next.index, next.payload);
  assert.equal((await next.work).value, true);
  await h.flush();
  assert.equal(h.requests.length, next.index + 2, 'only the proven queued intent starts next');
  assert.equal(h.requests[next.index + 1].url, mainUrl(next.queuedPayload));
  const queued = h.invocations.at(-1).outcome;
  h.reply(next.index + 1, next.queuedPayload);
  assert.equal((await queued).value, true);
  const snapshot = h.runtime().snapshot(), lease = source(h, snapshot);
  assert.equal(snapshot.status, 'ready');
  assert.equal(h.state.view.query, next.queuedPayload.query);
  assert.equal(h.runtime().isCurrent(snapshot), true);
  assert.ok(lease.snapshot(), 'the surviving request owns a genuine accepted source');
  lease.dispose();
}

test('current terminal full-startup AbortError clears only its own awaiting state and followup', async t => {
  const h = fixture(t);
  h.state.awaitingInitialDataRefresh = true;
  const followup = startupMarker(h), work = h.read(ordinaryUrl, {...startupOptions});
  assert.ok(followup);
  const controller = h.state.ui.activeViewRequestController;
  controller.abort();
  rejectAborted(h, 0);
  const result = await work;
  assert.equal(result.error, undefined);
  assert.equal(result.value, false);
  assert.equal(h.state.awaitingInitialDataRefresh, false);
  assert.equal(h.state.ui.pendingStartupHydrationFollowup, null);
  assert.equal(h.state.ui.activeViewRequestController, null);
  assert.equal(h.state.ui.activeViewRequestUrl, '');
  assert.equal(h.state.busy, false);
  assert.equal(h.requests.length, 1, 'terminal cancellation cannot silently restart hydration');
  assert.equal(h.applications.length, 0);
});

test('actual utility preemption retains the same-generation full-startup retry through AbortError', async t => {
  const h = fixture(t), modal = h.document.createElement('section');
  modal.id = 'utility-modal'; modal.hidden = false; h.document.body.append(modal);
  h.state.awaitingInitialDataRefresh = true;
  const work = h.read(ordinaryUrl, {...startupOptions});
  assert.equal(h.c.deferActiveStartupViewForUtilityModal(), true);
  const retry = h.state.ui.deferredUtilityViewRequest;
  assert.equal(retry.url, ordinaryUrl);
  assert.equal(retry.originatingViewStateRevision, h.state.ui.viewStateRevision);
  rejectAborted(h, 0);
  assert.equal((await work).value, false);
  assert.equal(h.state.awaitingInitialDataRefresh, true);
  assert.equal(h.state.ui.deferredUtilityViewRequest, retry);
  assert.equal(h.state.ui.activeViewRequestController, null);
  assert.equal(h.requests.length, 1);
  // Successful resume is a separate existing owner contract. This correction
  // proves cancellation retains the actual retry without launching more work.
});

test('identity retirement before AbortError settlement preserves newly owned startup work and prevents recovery', async t => {
  const h = fixture(t), work = h.read(ordinaryUrl, {...startupOptions});
  const controller = h.state.ui.activeViewRequestController;
  h.change('context');
  h.state.awaitingInitialDataRefresh = true;
  const followup = startupMarker(h);
  h.state.ui.pendingScanCompletionViewRefresh = true;
  controller.abort();
  rejectAborted(h, 0);
  const result = await work;
  assert.equal(result.error, undefined);
  assert.equal(result.value, false);
  assert.equal(h.state.awaitingInitialDataRefresh, true);
  assert.equal(h.state.ui.pendingStartupHydrationFollowup, followup);
  assert.equal(h.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(h.state.ui.activeViewRequestController, null, 'retirement still releases only the matching old physical slot');
  assert.equal(h.state.busy, false);
  assert.equal(h.requests.length, 1, 'the retired captured scope cannot authorize automatic recovery');
  assert.equal(h.applications.length, 0);
});

function familyPayload(filtered = false) {
  const primary = {artist: 'Primary Artist', albums: []};
  const related = {artist: 'Related Artist', albums: []};
  return {...ordinary(), selected_artist: 'Primary Artist', related_artists: ['Related Artist'],
    related_filter_artists: filtered ? ['Related Artist'] : [], primary_filter_active: false,
    primary_artist_groups: filtered ? [] : [primary], family_artist_groups: [related],
    artist_groups: filtered ? [related] : [primary, related], artist_count: filtered ? 1 : 2};
}

async function beginFamilyReplacement(h) {
  const seed = h.read('/view-data?surface=albums&artist=Primary%20Artist');
  h.reply(0, familyPayload());
  assert.equal((await seed).value, true);
  const url = h.c.buildApiUrl(h.state.view), old = h.read(url, {preserveScroll: true});
  const queued = h.read(url + '&family_display=chronological', {preserveScroll: true, interruptCurrent: false});
  const queuedIntent = h.state.ui.pendingViewRequest, revision = h.state.ui.viewStateRevision;
  assert.equal(queuedIntent.originatingViewStateRevision, revision);
  const filtered = h.c.applyLocalRelatedFilterState(['Related Artist']);
  assert.ok(filtered, 'the actual cached-family owner performs the local transition');
  assert.equal(h.state.ui.viewStateRevision, revision + 1);
  assert.deepEqual(Array.from(h.state.view.related_filter_artists), ['Related Artist']);
  return {old, queued, queuedIntent, filtered};
}

test('actual local family revision retires the stale queued intent while releasing the exact old slot', async t => {
  const h = fixture(t), active = await beginFamilyReplacement(h);
  h.reply(1, familyPayload());
  assert.equal((await active.old).value, false);
  assert.equal((await active.queued).value, false);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.state.ui.pendingViewRequest, null);
  assert.equal(h.state.ui.activeViewRequestController, null);
  assert.equal(h.state.ui.activeViewRequestUrl, '');
  assert.equal(h.state.busy, false);
  assert.equal(h.state.view, active.filtered);
  assert.deepEqual(Array.from(h.state.view.related_filter_artists), ['Related Artist']);
});

test('stale family queue retirement still permits actual scan recovery for the current local filter', async t => {
  const h = fixture(t), active = await beginFamilyReplacement(h);
  h.state.ui.pendingScanCompletionViewRefresh = true;
  const expected = h.c.buildApiUrl(h.state.view);
  h.reply(1, familyPayload());
  await h.flush();
  assert.equal(h.requests.length, 3, 'the actual post-scan owner starts one current-filter read');
  assert.equal(h.requests[2].url, expected);
  const params = new URL(h.requests[2].url, h.location).searchParams;
  assert.deepEqual(params.getAll('related_artist'), ['Related Artist']);
  assert.equal(params.get('artist'), 'Primary Artist');
  assert.equal(params.get('family_display'), null, 'the stale queued layout never relaunches');
  h.reply(2, familyPayload(true));
  assert.equal((await active.old).value, false);
  assert.equal((await active.queued).value, false);
  assert.equal(h.state.ui.pendingViewRequest, null);
  assert.equal(h.state.ui.pendingScanCompletionViewRefresh, false);
  assert.deepEqual(Array.from(h.state.view.related_filter_artists), ['Related Artist']);
});

test('a network error already obsolete on catch entry still retires its unchanged stale family queue', async t => {
  const h = fixture(t), active = await beginFamilyReplacement(h);
  h.requests[1].reject(new Error('obsolete family network error'));
  assert.equal((await active.old).value, false);
  assert.equal((await active.queued).value, false);
  await h.flush();
  assert.equal(h.state.view, active.filtered);
  assert.deepEqual(Array.from(h.state.view.related_filter_artists), ['Related Artist']);
  assert.equal(h.state.ui.pendingViewRequest, null);
  assert.equal(h.state.ui.activeViewRequestController, null);
  assert.equal(h.state.busy, false);
  assert.equal(h.requests.length, 2);
});

for (const failure of ['ordinary error', 'AbortError']) {
  test(`${failure} first catch scope check cannot transfer replacement startup work into finally`, async t => {
    const h = fixture(t), check = h.c.galleryReadScopeIsCurrent;
    let settled = 0;
    const old = h.read(ordinaryUrl, {...startupOptions, onSettled() {settled++;}});
    const original = startupMarker(h), view = h.state.view;
    const id = h.state.ui.activeViewRequestId, revision = h.state.ui.viewStateRevision;
    const controller = h.state.ui.activeViewRequestController;
    let armed = true, replacement = null;
    h.c.galleryReadScopeIsCurrent = function(...args) {
      const current = check.apply(this, args);
      if (armed && current && h.state.busy
        && h.state.ui.activeViewRequestId === id
        && h.state.ui.activeViewRequestController === controller) {
        armed = false;
        replacement = startupMarker(h);
        h.state.awaitingInitialDataRefresh = true;
        h.state.ui.pendingScanCompletionViewRefresh = true;
      }
      return current;
    };
    if (failure === 'AbortError') {
      controller.abort(); rejectAborted(h, 0);
    } else {
      h.requests[0].reject(new Error('old hydration initial scope error'));
    }
    const result = await old;
    await h.flush();
    assert.equal(armed, false, 'the first catch predicate delegated to the actual scope owner');
    assert.equal(result.error, undefined);
    assert.equal(result.value, false);
    assert.notEqual(replacement, original);
    assert.equal(h.state.view, view);
    assert.equal(h.state.ui.viewStateRevision, revision);
    assert.equal(h.state.ui.activeViewRequestId, id);
    assert.equal(h.state.ui.activeViewRequestController, null);
    assert.equal(h.state.ui.activeViewRequestUrl, '');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.ui.pendingViewRequest, null);
    assert.equal(h.state.ui.pendingStartupHydrationFollowup, replacement);
    assert.equal(h.state.awaitingInitialDataRefresh, true);
    assert.equal(h.state.ui.pendingScanCompletionViewRefresh, true);
    assert.equal(h.requests.length, 1);
    assert.equal(settled, 0);
    assert.equal([...h.timers.values()].some(timer => timer.delay === 350), false);
    assert.equal(h.applications.length, 0);
  });
}

for (const failure of ['ordinary error', 'AbortError']) {
  test(`${failure} catch transition paint cannot clear a reentrant successor controller, queue or startup markers`, async t => {
    const h = fixture(t), paint = h.c.renderLibraryLoader;
    const old = h.read(ordinaryUrl, {...startupOptions, preserveScroll: false});
    let next = null, armed = true;
    h.c.renderLibraryLoader = function(...args) {
      const result = paint.apply(this, args);
      if (armed && args[0]?.transition_in_progress === false) {
        armed = false; next = successorWithQueuedIntent(h);
      }
      return result;
    };
    if (failure === 'AbortError') {
      h.state.ui.activeViewRequestController.abort();
      rejectAborted(h, 0);
    } else {
      h.requests[0].reject(new Error('old hydration failed'));
    }
    const result = await old;
    assert.equal(armed, false, 'the actual catch transition owner painted');
    assert.equal(result.error, undefined, 'an obsolete catch cannot report failure for its successor');
    assert.equal(result.value, false);
    assertSuccessorOwnsState(h, next);
    await finishSuccessorAndQueue(h, next);
  });
}

for (const failure of ['ordinary error', 'AbortError']) {
  test(`${failure} catch preserves same-slot replacement followup through the entire finally`, async t => {
    const h = fixture(t), paint = h.c.renderLibraryLoader;
    let settled = 0;
    const old = h.read(ordinaryUrl, {...startupOptions, preserveScroll: false,
      onSettled() {settled++;}});
    const original = startupMarker(h), view = h.state.view;
    const id = h.state.ui.activeViewRequestId, revision = h.state.ui.viewStateRevision;
    let armed = true, replacement = null;
    h.c.renderLibraryLoader = function(...args) {
      const result = paint.apply(this, args);
      if (armed && args[0]?.transition_in_progress === false) {
        armed = false;
        replacement = startupMarker(h);
        h.state.awaitingInitialDataRefresh = true;
        h.state.ui.pendingScanCompletionViewRefresh = true;
      }
      return result;
    };
    if (failure === 'AbortError') {
      h.state.ui.activeViewRequestController.abort();
      rejectAborted(h, 0);
    } else {
      h.requests[0].reject(new Error('old same-slot hydration failed'));
    }
    const result = await old;
    await h.flush();
    assert.equal(armed, false, 'the genuine transition renderer reached the replacement callback');
    assert.equal(result.error, undefined);
    assert.equal(result.value, false);
    assert.notEqual(replacement, original);
    assert.equal(h.state.view, view);
    assert.equal(h.state.ui.viewStateRevision, revision);
    assert.equal(h.state.ui.activeViewRequestId, id, 'replacement did not claim a new network slot');
    assert.equal(h.state.ui.activeViewRequestController, null, 'only the matching physical slot is released');
    assert.equal(h.state.ui.activeViewRequestUrl, '');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.ui.pendingViewRequest, null);
    assert.equal(h.state.ui.pendingStartupHydrationFollowup, replacement);
    assert.equal(h.state.awaitingInitialDataRefresh, true);
    assert.equal(h.state.ui.pendingScanCompletionViewRefresh, true);
    assert.equal(h.requests.length, 1, 'finally cannot reacquire replacement work and start scan recovery');
    assert.equal(settled, 0, 'the retired cleanup cannot notify a successor-owned settlement callback');
    assert.equal([...h.timers.values()].some(timer => timer.delay === 350), false,
      'finally cannot schedule the replacement startup followup');
    assert.equal(h.applications.length, 0);
  });
}

test('finally release paint cannot consume a reentrant successor queue or clear its startup ownership', async t => {
  const h = fixture(t), paint = h.c.renderRelated;
  const old = h.read(ordinaryUrl, {preserveScroll: true, shouldApplyResponse: () => false});
  let next = null, armed = true;
  h.c.renderRelated = function(...args) {
    const result = paint.apply(this, args);
    if (armed && !h.state.busy && h.state.ui.activeViewRequestController === null) {
      armed = false; next = successorWithQueuedIntent(h);
    }
    return result;
  };
  h.reply(0, ordinary());
  assert.equal((await old).value, false);
  assert.equal(armed, false, 'the released request invoked the genuine related renderer');
  assertSuccessorOwnsState(h, next);
  await finishSuccessorAndQueue(h, next);
});

test('finally transition paint preserves a newer local view and queued intent without a new network ID', async t => {
  const h = fixture(t), paint = h.c.renderLibraryLoader;
  const seed = h.read('/view-data?surface=albums&artist=Primary%20Artist');
  h.reply(0, familyPayload()); assert.equal((await seed).value, true);
  const url = h.c.buildApiUrl(h.state.view);
  const old = h.read(url, {preserveScroll: false, shouldApplyResponse: () => false});
  const id = h.state.ui.activeViewRequestId;
  let armed = true, local = null, queue = null, followup = null, queuedWork = null;
  h.c.renderLibraryLoader = function(...args) {
    const result = paint.apply(this, args);
    if (armed && args[0]?.transition_in_progress === false) {
      armed = false;
      local = h.c.applyLocalRelatedFilterState(['Related Artist']);
      queuedWork = h.read(h.c.buildApiUrl(h.state.view), {...startupOptions, interruptCurrent: false});
      queue = h.state.ui.pendingViewRequest;
      h.state.awaitingInitialDataRefresh = true;
      followup = startupMarker(h);
    }
    return result;
  };
  h.reply(1, familyPayload());
  assert.equal((await old).value, false);
  assert.equal(armed, false);
  assert.ok(local);
  assert.equal((await queuedWork).value, false);
  assert.equal(h.state.ui.activeViewRequestId, id, 'local ownership changed without another foreground claim');
  assert.equal(h.state.ui.activeViewRequestController, null, 'the exact old physical slot is still released');
  assert.equal(h.state.busy, false);
  assert.equal(h.state.view, local);
  assert.equal(h.state.ui.pendingViewRequest, queue);
  assert.equal(queue.originatingViewStateRevision, h.state.ui.viewStateRevision);
  assert.ok(queue.originatingReadScope);
  assert.equal(h.state.ui.pendingStartupHydrationFollowup, followup);
  assert.equal(h.state.awaitingInitialDataRefresh, true);
  assert.equal(h.requests.length, 2, 'old finally cannot consume callback-owned queued work');
});

test('a startup-followup replacement during released paint fences old automatic scan recovery', async t => {
  const h = fixture(t), paint = h.c.renderRelated;
  const original = startupMarker(h);
  const old = h.read(ordinaryUrl, {...startupOptions, shouldApplyResponse: () => false});
  h.state.ui.pendingScanCompletionViewRefresh = true;
  let armed = true, replacement = null;
  h.c.renderRelated = function(...args) {
    const result = paint.apply(this, args);
    if (armed && !h.state.busy && h.state.ui.activeViewRequestController === null) {
      armed = false;
      replacement = startupMarker(h);
      h.state.awaitingInitialDataRefresh = true;
    }
    return result;
  };
  h.reply(0, ordinary());
  assert.equal((await old).value, false);
  assert.equal(armed, false);
  assert.notEqual(replacement, original);
  assert.equal(h.state.ui.pendingStartupHydrationFollowup, replacement);
  assert.equal(h.state.awaitingInitialDataRefresh, true);
  assert.equal(h.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(h.state.ui.activeViewRequestController, null);
  assert.equal(h.requests.length, 1, 'a changed followup identity alone retires the old recovery continuation');
});

for (const seam of ['released read scope', 'queued intent read scope']) {
  test(`${seam} callback reentry cannot dispatch an old captured queue or consume its successor`, async t => {
    const h = fixture(t), check = h.c.galleryReadScopeIsCurrent;
    const old = h.read(ordinaryUrl, {preserveScroll: true, shouldApplyResponse: () => false});
    let capturedQueue = null;
    if (seam === 'queued intent read scope') {
      assert.equal((await h.read('/view-data?surface=albums&q=old-queued', {interruptCurrent: false})).value, false);
      capturedQueue = h.state.ui.pendingViewRequest;
    }
    let next = null, armed = true;
    h.c.galleryReadScopeIsCurrent = function(...args) {
      const current = check.apply(this, args);
      if (armed && current && !h.state.busy && h.state.ui.activeViewRequestController === null
        && (!capturedQueue || args[0] === capturedQueue.originatingReadScope)) {
        armed = false; next = successorWithQueuedIntent(h);
      }
      return current;
    };
    h.reply(0, ordinary());
    assert.equal((await old).value, false);
    assert.equal(armed, false, 'the real scope callback was reached at the intended cleanup boundary');
    assertSuccessorOwnsState(h, next);
    assert.equal(h.requests.some(request => new URL(request.url, h.location).searchParams.get('q') === 'old-queued'), false);
    await finishSuccessorAndQueue(h, next);
  });
}

for (const recovery of ['dispatchPendingScanCompletionViewRefresh', 'dispatchPendingCoverCompletionViewRefresh']) {
  test(`an older finally awaiting ${recovery} cannot alter a subsequently accepted native Search result`, async t => {
    const h = fixture(t); await h.mount();
    const owner = h.c[recovery], entered = deferred(), release = deferred();
    let armed = true;
    h.c[recovery] = async function(...args) {
      const result = await owner.apply(this, args);
      if (armed) {
        armed = false; entered.resolve(); await release.promise;
      }
      return result;
    };
    const old = h.read(ordinaryUrl, {preserveScroll: true, shouldApplyResponse: () => false});
    h.reply(0, ordinary());
    await entered.promise;
    const payload = ready({query: ':obsessed', presentation: 'tracks'});
    const successor = h.read(mainUrl(payload));
    h.reply(1, payload);
    assert.equal((await successor).value, true);
    const snapshot = h.runtime().snapshot(), lease = source(h, snapshot), view = h.state.view;
    const id = h.state.ui.activeViewRequestId, controller = h.state.ui.activeViewRequestController;
    const followup = startupMarker(h);
    h.state.awaitingInitialDataRefresh = true;
    const applications = h.applications.length, history = h.historyCalls.length;
    release.resolve();
    assert.equal((await old).value, false);
    await h.flush();
    assert.equal(h.state.ui.activeViewRequestId, id);
    assert.equal(h.state.ui.activeViewRequestController, controller);
    assert.equal(controller, null, 'the successor completed its own release');
    assert.equal(h.state.ui.activeViewRequestUrl, '');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.ui.pendingViewRequest, null);
    assert.equal(h.state.ui.pendingStartupHydrationFollowup, followup);
    assert.equal(h.state.awaitingInitialDataRefresh, true);
    assert.equal(h.state.view, view);
    assert.equal(h.runtime().snapshot(), snapshot);
    assert.equal(h.runtime().isCurrent(snapshot), true);
    assert.ok(lease.snapshot());
    assert.equal(h.applications.length, applications);
    assert.equal(h.historyCalls.length, history);
    assert.equal(h.requests.length, 2, 'the obsolete await continuation cannot launch recovery');
    assert.ok(h.host.querySelector('[data-search-results-content]'), 'the genuine native consumer remains mounted');
    lease.dispose();
  });
}
