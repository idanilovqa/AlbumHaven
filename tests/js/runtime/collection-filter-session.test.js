const test = require('node:test'), assert = require('node:assert/strict');
const shared = () => import('../../../music_app/static/js/collections/native-filter-session.mjs');
const playlist = () => import('../../../music_app/static/js/playlists/native-filter-session.mjs');

function source() {
  let state = {scopeKey: 'one', resourceId: 'same-id', detail: {}, filters: {query: 'kept', addedWithinDays: 7}}, version = 1;
  const listeners = new Set();
  const controller = {
    getSnapshot: () => state, getLifecycleVersion: () => version,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
  };
  return {controller, listeners, state: () => state,
    publish(patch) {state = {...state, ...patch}; for (const fn of [...listeners]) fn();},
    restart() {version++; for (const fn of [...listeners]) fn();},
  };
}
const identity = state => state.detail ? [state.scopeKey, state.resourceId, state.detail] : null;

test('resource-configured filter disclosures never accept another resource session with identical identity', async t => {
  const {createCollectionFilterSession} = await shared(), {createPlaylistFilterSession} = await playlist();
  const h = source(), providers = {}, changes = [];
  const top = createCollectionFilterSession({resourceNamespace: 'album-top'}, h.controller, identity, providers, () => changes.push('top'));
  const list = createPlaylistFilterSession(h.controller, identity, providers, () => changes.push('playlist'));
  t.after(() => {top.dispose(); list.dispose();});
  top.toggle(); list.toggle();
  const topOpening = top.opening, listOpening = list.opening;
  assert.equal(topOpening.context.resourceNamespace, 'album-top');
  assert.equal(listOpening.context.resourceNamespace, 'playlist');
  assert.equal(top.sourceCurrent(listOpening), false); assert.equal(list.sourceCurrent(topOpening), false);
  top.close(listOpening); assert.equal(top.opening, topOpening);
  list.close(topOpening); assert.equal(list.opening, listOpening);
  assert.deepEqual(changes, ['top', 'playlist']);
});

test('closing retains the current source only for focus return until a new opening or source replacement', async t => {
  const {createPlaylistFilterSession} = await playlist(), h = source();
  const session = createPlaylistFilterSession(h.controller, identity); t.after(() => session.dispose());
  session.toggle(); const first = session.opening; session.close(first);
  assert.equal(session.opening, null); assert.equal(session.current(first), false);
  assert.equal(session.sourceCurrent(first), true);
  session.toggle(); const second = session.opening;
  assert.notEqual(second, first); assert.equal(session.sourceCurrent(first), false);
  h.publish({detail: {}});
  assert.equal(session.opening, null); assert.equal(session.sourceCurrent(second), false);
});

for (const invalidation of ['scope', 'resource', 'lifecycle', 'unavailable']) {
  test(`shared filter disclosure retires on ${invalidation} invalidation without changing filter values`, async t => {
    const {createCollectionFilterSession} = await shared(), h = source(), filters = h.state().filters;
    let notifications = 0;
    const session = createCollectionFilterSession({resourceNamespace: 'album-top'}, h.controller, identity, {}, () => notifications++);
    t.after(() => session.dispose()); session.toggle(); const opening = session.opening;
    if (invalidation === 'scope') h.publish({scopeKey: 'two'});
    else if (invalidation === 'resource') h.publish({resourceId: 'other'});
    else if (invalidation === 'unavailable') h.publish({detail: null});
    else h.restart();
    assert.equal(session.opening, null); assert.equal(session.sourceCurrent(opening), false);
    assert.equal(notifications, 2); assert.equal(h.state().filters, filters);
    assert.deepEqual(filters, {query: 'kept', addedWithinDays: 7});
  });
}

test('same session inputs retain an opening, provider replacement retires it, and disposal releases subscriptions', async () => {
  const {createCollectionFilterSession} = await shared(), h = source(), next = source(), providers = {};
  const session = createCollectionFilterSession({resourceNamespace: 'album-top'}, h.controller, identity, providers);
  session.toggle(); const first = session.opening;
  session.update(h.controller, identity, providers); assert.equal(session.opening, first);
  session.update(h.controller, identity, {}); assert.equal(session.opening, null); assert.equal(session.sourceCurrent(first), false);
  session.toggle(); session.update(next.controller, identity, providers);
  assert.equal(h.listeners.size, 0); assert.equal(next.listeners.size, 1); assert.equal(session.opening, null);
  session.dispose(); assert.equal(next.listeners.size, 0);
  session.update(h.controller, identity, providers); session.toggle();
  assert.equal(h.listeners.size, 0); assert.equal(session.opening, null);
});
