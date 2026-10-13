const test = require('node:test'), assert = require('node:assert/strict');
const {fixture, settle, F} = require('./album-tops-membership-fixtures/actual-request-fixture.cjs');
async function ready(t) {
  const h = fixture(t); h.runtime.snapshot(); await settle(); return h;
}
function observer(t, h) {
  const observed = {inside: false, calls: [], synchronous: 0};
  const unsubscribe = h.runtime.subscribe(() => {
    if (observed.inside) observed.synchronous++;
    observed.calls.push(h.runtime.snapshot());
  });
  t.after(unsubscribe);
  return {...observed, calls: observed.calls, unsubscribe,
    read() {observed.inside = true; try {return h.runtime.snapshot();} finally {observed.inside = false;}},
    synchronous: () => observed.synchronous};
}

for (const change of ['actor', 'library', 'private-context', 'denied-context', 'view', 'pending-transition']) {
  test(`${change} snapshot returns current facts immediately without notifying another store consumer during the read`, {timeout: 2000}, async t => {
    const h = await ready(t), before = h.runtime.snapshot(), o = observer(t, h);
    if (change === 'actor') h.shell.dataset.nativeAccountId = '8';
    else if (change === 'library') h.shell.dataset.nativeLibraryId = '10';
    else if (change === 'private-context') h.shell.dataset.privateUiContext = 'b'.repeat(64);
    else if (change === 'denied-context') h.shell.dataset.privateUiContext = '';
    else if (change === 'view') h.context.state.view = {surface: {active: 'album_tops'}, top_ref: F.OTHER};
    else h.context.state.ui.pendingViewTransition = true;
    const next = o.read();
    assert.equal(o.synchronous(), 0, 'snapshot must not synchronously notify a sibling React Session');
    assert.equal(o.calls.length, 0, 'the notification belongs after the snapshot/render stack');
    assert.notStrictEqual(next, before);
    if (change === 'view') {assert.equal(next.topRef, F.OTHER); assert.ok(next.viewVersion > before.viewVersion);}
    else if (change === 'pending-transition') assert.equal(next.visible, false);
    else {assert.notEqual(next.scopeKey, before.scopeKey); assert.equal(h.runtime.acceptsPrivateScope(before.scopeKey), false);}
    if (change === 'denied-context') assert.equal(next.authenticated, false);
    // Repeated reads are stable and cannot enqueue duplicate notifications.
    assert.strictEqual(o.read(), next); assert.strictEqual(o.read(), next);
    await settle(); assert.equal(o.calls.length, 1); assert.strictEqual(o.calls[0], next);
    assert.equal(o.synchronous(), 0); assert.strictEqual(o.read(), next);
    await settle(); assert.equal(o.calls.length, 1);
  });
}

test('multiple immediate scope snapshots coalesce into one latest subscription notification', {timeout: 2000}, async t => {
  const h = await ready(t), o = observer(t, h);
  h.shell.dataset.nativeAccountId = '8'; const intermediate = o.read();
  h.shell.dataset.privateUiContext = 'b'.repeat(64); const latest = o.read();
  assert.notEqual(intermediate.scopeKey, latest.scopeKey);
  assert.equal(o.calls.length, 0); assert.equal(o.synchronous(), 0);
  await settle(); assert.equal(o.calls.length, 1); assert.strictEqual(o.calls[0], latest);
});

test('unsubscribe before the queued delivery prevents notification to a disposed consumer', {timeout: 2000}, async t => {
  const h = await ready(t), o = observer(t, h);
  h.shell.dataset.nativeAccountId = '8'; o.read(); o.unsubscribe();
  await settle(); assert.equal(o.calls.length, 0); assert.equal(o.synchronous(), 0);
});

test('a replacement subscriber receives its next current event, never an old queued subscription delivery', {timeout: 2000}, async t => {
  const h = await ready(t), old = observer(t, h);
  h.shell.dataset.nativeAccountId = '8'; const changed = old.read(); old.unsubscribe();
  const replacement = observer(t, h);
  assert.strictEqual(replacement.read(), changed);
  await settle(); assert.equal(old.calls.length, 0); assert.equal(replacement.calls.length, 0);
  h.shell.dataset.nativeLibraryId = '10'; const latest = replacement.read();
  await settle(); assert.equal(old.calls.length, 0); assert.equal(replacement.calls.length, 1);
  assert.strictEqual(replacement.calls[0], latest); assert.equal(replacement.synchronous(), 0);
});

test('a notification callback can read its unchanged snapshot without recursive or repeated fanout', {timeout: 2000}, async t => {
  const h = await ready(t); let depth = 0, maxDepth = 0, count = 0, seen;
  const release = h.runtime.subscribe(() => {
    depth++; maxDepth = Math.max(maxDepth, depth); count++;
    seen = h.runtime.snapshot(); assert.strictEqual(h.runtime.snapshot(), seen); depth--;
  }); t.after(release);
  h.context.state.view = {...h.context.state.view}; const latest = h.runtime.snapshot();
  await settle(); assert.equal(count, 1); assert.equal(maxDepth, 1); assert.strictEqual(seen, latest);
  await settle(); assert.equal(count, 1);
});

test('ordinary native sync events are not missed after notifications move outside snapshot', {timeout: 2000}, async t => {
  const h = await ready(t), o = observer(t, h);
  h.context.getLibrarySidebarMode = () => 'albums';
  h.context.dispatchEvent(new h.context.Event('albumhaven:library-sidebar-change'));
  const latest = h.runtime.snapshot(); assert.equal(latest.sidebarMode, 'albums');
  await settle(); assert.equal(o.calls.length, 1); assert.strictEqual(o.calls[0], latest);
});

test('authority retires immediately while its consumer discard and store notification wait until after snapshot', {timeout: 2000}, async t => {
  const h = await ready(t), before = h.runtime.snapshot(), o = observer(t, h); let discarded = 0, departed = 0;
  const release = h.runtime.registerDraftNavigation({isCurrent: () => true,
    confirmLeave() {assert.fail('Authority retirement must not ask to navigate');}, onDiscard() {discarded++;}});
  assert.equal(typeof release, 'function'); t.after(release);
  h.shell.dataset.privateUiContext = 'b'.repeat(64); const next = o.read();
  assert.notEqual(next.scopeKey, before.scopeKey); assert.equal(h.runtime.acceptsPrivateScope(before.scopeKey), false);
  assert.equal(h.runtime.deferDraftNavigation(() => {departed++;}), false);
  assert.equal(discarded, 0); assert.equal(departed, 0); assert.equal(o.calls.length, 0); assert.equal(o.synchronous(), 0);
  await settle(); assert.equal(discarded, 1); assert.equal(departed, 0); assert.equal(o.calls.length, 1);
});

test('cleanup cancels an old queued discard before a replacement owner is registered', {timeout: 2000}, async t => {
  const h = await ready(t); let oldDiscard = 0, newDiscard = 0;
  const old = h.runtime.registerDraftNavigation({isCurrent: () => true, confirmLeave: () => true, onDiscard() {oldDiscard++;}});
  assert.equal(typeof old, 'function');
  h.shell.dataset.nativeAccountId = '8'; h.runtime.snapshot(); old();
  const replacement = h.runtime.registerDraftNavigation({isCurrent: () => true, confirmLeave: () => false, onDiscard() {newDiscard++;}});
  assert.equal(typeof replacement, 'function'); t.after(replacement);
  await settle(); assert.equal(oldDiscard, 0); assert.equal(newDiscard, 0);
  assert.equal(await h.runtime.deferDraftNavigation(() => assert.fail('Replacement guard was lost')), false);
});
