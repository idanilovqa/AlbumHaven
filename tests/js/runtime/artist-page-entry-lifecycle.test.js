'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {read} = require('./search-native-fixtures/actual-runtime.cjs');
const {fixture, artistView, album, ARTIST, drain, deferred} = require('./artist-host-fixtures/actual-artist-runtime.cjs');
async function mounted(t, options = {}) {
  const h = fixture(t, options); await h.entry(); await h.admit(); h.frame(); return h;
}
const ready = h => h.context.dispatchEvent(new h.context.Event('albumhaven:artist-page-runtime-ready'));
async function settleReturnedParent(h, original, requestIndex, invocationIndex, parentUrl) {
  assert.equal(h.requests.length, requestIndex + 1, 'return dispatched exactly one actual parent hydration');
  assert.equal(h.invocations.length, invocationIndex + 1);
  const request = h.requests[requestIndex], invocation = h.invocations[invocationIndex];
  assert.equal(request.settled, false, 'history completion did not settle the response');
  assert.equal(new URL(invocation.args[0], h.location.href).href, parentUrl);
  assert.equal(invocation.args[1], false, 'parent hydration does not push another entry');
  assert.equal(invocation.args[2].preserveScroll, true);
  assert.equal(h.state.busy, true); assertRetained(h, original, false);
  assert.equal(h.host.inert, true, 'same retained parent is held until its real response is admitted');
  const position = h.history.state.albumHavenNavigationPosition, location = h.location.href;
  h.reply(requestIndex, artistView());
  const outcome = await invocation.outcome; assert.equal(outcome.error, undefined);
  await drain(); h.frame();
  assert.equal(h.state.busy, false); assert.equal(h.location.href, location);
  assert.equal(h.history.state.albumHavenNavigationPosition, position);
  assert.equal(h.state.view.artist_page.artist_ref, ARTIST);
  assertRetained(h, original, true);
}
function assertRetained(h, original, actionable = false) {
  assert.equal(h.runtime().snapshot().sessionId, original.sessionId);
  assert.equal(h.runtime().snapshot().actionable, actionable);
  assert.equal(h.grid._artistPageLease, original.lease);
  assert.equal(h.section('discography').panel, original.panel);
  assert.equal(h.owner('virtualGrid'), original.grid);
}
function capture(h) {return {sessionId: h.runtime().snapshot().sessionId, lease: h.grid._artistPageLease,
  panel: h.section('discography').panel, grid: h.grid};}

test('actual entry initial mount and repeated readiness create one native lease and one action slot', async t => {
  const h = await mounted(t), original = capture(h), ids = h.identities();
  for (let n = 0; n < 8; n++) ready(h);
  assertRetained(h, original, true);
  assert.equal(h.host.querySelectorAll('.artist-page__sections').length, 1);
  assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1);
  assert.equal(h.document.querySelectorAll('[data-artist-page-action-slot="loved"]').length, 1);
  assert.equal(h.identities().scheduler, ids.scheduler); assert.equal(h.identities().cache, ids.cache);
});

test('entry replaces host only after restoring intact viewport, and stale deferred work cannot redock it', async t => {
  const h = await mounted(t), oldHost = h.host, viewport = h.nodes.viewport, oldLease = h.grid._artistPageLease;
  const deferredFrames = [...h.frames.values()], nextHost = h.document.createElement('section');
  oldHost.removeAttribute('id'); nextHost.id = 'artist-page-root'; nextHost.hidden = true;
  h.scroll.insertBefore(nextHost, oldHost); ready(h); await drain();
  assert.notEqual(h.grid._artistPageLease, oldLease);
  assert.equal(nextHost.contains(viewport), true); assert.equal(oldHost.contains(viewport), false);
  for (const frame of deferredFrames) frame(0);
  assert.equal(nextHost.contains(viewport), true); assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1);
  assert.equal(oldHost.querySelector('.artist-page__sections'), null);
});

test('real bridge runtime replacement retires old context and new entry starts from fresh admitted render', async t => {
  const h = await mounted(t), old = h.runtime(), oldLease = h.grid._artistPageLease;
  // Whole replacement script in a fresh realm, with the same actual lexical
  // owners. This is the existing delivery-fixture pattern, not a fake runtime.
  const realm = vm.createContext({...h.context, window: h.context, state: h.state,
    virtualGrid: h.grid, mobilePageState: h.mobileState()});
  vm.runInContext(read('music_app/static/js/runtime/artist-page-bridge.js'), realm,
    {filename: 'music_app/static/js/runtime/artist-page-bridge.js'});
  assert.notEqual(h.runtime(), old); assert.equal(old.snapshot().status, 'inactive');
  assert.equal(h.nodes.viewport.parentElement, h.scroll); assert.equal(h.grid._artistPageLease, null);
  h.refresh({preserveMountedGallery: true}); await drain();
  assert.equal(h.runtime().snapshot().mounted, true); assert.notEqual(h.grid._artistPageLease, oldLease);
});

for (const chain of [false, true]) for (const delta of [false, true]) {
  test(`actual ${chain ? 'album-to-form' : 'direct form'} return owns descriptor-removal midpoint, ${delta ? 'history delta' : 'replace path'}`, async t => {
    const h = await mounted(t, {mobile: true}), original = capture(h);
    h.scrollTo(347); const scrollBefore = h.scroll.scrollTop;
    if (chain) {
      const key = h.nodes.container.querySelector('[data-album-key]').getAttribute('data-album-key');
      assert.equal(h.context.presentMobileAlbumPage(h.context.getIndexedAlbum(key)), true);
    }
    const form = h.openForm(); assert.equal(h.mobileState().pages.at(-1).kind, 'form');
    assertRetained(h, original);
    if (!delta) {
      // Model the supported browser entry without a navigation position. Never
      // edit the product descriptor or construct a form-return object in tests.
      const snapshot = {...h.history.state}; delete snapshot.albumHavenNavigationPosition;
      h.history.replaceState(snapshot, '', h.location.href);
    }
    let midpoint = 0;
    const observe = mode => {
      if (mode !== (delta ? 'go' : 'replace') || h.mobileState().pages.some(page => page.kind === 'form')) return;
      midpoint++;
      const returning = h.mobileState().formReturn;
      assert.ok(returning, 'return owner exists before browser history changes');
      assert.ok(returning.artistParent, 'return lease was captured from the live parent');
      assert.equal(returning.artistParent.sessionId, original.sessionId);
      assertRetained(h, original);
      assert.equal(h.host.inert, true);
    };
    if (delta) h.holdHistory(observe); else h.observeHistory(observe);
    const requestIndex = h.requests.length, invocationIndex = h.invocations.length;
    const parentUrl = h.runtime().snapshot().parentViewUrl;
    const dismissed = form.dismiss('back'); await drain(); assert.equal(midpoint, 1);
    if (delta) {assert.equal(h.pendingHistory().length, 1); h.settleHistory();}
    await dismissed; await drain(); h.frame();
    assert.equal(h.mobileState().formReturn, null);
    if (!chain) await settleReturnedParent(h, original, requestIndex, invocationIndex, parentUrl);
    else assert.equal(h.requests.length, requestIndex, 'return to a still-live album child does not hydrate Gallery');
    assertRetained(h, original, !chain);
    assert.equal(h.scroll.scrollTop, scrollBefore, 'stored scroll uses absolute scroller coordinates');
  });
}

test('dirty form veto keeps host and live chain, and later accepted traversal returns through the real owner', async t => {
  const h = await mounted(t, {mobile: true}), original = capture(h); let permit = false;
  const form = h.openForm({beforeDismiss: () => permit});
  assert.equal(await form.dismiss('back'), false); assertRetained(h, original);
  assert.equal(h.mobileState().pages.at(-1).kind, 'form');
  const requestIndex = h.requests.length, invocationIndex = h.invocations.length;
  const parentUrl = h.runtime().snapshot().parentViewUrl;
  permit = true; h.holdHistory(); const close = form.dismiss('back'); await drain();
  assert.equal(h.pendingHistory().length, 1); h.settleHistory(); assert.equal(await close, true);
  await drain(); await settleReturnedParent(h, original, requestIndex, invocationIndex, parentUrl);
  assertRetained(h, original, true);
});

test('browser traversal veto never retires parent during the passive popstate midpoint', async t => {
  const h = await mounted(t, {mobile: true}), original = capture(h), gate = deferred();
  h.openForm({beforeDismiss: () => gate.promise});
  h.rawHistoryGo(-1); await drain();
  assertRetained(h, original); assert.ok(h.mobileState().formTraversal);
  gate.resolve(false); await drain();
  assertRetained(h, original); assert.equal(h.mobileState().pages.at(-1).kind, 'form');
});

function pendingReturn(h, original) {
  const returning = h.mobileState().formReturn;
  assert.ok(returning && returning.artistParent, 'actual live return owner exists');
  assert.equal(returning.artistParent.sessionId, original.sessionId);
  assert.equal(h.pendingHistory().length, 1, 'one actual browser return callback is queued');
  assert.equal(typeof returning.resolve, 'function');
  // This is the real deferred completion captured after dismiss removed the
  // descriptor. It is not an arbitrary earlier RAF or a fabricated callback.
  return {owner: returning, callbacks: [returning.resolve]};
}
function assertNoRetiredFocus(h, opener, checkpoint) {
  const calls = h.focusLog.slice(checkpoint);
  assert.equal(calls.some(row => opener.retiredNodes.has(row.node)), false,
    'no original card/toggle may be focused after its host retires');
  assert.equal(calls.some(row => row.albumKeyAtCall === opener.token.albumKey
    && row.versionKeyAtCall === opener.token.versionKey && row.triggerAtCall === opener.token.trigger), false,
    'no re-created trigger may replay the retired album/version/trigger token');
}

test('positive owned form return restores the visible real Discography opener', async t => {
  const h = await mounted(t, {mobile: true}), original = capture(h), opener = h.focusOpener('cover');
  const form = h.openForm({retainParentView: () => h.runtime().snapshot().sessionId === original.sessionId}); h.holdHistory(); const closing = form.dismiss('back'); await drain();
  const queued = pendingReturn(h, original); assert.equal(queued.callbacks.length, 1);
  const checkpoint = h.focusLog.length; h.settleHistory(); assert.equal(await closing, true); await drain();
  assertRetained(h, original, true);
  assert.ok(h.focusLog.slice(checkpoint).some(row => row.node === opener.trigger
    && row.albumKeyAtCall === opener.token.albumKey && row.versionKeyAtCall === opener.token.versionKey
    && row.triggerAtCall === 'cover'), 'same eligible opener really receives owned return focus');
  assert.equal(h.document.activeElement, opener.trigger);
});

test('scope loss during held form return immediately retires old lease and forbids queued opener focus', async t => {
  const h = await mounted(t, {mobile: true}), original = capture(h), opener = h.focusOpener('cover');
  const form = h.openForm({retainParentView: () => h.runtime().snapshot().sessionId === original.sessionId}); h.holdHistory(); const closing = form.dismiss('back'); await drain();
  const queued = pendingReturn(h, original); assertRetained(h, original);
  const checkpoint = h.focusLog.length;
  h.change('actor', '8'); assert.equal(h.runtime().snapshot().status, 'inactive');
  assert.equal(h.grid._artistPageLease, null); assert.equal(h.nodes.viewport.parentElement, h.scroll);
  h.settleHistory(); await closing; await drain();
  assert.equal(queued.callbacks.length, 1);
  for (const callback of queued.callbacks) callback(true);
  await drain(); h.frame(); assertNoRetiredFocus(h, opener, checkpoint);
});

test('newer unrelated committed navigation defeats pending return completion and retired focus identity', async t => {
  const h = await mounted(t, {mobile: true}), original = capture(h), opener = h.focusOpener('tracklist');
  const form = h.openForm({retainParentView: () => h.runtime().snapshot().sessionId === original.sessionId}); h.holdHistory(); const closing = form.dismiss('back'); await drain();
  const queued = pendingReturn(h, original), checkpoint = h.focusLog.length;
  h.history.pushState({albumHavenNavigationPosition: 900, mobilePages: []}, '', '/?surface=albums&artist=Unrelated');
  h.context.handleMobilePagePopState(); await closing; await drain();
  h.runtime().syncPresentation(); assert.equal(h.runtime().snapshot().status, 'inactive');
  assert.equal(queued.callbacks.length, 1);
  for (const callback of queued.callbacks) callback(true);
  await drain(); h.frame();
  assert.equal(h.nodes.viewport.parentElement, h.scroll); assertNoRetiredFocus(h, opener, checkpoint);
});

test('failed pushed navigation cannot bind Artist admission to the old entry', async t => {
  const h = await mounted(t), previous = h.runtime().snapshot();
  // Browser push failure occurs after normalized response rendering. Observers
  // may see a provisional host, but it must not acquire parent authority.
  const push = h.history.pushState; h.history.pushState = () => {throw new Error('fixture browser push denied');};
  t.after(() => {h.history.pushState = push;});
  const payload = artistView({selected_artist: 'New Artist', artist_page: {artist_ref: 'New Artist', active_page_mode: 'info'}});
  const index = h.requests.length, result = h.read(h.context.buildApiUrl(payload), {}, true); h.reply(index, payload);
  await result; await drain();
  const snapshot = h.runtime().snapshot();
  assert.equal(snapshot.actionable, false);
  assert.ok(snapshot.status === 'inactive' || snapshot.entryKey !== previous.entryKey,
    'rejected commit cannot rebind the provisional child to the previous parent entry');
});

test('disposal reentry through a DOM callback preserves the newest host rather than clearing its sections', async t => {
  const h = await mounted(t), retiringInfo = h.section('info').panel.parentElement;
  const oldHost = h.host, obsolete = h.document.createElement('section'), successor = h.document.createElement('section');
  obsolete.id = 'artist-page-root'; successor.hidden = true;
  oldHost.removeAttribute('id'); h.scroll.insertBefore(obsolete, oldHost);
  const proto = h.context.Element.prototype, replace = proto.replaceChildren; let once = true;
  // Browser DOM instrumentation delegates intact, then emits a real readiness
  // event at the disposal boundary. No native owner method is substituted.
  proto.replaceChildren = function(...nodes) {
    const result = replace.apply(this, nodes);
    if (once && this === retiringInfo) {
      once = false; obsolete.removeAttribute('id'); successor.id = 'artist-page-root';
      h.scroll.insertBefore(successor, obsolete); ready(h);
    }
    return result;
  };
  t.after(() => {proto.replaceChildren = replace;});
  ready(h); await drain();
  assert.equal(once, false); assert.equal(successor.contains(h.nodes.viewport), true);
  assert.equal(successor.querySelectorAll('.artist-page__sections').length, 1);
  assert.equal(obsolete.querySelector('.artist-page__sections'), null);
  assert.equal(oldHost.contains(h.nodes.viewport), false);
  assert.equal(h.runtime().snapshot().mounted, true);
});
