'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./album-tops-source-match-fixtures/picker.cjs');
const {F, JOB} = S;
const {loadOwners, nativeRuntime, button, click, search, settle} = require('./album-tops-sharing-harness.cjs');
test.before(async () => {await loadOwners(); await S.load();});

async function fixture(t, {draftOptions = {}, ...options} = {}) {
  const env = nativeRuntime(t), f = await S.base(t, options);
  f.draft = f.create(draftOptions);
  const props = () => {
    const value = f.draft.getSnapshot(), mutation = f.controller.getSnapshot().mutation;
    const blocked = value.stale || value.denied || value.remote.retired
      || mutation.refreshing === true || ['loading', 'uncertain'].includes(mutation.status);
    return {draft: f.draft, providers: f.api.providers, value, disabled: blocked || value.busy, blocked};
  };
  const owner = env.own(S.mount(env.host, env.runtime, props()));
  const unsubscribe = f.draft.subscribe(() => owner.update(props())); t.after(unsubscribe);
  return {...env, ...f, owner, redraw: () => owner.update(props())};
}
async function remoteSearch(f) {
  click(button(f.host, 'Remote albums'));
  F.input(f.host, 'Remote album title', 'Remote album');
  F.input(f.host, 'Remote artist (optional)', 'Remote artist');
  click(button(f.host, 'Search remote albums')); await settle();
}
const selectedKeys = f => [...f.host.querySelectorAll('[data-album-draft-key]')].map(row => row.getAttribute('data-album-draft-key'));
const localButtons = f => [...f.host.querySelector('.playlists__tracks').querySelectorAll('[data-gallery-card-intent="select"]')];
const hasNote = (f, text) => [...f.host.querySelectorAll('.playlists__note')].some(node => node.textContent === text);

test('source matching reuses actual native local search, one-item disabled state, Selected and remove owners', async t => {
  const f = await fixture(t, {handlers: {searchAlbums: () => ({albums: [F.album(13), F.album(14)], next_cursor: null})}});
  assert.equal(f.api.count('searchAlbums'), 0); assert.deepEqual(F.remoteCalls(f.api), []);
  assert.equal(f.draft.getSnapshot().capacity, 1);
  search(f.host, 'Albums'); await settle(); assert.equal(localButtons(f).length, 2);
  click(localButtons(f)[0]); await settle();
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.album_ref), [F.C]);
  const second = localButtons(f)[0]; assert.ok(second);
  assert.equal(second.disabled, true); assert.equal(second.getAttribute('aria-disabled'), 'true');
  assert.equal(hasNote(f, 'One album can be selected for this source row. Remove it before choosing another.'), true);
  click(second); await settle(); assert.equal(f.api.count('admitAlbum'), 1);
  click(f.host.querySelector('[data-in-page-tab="selected"]'));
  assert.deepEqual(selectedKeys(f), [F.C]); assert.equal(button(f.host, 'Remove Album 13').disabled, false);
  click(button(f.host, 'Remove Album 13')); await settle(); assert.deepEqual(selectedKeys(f), []);
  click(f.host.querySelector('[data-in-page-tab="all"]'));
  const retry = localButtons(f).find(node => !node.disabled); assert.ok(retry);
  click(retry); await settle(); assert.equal(f.draft.getSnapshot().items.length, 1);
  assert.equal(f.api.count('admitAlbum'), 2); assert.equal(await f.draft.submit(), false);
  S.noWrites(f); S.noCleanup(f);
});

test('source matching remote native cards share job destination and one removable selection with local pool', async t => {
  const f = await fixture(t); await remoteSearch(f);
  const selected = button(f.host, 'Select remote album Remote album'), second = button(f.host, 'Select remote album Second remote album');
  assert.equal(selected.disabled, false); assert.equal(second.disabled, false);
  click(selected); await settle();
  assert.equal(second.disabled, true); assert.equal(second.getAttribute('aria-disabled'), 'true');
  assert.equal(hasNote(f, 'One album can be selected for this source row. Remove it before choosing another.'), true);
  click(second); await settle(); assert.equal(f.api.count('beginRemotePreparation'), 1); assert.equal(f.api.count('acquireRemoteAlbum'), 1);
  assert.deepEqual(f.api.last('beginRemotePreparation').args[0], {destination: {kind: 'create', draft_ref: JOB}, form_ref: JOB});
  assert.equal(hasNote(f, 'Remote album selected. Confirm this match to use it for the source row.'), true);
  assert.doesNotMatch(f.host.textContent, /Save your Album Top to add it/);
  click(button(f.host, 'Local albums')); search(f.host, 'Found'); await settle();
  const local = localButtons(f)[0]; assert.ok(local); assert.equal(local.disabled, true);
  click(local); await settle(); assert.equal(f.api.count('admitAlbum'), 0);
  click(f.host.querySelector('[data-in-page-tab="selected"]'));
  assert.deepEqual(selectedKeys(f), ['remote:' + F.ACQUISITION]);
  assert.match(f.host.textContent, /Remote album summary/);
  click(button(f.host, 'Remove Remote album')); await settle();
  click(f.host.querySelector('[data-in-page-tab="all"]'));
  const available = localButtons(f)[0]; assert.ok(available); assert.equal(available.disabled, false);
  click(available); await settle();
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.album_ref), [F.C]);
  assert.equal(await f.draft.submit(), false); S.noWrites(f); S.noCleanup(f);
});

test('native source picker does not search, acquire, clean up or submit from rerender and tab changes', async t => {
  const f = await fixture(t); await remoteSearch(f);
  click(button(f.host, 'Select remote album Remote album')); await settle();
  const calls = f.api.calls.length, selected = F.clone(f.draft.getSnapshot().items);
  f.redraw(); f.redraw();
  click(f.host.querySelector('[data-in-page-tab="selected"]'));
  click(f.host.querySelector('[data-in-page-tab="all"]')); await settle();
  assert.deepEqual(f.draft.getSnapshot().items, selected); assert.equal(f.api.calls.length, calls);
  assert.equal(await f.draft.submit(), false); S.noWrites(f); S.noCleanup(f);
});

test('ordinary native picker retains its existing capacity and pending-selection captions', async t => {
  const f = await fixture(t, {draftOptions: {mode: 'edit'}});
  assert.equal(f.draft.getSnapshot().sourceMatch, false);
  assert.equal(hasNote(f, 'The 5,000-album limit is reached. Remove an album before adding another.'), true);
  await remoteSearch(f); click(button(f.host, 'Select remote album Remote album')); await settle();
  assert.equal(hasNote(f, 'Remote album selected. Save your Album Top to add it.'), true);
  assert.equal(button(f.host, 'Select remote album Second remote album').disabled, false);
  assert.notEqual(f.draft.getSnapshot().formRef, JOB); S.noWrites(f); S.noCleanup(f);
});

for (const retirement of ['scope', 'dispose']) test(`pending source-match native acquisition cannot restore controls after ${retirement}`, async t => {
  const gate = F.deferred(), f = await fixture(t, {handlers: {acquireRemoteAlbum: () => gate.promise}});
  await remoteSearch(f);
  const retained = button(f.host, 'Select remote album Remote album'); click(retained); await F.drain();
  assert.equal(f.api.count('acquireRemoteAlbum'), 1);
  const call = f.api.last('acquireRemoteAlbum');
  if (retirement === 'scope') f.controller.setScope('source-picker:new-session');
  f.owner.dispose(); f.draft.dispose();
  gate.resolve(f.api.acquisition(call.args[0])); await settle();
  assert.equal(call.args[1].signal.aborted, true); assert.deepEqual(f.draft.getSnapshot().items, []);
  assert.equal(f.host.children.length, 0);
  const calls = f.api.calls.length; click(retained); f.redraw(); await settle();
  assert.equal(f.api.calls.length, calls); assert.equal(f.host.children.length, 0);
  S.noWrites(f); S.noCleanup(f);
  // nativeRuntime teardown verifies real control/listener/observer/frame ownership.
});

test('actual directory denial disables retained source-match native selection controls', async t => {
  const f = await fixture(t); await remoteSearch(f);
  const retained = button(f.host, 'Select remote album Remote album');
  f.controller.observeDenial(F.SCOPE, Object.assign(new Error('Current grant denied'), {status: 403}));
  await settle(); const count = f.api.calls.length;
  assert.equal(f.draft.canEditMembership(), false);
  const visible = button(f.host, 'Select remote album Remote album');
  if (visible) {assert.equal(visible.disabled, true); assert.equal(visible.getAttribute('aria-disabled'), 'true');}
  click(retained); await settle();
  assert.equal(f.api.calls.length, count); assert.equal(f.api.count('beginRemotePreparation'), 0);
  assert.deepEqual(f.draft.getSnapshot().items, []); assert.equal(await f.draft.submit(), false); S.noWrites(f);
});
