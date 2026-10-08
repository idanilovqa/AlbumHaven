const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
let metrics, order, model;
test.before(async () => {
  metrics = await import('../../../music_app/static/js/playlists/track-metrics.mjs');
  order = await import('../../../music_app/static/js/home-friends/table-order.mjs');
  model = await import('../../../music_app/static/js/playlists/model.mjs');
});
function nativeTable(row, options) {
  const native = createNativeHomeRuntime(), {context, document} = native;
  vm.runInContext(readRepo('music_app/static/js/runtime/compact-data-table.js'), context);
  const runtime = {escapeHtml: context.escapeHtml, iconHtml: (name, config) => context.ButtonComponent.renderIconSvg(name, config),
    ratingHtml: context.buildGalleryRatingHtml};
  const host = document.createElement('div');
  host.innerHTML = context.buildCompactDataTable({id: 'metric-test', columnsConfig: metrics.playlistTrackMetricColumns(options),
    rows: [{key: 'row', cells: metrics.playlistTrackMetricCells(runtime, row)}]});
  const cell = key => host.querySelector(`[role="cell"][data-cdt-column="${key}"]`);
  return {host, cell};
}

test('native metrics distinguish personal plays, global popularity and optional track rating', () => {
  const {host, cell} = nativeTable({love_tier: 'obsessed', track_rating: 4, play_count: 0,
    popularity_count: 70001, listen_count: 88, scrobble_count: 900, duration_seconds: 179.9});
  assert.deepEqual([...host.querySelectorAll('[role="columnheader"]')].map(node => node.dataset.cdtColumn),
    ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'duration']);
  assert.equal(host.querySelector('[data-cdt-sort="track_rating"]'), null);
  assert.deepEqual(metrics.playlistTrackMetricColumns().filter(column => column.hideWhenNarrow).map(column => column.key), ['track_rating']);
  assert.equal(cell('play_count').textContent, '0'); assert.equal(cell('popularity_count').textContent, '70001');
  assert.equal(cell('duration').textContent, '2:59');
  assert.equal(cell('love_tier').querySelector('[role="img"]').getAttribute('aria-label'), 'Obsessed');
  assert.ok(cell('love_tier').querySelector('svg'));
  assert.equal(cell('track_rating').querySelector('[role="img"]').getAttribute('aria-label'), 'Track rating: 4 out of 5');
  assert.equal(cell('track_rating').querySelectorAll('.filled').length, 4);
  assert.match(cell('love_tier').innerHTML, /Love editing is unavailable/);
  assert.match(cell('track_rating').innerHTML, /Rating editing is unavailable/);
  for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'duration']) {
    assert.equal(cell(key).querySelector('button,input,[tabindex],[aria-pressed],[data-rating-star]'), null);
  }
  const withoutRating = nativeTable({}, {includeRating: false});
  assert.equal(withoutRating.cell('track_rating'), null);
  assert.deepEqual(metrics.playlistTrackMetricColumns({includeRating: false}).map(column => column.key),
    ['love_tier', 'play_count', 'popularity_count', 'duration']);
});

test('missing, inherited, invalid and denied metrics stay unknown instead of borrowing listening totals', () => {
  const known = {love_tier: 'loved', track_rating: 5, play_count: 33, popularity_count: 9999, duration_seconds: 123};
  for (const input of [{listen_count: 88, scrobble_count: 900}, Object.create(known),
    {love_tier: '<img>', track_rating: '5', play_count: -1, popularity_count: Infinity, duration_seconds: '123'},
    {...known, source_readable: false}, {...known, allowed_actions: {can_read: false}}]) {
    const {cell} = nativeTable(input);
    for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'duration']) {
      assert.equal(cell(key).textContent, '–', key);
      assert.equal(metrics.getPlaylistTrackMetricValue(input, key), null, key);
    }
  }
  assert.equal(nativeTable({love_tier: 'off'}).cell('love_tier').querySelector('[role="img"]').getAttribute('aria-label'), 'Not loved');
  assert.equal(metrics.getPlaylistTrackMetricValue({love_tier: 'off'}, 'love_tier'), 0);
  assert.equal(nativeTable({duration_seconds: 0}).cell('duration').textContent, '0:00');
});

test('supplied legacy length text remains display-only and cannot reveal denied metadata', () => {
  const row = {duration_display: '<3:21>'};
  assert.equal(nativeTable(row).cell('duration').textContent, '<3:21>');
  assert.match(nativeTable(row).cell('duration').innerHTML, /&lt;3:21&gt;/);
  assert.equal(metrics.getPlaylistTrackMetricValue(row, 'duration'), null);
  assert.equal(nativeTable({...row, duration_seconds: 12}).cell('duration').textContent, '0:12');
  for (const unknown of [Object.create(row), Object.assign([], row), {...row, source_readable: false}, {...row, allowed_actions: {can_read: false}}]) {
    assert.equal(nativeTable(unknown).cell('duration').textContent, '–');
  }
});

test('metric sorting uses supplied numeric facts, preserves ties and never changes authored rows', () => {
  const rows = [Object.freeze({id: 'unknown', listen_count: 999}), Object.freeze({id: 'ten', play_count: 10}),
    Object.freeze({id: 'zero', play_count: 0}), Object.freeze({id: 'ten-again', play_count: 10})];
  const columns = Object.fromEntries(metrics.playlistTrackMetricColumns().map(column => [column.key,
    {type: column.type, getValue: row => metrics.getPlaylistTrackMetricValue(row, column.key)}]));
  const sorted = order.sortTableRows(rows, {key: 'play_count', direction: 'asc'}, columns);
  assert.deepEqual(sorted.map(row => row.id), ['zero', 'ten', 'ten-again', 'unknown']);
  assert.strictEqual(sorted[0], rows[2]);
  assert.deepEqual(order.sortTableRows(rows, {key: 'play_count', direction: 'desc'}, columns).map(row => row.id),
    ['ten', 'ten-again', 'zero', 'unknown']);
  assert.deepEqual(rows.map(row => row.id), ['unknown', 'ten', 'zero', 'ten-again']);
  assert.deepEqual(order.sortTableRows(rows, {key: null, direction: 'default'}, columns), rows);
});

test('playlist model retains supplied metrics and strips denied row display facts before rendering', () => {
  const input = {playlist_sidebar: {items: []}, playlist_detail: {playlist_id: 'one', track_rows: [
    {playlist_item_id: 'known', play_count: 2, popularity_count: 800, track_rating: 3, love_tier: 'loved'},
    {playlist_item_id: 'denied', source_readable: false, play_count: 90, popularity_count: 9000, track_rating: 5},
  ]}};
  const [known, denied] = model.normalizePlaylistPayload(input).detail.track_rows;
  assert.equal(known.play_count, 2); assert.equal(known.popularity_count, 800); assert.equal(known.track_rating, 3);
  assert.equal(Object.isFrozen(known), true);
  assert.equal(nativeTable(denied).cell('play_count').textContent, '–');
  assert.equal(nativeTable(denied).cell('popularity_count').textContent, '–');
});
