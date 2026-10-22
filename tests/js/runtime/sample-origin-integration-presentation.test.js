'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {topOwner, modalOwner, A} = require('./sample-origin-integration-fixture.cjs');
async function prepareTop(t, mode) {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await topOwner(t, {mode, providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  const title = h.form?.querySelector('[aria-label="Album Top name"]');
  if (title) h.input(title, 'Exact unsaved parent title');
  if (mode === 'detached') {
    h.click(h.named('Find albums', h.form)); await h.settle();
    h.input(h.form.querySelector('input[type="search"]'), 'Picked'); await h.settle();
    h.click(h.form.querySelector('[data-gallery-card-intent="select"]')); await h.settle();
  }
  return {...h, title, admitted: mode === 'detached' ? 1 : 0};
}
function snapshotSource(h) {
  return {view: h.state.view, title: h.document.title, source: h.sourceSurface,
    form: h.form, input: h.title, value: h.title?.value, sourceButton: h.sourceButton(), history: h.history.mark()};
}
function retainedSource(h, before) {
  assert.equal(h.state.view, before.view, 'source view is retained, not replaced with a destination payload');
  assert.equal(h.sourceSurface, before.source); assert.equal(before.source.isConnected, true);
  if (before.form) {assert.equal(h.document.querySelector(`form[aria-label="${before.form.getAttribute('aria-label')}"]`), before.form);
    assert.equal(before.form.querySelector('[aria-label="Album Top name"]'), before.input); assert.equal(before.input.value, before.value);}
}
for (const mode of ['saved', 'inline', 'detached']) test(`actual ${mode} Top transfers only presentation to Sample and restores exact retained owner`, async t => {
  const h = await prepareTop(t, mode), before = snapshotSource(h); h.sameGlobalState();
  assert.equal(h.actual.snapshot().visible, true);
  if (mode === 'inline') {assert.equal(h.registrations.length, 1); assert.equal(typeof h.registrations[0].handle, 'function');}
  before.sourceButton.focus();
  h.click(before.sourceButton); await h.settle(); h.assertSetup();
  assert.equal(h.hidden(before.source), true, 'only Sample is painted'); assert.equal(h.inactive(before.source), true);
  assert.equal(h.actual.snapshot().visible, false); assert.equal(h.actual.acceptsPrivateScope(h.sourceScope), true);
  retainedSource(h, before); h.noWrites(h.svc, h.admitted);
  assert.equal(h.calls.draft[0].parentRegistration, mode === 'inline' ? h.registrations[0].handle : null);
  if (mode !== 'detached') {assert.equal(h.calls.draft[0].presentation, h.captures.at(-1).presentation);
    assert.equal(h.calls.draft[0].parentRegistration, h.captures.at(-1).parentRegistration);}
  if (mode === 'inline') assert.deepEqual(h.events, [], 'retaining Top did not discard/unregister it');
  before.sourceButton.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true})); await h.settle();
  assert.equal(h.calls.draft.length, 1, 'suspended initiating control cannot create a second child');
  const focusTarget = h.named('Back', h.host);
  assert.equal(focusTarget.disabled, false); assert.equal(focusTarget.closest('[hidden],[inert]'), null);
  focusTarget.focus(); assert.equal(h.document.activeElement, focusTarget, 'establish real Sample focus before testing the source trap');
  focusTarget.dispatchEvent(new h.c.Event('keydown', {key: 'Tab', bubbles: true}));
  assert.equal(before.source.contains(h.document.activeElement), false, 'retained source focus trap cannot steal Sample focus');
  h.click(h.named('Back', h.host)); await h.settle();
  retainedSource(h, before); assert.equal(h.hidden(before.source), false); assert.equal(h.inactive(before.source), false);
  assert.equal(h.actual.snapshot().visible, true); assert.equal(h.history.index(), before.history.index);
  assert.equal(h.c.location.href, before.history.url); assert.deepEqual(h.history.traversals, [-1]);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); h.noWrites(h.svc, h.admitted);
  if (mode === 'inline') {assert.deepEqual(h.events, []); assert.equal(h.nav.setPlaylistDraftOwner({token: 'foreign', scopeKey: 'scope', isCurrent: () => true, confirmLeave: () => true, discard() {}}), false);}
});
for (const mode of ['inline', 'detached']) test(`actual ${mode} Top failed history commit restores form and parent admission without destructive cleanup`, async t => {
  const h = await prepareTop(t, mode), before = snapshotSource(h), push = h.c.history.pushState;
  let injected = 0;
  h.c.history.pushState = function (state, title, url) {if (state?.playlistDraft) {injected++; throw new Error('injected history commit failure');} return push.call(this, state, title, url);};
  try {h.click(before.sourceButton);} catch (error) {assert.match(error.message, /injected history commit failure/);}
  await h.settle(); assert.equal(injected, 1, 'failure is after actual child registration/presentation transfer');
  retainedSource(h, before); assert.equal(h.hidden(before.source), false); assert.equal(h.inactive(before.source), false);
  assert.equal(h.c.location.href, before.history.url); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.deepEqual(h.events, []); h.noWrites(h.svc, h.admitted);
  h.c.history.pushState = push; h.click(before.sourceButton); await h.settle();
  assert.ok(h.named('Generate', h.host), 'failed child left the same source admissible');
  assert.equal(h.calls.draft.length, 2); assert.equal(h.hidden(before.source), true);
});
for (const reason of ['source view', 'private scope', 'host removal']) test(`actual retained Top ${reason} replacement retires Sample authority without restoring an obsolete parent`, async t => {
  const h = await prepareTop(t, 'inline'), before = snapshotSource(h);
  h.click(before.sourceButton); await h.settle(); h.assertSetup();
  const sourceGuard = h.calls.draft[0].isCurrent;
  if (reason === 'source view') h.state.view = {...h.state.view};
  else if (reason === 'private scope') h.shell.dataset.nativeLibraryId = '6';
  else h.topHost.remove();
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(sourceGuard(), false); assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.deepEqual(h.history.traversals, []); assert.equal(h.named('Generate', h.host), undefined);
  h.state.view = before.view; h.shell.dataset.nativeLibraryId = '5';
  assert.equal(sourceGuard(), false, 'original authority never revives'); h.noWrites(h.svc, h.admitted);
});
for (const kind of ['physical', 'duplicate', 'loose']) test(`actual ${kind} modal shares destination state and suspends exact surface without reopen or owner retirement`, async t => {
  const h = await modalOwner(t, {kind}), source = h.sourceSurface, button = h.sourceButton(), view = h.state.view;
  const nodes = [...source.childNodes], initial = {...h.counts}, mark = h.history.mark();
  assert.ok(button); button.focus(); h.sameGlobalState(); h.click(button); await h.settle(); h.assertSetup();
  assert.equal(h.state.view, view); assert.equal(h.hidden(source), true); assert.equal(h.inactive(source), true); h.assertRetained();
  assert.equal(h.calls.draft[0].parentRegistration, null);
  assert.deepEqual(h.counts, initial, 'presentation handoff cannot close/reopen/reprepare/fetch');
  const back = h.named('Back', h.host); back.focus();
  const escape = new h.c.Event('keydown', {key: 'Escape', bubbles: true, cancelable: true}); h.document.dispatchEvent(escape); await h.settle();
  assert.equal(h.counts.closes, initial.closes, 'suspended modal dismissal does not run over Sample');
  h.document.dispatchEvent(new h.c.Event('keydown', {key: 'Tab', bubbles: true}));
  assert.equal(source.contains(h.document.activeElement), false);
  h.click(back); await h.settle(); h.assertRetained();
  assert.equal(h.hidden(source), false); assert.equal(h.inactive(source), false); assert.deepEqual([...source.childNodes], nodes);
  assert.equal(h.c.location.href, mark.url); assert.equal(h.history.index(), mark.index); assert.deepEqual(h.history.traversals, [-1]);
  assert.deepEqual(h.counts, initial); h.noWrites();
});
for (const kind of ['physical', 'duplicate', 'loose']) test(`actual ${kind} failed launch rolls presentation back without changing canonical owner`, async t => {
  const h = await modalOwner(t, {kind}), source = h.sourceSurface, initial = {...h.counts}, mark = h.history.mark();
  const push = h.c.history.pushState; let failed = 0;
  h.c.history.pushState = function (state, title, url) {if (state?.playlistDraft) {failed++; throw new Error('injected history commit failure');} return push.call(this, state, title, url);};
  try {h.click(h.sourceButton());} catch (error) {assert.match(error.message, /injected history commit failure/);}
  await h.settle(); assert.equal(failed, 1); h.assertRetained();
  assert.equal(h.hidden(source), false); assert.equal(h.inactive(source), false); assert.equal(h.c.location.href, mark.url);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.deepEqual(h.counts, initial); h.noWrites();
});
for (const kind of ['physical', 'loose']) test(`actual ${kind} changed canonical rows while suspended cannot be restored from stale cached presentation`, async t => {
  const h = await modalOwner(t, {kind}); h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  const guard = h.calls.draft[0].isCurrent;
  if (kind === 'physical') h.retainedAlbum.tracks.splice(0, 1);
  else h.state.view.non_album_tracks.splice(0, 1);
  assert.equal(guard(), false); h.runtime.sync(); await h.settle();
  assert.equal(h.hidden(h.sourceSurface), true); assert.deepEqual(h.history.traversals, []); assert.equal(h.counts.fetches, 0);
});
test('ordinary non-Sample modal dismissal still closes its actual presentation and retires its owner', async t => {
  const h = await modalOwner(t, {kind: 'physical'}); assert.equal(h.hidden(h.sourceSurface), false);
  h.document.dispatchEvent(new h.c.Event('keydown', {key: 'Escape', bubbles: true, cancelable: true})); await h.settle();
  assert.equal(h.hidden(h.sourceSurface), true); assert.equal(h.counts.closes, 1); assert.equal(h.calls.draft.length, 0);
});
for (const mode of ['saved', 'inline']) test(`actual ${mode} no-argument factory captures exact source host and real opaque parent handle`, async t => {
  const h = await prepareTop(t, mode), before = snapshotSource(h);
  assert.equal(typeof h.actual.captureSampleOriginNavigation, 'function');
  const local = h.actual.captureSampleOriginNavigation(); assert.ok(local);
  assert.equal(local.parentRegistration, mode === 'inline' ? h.registrations[0].handle : null);
  assert.equal(typeof local.presentation.suspend, 'function'); assert.equal(h.hidden(before.source), false);
  retainedSource(h, before); assert.equal(h.calls.draft.length, 0, 'factory capture alone has no presentation effects');
  h.click(before.sourceButton); await h.settle(); h.assertSetup();
  const captured = h.captures.at(-1); assert.ok(captured);
  assert.equal(h.calls.draft[0].presentation, captured.presentation, 'facade and mount preserve the exact initiating port');
  assert.equal(h.calls.draft[0].parentRegistration, captured.parentRegistration);
  assert.equal(h.hidden(before.source), true); assert.equal(h.state.view, before.view);
  h.noWrites(h.svc, h.admitted);
});
for (const changed of ['hidden', 'host removal', 'private scope']) test(`actual Top factory rejects ${changed} without a trusted suspension`, async t => {
  const h = await prepareTop(t, 'saved');
  if (changed === 'hidden') h.topHost.hidden = true;
  else if (changed === 'host removal') h.topHost.remove();
  else h.shell.dataset.nativeLibraryId = '';
  assert.equal(h.actual.captureSampleOriginNavigation(), null); assert.equal(h.calls.draft.length, 0); h.noWrites(h.svc);
});
test('actual inline external cancellation keeps Sample active and parent suspended until both confirmations accept', async t => {
  const h = await prepareTop(t, 'inline'), before = snapshotSource(h);
  h.click(before.sourceButton); await h.settle(); await h.generate();
  const title = h.host.querySelector('[aria-label="Playlist title"]'); assert.ok(title); assert.equal(title.disabled, false);
  h.input(title, 'Unsaved child title'); await h.settle(); assert.equal(title.value, 'Unsaved child title');
  let childAsks = 0, parentAsks = 0, accepted = false;
  h.runtime.confirmDraft = async () => {childAsks++; return true;};
  h.c.showAppConfirmDialog = () => {parentAsks++; return Promise.resolve(accepted);};
  const token = h.runtime.snapshot().retainedDraftToken;
  assert.equal(await h.nav.deferCollectionDraftNavigation(() => assert.fail('cancelled external effect')), false);
  assert.equal(childAsks, 1); assert.equal(parentAsks, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, token);
  assert.equal(h.hidden(before.source), true); retainedSource(h, before);
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 0);
  accepted = true; let departed = 0;
  assert.equal(await h.nav.deferCollectionDraftNavigation(() => {departed++; h.state.view = {surface: {active: 'albums'}}; return true;}), true);
  await h.settle(); assert.equal(departed, 1); assert.equal(childAsks, 2); assert.equal(parentAsks, 2);
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.hidden(before.source), true);
  assert.equal(h.history.traversals.length, 0); assert.equal(h.calls.save.length, 0); assert.equal(h.svc.count('execute'), 0);
});
test('actual source-page modal performs exactly its original guarded revalidated reopen with one Sample history return', async t => {
  let h, revalidatedAlbum, revalidations = 0, handoffs = 0, freshChecks = 0;
  const freshCurrent = () => {freshChecks++; return true;};
  const sourcePageOwner = {isCurrent: () => true,
    revalidate: async ({signal, albumKey}) => {
      revalidations++; assert.equal(signal?.aborted === true, false);
      assert.equal(albumKey, h.retainedAlbum.key);
      revalidatedAlbum = {...h.retainedAlbum, name: 'Revalidated source-page album'};
      return {album: revalidatedAlbum, isCurrent: freshCurrent,
        presentationRestrictions: {can_open_album_page: true, can_play_album: false, can_view_artwork: false}};
    }, retainNavigation(handoff) {handoffs++; return handoff();}};
  h = await modalOwner(t, {kind: 'physical', sourcePageOwner});
  const token = h.c.getTrackModalSourcePageToken(), release = h.retainedAlbum, sourceView = h.state.view, initial = {...h.counts};
  const originalOwner = h.c.getTrackModalSourcePageOwner(), mark = h.history.mark(), entries = h.history.entries.length;
  h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  assert.equal(h.hidden(h.sourceSurface), true); assert.equal(h.c.getTrackModalSourcePageToken(), token);
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(revalidations, 1); assert.equal(handoffs, 1); assert.ok(freshChecks > 0);
  assert.equal(h.c.getTrackModalSourcePageToken(), token);
  const currentOwner = h.c.getTrackModalSourcePageOwner(), currentAlbum = h.c.getCurrentTrackModalAlbum();
  assert.notEqual(currentOwner, originalOwner); assert.equal(currentOwner.isCurrent, freshCurrent);
  assert.equal(h.c.isTrackModalSourcePageCurrent(token, release.key), true);
  assert.equal(h.state.view, sourceView); assert.notEqual(currentAlbum, release);
  assert.equal(currentAlbum.key, revalidatedAlbum.key); assert.equal(currentAlbum.name, revalidatedAlbum.name);
  assert.equal(currentAlbum.tracks, revalidatedAlbum.tracks, 'actual refreshed renderer retains its revalidated canonical rows');
  assert.equal(h.hidden(h.sourceSurface), false); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(h.counts.opens, initial.opens + 1, 'only the existing guarded source-page restore may reopen');
  assert.ok(h.counts.prepares > initial.prepares, 'the legitimate refreshed owner may prepare its new presentation');
  assert.equal(h.counts.closes, initial.closes); assert.equal(h.counts.fetches, 0);
  assert.equal(h.history.index(), mark.index); assert.equal(h.c.location.href, mark.url);
  assert.deepEqual(h.history.traversals, [-1]); assert.equal(h.history.entries.length, entries + 1);
  assert.equal(h.calls.draft.length, 1); h.noWrites();
});
for (const malformed of ['omitted navigation', 'null presentation', 'non-callable suspend']) test(`actual facade and mount reject ${malformed} before effects or default presentation synthesis`, async t => {
  const h = await modalOwner(t, {kind: 'physical'}), source = h.sourceSurface;
  const originOwner = h.c.captureTrackModalSampleOrigin({libraryRef: h.owner('TrackActionsRuntime').scope().library});
  assert.ok(originOwner); assert.equal(originOwner.isCurrent(), true, 'otherwise lawful actual source lease');
  const before = h.history.mark(), entries = structuredClone(h.history.entries), counts = {...h.counts};
  const registrations = [], historyEffects = [];
  for (const method of ['setPlaylistDraftOwner', 'setCollectionDraftOwner']) {
    const original = h.nav[method]; assert.equal(typeof original, 'function');
    h.nav[method] = function (...args) {registrations.push(method); return original.apply(this, args);};
  }
  for (const method of ['pushState', 'replaceState', 'go']) {
    const original = h.c.history[method];
    h.c.history[method] = function (...args) {historyEffects.push(method); return original.apply(this, args);};
  }
  const input = {originOwner};
  if (malformed !== 'omitted navigation') input.originNavigation = {parentRegistration: null,
    presentation: malformed === 'null presentation' ? null : {suspend: true}};
  assert.equal(h.facade.openSamplePlaylist(input), false); await h.settle();
  assert.deepEqual(registrations, []); assert.deepEqual(historyEffects, []);
  assert.equal(h.calls.runtime.length, 0); assert.equal(h.calls.draft.length, 0);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.named('Generate', h.host), undefined);
  assert.deepEqual(h.history.mark(), before); assert.deepEqual(h.history.entries, entries);
  assert.deepEqual(h.counts, counts); assert.equal(h.hidden(source), false); assert.equal(h.inactive(source), false);
  assert.equal(originOwner.isCurrent(), true); h.assertRetained(); h.noWrites();
  // Same unchanged actual source has a lawful positive baseline. Only its real
  // initiating control supplies the explicit presentation port; no facade shim.
  h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  assert.ok(registrations.length > 0); assert.deepEqual(historyEffects, ['pushState']);
  assert.equal(h.hidden(source), true); assert.equal(h.calls.runtime.length, 1); h.noWrites();
});
