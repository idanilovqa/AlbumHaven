const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
// Existing owned_album_tops.py MAX_TOP_COMMAND_BYTES; applies equally to preview and mutation routes.
const LIMIT = 512 * 1024, CONTEXT = 'a'.repeat(64), EVIDENCE = 'b'.repeat(64);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const binding = index => ({item_ref: F.id(10000 + index), album_ref: F.id(20000 + index), selected_local_album_id: 1, selected_source_ref: F.id(30000 + index)});
const options = () => ({scopeKey: F.SCOPE, signal: new AbortController().signal});
let createAlbumTopBackendProviders, createAlbumTopDraft, createAlbumTopController;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
});
function fixture(t) {
  const calls = [], transport = {context: () => CONTEXT, async request(path, request) {
    const body = F.clone(request.body); calls.push({path, body, bytes: bytes(body)});
    const data = path.endsWith('/publication-preview') ? {top_ref: F.TOP, revision: body.revision, evidence_revision: EVIDENCE,
      items: body.items.map(row => ({...row, title: 'Album', artist: 'Artist', year: null, track_count: 1}))}
      : {top_ref: F.TOP, revision: '8', action: 'save', request_key: body.request_key};
    return {status: 'ready', context_ref: CONTEXT, data};
  }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => scope === F.SCOPE});
  t.after(() => providers.dispose()); return {providers, calls};
}
function fillItems(body, target) {
  const count = Math.floor((target - bytes({...body, items: []}) + 1) / (bytes(binding(0)) + 1));
  assert.ok(count > 0 && count <= 5000);
  return {...body, items: Array.from({length: count}, (_, index) => binding(index))};
}
function exactPreview(target) {
  const body = fillItems({revision: '7'}, target); let remaining = target - bytes(body);
  // Increase valid positive safe-integer digit lengths, without changing item count or using forbidden fields.
  for (const row of body.items) {if (!remaining) break; const extra = Math.min(remaining, 15); row.selected_local_album_id = 10 ** extra; remaining -= extra;}
  assert.equal(remaining, 0); assert.equal(bytes(body), target); return body;
}
function exactCommandBody(target) {
  const body = fillItems({request_key: F.id(100), revision: '7', title: 'Unicode é😀 and JSON "\\\n', description: ''}, target);
  const remaining = target - bytes(body);
  body.description = '界'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3);
  assert.ok(body.description.length <= 2000); assert.equal(bytes(body), target);
  assert.ok(JSON.stringify(body).length < target); return body;
}

for (const delta of [-1, 0, 1]) test(`preview actual serialized body at 512 KiB ${delta >= 0 ? '+' : ''}${delta} bytes respects the inclusive route boundary`, async t => {
  const {providers, calls} = fixture(t), payload = exactPreview(LIMIT + delta), original = F.clone(payload);
  if (delta > 0) {await assert.rejects(providers.preview(F.TOP, payload, options()), error => error.code === 'command_too_large' && error.status === 413); assert.equal(calls.length, 0); assert.deepEqual(calls, []);}
  else {const result = await providers.preview(F.TOP, payload, options()); assert.equal(result.evidence_revision, EVIDENCE);
    assert.deepEqual(calls, [{path: `/album-tops/${F.TOP}/publication-preview`, body: payload, bytes: LIMIT + delta}]);}
  assert.deepEqual(payload, original);
});

for (const delta of [-1, 0, 1]) test(`Save actual UTF-8 body at 512 KiB ${delta >= 0 ? '+' : ''}${delta} counts JSON escapes and excludes path-only top_ref`, async t => {
  const {providers, calls} = fixture(t), body = exactCommandBody(LIMIT + delta), command = {top_ref: F.TOP, ...body}, original = F.clone(command);
  assert.ok(bytes(command) > LIMIT); // A naive command-object budget would reject boundary-valid requests.
  if (delta > 0) {await assert.rejects(providers.execute('save', command, options()), error => error.code === 'command_too_large' && error.status === 413); assert.equal(calls.length, 0); assert.deepEqual(calls, []);}
  else {await providers.execute('save', command, options()); assert.deepEqual(calls, [{path: `/album-tops/${F.TOP}/save`, body, bytes: LIMIT + delta}]);}
  assert.deepEqual(command, original);
});

test('preview budgets its projected wire body, never harmless presentation metadata that will not be sent', async t => {
  const {providers, calls} = fixture(t), item = binding(0), payload = {revision: '7', items: [{...item, title: '界'.repeat(LIMIT)}]};
  assert.ok(bytes(payload) > LIMIT);
  await providers.preview(F.TOP, payload, options());
  assert.deepEqual(calls, [{path: `/album-tops/${F.TOP}/publication-preview`, body: {revision: '7', items: [item]}, bytes: bytes({revision: '7', items: [item]})}]);
});

for (const count of [3000, 5000]) for (const published of [false, true]) test(`${count} source bindings: oversized ${published ? 'published metadata preview' : 'changed membership command'} fails locally without partial transport writes`, async t => {
  const remote = fixture(t), bindings = Array.from({length: count}, (_, index) => binding(index));
  const data = F.detail({items: bindings.map((row, index) => ({...row, title: 'Album ' + index, artist: 'Artist', year: null, position: index + 1})),
    edit_draft: {items: F.clone(bindings), publication_preview_required: published}}), original = F.clone(data);
  assert.ok(bytes({revision: '7', items: bindings}) > LIMIT);
  const providers = {...remote.providers, list: async () => F.state({data}).directory.data, read: async () => F.clone(data)};
  const controller = createAlbumTopController({providers, requestKey: () => F.id(100)});
  controller.setScope(F.SCOPE); await controller.load(); await controller.open(F.TOP);
  const draft = createAlbumTopDraft({controller, providers}); t.after(() => {draft.dispose(); controller.dispose();});
  draft.edit({title: 'Keep my authored title', description: 'Keep my subtitle'});
  if (!published) draft.reorder(bindings.map(row => row.album_ref).reverse());
  const before = F.clone(draft.getSnapshot().items); assert.equal(await draft.submit(), false);
  assert.equal(remote.calls.length, 0, 'Oversized intent must never reach transport');
  assert.deepEqual(remote.calls, []); assert.deepEqual(data, original); assert.deepEqual(draft.getSnapshot().items, before);
  assert.equal(draft.getSnapshot().title, 'Keep my authored title'); assert.equal(draft.getSnapshot().description, 'Keep my subtitle');
  assert.equal(draft.getSnapshot().dirty, true); assert.equal(draft.getSnapshot().busy, false);
  const error = published ? draft.getSnapshot().error : controller.getSnapshot().mutation.error;
  assert.equal(error.code, 'command_too_large'); assert.equal(error.status, 413);
  assert.equal(controller.canRetryMutation(), false);
  draft.dispose(); assert.deepEqual(data, original); assert.equal(remote.calls.length, 0); assert.deepEqual(remote.calls, []);
});
