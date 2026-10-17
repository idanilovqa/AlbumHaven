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

test('blank opening and cleared search never traverse inventory and retain Selected', async t => {
  const {draft, calls, mutations} = setup(t);
  assert.equal(calls.search.length, 0); assert.deepEqual(refs(draft), []);
  await draft.setQuery('   '); assert.equal(calls.search.length, 0);
  await selected(draft); draft.setTab('selected'); await draft.setQuery('');
  assert.deepEqual(refs(draft), [F.A]); assert.deepEqual(searchRefs(draft), []);
  assert.equal(draft.getSnapshot().tab, 'selected'); assert.deepEqual(mutations, []);
});

test('empty create needs a valid title and submits exactly the bounded create payload', async t => {
  const {draft, mutations} = setup(t);
  await draft.submit(); draft.edit({title: '   '}); await draft.submit(); assert.deepEqual(mutations, []);
  draft.edit({title: 'Empty collection', description: 'A subtitle'}); await draft.submit();
  assert.deepEqual(mutations, [{action: 'create', payload: {title: 'Empty collection', description: 'A subtitle', album_refs: []}}]);
});

test('query races discard late success and late denial without erasing current selection', async t => {
  const old = F.deferred(), current = F.deferred();
  const {draft, calls} = setup(t, {search: ({q}) => q === 'old' ? old.promise : current.promise});
  const first = draft.setQuery('old'), second = draft.setQuery('new');
  current.resolve({albums: [F.album(12)], next_cursor: null}); await second;
  old.reject(F.error(403)); await first;
  assert.deepEqual(searchRefs(draft), [F.B]); assert.equal(draft.getSnapshot().denied, false);
  assert.equal(calls.search[0].signal.aborted, true);
});

test('canonical aliases collapse across selected rows, pages and admission replies', async t => {
  const {draft, calls} = setup(t, {search: ({cursor}) => ({albums: cursor ? [F.album(14, {album_ref: F.A}), F.album(12)] :
    [F.album(11, {album_ref: null}), F.album(13, {album_ref: null})], next_cursor: cursor ? null : 'page-2'}), admit: () => ({album_ref: F.A})});
  await draft.setQuery('Artist'); await draft.select(F.album(11, {album_ref: null}));
  await draft.select(F.album(13, {album_ref: null})); await draft.loadMore();
  assert.deepEqual(refs(draft), [F.A]); assert.equal(searchRefs(draft).includes(F.A), false);
  assert.equal(searchRefs(draft).includes(F.B), true); assert.equal(calls.admit.length, 2);
  draft.remove(F.A); assert.deepEqual(refs(draft), []);
  await draft.setQuery('Artist'); await draft.select(F.album(11, {album_ref: null})); assert.deepEqual(refs(draft), [F.A]);
});

test('a denied-filtered empty page with a continuation remains pageable', async t => {
  const {draft, calls} = setup(t, {search: ({cursor}) => cursor ? {albums: [F.album()], next_cursor: null} : {albums: [], next_cursor: 'next-visible-page'}});
  await draft.setQuery('Album'); assert.deepEqual(searchRefs(draft), []); assert.equal(draft.getSnapshot().search.next_cursor, 'next-visible-page');
  await draft.loadMore(); assert.deepEqual(searchRefs(draft), [F.A]); assert.equal(calls.search[1].cursor, 'next-visible-page');
});

test('admission owns an identity once, survives metadata aliases and freezes submit while pending', async t => {
  const gate = F.deferred(); const {draft, calls, mutations} = setup(t, {admit: () => gate.promise});
  draft.edit({title: 'Pending selection'}); await draft.setQuery('Album');
  const selecting = draft.select(F.album()); await draft.select(F.album()); await draft.submit();
  assert.equal(calls.admit.length, 1); assert.deepEqual(mutations, []);
  gate.resolve({album_ref: F.C}); await selecting; assert.deepEqual(refs(draft), [F.C]);
  await draft.submit(); assert.deepEqual(mutations[0].payload.album_refs, [F.C]);
});

test('transient search failure preserves authored membership and the next search recovers', async t => {
  let fail = false; const {draft} = setup(t, {search: () => {if (fail) throw F.error(503); return {albums: [F.album()], next_cursor: null};}});
  await selected(draft); draft.edit({title: 'Keep this'}); fail = true; await draft.setQuery('failing');
  assert.equal(draft.getSnapshot().search.status, 'error'); assert.deepEqual(refs(draft), [F.A]); assert.equal(draft.getSnapshot().title, 'Keep this');
  fail = false; await draft.setQuery('recovered'); assert.equal(draft.getSnapshot().denied, false);
});

test('edit detaches source objects and saves rename, removal, ordering and addition in one command', async t => {
  const initial = F.state({editing: true}), before = F.clone(initial.detail.data);
  const {draft, mutations} = setup(t, {initial, search: () => ({albums: [F.album(13)], next_cursor: null})});
  assert.equal(draft.getSnapshot().dirty, false); await draft.submit(); assert.deepEqual(mutations, []);
  await selected(draft, F.album(13)); draft.edit({title: 'Renamed', description: 'Rewritten'}); draft.reorder([F.C, F.B, F.A]); draft.remove(F.B);
  assert.deepEqual(initial.detail.data, before); await draft.submit();
  assert.equal(mutations.length, 1); assert.deepEqual(mutations[0], {action: 'save', payload: {title: 'Renamed', description: 'Rewritten', items: [
    {item_ref: null, album_ref: F.C}, {item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE},
  ]}}); assert.deepEqual(initial.detail.data, before);
});

test('nonlocal retained member survives absent search results and keeps its exact saved identity', async t => {
  const {draft, mutations} = setup(t, {initial: F.state({editing: true}), search: () => ({albums: [], next_cursor: null})});
  await draft.setQuery('local only'); assert.deepEqual(refs(draft), [F.A, F.B]);
  draft.edit({title: 'Rename only'}); await draft.submit();
  assert.equal(Object.hasOwn(mutations[0].payload, 'items'), false);
  assert.deepEqual(refs(draft), [F.A, F.B]);
  assert.deepEqual(draft.getSnapshot().items.map(({item_ref, album_ref}) => ({item_ref, album_ref})), [{item_ref: F.IA, album_ref: F.A}, {item_ref: F.IB, album_ref: F.B}]);
});

test('reorder accepts only an exact unique permutation and reverting changes removes dirty state', t => {
  const {draft} = setup(t, {initial: F.state({editing: true})});
  for (const invalid of [[F.A], [F.A, F.A], [F.A, F.C], [F.A, F.B, F.C]]) {draft.reorder(invalid); assert.deepEqual(refs(draft), [F.A, F.B]);}
  draft.reorder([F.B, F.A]); assert.equal(draft.getSnapshot().dirty, true);
  draft.reorder([F.A, F.B]); assert.equal(draft.getSnapshot().dirty, false);
});

for (const reason of ['scope', 'top', 'denied']) test(`${reason} change retires pending selection and prevents any late write`, async t => {
  const gate = F.deferred(), initial = F.state({editing: true});
  const {draft, calls, mutations, replace} = setup(t, {initial, search: () => ({albums: [F.album(13)], next_cursor: null}), admit: () => gate.promise});
  await draft.setQuery('Album'); const selecting = draft.select(F.album(13));
  replace(reason === 'scope' ? {...initial, scopeKey: 'another-library'} : reason === 'top' ? {...initial, selectedTopRef: F.OTHER} : {...initial, detail: {status: 'denied', data: null}});
  gate.resolve({album_ref: F.C}); await selecting; draft.edit({title: 'Late'}); await draft.submit();
  assert.equal(calls.admit[0].options.signal.aborted, true); assert.equal(refs(draft).includes(F.C), false); assert.deepEqual(mutations, []);
});

test('new revision preserves the draft but cannot silently rebase Save', async t => {
  const initial = F.state({editing: true}), {draft, mutations, replace} = setup(t, {initial});
  draft.edit({title: 'My unsaved title'}); replace({...initial, detail: {status: 'ready', data: {...initial.detail.data, revision: '8'}}});
  assert.equal(draft.getSnapshot().stale, true); assert.equal(draft.getSnapshot().title, 'My unsaved title');
  await draft.submit(); assert.deepEqual(mutations, []);
});

for (const patch of [{can_edit: false}, {[F.BROWSE]: false}, {[F.ITEMS]: false}, {can_add: 'true', can_remove: 'true', can_reorder: 'true'}]) {
  test(`revoked or nonboolean edit grants stop authoring: ${Object.keys(patch).join(',')}`, async t => {
    const initial = F.state({editing: true}); initial.detail.data.allowed_actions = {...initial.detail.data.allowed_actions, ...patch};
    const {draft, mutations, calls} = setup(t, {initial});
    const before = F.clone(draft.getSnapshot().items); draft.remove(F.A); draft.reorder([F.B, F.A]); await draft.setQuery('Album'); await draft.submit();
    assert.deepEqual(draft.getSnapshot().items, before); assert.deepEqual(mutations, []); assert.deepEqual(calls.admit, []);
  });
}

test('published retained evidence is previewed once and unchanged membership is omitted from the single Save', async t => {
  const data = F.detail(); data.items = data.items.slice(0, 1); data.edit_draft.items = data.edit_draft.items.slice(0, 1); data.edit_draft.publication_preview_required = true;
  const {draft, calls, mutations} = setup(t, {initial: F.state({editing: true, data})});
  draft.edit({title: 'Published rename'}); await draft.submit();
  assert.equal(calls.preview.length, 1); assert.deepEqual(calls.preview[0].payload, {revision: '7', items: [{item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE}]});
  assert.equal(mutations.length, 1); assert.equal(mutations[0].payload.evidence_revision, 'a'.repeat(64));
  assert.equal(Object.hasOwn(mutations[0].payload, 'items'), false);
  assert.deepEqual(data.edit_draft.items, calls.preview[0].payload.items);
});

test('published evidence-less addition blocks before preview or Save and retains the whole draft', async t => {
  const data = F.detail(); data.edit_draft.publication_preview_required = true;
  const {draft, calls, mutations} = setup(t, {initial: F.state({editing: true, data}), search: () => ({albums: [F.album(13)], next_cursor: null})});
  await selected(draft, F.album(13)); draft.edit({title: 'Not lost'}); await draft.submit();
  assert.deepEqual(refs(draft), [F.A, F.B, F.C]); assert.equal(draft.getSnapshot().title, 'Not lost');
  assert.ok(draft.getSnapshot().error); assert.deepEqual(calls.preview, []); assert.deepEqual(mutations, []);
});

test('preview freezes intent and a newer revision invalidates its late evidence', async t => {
  const data = F.detail(); data.items = data.items.slice(0, 1); data.edit_draft.items = data.edit_draft.items.slice(0, 1); data.edit_draft.publication_preview_required = true;
  const initial = F.state({editing: true, data}), gate = F.deferred();
  const {draft, calls, mutations, replace} = setup(t, {initial, preview: () => gate.promise});
  draft.edit({title: 'Previewed'}); const saving = draft.submit(); draft.edit({title: 'Not previewed'}); draft.remove(F.A); await draft.submit();
  assert.equal(draft.getSnapshot().title, 'Previewed'); assert.deepEqual(refs(draft), [F.A]); assert.equal(calls.preview.length, 1);
  replace({...initial, detail: {status: 'ready', data: {...data, revision: '8'}}});
  gate.resolve({top_ref: F.TOP, revision: '7', evidence_revision: 'a'.repeat(64), items: []}); await saving;
  assert.deepEqual(mutations, []); assert.equal(draft.getSnapshot().stale, true);
});

test('dispose aborts pending work, unsubscribes and never persists Cancelled selection', async t => {
  const gate = F.deferred(); const {draft, calls, mutations, listeners} = setup(t, {search: () => gate.promise});
  const searching = draft.setQuery('Album'); draft.dispose(); gate.resolve({albums: [F.album()], next_cursor: null}); await searching;
  await draft.select(F.album()); await draft.submit();
  assert.equal(calls.search[0].signal.aborted, true); assert.equal(listeners.size, 0); assert.deepEqual(mutations, []);
});
