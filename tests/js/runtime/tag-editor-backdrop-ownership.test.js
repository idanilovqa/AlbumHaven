const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { create } = require('../../../music_app/static/js/surface-dismissal.js');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');

function harness() {
  const content = {}, player = {};
  const modal = { id: 'tag-editor-modal', hidden: false, contains: target => target === content };
  const track = { path: '/owned/track.mp3', artist: 'Artist', album: 'Album', title: 'Track' };
  const state = { tagEditor: { album: { artist: 'Artist', album: 'Album' }, tracks: [track], values: {} } };
  const context = vm.createContext({ state, window: {} });
  for (const name of ['utility-loaders-and-cover-lookup.js', 'tag-editor-and-optimistic-updates.js',
    'track-modal-lightbox-helpers.js', 'trigger-anchor.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtime, name), 'utf8'), context);
  }
  state.tagEditor.values[track.path] = { ...context.getTrackTagInitialValues(track, state.tagEditor.album) };
  let closes = 0;
  context.getTopmostOpenModal = () => modal.hidden ? null : modal;
  context.closeTagEditor = () => { closes++; modal.hidden = true; };
  const dismissal = create(() => context.getDismissibleForegroundSurface());
  function gesture(target = modal) {
    const consumed = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      dismissal[type]({ target, button: 0, pointerId: 1, detail: 1, clientX: 4, clientY: 4,
        preventDefault() {}, stopImmediatePropagation() { consumed.push(type); } });
    }
    return consumed;
  }
  return { context, state, track, modal, player, gesture, closes: () => closes };
}

test('captured Tag Editor backdrop closes a clean editor once and consumes the gesture', () => {
  const h = harness();
  assert.deepEqual(h.gesture(), ['pointerdown', 'pointerup', 'click']);
  assert.equal(h.closes(), 1);
});

test('captured Tag Editor backdrop preserves pending album values, then permits a reverted draft', () => {
  const h = harness();
  const original = h.state.tagEditor.values[h.track.path].album;
  h.state.tagEditor.values[h.track.path].album = 'Pending album';
  assert.deepEqual(h.gesture(), ['pointerdown', 'pointerup', 'click']);
  assert.equal(h.closes(), 0);
  assert.equal(h.modal.hidden, false);
  assert.equal(h.state.tagEditor.values[h.track.path].album, 'Pending album');
  h.state.tagEditor.values[h.track.path].album = original;
  h.gesture();
  assert.equal(h.closes(), 1);
});

test('an uncovered player action is not consumed or treated as a Tag Editor backdrop', () => {
  const h = harness();
  h.state.tagEditor.values[h.track.path].album = 'Pending album';
  assert.deepEqual(h.gesture(h.player), []);
  assert.equal(h.closes(), 0);
  assert.equal(h.modal.hidden, false);
});
