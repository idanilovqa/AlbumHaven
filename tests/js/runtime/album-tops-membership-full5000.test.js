const test = require('node:test');
const assert = require('node:assert/strict');
const {F, dataset, setup, countReads, observe} = require('./album-tops-membership-fixtures/full5000.cjs');
const N = 5000;
let createAlbumTopDraft;
test.before(async () => {({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));});

test('5000 retained bindings initialize with a linear lookup pass and unchanged local/nonlocal facts', t => {
  const {data, expected} = dataset(N), original = F.clone(data);
  const counter = countReads(data.edit_draft.items, 'item_ref');
  t.after(() => counter.restore());
  const measured = observe(t, 'initialize-5000', counter, () => setup(createAlbumTopDraft, data));
  const {draft, writes} = measured.result;
  t.after(() => draft.dispose());
  assert.deepEqual(draft.getSnapshot().items, expected);
  assert.equal(draft.getSnapshot().dirty, false);
  assert.deepEqual(data, original);
  assert.deepEqual(writes, []);
  assert.ok(measured.reads <= 2 * N, `binding.item_ref reads ${measured.reads} exceed one index pass plus one copy per retained binding (${2 * N})`);
});

test('5000-member reorder preserves exact row identities and bindings with one identity-index plus dirty scan', t => {
  const {data, expected} = dataset(N), original = F.clone(data);
  const {draft, writes} = setup(createAlbumTopDraft, data);
  t.after(() => draft.dispose());
  const before = [...draft.getSnapshot().items], refs = Object.freeze(expected.map(row => row.album_ref));
  const reversed = Object.freeze([...refs].reverse()), counter = countReads(before, 'album_ref');
  t.after(() => counter.restore());
  const moved = observe(t, 'reverse-5000', counter, () => draft.reorder(reversed));
  assert.equal(moved.result, true);
  const movedRows = draft.getSnapshot().items;
  for (let index = 0; index < N; index++) assert.equal(movedRows[index], before[N - index - 1]);
  assert.deepEqual(movedRows, [...expected].reverse());
  assert.equal(draft.getSnapshot().dirty, true);
  const restored = observe(t, 'restore-5000', counter, () => draft.reorder(refs));
  assert.equal(restored.result, true);
  for (let index = 0; index < N; index++) assert.equal(draft.getSnapshot().items[index], before[index]);
  assert.deepEqual(draft.getSnapshot().items, expected);
  assert.equal(draft.getSnapshot().dirty, false);
  assert.deepEqual(data, original);
  assert.deepEqual(writes, []);
  assert.ok(moved.reads <= 2 * N, `reverse album_ref reads ${moved.reads} exceed ${2 * N}`);
  assert.ok(restored.reads <= 2 * N, `restore album_ref reads ${restored.reads} exceed ${2 * N}`);
});

test('5000-member reorder rejects incomplete duplicate unknown and non-string vectors without emitting', t => {
  const {data, expected} = dataset(N), {draft, writes} = setup(createAlbumTopDraft, data);
  t.after(() => draft.dispose());
  const before = draft.getSnapshot(), refs = expected.map(row => row.album_ref);
  let emissions = 0; const unsubscribe = draft.subscribe(() => emissions++); t.after(unsubscribe);
  const invalid = [null, {}, [], refs.slice(1), [...refs, F.id(90000)],
    [refs[1], ...refs.slice(1)], [F.id(90000), ...refs.slice(1)],
    [null, ...refs.slice(1)], [false, ...refs.slice(1)], [20000, ...refs.slice(1)]];
  for (const vector of invalid) {
    assert.equal(draft.reorder(vector), false);
    assert.equal(draft.getSnapshot(), before);
    assert.deepEqual(draft.getSnapshot().items, expected);
  }
  assert.equal(emissions, 0);
  assert.deepEqual(writes, []);
});

test('5000-member reorder rejects a sparse vector rather than inserting an unowned hole', t => {
  const {data, expected} = dataset(N), {draft, writes} = setup(createAlbumTopDraft, data);
  t.after(() => draft.dispose());
  const before = draft.getSnapshot(), sparse = expected.map(row => row.album_ref); delete sparse[2500];
  let emissions = 0; const unsubscribe = draft.subscribe(() => emissions++); t.after(unsubscribe);
  assert.equal(draft.reorder(sparse), false, 'An exact permutation must contain a supplied identity at every index');
  assert.equal(draft.getSnapshot(), before);
  assert.deepEqual(draft.getSnapshot().items, expected);
  assert.equal(emissions, 0);
  assert.deepEqual(writes, []);
});

test('initial binding join preserves first duplicate match and safely retains an absent binding', t => {
  const {data, expected} = dataset(3), first = {...data.edit_draft.items[0]};
  const duplicate = {...first, selected_local_album_id: 999, selected_source_ref: F.id(99999)};
  data.edit_draft.items = [first, duplicate, data.edit_draft.items[2]];
  const original = F.clone(data), {draft, writes} = setup(createAlbumTopDraft, data);
  t.after(() => draft.dispose());
  assert.deepEqual(draft.getSnapshot().items, expected);
  assert.equal(draft.getSnapshot().items[0].selected_source_ref, first.selected_source_ref);
  assert.equal(Object.hasOwn(draft.getSnapshot().items[1], 'selected_source_ref'), false);
  assert.equal(draft.getSnapshot().items[1].item_ref, data.items[1].item_ref);
  assert.equal(draft.getSnapshot().dirty, false);
  assert.deepEqual(data, original);
  assert.deepEqual(writes, []);
});
