'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, detail, row, freeze, A, B} = require('./album-tops-native-gallery-fixture.cjs');
const modulePromise = load('album-tops/read-view.mjs');
const refs = rows => rows.map(row => row.album_ref);

test('default and descending curator views use the captured canonical order without rewriting it', async () => {
  const M = await modulePromise, source = freeze(detail({items: [row(12), row()]})), before = JSON.stringify(source);
  assert.deepEqual(refs(M.projectTopReadView(source)), [B, A]);
  assert.deepEqual(refs(M.projectTopReadView(source, {direction: 'desc'})), [A, B]);
  assert.equal(JSON.stringify(source), before);
  for (const row of M.projectTopReadView(source)) assert.ok(source.items.includes(row));
});

for (const sort of ['original', 'year', 'artist', 'album']) for (const direction of ['asc', 'desc']) {
  test(`${sort} ${direction} keeps unknown metadata last and ties stable`, async () => {
    const M = await modulePromise;
    const field = {original: 'original_position', year: 'year', artist: 'artist', album: 'title'}[sort];
    const numeric = ['original', 'year'].includes(sort), low = numeric ? 1 : 'alpha', high = numeric ? 2 : 'Beta';
    const items = [row(11, {[field]: null, original_position: sort === 'original' ? null : 9}),
      row(12, {original_position: 3, [field]: high}), row(13, {original_position: 2, [field]: low}),
      row(14, {original_position: 1, [field]: low})];
    const data = freeze(detail({items})), before = JSON.stringify(data);
    const output = M.projectTopReadView(data, {sort, direction});
    const ties = sort === 'original' ? [items[2], items[3]] : [items[3], items[2]];
    assert.deepEqual(output, direction === 'asc' ? [...ties, items[1], items[0]] : [items[1], ...ties, items[0]]);
    assert.equal(JSON.stringify(data), before);
  });
}

test('original ties preserve canonical sequence and do not reverse when direction changes', async () => {
  const M = await modulePromise, items = [row(12, {original_position: 2}), row(11, {original_position: 2})];
  for (const direction of ['asc', 'desc']) assert.deepEqual(M.projectTopReadView(detail({items}), {sort: 'original', direction}), items);
});

for (const [query, expected] of [['album 11', [A]], ['ARTIST', [A, B]], ['missing', []], ['  ', [A, B]]]) {
  test(`native query projection searches artist or album immediately: ${JSON.stringify(query)}`, async () => {
    const M = await modulePromise;
    assert.deepEqual(refs(M.projectTopReadView(detail(), {query})), expected);
  });
}

for (const completion of ['complete', 'incomplete']) test(`query AND ${completion} uses only known actor-scoped manual progress`, async () => {
  const M = await modulePromise, source = freeze(detail()), before = JSON.stringify(source);
  assert.deepEqual(refs(M.projectTopReadView(source, {query: 'artist', completion})), [completion === 'complete' ? B : A]);
  assert.deepEqual(M.projectTopReadView(source, {query: completion === 'complete' ? 'album 11' : 'album 12', completion}), []);
  assert.deepEqual(M.projectTopReadView(detail({top_viewer_overlay: {item_progress: {}}}), {completion}), []);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(source.completion_summary, {completed: 1, total: 2});
});

test('remote metadata stays in canonical views and is never made playable by projection', async () => {
  const M = await modulePromise, remote = freeze(row(12, {source_kind: 'remote_summary', native_album: null}));
  const source = freeze(detail({items: [row(), remote]}));
  assert.equal(M.projectTopReadView(source, {query: 'album 12'})[0], remote);
  assert.equal(remote.native_album, null);
});

test('dirty/reset state is explicit, bounded and independent from source or Playlist state', async () => {
  const M = await modulePromise;
  assert.equal(M.topReadViewDirty(M.DEFAULT_TOP_READ_VIEW), false);
  for (const patch of [{query: ' '}, {completion: 'complete'}, {sort: 'year'}, {direction: 'desc'}]) assert.equal(M.topReadViewDirty(patch), true);
  assert.deepEqual(M.normalizeTopReadView({sort: 'popularity', completion: 'automatic', direction: 'sideways'}), M.DEFAULT_TOP_READ_VIEW);
  assert.equal(M.normalizeTopReadView({query: 'a'.repeat(250)}).query.length, 200);
  assert.ok(Object.isFrozen(M.DEFAULT_TOP_READ_VIEW));
  assert.ok(Object.isFrozen(M.normalizeTopReadView({query: 'album'})));
});

test('all-unknown sort metadata remains deterministic without guessed values', async () => {
  const M = await modulePromise, items = [row(12, {year: null, original_position: null}), row(11, {year: null, original_position: null})];
  for (const direction of ['asc', 'desc']) assert.deepEqual(M.projectTopReadView(detail({items}), {sort: 'year', direction}), items);
});
