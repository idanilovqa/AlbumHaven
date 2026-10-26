'use strict';
// Reuse actual settings-navigation and closeDraft owners. Only browser history,
// network observation and the user's confirmation decision are platform ports.
const assert = require('node:assert/strict');
const {harness, settle} = require('./library-mix-navigation-fixture.cjs');
const A = require('./sample-origin-action-fixtures.cjs');
const {retainedPresentation} = require('./sample-origin-presentation-fixtures.cjs');

function closeHarness(options = {}) {
  const parentPosition = Object.hasOwn(options, 'parentPosition') ? options.parentPosition : 0;
  const {departurePosition, confirmLeave = () => true} = options;
  const h = harness(), calls = {go: [], fallback: [], returned: 0}; let active = true, sourceCurrent = true;
  const nativeGo = h.history.go.bind(h.history);
  h.history.go = delta => {calls.go.push(delta); return nativeGo(delta);};
  h.context.fetchAndRender = async (...args) => {calls.fallback.push(args); return true;};
  const initial = {...h.history.state};
  if (parentPosition === undefined) delete initial.albumHavenNavigationPosition;
  else initial.albumHavenNavigationPosition = parentPosition;
  h.history.replaceState(initial, '', h.location.href);
  const scopeKey = h.runtime.snapshot().scopeKey, token = 'sample:back:owner';
  assert.equal(h.runtime.openDraft({token, scopeKey, isCurrent: () => active, confirmLeave,
    onDiscard: () => {h.calls.discard++; active = false;}}), true);
  if (Object.hasOwn(options, 'departurePosition')) {
    const state = {...h.history.state};
    if (departurePosition === undefined) delete state.albumHavenNavigationPosition;
    else state.albumHavenNavigationPosition = departurePosition;
    h.history.replaceState(state, '', h.location.href);
  }
  return {...h, backCalls: calls, token, scopeKey, active: () => active,
    originIsCurrent: () => sourceCurrent, retireOrigin: () => {sourceCurrent = false;}};
}

function historyPort(h) {
  // The accepted action fixture's history.go intentionally throws. Supply a
  // browser-stack port, not an alternative departure owner. Real Settings
  // confirmation, discard and history writes are still invoked unchanged.
  const location = h.c.location, entries = [{url: location.href, state: structuredClone(h.c.history.state)}];
  const calls = {go: [], fetch: [], settingsReads: [], fallback: []}; let index = 0;
  h.c.history = {
    get state() {return entries[index].state;},
    pushState(state, _title, url) {location.href = new URL(url, location).href;
      entries.splice(++index, Infinity, {url: location.href, state: structuredClone(state)});},
    replaceState(state, _title, url) {location.href = new URL(url || location.href, location).href;
      entries[index] = {url: location.href, state: structuredClone(state)};},
    go(delta) {
      calls.go.push(delta); assert.equal(Number.isSafeInteger(delta), true);
      const target = index + delta; assert.ok(target >= 0 && target < entries.length, 'valid captured parent stack entry');
      // Native traversal is asynchronous. This bounded port commits the entry,
      // not a browser popstate/render boot. That limitation is explicit in docs.
      queueMicrotask(() => {index = target; location.href = entries[index].url;});
    },
  };
  h.c.fetch = async (url, options = {}) => {
    // Returning to the visible Top refreshes its account preference, not its
    // retained source/form. Admit only the genuine provider's read-only route.
    if (url === '/account/album-top-listening-settings' && options.method === 'GET'
      && options.credentials === 'same-origin' && options.redirect === 'error'
      && !Object.hasOwn(options, 'body')) {
      calls.settingsReads.push({url, options});
      return {ok: true, status: 200, json: async () => ({status: 'ready',
        data: {completed_target: 5, settings_revision: '1', preference_status: 'default'},
        context_ref: 'a'.repeat(64), context_scope: 'album-top-settings-v1'})};
    }
    calls.fetch.push([url, options]);
    throw new Error('Back must not fetch a reconstructed source');
  };
  h.c.fetchAndRender = async (...args) => {calls.fallback.push(args); return false;};
  return {calls, entries, index: () => index,
    mark: () => ({index, url: location.href, state: structuredClone(h.c.history.state)}),
    assertReturned(mark) {
      assert.equal(index, mark.index); assert.equal(location.href, mark.url);
      assert.equal(h.c.history.state.albumHavenNavigationPosition, mark.state.albumHavenNavigationPosition);
      assert.deepEqual(calls.go, [-1]); assert.equal(calls.fetch.length, 0); assert.equal(calls.fallback.length, 0);
    }};
}

function observeClose(h) {
  const close = h.runtime.closeDraft, seen = [];
  h.runtime.closeDraft = (token, returnToOrigin, originIsCurrent) => {
    assert.equal(typeof returnToOrigin, 'function', 'real typed Sample chooses the source return');
    assert.equal(typeof originIsCurrent, 'function', 'the original destination-scoped lease guard is forwarded');
    return close(token, returnToParent => {
      seen.push({returnToParent, token, marker: h.c.history.state.playlistDraft,
        retained: h.runtime.snapshot().retainedDraftToken, originCurrent: originIsCurrent()});
      return returnToOrigin(returnToParent);
    }, originIsCurrent);
  };
  return seen;
}

async function actualSource(t, h, returnToOrigin, {draft = false} = {}) {
  const svc = A.T.service();
  svc.data.detail = A.T.detail({type: 'manual', items: [{item_ref: A.F.id(510), album_ref: A.T.ALBUM,
    inventory_album_ref: 'inventory-album:5:11', local_album_id: 11}]});
  const controller = await A.T.preparedController(svc);
  const {captureAlbumTopSampleOrigin} = await A.T.load('playlists/sample-playlist-origins.mjs');
  let draftOwner = null;
  if (draft) {
    const {createAlbumTopDraft} = await A.T.load('album-tops/draft.mjs');
    draftOwner = createAlbumTopDraft({controller, providers: svc.providers});
    draftOwner.edit({title: 'Volatile unsaved title', description: 'Unsaved subtitle'});
  }
  // This trusted fixture source has no registered Top draft. Its own retained
  // surface supplies the required local presentation port; the destination
  // must not manufacture one or infer it from the source lease's scope.
  let lease;
  const presentation = retainedPresentation(t, h, () => lease?.isCurrent() === true, 'back-trusted-top-source');
  const returnFromSource = async returnToParent => {
    // Forward the same function to the original trusted callback. Presentation
    // restoration is owned here, not a second navigation or new authority.
    const returned = await returnToOrigin(returnToParent);
    if (returned === true) presentation.restore();
    return returned;
  };
  lease = captureAlbumTopSampleOrigin({controller, ...(draftOwner ? {draft: draftOwner} : {}), libraryRef: '5',
    isCurrent: () => controller.getSnapshot().scopeKey === A.T.SCOPE, returnToOrigin: returnFromSource});
  assert.ok(lease); assert.notEqual(lease.scopeKey, h.runtime.snapshot().scopeKey);
  const originNavigation = presentation.navigation;
  t.after(() => {draftOwner?.dispose(); controller.dispose();});
  return {controller, draft: draftOwner, lease, svc, originNavigation};
}
module.exports = {...A, closeHarness, historyPort, observeClose, actualSource, settle};
