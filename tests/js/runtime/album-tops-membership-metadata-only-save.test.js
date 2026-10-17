const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopDraft, createAlbumTopController;
test.before(async () => {
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
});
const binding = index => ({item_ref: F.id(10000 + index), album_ref: F.id(20000 + index), selected_local_album_id: index + 1, selected_source_ref: F.id(30000 + index)});
const wire = ({item_ref, album_ref, selected_local_album_id, selected_source_ref}) => ({item_ref: item_ref ?? null, album_ref,
  ...(selected_source_ref ? {selected_local_album_id, selected_source_ref} : {})});
function detail(count, published = false) {
  const bindings = Array.from({length: count}, (_, index) => binding(index));
  return F.detail({items: bindings.map((row, index) => ({...row, title: 'Retained ' + index, artist: 'Artist', year: null, position: index + 1, original_position: index + 1})),
    edit_draft: {items: F.clone(bindings), publication_preview_required: published}});
}
function setup(t, count, published = false) {
  const data = detail(count, published), initial = F.state({editing: true, data}), original = F.clone(data);
  const c = F.controllerFixture(initial), p = F.providerFixture({search: () => ({albums: [F.album(13)], next_cursor: null})});
  const draft = createAlbumTopDraft({controller: c.controller, providers: p.providers});
  t.after(() => draft.dispose());
  return {draft, data, initial, original, mutations: c.calls, preview: p.calls.preview, replace: c.replace};
}

for (const count of [3000, 5000]) test(`${count} retained source bindings survive title/subtitle-only Save without an items field`, async t => {
  const {draft, data, original, mutations, preview, initial, replace} = setup(t, count);
  // A refreshed object at the same current revision must not make unchanged membership dirty.
  replace({...initial, detail: {status: 'ready', data: F.clone(data)}});
  draft.edit({title: 'Rename only', description: 'Subtitle only'});
  const before = F.clone(draft.getSnapshot().items);
  assert.ok(Buffer.byteLength(JSON.stringify({revision: '7', items: data.edit_draft.items}), 'utf8') > 512 * 1024);
  await draft.submit();
  assert.equal(mutations.length, 1);
  assert.equal(Object.hasOwn(mutations[0].payload, 'items'), false, 'Metadata-only Save must omit the full membership vector');
  assert.deepEqual(mutations, [{action: 'save', payload: {title: 'Rename only', description: 'Subtitle only'}}]);
  assert.deepEqual(preview, []); assert.deepEqual(data, original);
  assert.deepEqual(draft.getSnapshot().items, before);
  assert.deepEqual(draft.getSnapshot().items.map(wire), original.edit_draft.items);
  assert.equal(draft.getSnapshot().revision, '7');
});

for (const count of [3000, 5000]) for (const change of ['reorder', 'remove']) test(`${count} bindings with ${change} still produce one complete ordered atomic membership intent`, async t => {
  const {draft, data, original, mutations} = setup(t, count);
  const expected = F.clone(original.edit_draft.items);
  if (change === 'reorder') {expected.reverse(); draft.reorder(expected.map(row => row.album_ref));}
  else {expected.splice(Math.floor(count / 2), 1); draft.remove(original.edit_draft.items[Math.floor(count / 2)].album_ref);}
  draft.edit({title: 'Changed membership', description: 'One intent'}); await draft.submit();
  // This unit seam observes intent, not network acceptance. The provider cap suite must reject an oversized body.
  assert.equal(mutations.length, 1); assert.equal(Object.hasOwn(mutations[0].payload, 'items'), true);
  assert.equal(mutations[0].payload.items.length, expected.length);
  assert.equal(mutations[0].payload.items.every((row, index) => JSON.stringify(row) === JSON.stringify(expected[index])), true, 'Full ordered source-bound membership intent must be exact');
  assert.deepEqual(mutations, [{action: 'save', payload: {title: 'Changed membership', description: 'One intent', items: expected}}]);
  assert.deepEqual(data, original); assert.deepEqual(draft.getSnapshot().items.map(wire), expected);
});

for (const change of ['reorder then restore', 'add then remove']) test(`${change} restores exact membership so a metadata edit omits items`, async t => {
  const {draft, original, mutations} = setup(t, 3);
  if (change === 'reorder then restore') {
    draft.reorder(original.edit_draft.items.map(row => row.album_ref).reverse());
    draft.reorder(original.edit_draft.items.map(row => row.album_ref));
  } else {await draft.setQuery('new'); await draft.select(F.album(13)); draft.remove(F.C);}
  assert.equal(draft.getSnapshot().dirty, false);
  draft.edit({description: 'Only subtitle'}); await draft.submit();
  assert.deepEqual(mutations, [{action: 'save', payload: {title: original.title, description: 'Only subtitle'}}]);
  assert.deepEqual(draft.getSnapshot().items.map(wire), original.edit_draft.items);
});

test('same-count remove and add is a membership change, not equal membership length', async t => {
  const data = F.detail(), original = F.clone(data), c = F.controllerFixture(F.state({editing: true, data})), p = F.providerFixture({search: () => ({albums: [F.album(13)], next_cursor: null})});
  const draft = createAlbumTopDraft({controller: c.controller, providers: p.providers}); t.after(() => draft.dispose());
  draft.remove(F.A); await draft.setQuery('Album'); await draft.select(F.album(13)); draft.reorder([F.C, F.B]);
  draft.edit({title: 'Replacement membership'}); await draft.submit();
  assert.deepEqual(c.calls, [{action: 'save', payload: {title: 'Replacement membership', description: 'Subtitle',
    items: [{item_ref: null, album_ref: F.C}, {item_ref: F.IB, album_ref: F.B}]}}]);
  assert.deepEqual(data, original); assert.equal(Object.hasOwn(c.calls[0].payload.items[0], 'selected_source_ref'), false);
});

for (const changed of [false, true]) test(`published ${changed ? 'reordered' : 'metadata-only'} intent previews the full exact vector and carries its evidence revision`, async t => {
  const {draft, original, mutations, preview} = setup(t, 3, true);
  const expected = F.clone(original.edit_draft.items); if (changed) {expected.reverse(); draft.reorder(expected.map(row => row.album_ref));}
  draft.edit({title: 'Published title', description: 'Published subtitle'}); await draft.submit();
  assert.equal(preview.length, 1); assert.equal(preview[0].ref, F.TOP);
  assert.deepEqual(preview[0].payload, {revision: '7', items: expected});
  assert.deepEqual(mutations, [{action: 'save', payload: {title: 'Published title', description: 'Published subtitle',
    ...(changed ? {items: expected} : {}), evidence_revision: 'a'.repeat(64)}}]);
});

test('large omitted-items uncertain Save retries the original current revision and request key without replacing its intent', async t => {
  const data = detail(5000), original = F.clone(data), writes = [], keys = []; let fail = true;
  const p = F.providerFixture(), providers = {...p.providers, list: async () => F.state({data}).directory.data, read: async () => F.clone(data),
    execute: async (action, command) => {writes.push(F.clone(command)); if (fail) throw new TypeError('Lost acknowledgement');
      return {top_ref: F.TOP, revision: '8', action, request_key: command.request_key};}};
  const controller = createAlbumTopController({providers, requestKey: () => {const key = F.id(100 + keys.length); keys.push(key); return key;}});
  controller.setScope(F.SCOPE); await controller.load(); await controller.open(F.TOP);
  const draft = createAlbumTopDraft({controller, providers}); t.after(() => {draft.dispose(); controller.dispose();});
  draft.edit({title: 'Original metadata intent', description: 'Original subtitle'}); await draft.submit();
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain'); assert.equal(controller.canRetryMutation(), true);
  draft.edit({title: 'Replacement intent'}); draft.remove(binding(0).album_ref); await draft.submit();
  assert.equal(writes.length, 1); assert.equal(draft.getSnapshot().title, 'Original metadata intent');
  fail = false; await controller.retryMutation();
  const expected = {title: 'Original metadata intent', description: 'Original subtitle', top_ref: F.TOP, revision: '7', request_key: F.id(100)};
  assert.equal(writes.length, 2); assert.equal(writes.every(command => !Object.hasOwn(command, 'items')), true, 'Original omitted-items intent must remain omitted on retry');
  assert.deepEqual(writes, [expected, expected]); assert.deepEqual(keys, [F.id(100)]); assert.deepEqual(data, original);
  assert.deepEqual(draft.getSnapshot().items.map(wire), original.edit_draft.items);
});

test('large metadata intent cannot turn a new revision into an implicit rebase', async t => {
  const {draft, data, mutations, initial, replace} = setup(t, 3000);
  draft.edit({title: 'Keep my title'}); replace({...initial, detail: {status: 'ready', data: {...F.clone(data), revision: '8'}}});
  await draft.submit(); assert.equal(mutations.length, 0); assert.deepEqual(mutations, []); assert.equal(draft.getSnapshot().stale, true);
  assert.equal(draft.getSnapshot().title, 'Keep my title'); assert.equal(draft.getSnapshot().revision, '7');
});
