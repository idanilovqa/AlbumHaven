const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtime = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const read = name => fs.readFileSync(path.join(runtime, name), 'utf8');

function loadEditor() {
  const renders = [];
  const context = { console, state: {}, URL };
  vm.createContext(context);
  vm.runInContext(read('tag-editor-and-optimistic-updates.js'), context);
  vm.runInContext(read('utility-loaders-and-cover-lookup.js'), context);
  const tracks = [
    { cue_segment_ref: 'cue:1', cue_structure: { start_frame: 0, end_frame: 45000, base_revision_sha256: 'a'.repeat(64) } },
    { cue_segment_ref: 'cue:2', cue_structure: { start_frame: 45000, end_frame: 90000, base_revision_sha256: 'a'.repeat(64) } },
  ];
  context.state.tagEditor = { tracks, cueDraft: null, cueError: '', cueTyping: null };
  context.getTagEditorFocusedPath = () => 'cue:1';
  context.renderTagEditor = () => renders.push(context.state.tagEditor.cueTyping?.value);
  return { context, renders };
}

test('a half-typed CUE timecode stays in the field and is reported only once committed', () => {
  // Owner 2026-11-17: "Time code seems to be not editable" - every keystroke snapped the field back and
  // raised "Invalid CUE timecode." at once.
  const { context } = loadEditor();
  const editor = context.state.tagEditor;

  context.updateCueStructureDraft('index_01', '00:00:0');
  assert.equal(editor.cueDraft, null, 'nothing to apply yet');
  assert.equal(editor.cueError, '', 'no error while typing');
  assert.equal(context.getCueTypedValue({ cue_segment_ref: 'cue:1' }, 'index_01'), '00:00:0', 'the typed text stays');
  assert.equal(context.getCueTypedValue({ cue_segment_ref: 'cue:2' }, 'index_01'), null, 'another track shows its own value');

  context.updateCueStructureDraft('index_01', '00:00:0', { commit: true });
  assert.equal(editor.cueError, 'Invalid CUE timecode.');

  context.updateCueStructureDraft('index_01', '00:00:10');
  assert.equal(editor.cueDraft.start_frame, 10);
  assert.equal(editor.cueError, '', 'a valid value clears the error');
});

test('the CUE notice is a compact footer alert whose details open over the form', () => {
  // Owner 2026-11-17: "Relocate it into an expandable alert. Put it in the footer ... Don't break the page".
  const template = fs.readFileSync(path.join(runtime, '..', '..', '..', 'templates', 'partials', 'primary-modals.html'), 'utf8');
  const form = template.slice(template.indexOf('id="tag-editor-form"'), template.indexOf('id="tag-editor-footer"'));
  assert.doesNotMatch(form, /tag-editor-cue-alert/, 'no longer inside the form');
  assert.match(template, /id="tag-editor-footer">\s*<div class="tag-editor-cue-alert" id="tag-editor-cue-alert" hidden><\/div>/);
  assert.match(read('bootstrap-init.js'), /leadingElement: \[\s*document\.getElementById\('tag-editor-cue-alert'\),/);
  const loader = read('utility-loaders-and-cover-lookup.js');
  assert.match(loader, /buildSmallAlertHtml\(\{\s*severity,\s*message: state\.tagEditor\.cueError \|\| title,\s*interactive: true,/);
  assert.match(loader, /'data-toggle-tag-editor-cue-alert': '1'/);
  const css = fs.readFileSync(path.join(runtime, '..', '..', '..', 'static', 'css', 'runtime', 'utilities.css'), 'utf8');
  assert.match(css, /\.tag-editor-cue-alert__details \{\s*position: absolute;\s*bottom: calc\(100% \+ 10px\);/);
});

test('the Exception field hides on the CUE structure tab', () => {
  // Owner 2026-11-17: "Exception dropdown should not be shown - only CUE structure related edits".
  const css = fs.readFileSync(path.join(runtime, '..', '..', '..', 'static', 'css', 'runtime', 'utilities.css'), 'utf8');
  assert.match(css, /\.tag-editor-exception-field\[hidden\] \{ display: none; \}/);
});
