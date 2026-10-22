'use strict';
// Two additive regressions for distinct real presentation owners. No product
// owner, admission, source port or suspension handle is fabricated here.
const test = require('node:test'), assert = require('node:assert/strict');
const {topOwner, modalOwner, A} = require('./sample-origin-integration-fixture.cjs');
const flags = node => ({inert: node.inert, aria: node.getAttribute('aria-hidden')});
const presentation = node => ({hidden: node.hidden, display: node.style.display, ...flags(node)});
function observeAcquisition(t, h) {
  const open = h.runtime.openDraft, captures = [];
  h.runtime.openDraft = function (input) {
    const actual = input.presentation;
    assert.equal(typeof actual?.suspend, 'function', 'the real source supplied its own admitted port');
    return open.call(this, {...input, presentation: {suspend(...args) {
      // Transparent observation after facade admission: original receiver and
      // arguments, exact returned actual handle, no fallback or added authority.
      const handle = actual.suspend.apply(actual, args);
      captures.push({actual, handle, guard: input.isCurrent, token: input.token});
      return handle;
    }}});
  };
  t.after(() => {h.runtime.openDraft = open;}); return captures;
}
function child(h, captures, count) {
  assert.equal(h.calls.draft.length, count); assert.equal(captures.length, count);
  const captured = captures.at(-1); assert.ok(captured.handle); assert.equal(captured.guard(), true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, captured.token); assert.ok(h.named('Generate', h.host)); return captured;
}
function failedRestore(h, old, root, original) {
  const nodes = [...root.childNodes], focus = h.document.activeElement;
  const history = [...h.history.traversals], counts = h.counts && {...h.counts};
  // The caller has changed a legitimate source/context input. Do not synchronize,
  // inspect the destination guard or call retire before this actual restore:
  // any of those could hide the failed-restore path behind proactive cleanup.
  assert.equal(old.handle.restore(), false);
  assert.equal(root.hidden, true, 'failed restoration must not reveal obsolete content');
  assert.deepEqual(flags(root), original, 'failed restore itself must relinquish its owned inert/ARIA writes');
  assert.deepEqual([...root.childNodes], nodes); assert.equal(h.document.activeElement, focus);
  assert.deepEqual(h.history.traversals, history); if (counts) assert.deepEqual(h.counts, counts);
  // A later retire cannot be the repair: the preceding checks already required
  // cleanup before this consumed one-shot handle is touched a second time.
  old.handle.retire(); assert.equal(old.handle.restore(), false);
  assert.equal(root.hidden, true); assert.deepEqual(flags(root), original);
}
function spentCannotMutate(h, old, root, current = null) {
  const before = presentation(root), nodes = [...root.childNodes], focus = h.document.activeElement;
  const history = [...h.history.traversals], drafts = h.calls.draft.length, counts = h.counts && {...h.counts};
  assert.equal(old.guard(), false); assert.equal(old.handle.restore(), false);
  old.handle.retire(); old.handle.retire(); assert.ok(!old.actual.suspend());
  assert.deepEqual(presentation(root), before); assert.deepEqual([...root.childNodes], nodes);
  assert.equal(h.document.activeElement, focus); assert.deepEqual(h.history.traversals, history);
  assert.equal(h.calls.draft.length, drafts); if (counts) assert.deepEqual(h.counts, counts);
  if (current) assert.equal(current.guard(), true, 'old cleanup must not retire a newer child');
}
function interactive(h, root, original) {
  assert.equal(root.isConnected, true); assert.equal(h.hidden(root), false); assert.equal(h.inactive(root), false);
  assert.deepEqual(flags(root), original);
}
async function freshControlAndBack(h, captures, old, root, original, control) {
  interactive(h, root, original); spentCannotMutate(h, old, root);
  assert.ok(control); assert.equal(control.disabled, false); assert.equal(control.closest('[hidden],[inert],[aria-hidden="true"]'), null);
  h.click(control); await h.settle(); const current = child(h, captures, 2);
  assert.equal(root.hidden, true); assert.equal(root.inert, true); assert.equal(root.getAttribute('aria-hidden'), 'true');
  spentCannotMutate(h, old, root, current);
  h.click(h.named('Back', h.host)); await h.settle(); interactive(h, root, original);
  assert.deepEqual(h.history.traversals, [-1], 'only the fresh child performs its genuine Back');
  spentCannotMutate(h, old, root);
}

test('actual Top failed restore cleans its hidden owned root before lawful fresh source reuse', async t => {
  const h = await topOwner(t, {mode: 'saved'}), root = h.topHost, original = flags(root), captures = observeAcquisition(t, h);
  h.click(h.sourceButton()); await h.settle(); const old = child(h, captures, 1);
  assert.equal(root.hidden, true); assert.equal(root.inert, true); assert.equal(root.getAttribute('aria-hidden'), 'true');
  // Actual shell source input loses the captured view identity. No private
  // sampleSuspension/settled flag, presentation flag or currentness function is changed.
  h.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}, selected_artist: 'Artist A'};
  failedRestore(h, old, root, original);
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(old.guard(), false); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(root.hidden, true); assert.deepEqual(h.history.traversals, []);

  h.svc.data.detail = {...h.svc.data.detail, top_ref: A.T.OTHER, title: 'Fresh Top after failed restore', revision: '8'};
  h.state.view = {...h.sourceView, top_ref: A.T.OTHER};
  h.nav.writeLibraryHistory(`/?surface=album_tops&top_ref=${A.T.OTHER}`, {...h.c.history.state}, {mode: 'replace'});
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(h.document.getElementById('album-tops-root'), root); assert.equal(h.actual.snapshot().topRef, A.T.OTHER);
  assert.match(root.textContent, /Fresh Top after failed restore/);
  await freshControlAndBack(h, captures, old, root, original, h.named('Create sample playlist', root));
  h.noWrites(h.svc);
});

test('actual modal failed restore cleans its hidden owned root before fresh canonical admission', async t => {
  const h = await modalOwner(t, {kind: 'physical'}), root = h.sourceSurface, original = flags(root), captures = observeAcquisition(t, h);
  const oldAlbum = h.retainedAlbum, library = h.shell.dataset.nativeLibraryId;
  assert.equal(library, '5');
  const oldLease = h.c.captureTrackModalSampleOrigin({libraryRef: library}); assert.ok(oldLease);
  h.click(h.sourceButton()); await h.settle(); const old = child(h, captures, 1);
  assert.equal(root.hidden, true); assert.equal(root.inert, true); assert.equal(root.getAttribute('aria-hidden'), 'true');
  // The actual TrackActions owner derives its opaque token from this existing
  // shell identity input. Do not replace the canonical lease or private modal owner.
  h.shell.dataset.nativeLibraryId = '6';
  failedRestore(h, old, root, original);
  assert.equal(oldLease.isCurrent(), false); h.runtime.sync(); await h.settle();
  assert.equal(old.guard(), false); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(root.hidden, true); assert.deepEqual(h.history.traversals, []);

  h.shell.dataset.nativeLibraryId = library; h.state.view = {...h.sourceView};
  h.nav.writeLibraryHistory('/?surface=albums', {...h.c.history.state}, {mode: 'replace'}); h.runtime.sync();
  const before = {...h.counts}, ref = 'inventory-track:5:778';
  const fresh = A.album({key: 'gamma', request_key: 'actual:gamma', name: 'Fresh canonical owner after failed restore', tracks: [A.row(ref)]});
  h.state.gallery.albumIndex.set('gamma', fresh);
  h.c.openTrackModal(fresh, {releaseSet: {releases: [fresh], selectedIndex: 0},
    presentationRestrictions: {can_open_album_page: true, can_play_album: false, can_view_artwork: false}});
  await h.settle(); assert.equal(h.document.getElementById('track-modal'), root);
  assert.notEqual(h.c.getCurrentTrackModalAlbum(), oldAlbum); assert.equal(h.c.getAlbumRequestKey(h.c.getCurrentTrackModalAlbum()), 'gamma');
  const freshLease = h.c.captureTrackModalSampleOrigin({libraryRef: library}); assert.ok(freshLease);
  assert.deepEqual(Array.from(freshLease.origin.track_refs), [ref]); assert.equal(freshLease.isCurrent(), true); assert.equal(oldLease.isCurrent(), false);
  await freshControlAndBack(h, captures, old, root, original, h.sourceButton());
  assert.equal(h.counts.opens, before.opens + 1); assert.ok(h.counts.prepares > before.prepares);
  assert.equal(h.counts.closes, before.closes); assert.equal(h.counts.fetches, 0); assert.equal(oldLease.isCurrent(), false);
  h.noWrites();
});
