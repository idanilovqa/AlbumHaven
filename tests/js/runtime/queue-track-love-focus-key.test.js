const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
let preference;
test.before(async () => {preference = await import('../../../music_app/static/js/home-friends/track-preference.mjs');});
const saved = (love_tier = 'off', identity = 'opaque:actor-track') => ({identity, love_tier, rating: null,
  allowed_actions: {can_set_love_tier: true}});
function fixture() {
  const native = createNativeHomeRuntime(), document = native.document;
  const runtime = {escapeHtml: native.context.escapeHtml, setTrackLove() {},
    actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
    iconHtml: (name, options) => native.context.ButtonComponent.renderIconSvg(name, options)};
  const row = {id: 'occurrence:one', title: 'Original title', source_readable: true};
  const host = document.createElement('div'); document.body.appendChild(host);
  host.innerHTML = preference.trackLoveHtml(runtime, row, {preference: saved()});
  const cell = host.querySelector('[data-track-love-cell]'), button = cell.querySelector('button');
  // Same bounded focus model as home-track-preference.test.js: assertions verify
  // the helper's ownership decision, not browser focus or disabled-button rules.
  Object.getPrototypeOf(button).focus = function () {document.activeElement = this;};
  return {native, document, runtime, row, cell, button};
}
test('Queue stable focus key restores Love focus across replacement public row DTO', () => {
  const f = fixture(), handle = {id: f.row.id}; f.button.focus();
  preference.paintTrackLoveCell(f.cell, f.runtime, f.row, {preference: saved(), pending: true}, handle);
  assert.equal(f.cell.querySelector('button'), f.button); assert.equal(f.button.disabled, true);
  f.document.activeElement = f.document.body;
  const updated = {...f.row, title: 'Updated title'};
  preference.paintTrackLoveCell(f.cell, f.runtime, updated, {preference: saved('loved')}, handle);
  assert.equal(f.cell.querySelector('button'), f.button); assert.equal(f.button.disabled, false);
  assert.equal(f.document.activeElement, f.button);
  assert.equal(f.button.getAttribute('aria-label'), 'Mark Obsessed: Updated title');
  assert.equal(f.button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.native.forbiddenCalls, []);
});
test('a different occurrence or replacement scope handle cannot acquire pending Love focus', () => {
  for (const replacement of [{id: 'occurrence:other'}, {id: 'occurrence:one'}]) {
    const f = fixture(), handle = {id: f.row.id}; f.button.focus();
    preference.paintTrackLoveCell(f.cell, f.runtime, f.row, {preference: saved(), pending: true}, handle);
    f.document.activeElement = f.document.body;
    preference.paintTrackLoveCell(f.cell, f.runtime, {...f.row}, {preference: saved('loved')}, replacement);
    assert.equal(f.document.activeElement, f.document.body, 'Object identity, not matching occurrence text, owns focus');
    assert.equal(f.button.disabled, false);
  }
});
test('stable focus key still checks exact preference identity and does not steal user-moved focus', () => {
  for (const changed of ['identity', 'focus']) {
    const f = fixture(), handle = {id: f.row.id}; f.button.focus();
    preference.paintTrackLoveCell(f.cell, f.runtime, f.row, {preference: saved(), pending: true}, handle);
    const other = f.document.createElement('button'); f.document.body.appendChild(other);
    f.document.activeElement = changed === 'focus' ? other : f.document.body;
    preference.paintTrackLoveCell(f.cell, f.runtime, {...f.row},
      {preference: saved('loved', changed === 'identity' ? 'opaque:replacement-track' : 'opaque:actor-track')}, handle);
    assert.equal(f.document.activeElement, changed === 'focus' ? other : f.document.body);
  }
});
test('existing same-row caller without fifth argument retains pending-to-ack focus behavior', () => {
  const f = fixture(); f.button.focus();
  preference.paintTrackLoveCell(f.cell, f.runtime, f.row, {preference: saved(), pending: true});
  f.document.activeElement = f.document.body;
  preference.paintTrackLoveCell(f.cell, f.runtime, f.row, {preference: saved('loved')});
  assert.equal(f.document.activeElement, f.button); assert.equal(f.button.disabled, false);
});
