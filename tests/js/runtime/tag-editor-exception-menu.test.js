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
  const template = fs.readFileSync(
    path.join(root, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(root, 'music_app', 'static', 'css', 'runtime', 'utilities.css'),
    'utf8',
  );
  assert.match(css, /\.tag-editor-form\s+label\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /label\[data-custom-collection-name-field\]\[hidden\]\s*\{[^}]*display:\s*flex[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.tag-editor-exception-menu\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /#tag-editor-modal \.tag-editor-exception-field input:focus\s*\{[^}]*transition:\s*none/s);
  assert.match(css, /\.tag-editor-exception-menu\s+\[role="option"\]\[aria-selected="true"\]\s*\{[^}]*color:\s*var\(--text\)/s);
  assert.doesNotMatch(css, /\.tag-editor-exception-menu\s+\[role="option"\]\[aria-selected="true"\]\s*\{[^}]*--accent/s);

  const context = loadHelpers();
  assert.equal(context.isCustomCollectionException(''), false);
  assert.equal(context.isCustomCollectionException('Interview'), false);
  assert.equal(context.isCustomCollectionException('Custom Collection'), true);
  assert.equal(context.isCustomCollectionException('custom collection'), false);

  const editionIndex = template.indexOf('data-tag-field="edition"');
  const ratingIndex = template.indexOf('data-tag-field="album_rating"');
  const exceptionIndex = template.indexOf('data-tag-field="exception_type"');
  const collectionIndex = template.indexOf('data-tag-field="custom_collection_name"');
  assert.ok(editionIndex < exceptionIndex);
  assert.ok(ratingIndex < exceptionIndex);
  assert.ok(exceptionIndex < collectionIndex);
});

test('exception menu flips above the fixed footer without changing form flow', () => {
  const context = loadHelpers();
  const layout = context.getTagEditorExceptionMenuLayout(
    { top: 520, bottom: 558, left: 865, width: 274 },
    115,
    { top: 108, bottom: 644 },
    1440,
    720,
  );

  assert.equal(layout.placement, 'above');
  assert.equal(layout.top, 406);
  assert.equal(layout.left, 865);
  assert.equal(layout.width, 274);
  assert.equal(layout.maxHeight, 115);
});

test('missing tag artwork reuses the shared missing-album mark instead of text', () => {
  assert.match(helperSource, /tag-editor-artwork-placeholder[^`]+\$\{buildMissingAlbumMarkHtml\(\)\}/s);
  assert.doesNotMatch(helperSource, /tag-editor-artwork-placeholder">No artwork/);
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
