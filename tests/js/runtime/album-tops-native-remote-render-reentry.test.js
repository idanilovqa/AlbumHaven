'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {loadOwners, nativeRuntime, button, click, settle} = require('./album-tops-sharing-harness.cjs');
let createAlbumTopDraft, mountRemoteAlbumPicker;
test.before(async () => {await loadOwners();
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({mountRemoteAlbumPicker} = await F.load('album-tops/builder.mjs'));
});
function fixture(t) {
  const env = nativeRuntime(t), c = F.controllerFixture(F.state()), api = F.service();
  const draft = env.own(createAlbumTopDraft({controller: c.controller, providers: api.providers}));
  const props = () => ({draft, value: draft.getSnapshot(), disabled: draft.getSnapshot().busy, blocked: false});
  const owner = env.own(mountRemoteAlbumPicker(env.host, env.runtime, props()));
  const unsubscribe = draft.subscribe(() => owner.update(props())); t.after(unsubscribe);
  return {...env, api, draft, owner, mutations: c.calls};
}

for (const renderer of ['artboxHtml', 'galleryCardHtml']) test(`${renderer} reentrant draft update wins over the retired remote candidate render`, async t => {
  const f = fixture(t), original = f.runtime[renderer]; let reentered = false;
  f.runtime[renderer] = options => {
    if (!reentered) {reentered = true; assert.equal(f.draft.setRemoteTitle('Replacement query'), true);}
    return original(options);
  };
  f.draft.setRemoteTitle('Original query'); await f.draft.searchRemote(); await settle();
  assert.equal(reentered, true); assert.equal(f.draft.getSnapshot().remote.title, 'Replacement query');
  assert.equal(f.draft.getSnapshot().remote.search.candidates.length, 0);
  assert.equal(button(f.host, 'Select remote album Remote album'), undefined);
  assert.equal(f.host.querySelectorAll('[data-gallery-card-intent="select"]').length, 0);
  assert.equal(f.api.count('searchRemoteAlbums'), 1); assert.equal(f.api.count('beginRemotePreparation'), 0);
  assert.equal(f.mutations.length, 0);
});

for (const renderer of ['artboxHtml', 'galleryCardHtml']) test(`${renderer} disposal during remote render leaves no resurrected nodes or live selection handler`, async t => {
  const f = fixture(t), original = f.runtime[renderer]; let disposed = false;
  f.runtime[renderer] = options => {if (!disposed) {disposed = true; f.owner.dispose();} return original(options);};
  f.draft.setRemoteTitle('Original query'); await f.draft.searchRemote(); await settle();
  assert.equal(disposed, true); assert.equal(f.host.children.length, 0);
  f.owner.update({draft: f.draft, value: f.draft.getSnapshot(), disabled: false, blocked: false});
  assert.equal(f.host.children.length, 0); assert.equal(f.api.count('beginRemotePreparation'), 0);
  assert.equal(f.api.count('closeRemotePreparation'), 0); assert.equal(f.mutations.length, 0);
});

test('native control acquisition disposed by a reentrant renderer is released before the stale status render returns', async t => {
  const f = fixture(t), original = f.runtime.buttonHtml; let disposed = false;
  f.runtime.buttonHtml = options => {
    if (!disposed && JSON.stringify(options).includes('Close saved preparation')) {disposed = true; f.owner.dispose();}
    return original(options);
  };
  click(button(f.host, 'Check preparation status')); await settle();
  assert.equal(disposed, true, 'the actual saved-parent button renderer was reached');
  assert.equal(f.host.children.length, 0); assert.equal(f.api.count('readRemotePreparationState'), 1);
  assert.equal(f.api.count('closeRemotePreparation'), 0); assert.equal(f.api.count('maintainRemotePreparations'), 0);
  assert.equal(f.mutations.length, 0);
});
