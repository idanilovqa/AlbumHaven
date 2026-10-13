const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');

test('real Loose Tracks explicitly adopts shared presentation columns with truthful unavailable Love', () => {
  const context = vm.createContext({
    state: {view: {}, player: {current: null}}, document: {documentElement: {getAttribute: () => null}},
    formatTrackDuration: () => '3:00', formatAlbumDuration: () => '3m',
    getPlayerPlaybackSnapshot: () => ({paused: true, ended: false}),
    getProblematicAlbumForTrackPath: () => null,
  });
  context.window = context;
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js',
    'runtime/album-track-table.js', 'runtime/modal-and-overlay-helpers.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8'), context, {filename: file});
  }
  const html = context.buildNonAlbumTrackSectionsMarkup([{path: 'synthetic-loose.flac', title: 'Loose fixture',
    display_path: 'fixture/loose.flac', duration_seconds: 180, exception_type: ''}]);
  const headers = [...html.matchAll(/data-cdt-column="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(headers)], ['number', 'title', 'path', 'love', 'problem', 'duration']);
  assert.match(html, /data-track-love-cell/);
  assert.match(html, /aria-label="Love unavailable"/);
  assert.doesNotMatch(html, /data-track-love=|aria-label="off"|love-off|data-cdt-column="rating"/);
  const columns = context.albumTrackTableColumns({showPath: true, showProblem: true});
  const grid = columns.map(column => column.identity ? 'minmax(0,1fr)' : `${column.width}px`).join(' ');
  assert.ok(html.includes(`--cdt-columns: ${grid}`), 'The callsite uses shared widths and flexible title policy');
  assert.match(html, /data-cdt-overflow="local"/);
  assert.match(html, /fixture\/loose\.flac/);
});
