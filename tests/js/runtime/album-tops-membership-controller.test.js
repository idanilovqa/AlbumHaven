const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopDraft;
test.before(async () => {({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));});
function setup(t, {initial, ...overrides} = {}) {
  const c = F.controllerFixture(initial), p = F.providerFixture(overrides);
  const draft = createAlbumTopDraft({controller: c.controller, providers: p.providers});
  t.after(() => draft.dispose()); return {...c, ...p, mutations: c.calls, draft};
}
const refs = draft => draft.getSnapshot().items.map(item => item.album_ref);
const searchRefs = draft => draft.getSnapshot().search.items.map(item => item.album_ref);
const selected = async (draft, row = F.album()) => {await draft.setQuery('Album'); await draft.select(row);};

test('real controller retains the exact uncertain create intent and retry key despite attempted draft edits', async t => {
  const {createAlbumTopController} = await F.load('album-tops/model.mjs');
  const writes = [], keys = []; let fail = true;
  const p = F.providerFixture();
  const providers = {...p.providers, list: async () => F.state().directory.data,
    read: async ref => ({...F.detail(), top_ref: ref}),
    execute: async (action, command) => {writes.push(F.clone(command)); if (fail) throw new TypeError('Lost acknowledgement'); return {top_ref: F.TOP, revision: '8', action, request_key: command.request_key};}};
  const controller = createAlbumTopController({providers, requestKey: () => {const key = F.id(100 + keys.length); keys.push(key); return key;}});
  controller.setScope(F.SCOPE); await controller.load();
  const draft = createAlbumTopDraft({controller, providers}); t.after(() => {draft.dispose(); controller.dispose();});
  draft.edit({title: 'Original intent', description: 'Original subtitle'}); await selected(draft); await draft.submit();
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  draft.edit({title: 'Replacement intent'}); draft.remove(F.A); await draft.submit();
  assert.equal(writes.length, 1); assert.equal(draft.getSnapshot().title, 'Original intent'); assert.deepEqual(refs(draft), [F.A]);
  fail = false; await controller.retryMutation();
  assert.deepEqual(writes, [
    {title: 'Original intent', description: 'Original subtitle', album_refs: [F.A], request_key: F.id(100)},
    {title: 'Original intent', description: 'Original subtitle', album_refs: [F.A], request_key: F.id(100)},
  ]); assert.equal(keys.length, 1); assert.equal(controller.getSnapshot().selectedTopRef, F.TOP);
});

test('metadata-only existing edit stays available without fabricating membership or publication evidence', async t => {
  const data = F.detail(); delete data.edit_draft; delete data.allowed_actions.can_add; delete data.allowed_actions.can_remove; delete data.allowed_actions.can_reorder;
  const {draft, mutations, calls} = setup(t, {initial: F.state({editing: true, data})});
  draft.remove(F.A); draft.reorder([F.B, F.A]); await draft.setQuery('Album');
  draft.edit({title: 'Still renameable'}); await draft.submit();
  assert.deepEqual(mutations, [{action: 'save', payload: {title: 'Still renameable', description: 'Subtitle'}}]); assert.deepEqual(calls.search, []);
});
