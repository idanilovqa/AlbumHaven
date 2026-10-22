'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, state, prepare, apply, ready, ordinary} = require('./search-native-fixtures/advanced-cases.cjs');

// The earlier request is dispatched by the real commit/foreground owners. Its
// fetch response stays deferred while a second, equal Advanced Apply settles.
// No busy flag, active URL, request ID, generation or completion owner is edited.
function pendingEquality(h) {
  const previousView = h.state.view;
  const firstIndex = h.requests.length;
  const completion = h.commit(':loved');
  assert.equal(h.requests.length, firstIndex + 1);
  const request = h.requests[firstIndex];
  const invocation = h.invocations.at(-1);
  const requestId = h.state.ui.activeViewRequestId;
  const controller = h.state.ui.activeViewRequestController;
  assert.equal(h.state.busy, true);
  assert.equal(new URL(request.url, h.location).searchParams.get('q'), ':loved');
  const session = prepare(h);
  const draft = session.draft;
  const operation = apply(h);
  assert.equal(operation.result.status, 'unchanged');
  assert.equal(operation.result.reason, 'already-pending');
  assert.equal(state(h).session, session);
  assert.equal(session.draft, draft);
  assert.equal(session.dirty, true);
  assert.equal(h.c.advancedSearchBaseCurrent(session), true);
  assert.equal(h.input.value, '');
  assert.equal(h.state.ui.searchDraftQuery, '');
  assert.equal(h.state.view, previousView);
  assert.equal(request.settled, false);
  assert.equal(h.state.ui.activeViewRequestId, requestId);
  assert.equal(h.state.ui.activeViewRequestController, controller);
  assert.equal(h.invocations.at(-1), invocation);
  assert.equal(h.requests.length, firstIndex + 1, 'equal Apply starts no second transport');
  return {previousView, request, completion, session, operation, firstIndex, draft};
}

test('pending equality observes the original request succeed and retire its unapplied draft', async t => {
  const h = fixture(t); await h.mount();
  const p = pendingEquality(h);
  assert.notEqual(new URL(p.request.url, h.location).searchParams.get('all_artists'), '1',
    'initial query commit requests the server-selected artist, not all artists');
  p.request.resolve(ready());
  const result = await p.completion; await h.flush();
  assert.equal(result.error, undefined);
  assert.equal(result.value, true, 'the original foreground request actually admitted');
  assert.equal(h.state.view.query, ':loved');
  assert.equal(h.state.busy, false);
  assert.equal(state(h).session, null);
  assert.equal(h.c.advancedSearchBaseCurrent(p.session), false);
  assert.equal(p.operation.result.reason, 'already-pending', 'settled no-op is not retroactively accepted');
  assert.equal(h.document.getElementById('search-advanced-toggle').getAttribute('data-filters-active'), 'true');
  assert.equal(h.requests.length, p.firstIndex + 1);
  h.c.toggleSearchAdvancedFilters();
  assert.notEqual(state(h).session, p.session);
});

test('pending equality observes original transport failure with unchanged base and retains retryable edits', async t => {
  const h = fixture(t); await h.mount();
  const p = pendingEquality(h), failure = new Error('original network failure');
  p.request.reject(failure);
  const result = await p.completion; await h.flush();
  assert.equal(result.error, failure);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.view, p.previousView);
  assert.equal(state(h).session, p.session);
  assert.equal(p.session.draft, p.draft);
  assert.equal(p.session.dirty, true);
  assert.equal(h.c.advancedSearchBaseCurrent(p.session), true);
  assert.equal(h.input.value, '');
  assert.equal(h.state.ui.searchDraftQuery, '');
  assert.equal(h.state.ui.failedGallerySearch.query, ':loved', 'original commit failure continuation ran');
  assert.equal(h.requests.length, p.firstIndex + 1, 'no retry needed to establish failure behavior');
  assert.equal(p.operation.result.reason, 'already-pending');
});

test('original failure rollback after a real intervening applied base cannot resurrect pending-equality edits', async t => {
  const h = fixture(t); await h.mount();
  const p = pendingEquality(h);
  // An independent applied-view boundary changes the base while the original
  // transport is outstanding. Use the actual apply owner, never state.view writes.
  // This ordinary payload is an applied-view input, not a private wire response.
  const changed = ordinary(':loved');
  h.c.applyViewPayload(changed, {trackSidebarReveal:false});
  assert.equal(h.state.view.query, ':loved');
  assert.equal(state(h).session, null);
  assert.equal(h.c.advancedSearchBaseCurrent(p.session), false);
  const applicationCount = h.applications.length;
  const failure = new Error('original request fails after base application');
  p.request.reject(failure);
  const result = await p.completion; await h.flush();
  assert.equal(result.error, failure);
  assert.equal(h.state.ui.failedGallerySearch.query, ':loved');
  assert.ok(h.applications.length > applicationCount, 'original failure callback invoked rollback apply owner');
  assert.equal(h.applications.at(-1).args[0], p.previousView, 'rollback uses original captured view');
  assert.equal(h.state.view.query, p.previousView.query);
  assert.equal(state(h).session, null);
  assert.equal(h.c.advancedSearchBaseCurrent(p.session), false);
  assert.equal(p.operation.result.reason, 'already-pending');
  assert.equal(h.requests.length, p.firstIndex + 1);
  h.c.toggleSearchAdvancedFilters();
  assert.notEqual(state(h).session, p.session);
});
