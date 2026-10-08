const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const presentation = import(pathToFileURL(path.join(__dirname, '../../../music_app/static/js/home-friends/comparison-presentation.mjs')));
const side = (listen_count, facts = {}) => Object.freeze({listen_count, ...facts});
const row = (id, yours, friend, fields = {}) => Object.freeze({id, kind: 'track', title: id, yours, friend, ...fields});
const ids = rows => rows.map(item => item.id);
const context = {friendRef: 'friend:1', kind: 'tracks', period: 'week'};
const metricSort = (side = 'yours', key = 'play_count', direction = 'descending') => ({side, key, direction});

test('relations compare only finite nonnegative numbers, including explicit zero', async () => {
  const {comparisonRelation} = await presentation;
  assert.deepEqual(comparisonRelation(0, 1), {symbol: '<', spoken: 'less than'});
  assert.deepEqual(comparisonRelation(1, 0), {symbol: '>', spoken: 'greater than'});
  assert.deepEqual(comparisonRelation(0, 0), {symbol: '=', spoken: 'equal to'});
  assert.deepEqual(comparisonRelation(0.25, 0.25), {symbol: '=', spoken: 'equal to'});
  assert.deepEqual(comparisonRelation(Number.MAX_VALUE, 1), {symbol: '>', spoken: 'greater than'});
  for (const unknown of [null, undefined, '', '0', true, false, NaN, Infinity, -Infinity, -1, {}, [], new Number(0), 0n]) {
    assert.equal(comparisonRelation(unknown, 0), null);
    assert.equal(comparisonRelation(0, unknown), null);
    assert.equal(comparisonRelation(unknown, unknown), null);
  }
});

test('restoration preserves the old shape and scopes an optional metric sort to its exact comparison', async () => {
  const {restoreComparisonPresentation} = await presentation;
  const defaults = {...context, commonOnly: true, order: 'general', ascending: false, view: 'rows', selection: null};
  assert.deepEqual(restoreComparisonPresentation(null, context), defaults);
  const sort = Object.freeze({...metricSort('friend', 'rating', 'ascending'), rawMedia: '/private'});
  const saved = {...defaults, metricSort: sort};
  const restored = restoreComparisonPresentation(saved, context);
  assert.deepEqual(restored, {...defaults, metricSort: metricSort('friend', 'rating', 'ascending')});
  assert.notStrictEqual(restored.metricSort, sort);
  for (const changed of [{friendRef: 'friend:2'}, {kind: 'albums'}, {period: 'month'}]) {
    assert.deepEqual(restoreComparisonPresentation(saved, {...context, ...changed}), {...defaults, ...changed, metricSort: null});
  }
  assert.deepEqual(restoreComparisonPresentation({...defaults, metricSort: null}, context), {...defaults, metricSort: null});
});

test('metric sort restoration allowlists side, direction and the actual kind metrics', async () => {
  const {restoreComparisonPresentation} = await presentation;
  for (const kind of ['tracks', 'albums', 'artists']) {
    for (const key of ['listen_count', 'play_count', 'full_listen_count', 'rating']) {
      const sort = metricSort('friend', key, 'ascending');
      const compatible = key === 'full_listen_count' ? kind === 'albums' : key !== 'rating' || kind !== 'artists';
      assert.deepEqual(restoreComparisonPresentation({...context, kind, metricSort: sort}, {...context, kind}).metricSort,
        compatible ? sort : null, `${kind}: ${key}`);
    }
  }
  for (const sort of [undefined, true, 'yours', [], {}, metricSort('other'), metricSort('yours', 'favorite'),
    metricSort('yours', 'love_tier'), metricSort('yours', 'duration'), metricSort('yours', 'rating', 'up'),
    metricSort('yours', 'play_count', true)]) {
    assert.equal(restoreComparisonPresentation({...context, metricSort: sort}, context).metricSort, null);
  }
  const unsupported = {...context, kind: 'all'};
  assert.equal(restoreComparisonPresentation({...unsupported, metricSort: metricSort()}, unsupported).metricSort, null);
});

test('metric order moves joined pairs together and keeps unknowns last in either direction', async () => {
  const {projectComparisonRows} = await presentation;
  const rows = Object.freeze([
    row('a', side(3, {play_count: 4}), side(3, {play_count: 1})),
    row('b', side(2, {play_count: 1}), side(8, {play_count: 4})),
    row('zero', side(1, {play_count: 0}), side(1, {play_count: 0})),
    row('missing', side(9), side(9)),
    row('text', side(8, {play_count: '99'}), side(8, {play_count: '99'})),
  ]);
  for (const [owner, direction, expected] of [
    ['yours', 'descending', ['a', 'b', 'zero', 'missing', 'text']],
    ['friend', 'descending', ['b', 'a', 'zero', 'missing', 'text']],
    ['yours', 'ascending', ['zero', 'b', 'a', 'missing', 'text']],
    ['friend', 'ascending', ['zero', 'a', 'b', 'missing', 'text']],
  ]) {
    const projected = projectComparisonRows(rows, 'tracks', {metricSort: metricSort(owner, 'play_count', direction)});
    assert.deepEqual(ids(projected), expected);
    for (const item of projected) assert.strictEqual(item, rows.find(source => source.id === item.id));
  }
  assert.deepEqual(ids(rows), ['a', 'b', 'zero', 'missing', 'text']);
  assert.equal(rows[4].yours.play_count, '99');
});

test('metric descriptors require own fields and cannot be arrays with assigned valid fields', async () => {
  const {restoreComparisonPresentation, projectComparisonRows} = await presentation;
  const invalidDescriptors = [Object.create(metricSort()), Object.assign([], metricSort())];
  for (const key of ['side', 'key', 'direction']) {
    const fields = metricSort(), descriptor = Object.create({[key]: fields[key]});
    delete fields[key];
    invalidDescriptors.push(Object.assign(descriptor, fields));
  }
  const rows = [row('a', side(1, {play_count: 99}), side(1)), row('b', side(9, {play_count: 0}), side(9))];
  for (const sort of invalidDescriptors) {
    assert.equal(restoreComparisonPresentation({...context, metricSort: sort}, context).metricSort, null);
    assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {metricSort: sort})), ['b', 'a']);
  }
  // Inherited unrelated properties do not disqualify a complete own descriptor.
  const own = Object.assign(Object.create({unrelated: 'ignored'}), metricSort());
  assert.deepEqual(restoreComparisonPresentation({...context, metricSort: own}, context).metricSort, metricSort());
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {metricSort: own})), ['a', 'b']);
});

test('metric ties preserve the existing General, Yours and Friend order and direction', async () => {
  const {projectComparisonRows} = await presentation;
  const rows = Object.freeze([
    row('a', side(9, {rating: 4}), side(1)), row('b', side(2, {rating: 4}), side(10)),
    row('c', side(4, {rating: 4}), side(4)), row('d', side(1, {rating: 4}), side(1)),
  ]);
  for (const [order, descending, ascendingIds] of [
    ['general', ['b', 'a', 'c', 'd'], ['d', 'c', 'a', 'b']],
    ['yours', ['a', 'c', 'b', 'd'], ['d', 'b', 'c', 'a']],
    ['friend', ['b', 'c', 'a', 'd'], ['a', 'd', 'c', 'b']],
  ]) {
    for (const ascending of [false, true]) {
      // The equal friend listens retain the title/identity tie order in both directions.
      const expected = ascending ? ascendingIds : descending;
      for (const direction of ['ascending', 'descending']) {
        assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {order, ascending, metricSort: metricSort('yours', 'rating', direction)})), expected);
      }
    }
  }
});

test('every supported metric sorts its supplied values without coercing unknown facts', async () => {
  const {projectComparisonRows} = await presentation;
  for (const [kind, keys] of [['tracks', ['listen_count', 'play_count', 'rating']],
    ['albums', ['listen_count', 'full_listen_count', 'play_count', 'rating']], ['artists', ['listen_count', 'play_count']]]) {
    for (const key of keys) {
      const singular = {tracks: 'track', albums: 'album', artists: 'artist'}[kind];
      const rows = Object.freeze([0, 5, null, false, '7', -1, NaN, Infinity].map((value, index) =>
        row(String(index), side(1, {[key]: value}), side(1), {kind: singular})));
      const options = {commonOnly: false, order: 'friend', metricSort: metricSort('yours', key)};
      assert.deepEqual(ids(projectComparisonRows(rows, kind, options)), ['1', '0', '2', '3', '4', '5', '6', '7'], `${kind}: ${key}`);
      assert.deepEqual(ids(projectComparisonRows(rows, kind, {...options, metricSort: metricSort('yours', key, 'ascending')})),
        ['0', '1', '2', '3', '4', '5', '6', '7'], `${kind}: ${key} ascending`);
    }
  }
});

test('invalid metric sorts preserve baseline order and cannot sort unsupported facts', async () => {
  const {projectComparisonRows} = await presentation;
  for (const [kind, key] of [['tracks', 'full_listen_count'], ['artists', 'rating'], ['albums', 'favorite']]) {
    const singular = {tracks: 'track', albums: 'album', artists: 'artist'}[kind];
    const rows = [row('a', side(1, {[key]: 99}), side(1), {kind: singular}), row('b', side(9, {[key]: 0}), side(9), {kind: singular})];
    assert.deepEqual(ids(projectComparisonRows(rows, kind, {metricSort: metricSort('yours', key)})), ['b', 'a']);
  }
  const rows = [row('a', side(1, {play_count: 99}), side(1)), row('b', side(9, {play_count: 0}), side(9))];
  for (const sort of [null, {}, metricSort('foreign'), metricSort('yours', 'play_count', 'up')]) {
    assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {metricSort: sort})), ['b', 'a']);
  }
});

test('metric sort retains Common only, page boundaries, kind filtering and absent sides', async () => {
  const {projectComparisonRows} = await presentation;
  const rows = Object.freeze([
    row('shared', side(2, {play_count: 1}), side(3)), row('yours-only', side(5, {play_count: 8}), null),
    row('friend-only', null, side(5)), row('zero', side(0, {play_count: 4}), side(3)),
    row('album', side(4, {play_count: 99}), side(4), {kind: 'album'}),
  ]);
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {metricSort: metricSort()})), ['shared']);
  const projected = projectComparisonRows(rows, 'tracks', {commonOnly: false, metricSort: metricSort()});
  assert.deepEqual(ids(projected), ['yours-only', 'zero', 'shared', 'friend-only']);
  assert.strictEqual(projected[0].friend, null);
  assert.strictEqual(projected[3].yours, null);
  assert.deepEqual(projectComparisonRows([], 'tracks', {metricSort: metricSort()}), []);
});

test('extracted presentation facts and selection retain nullable Favorite and identity-only behavior', async () => {
  const {comparisonFacts, comparisonSelection, restoreComparisonPresentation, reconcileComparisonSelection} = await presentation;
  const source = row('track:1', side(0, {rating: 0, favorite: false}), null, {album_ref: '/private', allowed_actions: {can_play: true}});
  assert.deepEqual(comparisonFacts(source.yours, 'tracks'), [
    ['listen_count', 'Listens', '0'], ['play_count', 'PC', '–'], ['rating', 'Rating', '0'], ['favorite', 'Favorite', 'No'],
  ]);
  assert.deepEqual(comparisonFacts(null, 'artists'), [['listen_count', 'Listens', '–'], ['play_count', 'PC', '–']]);
  const selection = comparisonSelection(source);
  assert.deepEqual(selection, {id: 'track:1', kind: 'track'});
  assert.deepEqual(restoreComparisonPresentation({...context, selection: source, metricSort: metricSort()}, context).selection, selection);
  for (const status of ['loading', 'unavailable', 'error', 'ready']) {
    assert.strictEqual(reconcileComparisonSelection(selection, status, [source]), selection);
  }
  for (const status of ['denied', 'empty', 'ready']) assert.equal(reconcileComparisonSelection(selection, status, []), null);
});
