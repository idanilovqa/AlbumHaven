const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const helperPath = path.join(root, 'music_app/static/js/runtime/tag-editor-reorder.js');

function loadHelper() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  return context;
}

const rows = [
  { path: 'A', top: 0, height: 20 },
  { path: 'B', top: 20, height: 20 },
  { path: 'C', top: 40, height: 20 },
];

test('midpoint insertion excludes the dragged row and appends below the final row', () => {
  const helper = loadHelper();
  assert.equal(helper.getTagEditorReorderInsertionBefore(rows, 'A', 25), 'B');
  assert.equal(helper.getTagEditorReorderInsertionBefore(rows, 'A', 51), null);
  assert.equal(helper.getTagEditorReorderInsertionBefore(rows, 'C', 1), 'A');
});

test('first, middle, last and same-place moves retain stable track objects', () => {
  const helper = loadHelper();
  const tracks = rows.map(({ path }) => ({ path }));
  const paths = (items) => items.map((item) => item.path);

  assert.deepEqual(paths(helper.reorderTagEditorTracksByPath(tracks, 'A', null)), ['B', 'C', 'A']);
  assert.deepEqual(paths(helper.reorderTagEditorTracksByPath(tracks, 'C', 'A')), ['C', 'A', 'B']);
  assert.deepEqual(paths(helper.reorderTagEditorTracksByPath(tracks, 'B', 'C')), ['A', 'B', 'C']);
  assert.strictEqual(helper.reorderTagEditorTracksByPath(tracks, 'C', 'A')[0], tracks[2]);
});

test('grip-only drag, cleanup paths, boundary cue, and accessible arrow reorder are wired', () => {
  const handlers = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/utilities.css'), 'utf8');

  assert.match(renderer, /data-tag-editor-reorder-grip/);
  assert.match(renderer, /track_number:\s*String\(index \+ 1\)/);
  assert.match(handlers, /function handleUtilityBootstrapDragEnd\(\)[^]*clearTagEditorReorderCue\(\)/);
  assert.match(handlers, /event\.key === 'Escape' && state\.tagEditor\.reorder/);
  assert.match(handlers, /\['ArrowUp', 'ArrowDown'\]/);
  assert.match(css, /\.tag-editor-track\.is-reorder-before::before/);
  assert.match(css, /\.tag-editor-track-list\.is-reorder-end/);
  assert.match(css, /\.tag-editor-reorder-grip:hover\s*\{[^}]*outline:\s*0/s);
  assert.doesNotMatch(renderer, /data-tag-editor-track="[^\n]+aria-selected=/);
  assert.doesNotMatch(renderer, /button\.setAttribute\('aria-selected'/);
});
