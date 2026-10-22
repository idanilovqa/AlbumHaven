'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, id, TOP, ALBUM, deferred, drain, nextTask, detail, service, preparedController, nativeEnvironment, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

async function pickerFixture(backend, selected = null) {
  const env = nativeEnvironment(), controller = await preparedController(backend, {selected});
  const {createAlbumTopDraft} = await load('album-tops/draft.mjs'), {mountAlbumPicker} = await load('album-tops/builder.mjs');
  const draft = createAlbumTopDraft({controller, providers: backend.providers});
  const props = () => ({draft, value: draft.getSnapshot(), disabled: draft.getSnapshot().busy || draft.getSnapshot().denied || draft.getSnapshot().stale});
  const picker = mountAlbumPicker(env.host, env.runtime, props()), unsubscribe = draft.subscribe(() => picker.update(props()));
  return {...env, controller, draft, picker, dispose() {unsubscribe(); picker.dispose(); draft.dispose(); controller.dispose();}};
}

test('actual native SearchInput clear and stale search ownership drive the real draft', async () => {
  const old = deferred(), current = deferred(), backend = service({searchAlbums: options => options.q === 'old' ? old.promise : current.promise});
  const env = await pickerFixture(backend);
  try {
    const input = env.host.querySelector('input[type="search"]'); env.input(input, 'old'); env.input(input, 'new');
    assert.equal(backend.calls.filter(row => row.method === 'searchAlbums')[0].args[0].signal.aborted, true);
    current.resolve({albums: [{local_album_id: 12, album_ref: id(12), title: 'Current result', artist: 'Artist', year: 2001}], next_cursor: null}); await drain();
    old.resolve({albums: [{local_album_id: 11, album_ref: ALBUM, title: 'Stale result', artist: 'Artist', year: 2001}], next_cursor: null}); await drain();
    assert.equal(env.draft.getSnapshot().search.items.length, 1); assert.equal(env.draft.getSnapshot().search.items[0].local_album_id, 12);
    assert.doesNotMatch(env.host.textContent, /Stale result/); assert.equal(env.host.querySelector('input[type="search"]'), input);
    const enter = new env.context.Event('keydown', {key: 'Enter'}); input.dispatchEvent(enter); assert.equal(enter.defaultPrevented, true);
    env.click(env.host.querySelector('[data-search-clear]')); assert.equal(env.draft.getSnapshot().query, ''); assert.equal(env.draft.getSnapshot().search.items.length, 0); assert.equal(env.document.activeElement, input);
  } finally {env.dispose();}
  env.assertClean();
});

test('native picker admission, selected tab and removal mutate the actual detached draft only', async () => {
  const admission = deferred(), backend = service({admitAlbum: () => admission.promise}), env = await pickerFixture(backend);
  try {
    env.input(env.host.querySelector('input[type="search"]'), 'album'); await drain();
    const select = env.host.querySelector('[data-gallery-card-intent="select"]'); assert.ok(select); select.focus(); env.click(select);
    assert.equal(env.draft.getSnapshot().busy, true); assert.equal(select.disabled, true); assert.equal(backend.count('execute'), 0);
    admission.resolve({album_ref: ALBUM}); await drain(); assert.equal(env.draft.getSnapshot().items.length, 1);
    const selectedTab = env.host.querySelector('[data-in-page-tab="selected"]'); env.click(selectedTab);
    assert.equal(env.draft.getSnapshot().tab, 'selected');
    const remove = env.host.querySelector('[data-album-draft-remove]'); remove.focus(); env.click(remove);
    assert.equal(env.draft.getSnapshot().items.length, 0); assert.equal(env.document.activeElement.getAttribute('data-in-page-tab'), 'selected');
    assert.equal(backend.count('execute'), 0, 'picker changes stay detached until explicit submission');
  } finally {env.dispose();}
  env.assertClean();
});

test('native keyboard reorder changes actual draft order and retains the keyed move control', async () => {
  const backend = service(), items = [11, 12].map(n => ({item_ref: id(n + 20), album_ref: id(n), title: `Album ${n}`, artist: 'Artist', year: 2001}));
  backend.data.detail = detail({items, edit_draft: {items: items.map(({item_ref, album_ref}) => ({item_ref, album_ref})), publication_preview_required: false}});
  const env = await pickerFixture(backend, TOP);
  try {
    const rows = env.host.querySelectorAll('[data-album-draft-key]'), first = rows[0], move = first.querySelector('[data-album-draft-move]');
    move.focus(); move.dispatchEvent(new env.context.Event('keydown', {key: 'End'}));
    assert.deepEqual(env.draft.getSnapshot().items.map(row => row.album_ref), [id(12), id(11)]);
    assert.equal(env.host.querySelectorAll('[data-album-draft-key]')[1], first); assert.equal(env.document.activeElement, move);
    assert.match(env.host.querySelector('[aria-live="polite"]').textContent, /Moved to position 2 of 2/);
    assert.equal(backend.count('execute'), 0);
    env.controller.observeDenial(env.controller.getSnapshot().scopeKey, Object.assign(new Error('Denied'), {status: 403}));
    move.dispatchEvent(new env.context.Event('keydown', {key: 'Home'}));
    assert.deepEqual(env.draft.getSnapshot().items.map(row => row.album_ref), [id(12), id(11)]);
  } finally {env.dispose();}
  env.assertClean();
});

test('uncertain mutation uses native confirmation to retry the exact actual-controller command', async () => {
  let attempt = 0; const backend = service({execute: (action, command) => ++attempt === 1 ? Promise.reject(new Error('Unknown transport result'))
    : Promise.resolve({action, request_key: command.request_key, top_ref: TOP, revision: '8'})});
  const env = nativeEnvironment(), controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    await controller.mutate('save', {title: 'Changed', description: 'Subtitle'});
    assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
    const original = structuredClone(backend.calls.find(row => row.method === 'execute').args[1]);
    env.click(env.button(env.host, 'Retry original request')); await drain();
    assert.equal(backend.count('execute'), 1); assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    env.click(env.document.getElementById('app-confirm-accept')); await drain();
    assert.equal(backend.count('execute'), 2);
    assert.deepEqual(backend.calls.filter(row => row.method === 'execute')[1].args[1], original);
    assert.equal(controller.getSnapshot().mutation.status, 'ready');
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});
