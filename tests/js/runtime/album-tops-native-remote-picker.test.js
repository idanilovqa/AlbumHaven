'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {loadOwners, nativeRuntime, button, click, search, settle} = require('./album-tops-sharing-harness.cjs');
let createAlbumTopDraft, mountAlbumPicker;
test.before(async () => {await loadOwners();
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({mountAlbumPicker} = await F.load('album-tops/builder.mjs'));
});
function fixture(t, options = {}) {
  const env = nativeRuntime(t), api = F.service(options), c = F.controllerFixture(F.state());
  const draft = env.own(createAlbumTopDraft({controller: c.controller, providers: api.providers}));
  const props = () => {const value = draft.getSnapshot(), mutation = c.controller.getSnapshot().mutation;
    const blocked = value.stale || value.denied || mutation.refreshing === true || ['loading', 'uncertain'].includes(mutation.status);
    return {draft, providers: api.providers, value, disabled: blocked || value.busy, blocked};};
  const owner = env.own(mountAlbumPicker(env.host, env.runtime, props()));
  const unsubscribe = draft.subscribe(() => owner.update(props())); t.after(unsubscribe);
  return {...env, ...c, calls: env.calls, mutations: c.calls, api, draft, owner, redraw: () => owner.update(props())};
}
async function remoteSearch(f) {
  click(button(f.host, 'Remote albums'));
  F.input(f.host, 'Remote album title', '  Remote album  ');
  F.input(f.host, 'Remote artist (optional)', ' Remote artist ');
  click(button(f.host, 'Search remote albums')); await settle();
}
async function selectRemote(f, title = 'Remote album') {click(button(f.host, `Select remote album ${title}`)); await settle();}
const selectedKeys = f => [...f.host.querySelectorAll('[data-album-draft-key]')].map(row => row.getAttribute('data-album-draft-key'));

test('native local/remote pools share one selection and remote title/artist typing never searches automatically', async t => {
  const f = fixture(t); f.redraw(); await settle(); assert.deepEqual(F.remoteCalls(f.api), []);
  search(f.host, 'Found'); await settle();
  click(f.host.querySelector('[data-gallery-card-intent="select"]')); await settle();
  assert.equal(f.draft.getSnapshot().items[0].album_ref, F.C);
  click(button(f.host, 'Remote albums'));
  F.input(f.host, 'Remote album title', '  Remote album  '); F.input(f.host, 'Remote artist (optional)', ' Remote artist ');
  f.redraw(); await settle(); assert.deepEqual(F.remoteCalls(f.api), []);
  assert.equal(f.api.count('searchAlbums'), 1); assert.equal(f.api.count('admitAlbum'), 1);
  click(button(f.host, 'Search remote albums')); await settle();
  assert.equal(f.api.count('searchRemoteAlbums'), 1);
  assert.deepEqual(f.api.last('searchRemoteAlbums').args[0], {destination: {kind: 'create', draft_ref: f.draft.getSnapshot().formRef},
    title: 'Remote album', artist: 'Remote artist'});
  assert.match(f.host.textContent, /Remote album summary · tracks unavailable/);
  assert.match(f.host.textContent, /Tracks and artwork are unavailable/);
  assert.equal(f.api.count('beginRemotePreparation'), 0);
  await selectRemote(f);
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.album_ref || row.selection_key), [F.C, 'remote:' + F.ACQUISITION]);
  assert.equal(f.api.count('beginRemotePreparation'), 1); assert.equal(f.api.count('acquireRemoteAlbum'), 1);
  assert.equal(f.mutations.length, 0, 'no membership mutation is issued by selection');
  click(button(f.host, 'Local albums')); assert.equal(f.draft.getSnapshot().pool, 'local');
  assert.equal(f.draft.getSnapshot().items.length, 2);
});

test('unsaved remote selection_key keeps distinct native cards, reorder handles and remove targets without invented album refs', async t => {
  const f = fixture(t); await remoteSearch(f); await selectRemote(f); await selectRemote(f, 'Second remote album');
  const [first, second] = f.draft.getSnapshot().items;
  assert.equal(first.album_ref, undefined); assert.equal(second.album_ref, undefined);
  assert.notEqual(first.selection_key, second.selection_key);
  click(f.host.querySelector('[data-in-page-tab="selected"]'));
  assert.deepEqual(selectedKeys(f), [first.selection_key, second.selection_key]);
  const original = f.host.querySelector(`[data-album-draft-key="${first.selection_key}"]`), handle = original.querySelector('[data-album-draft-move]');
  handle.focus(); handle.dispatchEvent(new f.context.Event('keydown', {key: 'End'}));
  assert.deepEqual(selectedKeys(f), [second.selection_key, first.selection_key]);
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.selection_key), [second.selection_key, first.selection_key]);
  assert.equal(f.host.querySelectorAll('[data-album-draft-key]')[1], original);
  assert.equal(f.document.activeElement, handle);
  click(button(f.host, 'Remove Second remote album'));
  assert.deepEqual(selectedKeys(f), [first.selection_key]);
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.source.acquisition_ref), [F.ACQUISITION]);
  assert.equal(f.api.count('closeRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
});

for (const failure of ['in_flight', 'unknown']) test(`native ${failure} preparation has one explicit exact retry and no render-driven poll`, async t => {
  let attempts = 0, api;
  const f = fixture(t, {handlers: {acquireRemoteAlbum: body => {
    if (++attempts === 1) {if (failure === 'unknown') throw new TypeError('Preparation reply lost');
      return {version: 2, context_ref: F.CONTEXT, preparation_ref: body.preparation_ref, request_key: body.request_key,
        destination: body.destination, state: 'in_flight', retry_after_seconds: 1};}
    return api.acquisition(body);
  }}}); api = f.api;
  await remoteSearch(f); await selectRemote(f);
  const original = F.clone(f.api.last('acquireRemoteAlbum').args[0]);
  assert.equal(f.draft.getSnapshot().remote.status, failure); assert.equal(f.draft.getSnapshot().items.length, 0);
  assert.equal(button(f.host, 'Search remote albums').disabled, true);
  assert.equal(button(f.host, 'Retry preparation').disabled, false);
  f.redraw(); f.redraw(); await settle(); assert.equal(attempts, 1);
  for (const label of ['Check preparation status', 'Reclaim expired preparations', 'Discard legacy preparations', 'Close current preparation']) {
    assert.equal(button(f.host, label).disabled, true);
  }
  click(button(f.host, 'Retry preparation')); await settle();
  assert.equal(attempts, 2); assert.deepEqual(f.api.last('acquireRemoteAlbum').args[0], original);
  assert.equal(f.draft.getSnapshot().items.length, 1); assert.equal(f.mutations.length, 0);
});

test('status, bounded reclaim, legacy discard and foreign-parent close are explicit with independent confirmation', async t => {
  const f = fixture(t); click(button(f.host, 'Remote albums')); await settle();
  assert.deepEqual(F.remoteCalls(f.api), []);
  click(button(f.host, 'Check preparation status')); await settle(); assert.equal(f.api.count('readRemotePreparationState'), 1);
  assert.match(f.host.textContent, /511 additional remote acquisitions/);
  click(button(f.host, 'Reclaim expired preparations')); await settle();
  assert.deepEqual(f.api.last('maintainRemotePreparations').args[0], {mode: 'reclaim'});
  f.redraw(); await settle(); assert.equal(f.api.count('maintainRemotePreparations'), 1, 'more_work never schedules another pass');
  click(button(f.host, 'Discard legacy preparations')); await settle();
  assert.equal(f.calls.confirms.length, 1); assert.equal(f.api.count('maintainRemotePreparations'), 1);
  f.runtime.confirm = async () => true;
  click(button(f.host, 'Discard legacy preparations')); await settle();
  assert.deepEqual(f.api.last('maintainRemotePreparations').args[0], {mode: 'discard_legacy'});
  f.runtime.confirm = async () => false;
  click(button(f.host, 'Close saved preparation')); await settle(); assert.equal(f.api.count('closeRemotePreparation'), 0);
  f.runtime.confirm = async () => true;
  click(button(f.host, 'Close saved preparation')); await settle();
  assert.equal(f.api.count('closeRemotePreparation'), 1); assert.equal(f.api.last('closeRemotePreparation').args[0], F.SAVED_PARENT);
  assert.equal(f.mutations.length, 0);
});

test('explicit current-parent close retains selected evidence visibly but prevents saving expired acquisition', async t => {
  const f = fixture(t); f.draft.edit({title: 'Retain my draft'}); await remoteSearch(f); await selectRemote(f);
  const selected = F.clone(f.draft.getSnapshot().items);
  click(button(f.host, 'Close current preparation')); await settle();
  assert.equal(f.api.count('closeRemotePreparation'), 1); assert.equal(f.api.last('closeRemotePreparation').args[0], F.PARENT);
  assert.deepEqual(f.draft.getSnapshot().items, selected); assert.equal(f.draft.getSnapshot().title, 'Retain my draft');
  await f.draft.submit(); assert.equal(f.mutations.length, 0); assert.equal(f.draft.getSnapshot().error.code, 'remote_acquisition_expired');
});

test('a pending cleanup confirmation cannot act after the picker owner is retired', async t => {
  const f = fixture(t), gate = F.deferred(); click(button(f.host, 'Remote albums'));
  f.runtime.confirm = () => gate.promise; click(button(f.host, 'Discard legacy preparations')); await F.drain();
  f.owner.dispose(); gate.resolve(true); await settle();
  assert.equal(f.api.count('maintainRemotePreparations'), 0); assert.equal(f.api.count('closeRemotePreparation'), 0);
});

test('shared uncertain membership blocks preparation retry and every cleanup action', async t => {
  const f = fixture(t, {handlers: {acquireRemoteAlbum: () => {throw new TypeError('Unknown preparation');}}});
  await remoteSearch(f); await selectRemote(f);
  const before = F.remoteCalls(f.api).length, initial = f.controller.getSnapshot();
  f.replace({...initial, mutation: {status: 'uncertain', action: 'create', command: {request_key: F.id(91)}}});
  // The parent surface forwards controller changes even when draft.busy was
  // already true and the draft therefore emitted no new snapshot.
  f.redraw();
  for (const label of ['Retry preparation', 'Check preparation status', 'Reclaim expired preparations', 'Discard legacy preparations', 'Close current preparation']) {
    const control = button(f.host, label); assert.equal(control.disabled, true); click(control);
  }
  await settle(); assert.equal(F.remoteCalls(f.api).length, before);
});

test('picker update and disposal do not close preparations, reclaim capacity or save membership', async t => {
  const f = fixture(t); await remoteSearch(f); await selectRemote(f);
  const before = F.remoteCalls(f.api).length;
  f.redraw(); f.redraw(); await settle(); f.owner.dispose(); f.draft.dispose(); await settle();
  assert.equal(F.remoteCalls(f.api).length, before); assert.equal(f.api.count('closeRemotePreparation'), 0);
  assert.equal(f.api.count('maintainRemotePreparations'), 0); assert.equal(f.mutations.length, 0);
});

test('remote renderer disposal of the outer picker cannot resurrect its retained local-search cards or owners', async t => {
  const f = fixture(t); search(f.host, 'Retained local result'); await settle();
  assert.match(f.host.textContent, /Found local album/);
  const original = f.runtime.galleryCardHtml; let disposed = false;
  f.runtime.galleryCardHtml = options => {
    if (!disposed && options.title === 'Remote album') {disposed = true; f.owner.dispose();}
    return original(options);
  };
  await remoteSearch(f);
  assert.equal(disposed, true); assert.equal(f.host.children.length, 0);
  f.redraw(); await settle(); assert.equal(f.host.children.length, 0);
  assert.equal(f.api.count('beginRemotePreparation'), 0); assert.equal(f.api.count('closeRemotePreparation'), 0);
  assert.equal(f.mutations.length, 0);
  // nativeRuntime's teardown verifies connected listeners, observers and frame ownership.
});

test('remote renderer switching outer picker to Selected cannot restore stale local-search rows afterward', async t => {
  const f = fixture(t); search(f.host, 'Found'); await settle();
  click(f.host.querySelector('[data-gallery-card-intent="select"]')); await settle();
  f.api.control.searchAlbums = () => ({albums: [F.album(14, {title: 'Stale local search row'})], next_cursor: null});
  search(f.host, 'Other local'); await settle();
  assert.match(f.host.textContent, /Stale local search row/);
  const original = f.runtime.galleryCardHtml; let reentered = false;
  f.runtime.galleryCardHtml = options => {
    if (!reentered && options.title === 'Remote album') {reentered = true; f.draft.setTab('selected');}
    return original(options);
  };
  await remoteSearch(f);
  assert.equal(reentered, true); assert.equal(f.draft.getSnapshot().tab, 'selected');
  assert.deepEqual(selectedKeys(f), [F.C]);
  assert.doesNotMatch(f.host.querySelector('.playlists__tracks').textContent, /Stale local search row/);
  assert.equal(button(f.host, 'Select remote album Remote album'), undefined, 'remote results are not actionable in Selected');
  assert.equal(f.api.count('beginRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
});

test('outer selected-row button acquisition disposes a newly acquired native control after renderer retirement', async t => {
  const f = fixture(t); await remoteSearch(f); await selectRemote(f);
  const original = f.runtime.buttonHtml; let disposed = false;
  f.runtime.buttonHtml = options => {
    if (!disposed && JSON.stringify(options).includes('Move')) {disposed = true; f.owner.dispose();}
    return original(options);
  };
  click(f.host.querySelector('[data-in-page-tab="selected"]'));
  assert.equal(disposed, true, 'the actual selected-row Move renderer was reached');
  await settle(); assert.equal(f.host.children.length, 0);
  assert.equal(f.api.count('closeRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
  // Real native owner teardown accounts for control/global/gesture resources.
});
