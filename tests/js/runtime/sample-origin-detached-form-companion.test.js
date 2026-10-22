'use strict';
// Actual builder -> openNativeDialog -> runtime -> shared native helper, then
// actual Sample facade/mount/Settings/Back. No local presentation port is injected.
const test = require('node:test'), assert = require('node:assert/strict');
const {topOwner} = require('./sample-origin-integration-fixture.cjs');
const {observe} = require('./sample-origin-native-form-companion-fixture.cjs');
async function detached(t) {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11',
    title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await topOwner(t, {mode: 'detached', providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  const title = h.form.querySelector('[aria-label="Album Top name"]'); h.input(title, 'Unsubmitted native title');
  h.click(h.named('Find albums', h.form)); await h.settle();
  h.input(h.form.querySelector('input[type="search"]'), 'Picked'); await h.settle();
  h.click(h.form.querySelector('[data-gallery-card-intent="select"]')); await h.settle();
  const owner = h.owner('activeAppFormDialog'); assert.ok(owner); assert.equal(h.owner('getActiveAppFormPage')(), owner);
  assert.equal(owner.isActive(), true); assert.equal(owner.isCurrentContext(), true);
  return {...h, title, nativeOwner: owner, nativePromise: observe(owner.promise),
    assertNativeRetained() {
      assert.equal(h.owner('activeAppFormDialog'), owner); assert.equal(owner.isActive(), true);
      assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'), h.form);
      assert.equal(h.form.querySelector('[aria-label="Album Top name"]'), title); assert.equal(title.value, 'Unsubmitted native title');
    }};
}

test('actual detached builder native admission survives child launch and successful Back with its exact form promise still pending', async t => {
  const h = await detached(t), before = h.history.mark(); h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  h.assertNativeRetained(); assert.equal(h.nativePromise.status, 'pending'); assert.equal(h.owner('getActiveAppFormPage')(), null);
  assert.equal(h.hidden(h.sourceSurface), true); assert.equal(h.inactive(h.sourceSurface), true);
  let mounted = 0;
  assert.equal(h.c.showAppFormDialog({title: 'Competing legacy form', onMount() {mounted++;}}), h.nativeOwner.promise);
  assert.throws(() => h.c.openReactFormDialog({title: 'Competing React form', onMount() {mounted++;}}), /The form dialog is unavailable/);
  await h.settle(); assert.equal(mounted, 0); h.assertNativeRetained(); assert.equal(h.nativePromise.status, 'pending');
  h.click(h.named('Back', h.host)); await h.settle();
  h.assertNativeRetained(); assert.equal(h.owner('getActiveAppFormPage')(), h.nativeOwner); assert.equal(h.nativePromise.status, 'pending');
  assert.equal(h.hidden(h.sourceSurface), false); assert.equal(h.inactive(h.sourceSurface), false);
  assert.deepEqual(h.history.traversals, [-1]); assert.equal(h.history.index(), before.index); assert.equal(h.c.location.href, before.url);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); h.noWrites(h.svc, 1);
});

test('actual detached native presentation rolls back a failed child history commit without releasing its sole admission', async t => {
  const h = await detached(t), before = h.history.mark(), push = h.c.history.pushState; let failures = 0;
  h.c.history.pushState = function (state, title, url) {
    if (state?.playlistDraft) {failures++; throw new Error('companion child commit failure');}
    return push.call(this, state, title, url);
  };
  try {h.click(h.sourceButton());} catch (error) {assert.match(error.message, /companion child commit failure/);}
  await h.settle(); assert.equal(failures, 1); h.assertNativeRetained(); assert.equal(h.nativePromise.status, 'pending');
  assert.equal(h.owner('getActiveAppFormPage')(), h.nativeOwner); assert.equal(h.hidden(h.sourceSurface), false);
  assert.equal(h.inactive(h.sourceSurface), false); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(h.history.index(), before.index); assert.equal(h.c.location.href, before.url); assert.deepEqual(h.history.traversals, []);
  h.c.history.pushState = push; h.click(h.sourceButton()); await h.settle(); h.assertSetup(2);
  h.assertNativeRetained(); assert.equal(h.owner('getActiveAppFormPage')(), null); assert.equal(h.nativePromise.status, 'pending'); h.noWrites(h.svc, 1);
});

test('actual detached accepted external departure physically disposes the retired native parent instead of stranding invisible admission', async t => {
  const h = await detached(t); h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  h.assertNativeRetained(); let departed = 0;
  assert.equal(await h.nav.deferCollectionDraftNavigation(() => {departed++; h.state.view = {surface: {active: 'albums'}}; return true;}), true);
  await h.settle(); assert.equal(departed, 1); assert.equal(h.nativeOwner.isActive(), false); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.nativePromise.status, 'resolved'); assert.equal(h.nativePromise.settlements, 1); assert.equal(h.hidden(h.sourceSurface), true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.deepEqual(h.history.traversals, []);
  h.actual.sync(); h.runtime.sync(); await h.settle(); assert.equal(h.nativePromise.settlements, 1); h.noWrites(h.svc, 1);
});

for (const lost of ['actor', 'library', 'source host']) test(`actual detached ${lost} retirement cleans its suspended native owner once without resurrecting the form`, async t => {
  const h = await detached(t); h.click(h.sourceButton()); await h.settle(); h.assertSetup();
  const guard = h.calls.draft[0].isCurrent;
  if (lost === 'source host') h.topHost.remove();
  else h.shell.dataset[lost === 'actor' ? 'nativeAccountId' : 'nativeLibraryId'] = '999';
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(guard(), false); assert.equal(h.nativeOwner.isActive(), false); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.nativePromise.status, 'resolved'); assert.equal(h.nativePromise.settlements, 1);
  assert.equal(h.hidden(h.sourceSurface), true); assert.deepEqual(h.history.traversals, []);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(guard(), false); assert.equal(h.nativePromise.settlements, 1); h.noWrites(h.svc, 1);
});
