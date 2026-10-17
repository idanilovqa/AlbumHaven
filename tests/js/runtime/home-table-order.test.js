const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {pathToFileURL} = require('node:url');

const tableOrder = import(pathToFileURL(path.join(__dirname, '../../../music_app/static/js/home-friends/table-order.mjs')));
const ids = rows => rows.map(row => row.id);

test('a header cycles ascending, descending and original order without retaining the old key', async () => {
  const {cycleTableSort} = await tableOrder;
  const ascending = cycleTableSort(null, 'plays');
  assert.deepEqual(ascending, {key: 'plays', direction: 'asc'});
  const descending = cycleTableSort(ascending, 'plays');
  assert.deepEqual(descending, {key: 'plays', direction: 'desc'});
  assert.deepEqual(cycleTableSort(descending, 'plays'), {key: null, direction: 'default'});
  assert.deepEqual(cycleTableSort(descending, 'length'), {key: 'length', direction: 'asc'});
  assert.deepEqual(cycleTableSort({key: 'plays', direction: 'bad'}, 'plays'), ascending);
  assert.deepEqual(ascending, {key: 'plays', direction: 'asc'});
});

test('numeric sorting preserves true zero and keeps all unknown values last in both directions', async () => {
  const {sortTableRows} = await tableOrder;
  const values = [null, 3, 0, undefined, NaN, Infinity, -Infinity, '', '9', false, 3];
  const rows = Object.freeze(values.map((value, id) => Object.freeze({id, value})));
  const columns = {plays: {type: 'number', getValue: row => row.value}};
  assert.deepEqual(ids(sortTableRows(rows, {key: 'plays', direction: 'asc'}, columns)), [2, 1, 10, 0, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids(sortTableRows(rows, {key: 'plays', direction: 'desc'}, columns)), [1, 10, 2, 0, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ids(rows), values.map((_, index) => index));
});

test('sorting uses explicit accessors once per row and resets to the latest incoming author order', async () => {
  const {sortTableRows, cycleTableSort} = await tableOrder;
  const rows = [{id: 'later', stats: {plays: 5}}, {id: 'earlier', stats: {plays: 1}}];
  let reads = 0;
  const columns = {plays: {type: 'number', getValue: row => {reads++; return row.stats.plays;}}};
  const asc = cycleTableSort(null, 'plays'), desc = cycleTableSort(asc, 'plays');
  const sorted = sortTableRows(rows, asc, columns);
  assert.deepEqual(ids(sorted), ['earlier', 'later']);
  assert.equal(reads, 2);
  assert.equal(sorted[0], rows[1], 'sorting retains original row/action identity');
  const nextRows = [rows[1], {id: 'new', stats: {plays: 2}}, rows[0]];
  const restored = sortTableRows(nextRows, cycleTableSort(desc, 'plays'), columns);
  assert.deepEqual(restored, nextRows);
  assert.notEqual(restored, nextRows);
  assert.equal(reads, 2, 'default order must not access sort values');
});

test('text and boolean columns do not coerce missing or mismatched values', async () => {
  const {sortTableRows} = await tableOrder;
  const text = [{id: 'ten', value: 'Track 10'}, {id: 'two', value: 'Track 2'}, {id: 'same', value: 'track 2'},
    {id: 'blank', value: ' '}, {id: 'missing'}, {id: 'number', value: 0}];
  const columns = {label: {type: 'text', getValue: row => row.value}};
  assert.deepEqual(ids(sortTableRows(text, {key: 'label', direction: 'asc'}, columns)), ['two', 'same', 'ten', 'blank', 'missing', 'number']);
  assert.deepEqual(ids(sortTableRows(text, {key: 'label', direction: 'desc'}, columns)), ['ten', 'two', 'same', 'blank', 'missing', 'number']);
  const booleans = [{id: 'unknown', value: null}, {id: 'yes', value: true}, {id: 'no', value: false}, {id: 'zero', value: 0}];
  const booleanColumn = {love: {type: 'boolean', getValue: row => row.value}};
  assert.deepEqual(ids(sortTableRows(booleans, {key: 'love', direction: 'asc'}, booleanColumn)), ['no', 'yes', 'unknown', 'zero']);
  assert.deepEqual(ids(sortTableRows(booleans, {key: 'love', direction: 'desc'}, booleanColumn)), ['yes', 'no', 'unknown', 'zero']);
});

test('unavailable columns and invalid descriptors retain source order without invoking an accessor', async () => {
  const {sortTableRows} = await tableOrder;
  const rows = [{id: 'b'}, {id: 'a'}];
  const inaccessible = () => {throw new Error('should not read this value');};
  const columns = {plays: {type: 'number', getValue: inaccessible}, unknown: {type: 'unsupported', getValue: inaccessible},
    noAccessor: {type: 'text'}, undefined: {type: 'number', getValue: inaccessible}};
  for (const sort of [null, {key: 'plays', direction: 'default'}, {key: 'plays', direction: 'invalid'},
    {key: 'missing', direction: 'asc'}, {key: 'unknown', direction: 'asc'}, {key: 'noAccessor', direction: 'desc'}, {key: 'constructor', direction: 'asc'}]) {
    const ordered = sortTableRows(rows, sort, columns);
    assert.deepEqual(ordered, rows);
    assert.notEqual(ordered, rows);
  }
  assert.deepEqual(sortTableRows([], {key: 'plays', direction: 'asc'}, columns), []);
});
