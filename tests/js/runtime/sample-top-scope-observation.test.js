'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {topOwner, platform, observeScope} = require('./sample-top-lifecycle-fixture.cjs');
function assertObserver(h) {assert.equal(typeof h.actual.isCurrentSampleScope, 'function'); return h.owner('PrivateUITransport');}

test('actual Top scope observation does not initialize its private snapshot', async t => {
  const base = await platform(t), topHost = base.add('album-tops-root');
  base.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'album_tops'}, top_ref: null};
  base.load('runtime/album-tops-react-bridge.js');
  const h = {...base, topHost, actual: base.c.AlbumHavenAlbumTopsRuntime}, transport = assertObserver(h), observed = observeScope(t, h);
  assert.equal(transport.peekGeneration(), 0);
  assert.equal(h.actual.isCurrentSampleScope('not-an-initialized-owner'), false);
  assert.equal(h.actual.isCurrentSampleScope(null), false); observed.quiet();
  const first = h.actual.snapshot(); observed.reset();
  assert.equal(h.actual.isCurrentSampleScope(first.scopeKey), true); observed.quiet();
  for (const key of ['nativeAccountId', 'nativeLibraryId']) {
    const value = h.shell.dataset[key]; h.shell.dataset[key] = '';
    const unauthenticated = h.actual.snapshot(); observed.reset();
    assert.equal(unauthenticated.authenticated, false);
    assert.equal(h.actual.isCurrentSampleScope(unauthenticated.scopeKey), false); observed.quiet();
    h.shell.dataset[key] = value; h.actual.snapshot(); observed.reset();
    assert.equal(h.actual.isCurrentSampleScope(first.scopeKey), true); observed.quiet();
  }
});

test('actual Top rejects unsynchronized scope view visibility and host loss without normalization', async t => {
  const h = await topOwner(t), transport = assertObserver(h), before = h.actual.snapshot(), observed = observeScope(t, h);
  const source = h.state.view, history = JSON.stringify(h.c.history.state), children = [...h.topHost.childNodes], generation = transport.peekGeneration();
  const input = (change, restore) => {change(); assert.equal(h.actual.isCurrentSampleScope(before.scopeKey), false); observed.quiet(); restore();
    assert.equal(h.actual.isCurrentSampleScope(before.scopeKey), true); observed.quiet();};
  for (const key of ['nativeAccountId', 'nativeLibraryId']) {const value = h.shell.dataset[key]; input(() => {h.shell.dataset[key] = '999';}, () => {h.shell.dataset[key] = value;});}
  const context = h.shell.dataset.privateUiContext;
  for (const value of ['b'.repeat(64), 'malformed']) input(() => {h.shell.dataset.privateUiContext = value; assert.equal(transport.peekGeneration(), null);}, () => {h.shell.dataset.privateUiContext = context;});
  input(() => {h.state.view = {...source};}, () => {h.state.view = source;});
  input(() => {h.shell.hidden = true;}, () => {h.shell.hidden = false;});
  const parent = h.topHost.parentNode, sibling = h.topHost.nextSibling;
  input(() => {h.topHost.remove();}, () => {parent.insertBefore(h.topHost, sibling);});
  assert.equal(h.actual.isCurrentSampleScope(before.scopeKey + ':foreign'), false); observed.quiet();
  assert.equal(transport.peekGeneration(), generation); assert.equal(h.state.view, source);
  assert.equal(JSON.stringify(h.c.history.state), history); assert.deepEqual([...h.topHost.childNodes], children);
  assert.equal(h.actual.snapshot(), before); h.noWrites(h.svc);
});

for (const method of ['invalidate', 'dispose']) test(`actual Top observer rejects ${method} transport even after ordinary scope normalization`, async t => {
  const h = await topOwner(t), transport = assertObserver(h), old = h.actual.snapshot(), observed = observeScope(t, h);
  transport[method](); const latest = h.actual.snapshot(); observed.reset();
  assert.equal(transport.peekGeneration(), null); assert.equal(h.actual.isCurrentSampleScope(old.scopeKey), false);
  assert.equal(h.actual.isCurrentSampleScope(latest.scopeKey), false); observed.quiet(); h.noWrites(h.svc);
});

test('actual inline child observes pure Top continuity without reentering Settings and Back keeps its exact parent', async t => {
  const h = await topOwner(t, {mode: 'inline'}); assertObserver(h);
  const title = h.form.querySelector('[aria-label="Album Top name"]'); h.input(title, 'Unsaved inline title');
  assert.equal(h.registrations.length, 1); const parent = h.registrations[0].handle;
  h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  assert.equal(h.calls.draft[0].parentRegistration, parent); assert.equal(h.topHost.hidden, true);
  const observed = observeScope(t, h), before = JSON.stringify(h.c.history.state), scope = h.sourceScope;
  for (let n = 0; n < 5; n++) {assert.equal(h.actual.isCurrentSampleScope(scope), true); assert.equal(h.calls.draft[0].isCurrent(), true);}
  observed.quiet(); assert.equal(JSON.stringify(h.c.history.state), before); assert.deepEqual(h.events, []);
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(h.topHost.hidden, false); assert.equal(h.document.querySelector('form[aria-label="Edit Album Top"]'), h.form);
  assert.equal(title.value, 'Unsaved inline title'); assert.deepEqual(h.history.traversals, [-1]); assert.deepEqual(h.events, []);
  assert.equal(h.registrations.length, 1); assert.equal(h.registrations[0].handle, parent);
  h.click(h.sourceButton()); await h.settle(); assert.equal(h.calls.draft.length, 2);
  assert.equal(h.calls.draft[1].parentRegistration, parent); assert.equal(h.calls.draft[1].isCurrent(), true); h.noWrites(h.svc);
});

for (const loss of ['actor', 'library', 'context', 'view']) test(`actual inline source lease observed ${loss} loss cannot revive after restoring inputs`, async t => {
  const h = await topOwner(t, {mode: 'inline'}); assertObserver(h);
  h.click(h.sourceButton()); await h.settle(); h.assertSetup(); const guard = h.calls.draft[0].isCurrent, observed = observeScope(t, h);
  const key = {actor: 'nativeAccountId', library: 'nativeLibraryId', context: 'privateUiContext'}[loss], view = h.state.view, prior = key && h.shell.dataset[key];
  if (key) h.shell.dataset[key] = loss === 'context' ? 'b'.repeat(64) : '999'; else h.state.view = {...view};
  assert.equal(guard(), false); observed.quiet();
  if (key) h.shell.dataset[key] = prior; else h.state.view = view;
  assert.equal(h.actual.isCurrentSampleScope(h.sourceScope), true, 'raw input restoration is not authority restoration for the retired lease');
  assert.equal(guard(), false); observed.quiet();
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.deepEqual(h.history.traversals, []); h.noWrites(h.svc);
});
