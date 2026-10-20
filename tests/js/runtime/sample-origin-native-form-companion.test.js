'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {fixture, observe, deferred, drain} = require('./sample-origin-native-form-companion-fixture.cjs');
function retained(h, source) {
  assert.equal(h.active(), source.owner); assert.equal(source.owner.isActive(), true);
  assert.equal(source.owner.promise, source.handle.promise); assert.equal(source.promise.status, 'pending');
  assert.equal(h.get('modal'), source.nodes.modal); assert.equal(h.get('title'), source.nodes.title);
  assert.equal(h.get('content'), source.nodes.content); assert.equal(source.nodes.host.parentNode, source.nodes.content);
  assert.equal(source.nodes.input.parentNode, source.nodes.host); assert.equal(source.nodes.input.value, 'Unsaved title including \u2713');
  assert.equal(source.nodes.title.textContent, 'Exact original form');
}
function suspended(h, source) {
  retained(h, source); assert.equal(h.foreground(), null); assert.equal(h.mobileForeground(), null);
  assert.equal(h.concealed(source.nodes.modal), true); assert.equal(h.events.length, 0); h.noEffects();
}

test('actual native handle suspends presentation only and restores exact nodes, values, title, focus and pending promise', async t => {
  const h = fixture(t), source = h.open(), before = Object.fromEntries(Object.entries(source.nodes).map(([key,node]) => [key,h.flags(node)]));
  assert.equal(Object.isFrozen(source.handle), true); source.nodes.input.focus();
  const presentation = source.handle.suspendPresentation(); assert.ok(presentation); suspended(h, source);
  h.child.focus(); await drain(); suspended(h, source); assert.equal(h.document.activeElement, h.child);
  assert.equal(presentation.restore(), true); await drain(); retained(h, source);
  assert.equal(h.foreground(), source.owner); assert.equal(h.mobileForeground(), source.owner);
  for (const [key,node] of Object.entries(source.nodes)) assert.deepEqual(h.flags(node), before[key]);
  assert.equal(h.document.activeElement, source.nodes.input); assert.equal(presentation.restore(), false);
  assert.equal(h.events.length, 0); h.noEffects();
});

test('duplicate suspension is rejected without consuming the original presentation owner', async t => {
  const h = fixture(t), source = h.open(), first = source.handle.suspendPresentation(); assert.ok(first);
  assert.equal(source.handle.suspendPresentation(), false); suspended(h, source);
  assert.equal(first.restore(), true); retained(h, source);
  const second = source.handle.suspendPresentation(); assert.ok(second);
  assert.equal(first.restore(), false); first.retire(); suspended(h, source);
  assert.equal(second.restore(), true); retained(h, source);
});

test('retiring a native presentation is not physical disposal and cannot restore after subsequent forced owner cleanup', async t => {
  const h = fixture(t), source = h.open(), presentation = source.handle.suspendPresentation(); assert.ok(presentation);
  presentation.retire(); presentation.retire(); assert.equal(presentation.restore(), false);
  retained(h, source); assert.equal(h.concealed(source.nodes.modal), true); assert.equal(h.events.length, 0);
  await h.forceClose(source.handle); await drain();
  assert.equal(h.active(), null); assert.equal(source.promise.status, 'resolved'); assert.equal(source.promise.settlements, 1);
  assert.equal(h.events.filter(row => row[0] === 'close').length, 1); assert.equal(presentation.restore(), false);
  assert.equal(source.handle.suspendPresentation(), false); await h.forceClose(source.handle); await drain();
  assert.equal(source.promise.settlements, 1); assert.equal(h.events.filter(row => row[0] === 'close').length, 1); h.noEffects();
});

test('forced close during suspension leaves no late presentation authority over a subsequently admitted native form', async t => {
  const h = fixture(t), source = h.open(), old = source.handle.suspendPresentation(); assert.ok(old);
  await h.forceClose(source.handle); await drain(); assert.equal(source.promise.settlements, 1);
  const next = h.open({title: 'Successor form', pageId: 'native-companion-successor'}), before = h.flags(next.nodes.modal);
  assert.equal(old.restore(), false); old.retire(); assert.equal(source.handle.suspendPresentation(), false);
  assert.equal(h.active(), next.owner); assert.equal(h.foreground(), next.owner); assert.deepEqual(h.flags(next.nodes.modal), before);
  assert.equal(next.nodes.title.textContent, 'Successor form'); assert.equal(next.promise.status, 'pending'); h.noEffects();
});

for (const scope of ['actor', 'library']) test(`actual native ${scope} loss rejects suspension acquisition without closing the original owner`, async t => {
  const h = fixture(t), source = h.open(), before = h.flags(source.nodes.modal);
  h.shell.dataset[scope === 'actor' ? 'nativeAccountId' : 'nativeLibraryId'] = '991';
  assert.equal(source.owner.isCurrentContext(), false); assert.equal(source.handle.suspendPresentation(), false);
  assert.equal(h.active(), source.owner); assert.deepEqual(h.flags(source.nodes.modal), before); assert.equal(source.promise.status, 'pending');
  assert.equal(h.events.length, 0); await h.forceClose(source.handle); await drain();
  assert.equal(source.promise.settlements, 1); assert.equal(source.promise.value, null); h.noEffects();
});

for (const scope of ['actor', 'library']) test(`actual native ${scope} loss during suspension never reveals obsolete content and remains physically cleanable`, async t => {
  const h = fixture(t), source = h.open(), presentation = source.handle.suspendPresentation(); assert.ok(presentation);
  h.shell.dataset[scope === 'actor' ? 'nativeAccountId' : 'nativeLibraryId'] = '992'; h.child.focus();
  assert.equal(presentation.restore(), false); assert.equal(h.concealed(source.nodes.modal), true); assert.equal(h.document.activeElement, h.child);
  assert.equal(source.promise.status, 'pending'); await h.forceClose(source.handle); await drain();
  assert.equal(source.promise.settlements, 1); assert.equal(h.events.filter(row => row[0] === 'close').length, 1);
  assert.equal(h.events.at(-1)[2].current, false); assert.equal(presentation.restore(), false); h.noEffects();
});

for (const removed of ['host', 'title']) test(`suspended native ${removed} removal invalidates restoration instead of recreating detached nodes`, async t => {
  const h = fixture(t), source = h.open(), presentation = source.handle.suspendPresentation(); assert.ok(presentation);
  source.nodes[removed].remove(); h.child.focus();
  assert.equal(presentation.restore(), false); assert.equal(source.nodes[removed].isConnected, false);
  assert.equal(h.concealed(source.nodes.modal), true); assert.equal(h.document.activeElement, h.child);
  assert.equal(source.promise.status, 'pending'); await h.forceClose(source.handle); await drain();
  assert.equal(source.promise.settlements, 1); assert.equal(presentation.restore(), false); h.noEffects();
});

test('pending actual dismissal rejects suspension and a declined decision leaves the same owner eligible afterwards', async t => {
  const decision = deferred(), h = fixture(t), source = h.open({beforeDismiss: () => decision.promise});
  const dismiss = source.handle.dismiss('back'); await drain(); assert.deepEqual(h.events, [['beforeDismiss', 'back']]);
  assert.equal(source.handle.suspendPresentation(), false); assert.equal(source.promise.status, 'pending'); assert.equal(h.foreground(), source.owner);
  decision.resolve(false); assert.equal(await dismiss, false); await drain();
  const presentation = source.handle.suspendPresentation(); assert.ok(presentation); assert.equal(h.foreground(), null);
  assert.equal(presentation.restore(), true); retained(h, source); assert.equal(h.events.length, 1); h.noEffects();
});

for (const competitor of ['legacy show', 'React open']) test(`suspended actual React form retains sole admission against competing ${competitor}`, async t => {
  const h = fixture(t), source = h.open(), presentation = source.handle.suspendPresentation(); assert.ok(presentation);
  let mounts = 0, rejected = 0; const anchor = h.document.createElement('button'); h.document.body.append(anchor); t.after(() => anchor.remove());
  const options = {title: 'Must not replace original', pageId: 'competing-native', anchor,
    onMount() {mounts++;}, onAdmissionRejected() {rejected++;}};
  assert.equal(source.owner.anchor, undefined, 'accepted React API has no anchor forwarding');
  if (competitor === 'legacy show') assert.equal(h.owner('showAppFormDialog')(options), source.handle.promise);
  else assert.throws(() => h.owner('openReactFormDialog')(options), /The form dialog is unavailable/);
  await drain(); suspended(h, source); assert.equal(mounts, 0); assert.equal(rejected, competitor === 'React open' ? 1 : 0);
  assert.equal(presentation.restore(), true); retained(h, source);
});

for (const eventKind of ['Escape', 'Tab', 'Shift-Tab', 'backdrop', 'cancel', 'header-close']) test(`actual suspended native ${eventKind} handler cannot dismiss parent or steal child focus`, async t => {
  const h = fixture(t), source = h.open(), presentation = source.handle.suspendPresentation(); assert.ok(presentation); h.child.focus();
  let event;
  if (eventKind === 'Escape' || eventKind.includes('Tab')) {
    event = h.dispatch(source.nodes.modal, 'keydown', {key: eventKind === 'Escape' ? 'Escape' : 'Tab', shiftKey: eventKind === 'Shift-Tab'});
    assert.equal(event.defaultPrevented, false, 'suspended parent does not intercept the foreground key');
  } else if (eventKind === 'backdrop') {h.dispatch(source.nodes.modal, 'pointerdown'); h.dispatch(source.nodes.modal, 'click');}
  else h.dispatch(h.get(eventKind === 'cancel' ? 'cancel' : 'close'), 'click');
  await drain(); suspended(h, source); assert.equal(h.document.activeElement, h.child); assert.equal(presentation.restore(), true);
});

test('queued real form focus observer preserves foreground child and does not remount original controls while suspended', async t => {
  const h = fixture(t), source = h.open(), focusCalls = [], original = source.nodes.input.focus;
  source.nodes.input.focus = function (...args) {focusCalls.push(args); return original.apply(this, args);};
  source.nodes.content.focus(); const added = h.document.createElement('button'); added.textContent = 'Late original commit'; source.nodes.host.append(added);
  const presentation = source.handle.suspendPresentation(); assert.ok(presentation); h.child.focus(); await drain();
  suspended(h, source); assert.equal(h.document.activeElement, h.child); assert.equal(focusCalls.length, 0);
  assert.equal(added.parentNode, source.nodes.host); assert.equal(presentation.restore(), true); retained(h, source);
});

for (const flag of ['hidden', 'inert']) test(`ordinary ${flag} DOM without an owned suspension does not suppress real native foreground routing`, async t => {
  const h = fixture(t), source = h.open(); source.nodes.modal[flag] = true;
  assert.equal(h.foreground(), source.owner); assert.equal(h.mobileForeground(), source.owner); assert.equal(source.owner.isActive(), true);
  assert.equal(source.promise.status, 'pending'); source.nodes.modal[flag] = false; h.noEffects();
});

test('actual mobile replacement dispatcher routes to Settings child while suspended and back to the same form after restoration', async t => {
  const h = fixture(t), source = h.open(), nav = h.c.AlbumHavenSettingsNavigation.instance, trace = [];
  assert.ok(nav); const unregister = nav.setPlaylistDraftOwner({token: 'companion-child', scopeKey: 'companion-scope', isCurrent: () => true,
    confirmLeave() {trace.push('child-confirm'); return false;}, discard() {trace.push('child-discard');}});
  assert.equal(typeof unregister, 'function'); t.after(unregister);
  const presentation = source.handle.suspendPresentation(); assert.ok(presentation);
  assert.equal(await h.owner('deferAppFormPageReplacement')(() => {trace.push('navigate'); return true;}), false);
  assert.deepEqual(trace, ['child-confirm']); suspended(h, source);
  assert.equal(presentation.restore(), true);
  assert.equal(await h.owner('deferAppFormPageReplacement')(() => {trace.push('navigate'); return true;}), false);
  assert.deepEqual(trace, ['child-confirm']); assert.deepEqual(h.events, [['beforeDismiss', 'replace']]);
  retained(h, source); h.noEffects();
});

test('accepted Settings child departure retires presentation then explicitly disposes the native source once without parent navigation', async t => {
  const h = fixture(t), trace = [], source = h.open({onClose() {trace.push('source-close');}}), nav = h.c.AlbumHavenSettingsNavigation.instance;
  const unregister = nav.setPlaylistDraftOwner({token: 'external-companion-child', scopeKey: 'companion-scope', isCurrent: () => true,
    confirmLeave() {trace.push('child-confirm'); return true;}, discard() {trace.push('child-discard');}});
  assert.equal(typeof unregister, 'function'); t.after(unregister);
  const presentation = source.handle.suspendPresentation(); assert.ok(presentation); const history = structuredClone(h.entries), url = h.location.href;
  assert.equal(await h.owner('deferAppFormPageReplacement')(() => {
    trace.push('source-retire'); presentation.retire(); assert.equal(source.promise.status, 'pending');
    return h.forceClose(source.handle);
  }), true); await drain();
  assert.deepEqual(trace, ['child-confirm', 'child-discard', 'source-retire', 'source-close']);
  assert.equal(h.active(), null); assert.equal(source.promise.settlements, 1); assert.equal(presentation.restore(), false);
  assert.equal(h.events.filter(row => row[0] === 'beforeDismiss').length, 0);
  assert.deepEqual(h.entries, history); assert.equal(h.location.href, url); h.noEffects();
});

test('ordinary unsuspended native Escape still uses the original dismissal guard and focus trap', async t => {
  const h = fixture(t), source = h.open(); source.nodes.last.focus();
  const tab = h.dispatch(source.nodes.modal, 'keydown', {key: 'Tab'}); assert.equal(tab.defaultPrevented, true);
  assert.equal(h.document.activeElement, h.get('close'), 'existing visible header-close is first in the native trap');
  const escape = h.dispatch(source.nodes.modal, 'keydown', {key: 'Escape'}); assert.equal(escape.defaultPrevented, true); await drain();
  assert.deepEqual(h.events, [['beforeDismiss', 'escape']]); retained(h, source); h.noEffects();
});

for (const accepted of [false, true]) test(`ordinary legacy same-anchor toggle remains ${accepted ? 'accepted' : 'cancelled'} without admitting competing content`, async t => {
  const h = fixture(t), anchor = h.opener, asks = []; let controls, mounts = 0;
  const promise = h.owner('showAppFormDialog')({title: 'Legacy anchored', pageId: 'legacy-anchored', anchor,
    beforeDismiss(reason) {asks.push(reason); return accepted;}, onMount(_host, owner) {controls = owner; mounts++;}});
  const owner = h.active(), observed = observe(promise);
  t.after(() => controls.close(null, {force: true, restoreFocus: false, returnToParent: false}));
  assert.equal(owner.anchor, anchor);
  assert.equal(h.owner('showAppFormDialog')({title: 'Rejected competing title', anchor, onMount() {mounts++;}}), promise);
  await drain(); assert.deepEqual(asks, ['cancel']); assert.equal(mounts, 1);
  assert.equal(observed.status, accepted ? 'resolved' : 'pending'); assert.equal(h.active(), accepted ? null : owner); h.noEffects();
});

test('ordinary legacy pending submit keeps its original busy dismissal semantics without claiming suspended-handle coverage', async t => {
  const h = fixture(t), submitted = deferred(), asks = []; let controls, submissions = 0;
  const promise = h.owner('showAppFormDialog')({title: 'Legacy submit owner', pageId: 'legacy-submit', beforeDismiss(reason) {asks.push(reason); return true;},
    onSubmit() {submissions++; return submitted.promise;}, onMount(_host, owner) {controls = owner;}}), observed = observe(promise);
  t.after(() => {submitted.resolve('submitted'); return controls.close(null, {force: true, restoreFocus: false, returnToParent: false});});
  h.dispatch(h.get('submit'), 'click'); await drain(); assert.equal(submissions, 1); assert.equal(h.get('submit').disabled, true);
  assert.equal(await controls.dismiss('cancel'), false); assert.deepEqual(asks, []); assert.equal(observed.status, 'pending');
  h.dispatch(h.get('submit'), 'click'); assert.equal(submissions, 1); submitted.resolve('submitted'); await drain();
  assert.equal(observed.status, 'resolved'); assert.equal(observed.value, 'submitted'); assert.equal(observed.settlements, 1); assert.equal(h.active(), null); h.noEffects();
});
