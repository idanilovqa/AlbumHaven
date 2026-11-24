const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'track-modal-lightbox-helpers.js'),
  'utf8',
);

function loadOverlay(pending) {
  const start = source.indexOf('function overlayPendingTagEditMembership(');
  const end = source.indexOf('function openTrackModal(', start);
  const context = vm.createContext({
    hasPendingTagEditViewMutations: () => pending,
    compareAlbumTracks: (left, right) => Number(left.track_number) - Number(right.track_number),
    formatCanonicalAlbumDuration: (seconds) => `${seconds}s`,
  });
  vm.runInContext(source.slice(start, end), context);
  return context.overlayPendingTagEditMembership;
}

const track = (number, duration = 10) => ({ path: `/m/${number}.mp3`, track_number: number, duration_seconds: duration });

test('details of a merged album list the tracks the unsaved edit moved in, in track order', () => {
  const overlay = loadOverlay(true);
  const server = { name: 'Remixes', tracks: [track(6), track(7), track(8)], track_count: 3 };
  const card = { track_paths: [1, 2, 6, 7, 8].map((n) => `/m/${n}.mp3`), tracks: [track(1), track(2)] };
  const shown = overlay(server, card);
  assert.deepEqual([...shown.tracks.map((item) => item.track_number)], [1, 2, 6, 7, 8]);
  assert.equal(shown.track_count, 5);
  assert.equal(shown.total_duration_seconds, 50);
  assert.equal(shown.total_duration_display, '50s');
});

test('a compact merged card adds its moved tracks to every saved member', () => {
  const overlay = loadOverlay(true);
  const saved = { tracks: [track(6), track(7)] };
  const card = { preview_only: true, track_paths: ['/m/1.mp3'], tracks: [track(1)] };
  assert.deepEqual([...overlay(saved, card).tracks.map((item) => item.track_number)], [1, 6, 7]);
});

test('details of a split source drop the tracks the unsaved edit moved out', () => {
  const overlay = loadOverlay(true);
  const server = { tracks: [track(1), track(2), track(3)] };
  const card = { track_paths: ['/m/3.mp3'], tracks: [] };
  assert.deepEqual([...overlay(server, card).tracks.map((item) => item.track_number)], [3]);
});

test('without a pending tag edit the server details are shown unchanged', () => {
  const overlay = loadOverlay(false);
  const server = { tracks: [track(6)] };
  assert.equal(overlay(server, { track_paths: ['/m/1.mp3'], tracks: [track(1)] }), server);
});
