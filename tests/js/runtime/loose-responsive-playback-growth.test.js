// Actual Loose playback updater, with only its DOM/playback boundaries isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');

function fixture() {
  const refreshes = [], modal = {hidden: false};
  let present = true, playbackReads = 0;
  const playback = {currentTime: 59, duration: 180, paused: false, ended: false};
  const makeRow = (trackPath, original) => {
    const classes = new Set();
    const duration = {dataset: {originalDuration: original}, textContent: original,
      get innerHTML() {return this.textContent;}, set innerHTML(value) {this.textContent = value;}};
    const attributes = new Map([['aria-label', 'Play track']]);
    const button = {innerHTML: '', getAttribute: name => attributes.get(name),
      setAttribute: (name, value) => attributes.set(name, value)};
    return {classes, duration, button, dataset: {},
      classList: {toggle: (name, enabled) => {if (enabled) classes.add(name); else classes.delete(name);}},
      getAttribute: name => name === 'data-track-row-path' ? trackPath : null,
      querySelector: selector => selector === '.play-track-button' ? button : selector === '[data-track-duration-path]' ? duration : null};
  };
  const rows = [makeRow('synthetic-current.flac', '3:00'), makeRow('synthetic-other.flac', '4:00')];
  const context = vm.createContext({
    state: {player: {current: {path: 'synthetic-current.flac'}}},
    document: {getElementById: id => id === 'non-album-modal' && present ? modal : null,
      documentElement: {getAttribute: () => null},
      querySelectorAll(selector) {assert.equal(selector, '#non-album-modal [data-track-row-path]'); return rows;}},
    getPlayerPlaybackSnapshot: () => {playbackReads++; return playback;},
    formatTrackDuration: seconds => `${Math.floor(Number(seconds) / 60)}:${String(Math.floor(Number(seconds) % 60)).padStart(2, '0')}`,
    escapeHtml: value => String(value),
    ButtonComponent: {renderIconSvg: name => `<svg data-fixture-icon="${name}"></svg>`},
    NativePlaytables: {refresh(key) {refreshes.push({key, durations: rows.map(row => row.duration.textContent)});}},
  });
  vm.runInContext(fs.readFileSync(path.join(root,
    'music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'), 'utf8'), context,
  {filename: 'runtime/tag-editor-and-optimistic-updates.js'});
  return {context, rows, modal, playback, refreshes,
    update: () => context.refreshNonAlbumModalPlaybackState(),
    removeModal() {present = false;}, playbackReads: () => playbackReads};
}

test('Loose elapsed/total growth refreshes the existing presentation once after rendering the new durations', () => {
  const f = fixture();
  f.update();
  assert.equal(f.rows[0].duration.textContent, '0:59 / 3:00');
  assert.equal(f.rows[1].duration.textContent, '4:00');
  assert.deepEqual(f.refreshes, [{key: 'loose-tracks', durations: ['0:59 / 3:00', '4:00']}]);
  assert.equal(f.rows[0].button.getAttribute('aria-label'), 'Pause track');
  assert.equal(f.rows[0].dataset.trackPlaying, 'true');
  assert.ok(f.rows[0].classes.has('album-track-table__row--playing'));
  f.refreshes.length = 0;
  f.playback.currentTime = 6023; f.playback.duration = 6023;
  f.update();
  assert.deepEqual(f.refreshes, [{key: 'loose-tracks', durations: ['100:23 / 100:23', '4:00']}]);
});

test('unchanged length, repeated tick, shrinking text and leaving a Loose row do not redundantly remeasure', () => {
  const f = fixture();
  f.playback.currentTime = 6023; f.playback.duration = 6023; f.update();
  f.refreshes.length = 0;
  f.update();
  f.playback.currentTime = 6024; f.update();
  assert.equal(f.rows[0].duration.textContent, '100:24 / 100:23');
  f.playback.currentTime = 0; f.playback.duration = 9; f.update();
  assert.equal(f.rows[0].duration.textContent, '0:00 / 0:09');
  f.context.state.player.current = null; f.update();
  assert.equal(f.rows[0].duration.textContent, '3:00');
  assert.equal(f.rows[0].button.getAttribute('aria-label'), 'Play track');
  assert.equal(f.rows[0].dataset.trackPlaying, '');
  assert.deepEqual(f.refreshes, []);
});

for (const absent of ['hidden', 'removed']) test(`${absent} Loose modal neither paints playback nor requests a presentation refresh`, () => {
  const f = fixture();
  if (absent === 'hidden') f.modal.hidden = true; else f.removeModal();
  f.playback.currentTime = 6023; f.playback.duration = 6023;
  f.update();
  assert.deepEqual(f.refreshes, []); assert.equal(f.playbackReads(), 0);
  assert.equal(f.rows[0].duration.textContent, '3:00');
  assert.equal(f.rows[0].button.getAttribute('aria-label'), 'Play track');
});

test('multiple growing Loose duration cells coalesce into one presentation refresh', () => {
  const f = fixture();
  f.rows[1].duration.dataset.originalDuration = '100:23';
  f.rows[1].duration.textContent = '4:00';
  f.update();
  assert.deepEqual(f.refreshes, [{key: 'loose-tracks', durations: ['0:59 / 3:00', '100:23']}]);
});

test('Loose playback remains compatible when the native presentation owner is unavailable', () => {
  const f = fixture();
  delete f.context.NativePlaytables;
  f.update();
  assert.equal(f.rows[0].duration.textContent, '0:59 / 3:00');
  assert.equal(f.rows[0].button.getAttribute('aria-label'), 'Pause track');
});
