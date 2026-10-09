const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..', '..');
const helperPath = path.join(root, 'music_app', 'static', 'js', 'runtime', 'utility-loaders-and-cover-lookup.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const context = {
    escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

test('exception editor uses an owned anchored listbox and keeps custom values editable', () => {
  const template = fs.readFileSync(
    path.join(root, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );

  assert.match(template, /data-tag-editor-exception-anchor/);
  assert.match(template, /role="combobox"/);
  assert.match(template, /aria-controls="tag-editor-exception-menu"/);
  assert.match(template, /id="tag-editor-exception-menu"[^>]+role="listbox"[^>]+hidden/);
  assert.doesNotMatch(template, /<datalist id="tag-editor-exception-types"/);
});

test('custom collection name is hidden at the form boundary unless selected', () => {
  const css = fs.readFileSync(
    path.join(root, 'music_app', 'static', 'css', 'runtime', 'utilities.css'),
    'utf8',
  );
  assert.match(css, /\.tag-editor-form\s+label\[hidden\]\s*\{\s*display:\s*none/);

  const context = loadHelpers();
  assert.equal(context.isCustomCollectionException(''), false);
  assert.equal(context.isCustomCollectionException('Interview'), false);
  assert.equal(context.isCustomCollectionException('Custom Collection'), true);
  assert.equal(context.isCustomCollectionException('custom collection'), false);
});

test('exception listbox renders every library-scoped choice as a selectable option', () => {
  const context = loadHelpers();
  const html = context.buildTagEditorExceptionOptionsHtml([
    'Interview',
    'Custom Collection',
    'Archive & outtake',
  ], 'Custom Collection');

  assert.match(html, /role="option"/);
  assert.match(html, /data-tag-editor-exception-option="Custom Collection"/);
  assert.match(html, /aria-selected="true"[^>]+data-tag-editor-exception-option="Custom Collection"/);
  assert.match(html, /Archive &amp; outtake/);
});

test('exception listbox supports selection, dismissal, and keyboard navigation', () => {
  const handlers = fs.readFileSync(
    path.join(root, 'music_app', 'static', 'js', 'runtime', 'bootstrap-utility-event-handlers.js'),
    'utf8',
  );

  assert.match(handlers, /selectTagEditorExceptionOption\(exceptionOption\.getAttribute/);
  assert.match(handlers, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(handlers, /event\.key === 'Escape'.*closeTagEditorExceptionMenu/s);
  assert.match(handlers, /!event\.target\.closest\('\[data-tag-editor-exception-anchor\]'\).*closeTagEditorExceptionMenu/s);
});
