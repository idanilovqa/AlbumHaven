'use strict';
// Four additive owner-reuse regressions. Real integration fixture/owners are
// unchanged. No helper, registration, currentness or fresh-source admission is
// synthesized; the one tap delegates an already supplied actual presentation.
const test = require('node:test'), assert = require('node:assert/strict');
const {topOwner, modalOwner, A} = require('./sample-origin-integration-fixture.cjs');
const {observe} = require('./sample-origin-native-form-companion-fixture.cjs');
const semantics = node => ({inert: node.inert, aria: node.getAttribute('aria-hidden')});
const presentationState = node => ({hidden: node.hidden, inert: node.inert, aria: node.getAttribute('aria-hidden'), display: node.style.display});
function interactive(h, node, original) {
  assert.equal(node.isConnected, true); assert.equal(h.hidden(node), false); assert.equal(h.inactive(node), false);
  assert.deepEqual(semantics(node), original, 'fresh owner retains the root\'s original non-suspended inert/ARIA semantics');
}
function observeAcquisition(t, h) {
  const open = h.runtime.openDraft, captures = [];
  h.runtime.openDraft = function (input) {
    const actual = input.presentation;
    assert.equal(typeof actual?.suspend, 'function', 'the initiating source supplied its real presentation port');
    // Observation only: original receiver/arguments and exact returned handle.
    // The facade and source have already admitted and forwarded this real port.
    // No fallback port, suspension implementation or permission is supplied.
    return open.call(this, {...input, presentation: {suspend(...args) {
      const handle = actual.suspend.apply(actual, args);
      captures.push({actual, handle, guard: input.isCurrent, token: input.token});
      return handle;
    }}});
  };
  t.after(() => {h.runtime.openDraft = open;});
  return captures;
}
function spentCannotMutate(h, old, surfaces, current = null) {
  const flags = surfaces.map(presentationState), children = surfaces.map(node => [...node.childNodes]);
  const focus = h.document.activeElement, history = [...h.history.traversals], count = h.calls.draft.length;
  const modalCounts = h.counts && {...h.counts};
  assert.equal(old.guard(), false, 'retired Sample authority never revives for a new source');
  assert.equal(old.handle.restore(), false); old.handle.retire(); old.handle.retire();
  assert.ok(!old.actual.suspend(), 'spent original source port cannot acquire the newer root');
  assert.equal(old.guard(), false);
  surfaces.forEach((node, index) => {assert.deepEqual(presentationState(node), flags[index]); assert.deepEqual([...node.childNodes], children[index]);});
  assert.equal(h.document.activeElement, focus); assert.deepEqual(h.history.traversals, history); assert.equal(h.calls.draft.length, count);
  if (modalCounts) assert.deepEqual(h.counts, modalCounts, 'spent handle cannot reopen, close, prepare or fetch the new modal');
  if (current) assert.equal(current.guard(), true, 'old cleanup cannot retire the newer admitted child');
}
async function depart(h, surfaces) {
  let departures = 0;
  assert.equal(await h.nav.deferCollectionDraftNavigation(() => {
    departures++;
    for (const root of surfaces) assert.equal(h.hidden(root), true, 'retirement itself must not reveal old content before external navigation');
    h.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}, selected_artist: 'Artist A'};
    h.nav.writeLibraryHistory('/?surface=albums', {...h.c.history.state}, {mode: 'replace'});
    return true;
  }), true);
  h.actual?.sync(); h.runtime.sync(); await h.settle();
  assert.equal(departures, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  for (const root of surfaces) assert.equal(h.hidden(root), true, 'retired root remains unpainted until a real owner opens it');
  assert.deepEqual(h.history.traversals, [], 'retirement is not parent-return navigation');
}
async function selectDraftAlbum(h, form, name) {
  const title = form.querySelector('[aria-label="Album Top name"]'); h.input(title, name);
  h.click(h.named('Find albums', form)); await h.settle(); h.input(form.querySelector('input[type="search"]'), 'Picked'); await h.settle();
  h.click(form.querySelector('[data-gallery-card-intent="select"]')); await h.settle(); return title;
}
function activeChild(h, captures, expected) {
  assert.equal(h.calls.draft.length, expected); assert.equal(captures.length, expected);
  const next = captures.at(-1); assert.ok(next.handle); assert.equal(next.guard(), true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, next.token); assert.ok(h.named('Generate', h.host)); return next;
}

for (const mode of ['saved', 'detached']) test(`retired ${mode} Top presentation permits genuine fresh reuse without leaked inert ARIA or old authority`, async t => {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await topOwner(t, {mode, providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  const captures = observeAcquisition(t, h), topRoot = h.topHost, topSemantics = semantics(topRoot);
  let oldNative = null, oldClosed = null, nativeRoot = null, nativeSemantics = null;
  if (mode === 'detached') {
    await selectDraftAlbum(h, h.form, 'Old unsaved form'); oldNative = h.owner('activeAppFormDialog'); assert.ok(oldNative);
    oldClosed = observe(oldNative.promise); nativeRoot = h.sourceSurface; nativeSemantics = semantics(nativeRoot);
  }
  const roots = nativeRoot ? [topRoot, nativeRoot] : [topRoot];
  h.click(h.sourceButton()); await h.settle(); const old = activeChild(h, captures, 1);
  assert.equal(h.hidden(topRoot), true); assert.equal(topRoot.inert, true); assert.equal(topRoot.getAttribute('aria-hidden'), 'true');
  await depart(h, roots); assert.equal(old.guard(), false);
  if (oldNative) {assert.equal(oldNative.isActive(), false); assert.equal(oldClosed.status, 'resolved'); assert.equal(oldClosed.settlements, 1);}
  spentCannotMutate(h, old, roots);

  // Fresh native shell input and provider response, through the existing runtime
  // subscriber/index/controller. No direct DOM flag reset or reconstructed view.
  h.svc.data.detail = {...h.svc.data.detail, top_ref: A.T.OTHER, title: 'Fresh admitted Top', revision: '8'};
  h.state.view = {...h.sourceView, top_ref: mode === 'saved' ? A.T.OTHER : null};
  h.nav.writeLibraryHistory(`/?surface=album_tops${mode === 'saved' ? `&top_ref=${A.T.OTHER}` : ''}`, {...h.c.history.state}, {mode: 'replace'});
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(h.document.getElementById('album-tops-root'), topRoot); interactive(h, topRoot, topSemantics);
  let freshControl, freshForm = null, freshNative = null, freshClosed = null, freshTitle = null;
  if (mode === 'saved') {
    assert.equal(h.actual.snapshot().topRef, A.T.OTHER); assert.match(topRoot.textContent, /Fresh admitted Top/);
    freshControl = h.named('Create sample playlist', topRoot);
  } else {
    // This real control on the reused Top host must open a new actual native
    // owner on the same native modal root, not revive the disposed old form.
    h.click(h.named('Create Album Top', topRoot)); await h.settle();
    freshForm = h.document.querySelector('form[aria-label="Create Album Top"]'); assert.ok(freshForm); assert.notEqual(freshForm, h.form);
    freshNative = h.owner('activeAppFormDialog'); assert.ok(freshNative); assert.notEqual(freshNative, oldNative);
    freshClosed = observe(freshNative.promise); assert.equal(h.document.getElementById('app-form-modal'), nativeRoot);
    interactive(h, nativeRoot, nativeSemantics); freshTitle = await selectDraftAlbum(h, freshForm, 'Fresh unsaved form');
    freshControl = h.named('Create sample playlist', freshForm);
  }
  spentCannotMutate(h, old, roots); assert.ok(freshControl); assert.equal(freshControl.disabled, false);
  assert.equal(freshControl.closest('[hidden],[inert],[aria-hidden="true"]'), null);
  h.click(freshControl); await h.settle(); const current = activeChild(h, captures, 2);
  assert.equal(h.hidden(topRoot), true); assert.equal(topRoot.inert, true); assert.equal(topRoot.getAttribute('aria-hidden'), 'true');
  spentCannotMutate(h, old, roots, current); // Must not clear the newer suspension's flags/listeners/owner.
  h.click(h.named('Back', h.host)); await h.settle(); interactive(h, topRoot, topSemantics);
  assert.deepEqual(h.history.traversals, [-1], 'only the fresh child performs its legitimate Back traversal');
  if (freshNative) {
    assert.equal(h.owner('activeAppFormDialog'), freshNative); assert.equal(freshNative.isActive(), true); assert.equal(freshClosed.status, 'pending');
    assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'), freshForm); assert.equal(freshTitle.value, 'Fresh unsaved form');
    interactive(h, nativeRoot, nativeSemantics); assert.equal(oldClosed.settlements, 1); assert.equal(oldNative.isActive(), false);
  }
  spentCannotMutate(h, old, roots); h.noWrites(h.svc, mode === 'detached' ? 2 : 0);
});

for (const kind of ['physical', 'loose']) test(`retired ${kind} modal presentation permits fresh canonical reopen and a real control on the same root`, async t => {
  const h = await modalOwner(t, {kind}), captures = observeAcquisition(t, h), root = h.sourceSurface, original = semantics(root);
  const oldAlbum = h.retainedAlbum, oldPrepared = kind === 'loose' ? h.owner('nonAlbumSampleOwner') : null;
  const capture = kind === 'loose' ? 'captureNonAlbumSampleOrigin' : 'captureTrackModalSampleOrigin';
  const oldLease = h.c[capture]({libraryRef: h.owner('TrackActionsRuntime').scope().library}); assert.ok(oldLease);
  h.click(h.sourceButton()); await h.settle(); const old = activeChild(h, captures, 1);
  await depart(h, [root]); assert.equal(oldLease.isCurrent(), false); spentCannotMutate(h, old, [root]);
  const before = {...h.counts}, freshRef = 'inventory-track:5:777';
  h.state.view = {...h.sourceView, non_album_tracks: [A.row(freshRef, {exception_type: 'Non-album rarity', title: 'Fresh canonical row'})]};
  h.nav.writeLibraryHistory('/?surface=albums', {...h.c.history.state}, {mode: 'replace'});
  if (kind === 'physical') {
    const fresh = A.album({key: 'beta', request_key: 'actual:beta', name: 'Fresh canonical album', tracks: [A.row(freshRef)]});
    h.state.gallery.albumIndex.set('beta', fresh);
    h.c.openTrackModal(fresh, {releaseSet: {releases: [fresh], selectedIndex: 0},
      presentationRestrictions: {can_open_album_page: true, can_play_album: false, can_view_artwork: false}});
  } else h.c.openNonAlbumModal();
  await h.settle(); assert.equal(h.document.getElementById(kind === 'loose' ? 'non-album-modal' : 'track-modal'), root);
  interactive(h, root, original); assert.equal(h.counts.opens, before.opens + 1); assert.ok(h.counts.prepares > before.prepares);
  if (kind === 'physical') {assert.notEqual(h.c.getCurrentTrackModalAlbum(), oldAlbum); assert.equal(h.c.getAlbumRequestKey(h.c.getCurrentTrackModalAlbum()), 'beta');}
  else {assert.notEqual(h.owner('nonAlbumSampleOwner'), oldPrepared); assert.ok(h.owner('nonAlbumSampleOwner').source.snapshot());}
  const freshLease = h.c[capture]({libraryRef: h.owner('TrackActionsRuntime').scope().library}); assert.ok(freshLease);
  assert.deepEqual(Array.from(freshLease.origin.track_refs), [freshRef]); assert.equal(freshLease.isCurrent(), true); assert.equal(oldLease.isCurrent(), false);
  spentCannotMutate(h, old, [root]);
  const control = h.sourceButton(); assert.ok(control); assert.equal(control.disabled, false); assert.equal(control.closest('[hidden],[inert],[aria-hidden="true"]'), null);
  h.click(control); await h.settle(); const current = activeChild(h, captures, 2);
  assert.equal(h.hidden(root), true); assert.equal(root.inert, true); assert.equal(root.getAttribute('aria-hidden'), 'true');
  spentCannotMutate(h, old, [root], current);
  h.click(h.named('Back', h.host)); await h.settle(); interactive(h, root, original);
  assert.deepEqual(h.history.traversals, [-1]); assert.equal(h.counts.opens, before.opens + 1, 'ordinary fresh Back does not reconstruct either modal');
  assert.equal(h.counts.closes, before.closes); assert.equal(h.counts.fetches, 0); assert.equal(oldLease.isCurrent(), false);
  spentCannotMutate(h, old, [root]); h.noWrites();
});
