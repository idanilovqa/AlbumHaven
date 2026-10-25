const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, applyTheme } = require('../../../music_app/static/js/appearance-backgrounds.js');

const defaults = { card_colors: false, hover_outline_colors: false, icons: true };
const initial = () => ({ main_surface_color: null, panel_background_color: null, palette_id: null, panel_index: 0, player_override: null });

test('source choices are staged, cancelable, and saved together', async () => {
  const applied = [], requests = [];
  const editor = createController({ initial: initial(), apply: value => applied.push(value), request: async (method, value) => {
    requests.push({ method, value });
    return { ...value, revision: 1, player_recent_sets: [] };
  } });
  editor.setActiveSection('album-page');
  assert.deepEqual(editor.getState().draft.library_source_indicators, defaults);
  editor.setLibrarySourceIndicator('card_colors', true);
  assert.equal(editor.getState().dirty, true);
  assert.equal(applied.length, 0);
  editor.cancel();
  assert.deepEqual(editor.getState().draft.library_source_indicators, defaults);
  editor.setLibrarySourceIndicator('hover_outline_colors', true);
  editor.setLibrarySourceIndicator('icons', false);
  assert.equal(await editor.save(), true);
  assert.deepEqual(requests[0].value.library_source_indicators, { card_colors: false, hover_outline_colors: true, icons: false });
  assert.deepEqual(applied[0].library_source_indicators, requests[0].value.library_source_indicators);
});

test('last visible indicator and non-boolean choices cannot be disabled', () => {
  const editor = createController({ initial: initial(), request: async () => initial() });
  assert.throws(() => editor.setLibrarySourceIndicator('icons', false), /at least one/i);
  assert.throws(() => editor.setLibrarySourceIndicator('icons', 1), TypeError);
  assert.throws(() => editor.setLibrarySourceIndicator('unknown', true), TypeError);
  assert.deepEqual(editor.getState().draft.library_source_indicators, defaults);
});

test('applying saved preferences exposes independent source attributes', () => {
  const attrs = {};
  const root = { style: { setProperty() {}, removeProperty() {} }, setAttribute: (name, value) => { attrs[name] = value; }, removeAttribute: name => { delete attrs[name]; } };
  applyTheme({ ...initial(), library_source_indicators: { card_colors: true, hover_outline_colors: false, icons: false } }, root);
  assert.equal(attrs['data-library-source-card-colors'], 'true');
  assert.equal(attrs['data-library-source-hover-outline-colors'], 'false');
  assert.equal(attrs['data-library-source-icons'], 'false');
});

test('custom device indicators do not overwrite the desktop draft and cancel restores inheritance', () => {
  const editor = createController({ initial: initial(), request: async () => initial() });
  editor.setActiveSection('album-page');
  editor.setDeviceProfile('mobile');
  editor.setDeviceSectionMode('custom');
  editor.setLibrarySourceIndicator('card_colors', true);
  editor.setLibrarySourceIndicator('icons', false);
  editor.setDeviceProfile('web_desktop');
  assert.deepEqual(editor.getState().draft.library_source_indicators, defaults);
  editor.setDeviceProfile('mobile');
  assert.deepEqual(editor.getState().draft.library_source_indicators, { card_colors: true, hover_outline_colors: false, icons: false });
  editor.cancel();
  assert.deepEqual(editor.getState().draft.library_source_indicators, defaults);
});
