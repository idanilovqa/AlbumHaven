'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {loadOwners, nativeRuntime, viewOwner, button, click, settle} = require('./album-tops-sharing-harness.cjs');
test.before(loadOwners);

function fixture(t, {creating = false, data = F.mixed(), handlers = {}} = {}) {
  const env = nativeRuntime(t), api = F.service({detail: data, handlers});
  const c = F.controllerFixture(F.state({editing: !creating, data}));
  // Runtime navigation registration is an external boundary. These tests exercise
  // the real app/editor ownership, not browser-history behavior or the bridge.
  let navigationOwner;
  env.runtime.registerDraftNavigation = value => {navigationOwner = value; return () => {if (navigationOwner === value) navigationOwner = null;};};
  env.runtime.deferDraftNavigation = async run => {
    const owner = navigationOwner;
    if (owner && (!owner.isCurrent() || !await owner.confirmLeave(env.runtime.confirm))) return false;
    owner?.onDiscard(); return run();
  };
  let props = {controller: c.controller, state: c.controller.getSnapshot(), providers: api.providers, onOpen() {}};
  const view = viewOwner(env, props);
  const unsubscribe = c.controller.subscribe(() => {props = {...props, state: c.controller.getSnapshot()}; view.update(props);});
  t.after(unsubscribe);
  const form = () => env.document.querySelector('form.album-top-builder');
  return {...env, ...c, calls: env.calls, mutations: c.calls, api, view, form,
    replaceProviders(value) {props = {...props, providers: value}; view.update(props);},
    open(mode) {click(button(env.host, mode === 'create' ? 'Create Album Top' : mode === 'add' ? 'Add albums' : 'Edit Album Top')); assert.ok(form());},
  };
}
async function startRemote(f) {
  const form = f.form();
  const find = button(form, 'Find albums'); if (find && !form.querySelector('[aria-label="Choose albums"]')) click(find);
  const all = form.querySelector('[data-in-page-tab="all"]'); if (all) click(all);
  click(button(form, 'Remote albums'));
  F.input(form, 'Remote album title', 'Private remote search');
  click(button(form, 'Search remote albums')); await F.drain();
}

for (const mode of ['create', 'edit', 'add']) test(`provider replacement retires native ${mode} form and its in-flight remote result`, async t => {
  const gate = F.deferred(), f = fixture(t, {creating: mode === 'create', handlers: {searchRemoteAlbums: () => gate.promise}});
  f.open(mode); await startRemote(f); const oldForm = f.form(), request = f.api.last('searchRemoteAlbums');
  assert.ok(request); f.replaceProviders({...f.api.providers});
  assert.equal(request.args[1].signal.aborted, true); assert.equal(f.form(), null);
  gate.resolve(F.searchPage(request.args[0], [F.summary(F.id(72), {title: 'Late private remote row'})])); await settle();
  oldForm.dispatchEvent(new f.context.Event('submit'));
  assert.doesNotMatch(f.document.body.textContent, /Late private remote row/);
  assert.equal(f.api.count('beginRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
  assert.equal(f.api.count('closeRemotePreparation'), 0);
});

for (const change of ['scope', 'navigation', 'source']) test(`${change} retirement aborts old inline remote search and prevents old-form submission`, async t => {
  const gate = F.deferred(), f = fixture(t, {handlers: {searchRemoteAlbums: () => gate.promise}});
  f.open('edit'); await startRemote(f); const oldForm = f.form(), before = f.controller.getSnapshot();
  const signal = f.api.last('searchRemoteAlbums').args[1].signal;
  if (change === 'scope') f.replace({...before, scopeKey: 'replacement-session'});
  if (change === 'navigation') f.replace({...before, selectedTopRef: F.OTHER});
  if (change === 'source') f.replace({...before, detail: {...before.detail, data: F.clone(before.detail.data)}});
  assert.equal(signal.aborted, true);
  gate.resolve(F.searchPage(f.api.last('searchRemoteAlbums').args[0], [F.summary(F.id(72), {title: 'Retired search result'})])); await settle();
  oldForm.dispatchEvent(new f.context.Event('submit'));
  assert.equal(f.api.count('beginRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
  assert.doesNotMatch(f.document.body.textContent, /Retired search result/);
  if (change === 'source') {
    const save = button(f.form(), 'Save'); assert.ok(save); assert.equal(save.disabled, true);
    assert.equal(f.form().querySelector('[aria-label="Album Top name"]').disabled, true);
  } else assert.equal(f.form(), null);
});

for (const omitEditDraft of [false, true]) test(`Manage-only mixed metadata Save is available ${omitEditDraft ? 'without' : 'with'} an edit_draft and omits all membership`, async t => {
  const data = F.mixed({manageOnly: true}); if (omitEditDraft) delete data.edit_draft;
  const original = F.clone(data), f = fixture(t, {data}); f.open('edit');
  const form = f.form(); assert.ok(form.classList.contains('album-top-inline-edit'));
  assert.equal(form.querySelector('[aria-label="Choose albums"]'), null);
  F.input(form, 'Album Top name', 'Manage-only title'); F.input(form, 'Album Top subtitle', 'Manage-only subtitle');
  const save = button(form, 'Save'); assert.equal(save.disabled, false);
  form.dispatchEvent(new f.context.Event('submit')); await settle();
  assert.deepEqual(f.mutations, [{action: 'save', payload: {title: 'Manage-only title', description: 'Manage-only subtitle'}}]);
  assert.deepEqual(data, original); assert.deepEqual(F.remoteCalls(f.api), []);
  assert.equal(f.api.count('searchAlbums'), 0); assert.equal(f.api.count('preview'), 0);
});

test('Items permission ABA retires native membership controls while keeping unchanged metadata Save available', async t => {
  const f = fixture(t); f.open('edit');
  const source = f.controller.getSnapshot().detail.data, originalItems = F.clone(source.items);
  const picker = f.form().querySelector('[aria-label="Choose albums"]'); assert.ok(picker);
  const originalControls = [...picker.querySelectorAll('[data-album-draft-remove],[data-album-draft-move]')];
  assert.ok(originalControls.length > 0); assert.ok(originalControls.every(node => !node.disabled));
  const lost = () => {source.allowed_actions[F.ITEMS] = false; source.allowed_actions.can_add = false; f.replace({...f.controller.getSnapshot()});};
  // This fixture registers the parent view listener before the later-created
  // draft listener, matching the real index-to-editor notification order.
  lost(); assert.equal(f.form().querySelector('[aria-label="Choose albums"]'), picker, 'already-visible selections stay reviewable');
  assert.ok(originalControls.every(node => node.isConnected && node.disabled));
  source.allowed_actions[F.ITEMS] = true; source.allowed_actions.can_add = true; f.replace({...f.controller.getSnapshot()});
  const form = f.form(), selected = [...form.querySelectorAll('[data-album-draft-remove],[data-album-draft-move]')];
  assert.equal(form.querySelector('[aria-label="Choose albums"]'), picker);
  assert.deepEqual(selected, originalControls, 'authority ABA cannot replace or revive retained membership controls');
  assert.ok(selected.length > 0); assert.ok(selected.every(node => node.disabled));
  for (const node of selected) click(node);
  F.input(form, 'Album Top name', 'Metadata after Items retirement');
  assert.equal(button(form, 'Save').disabled, false);
  form.dispatchEvent(new f.context.Event('submit')); await settle();
  assert.deepEqual(f.mutations, [{action: 'save', payload: {title: 'Metadata after Items retirement', description: 'Subtitle'}}]);
  assert.deepEqual(source.items, originalItems); assert.deepEqual(F.remoteCalls(f.api), []);
});
