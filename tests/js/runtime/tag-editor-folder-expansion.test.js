const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..', '..');
const helperPath = path.join(
  root,
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-loaders-and-cover-lookup.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadHelpers(overrides = {}) {
  const context = {
    escapeHtml,
    state: {},
    document: { getElementById: () => null },
    getTagEditorElements: () => ({ overlay: { hidden: false } }),
    buildMissingAlbumMarkHtml: () => '<span class="missing-mark"></span>',
    getFilenameFromPath: (value) => String(value).split(/[\\/]/).pop(),
    showRepairAlert() {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

test('tag editor shows folder path beside artwork and provides an icon-only folder action', () => {
  const template = fs.readFileSync(
    path.join(root, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(root, 'music_app', 'static', 'css', 'runtime', 'utilities.css'),
    'utf8',
  );

  assert.match(template, /data-load-tag-editor-folder="1"/);
  assert.match(template, /aria-label="Load all files from this folder"/);
  assert.match(template, /data-load-tag-editor-folder="1"[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<\/button>/);
  assert.match(css, /\.tag-editor-artwork\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.tag-editor-folder-path\s*\{/);

  const artwork = { innerHTML: '' };
  const context = loadHelpers({
    state: {
      tagEditor: {
        anchorPath: 'C:\\Music\\Album\\02 - Two.mp3',
        album: {},
        tracks: [
          { path: 'C:\\Music\\Album\\01 - One.mp3' },
          { path: 'C:\\Music\\Album\\02 - Two.mp3' },
        ],
      },
    },
    getTagEditorElements: () => ({ artwork }),
  });

  context.renderTagEditorArtwork([
    'C:\\Music\\Album\\01 - One.mp3',
    'C:\\Music\\Album\\02 - Two.mp3',
  ]);
  assert.match(artwork.innerHTML, /class="tag-editor-folder-path"/);
  assert.match(artwork.innerHTML, />C:\\Music\\Album<\/div>/);
});

test('loading folder files preserves selection and pending values while deduplicating paths', async () => {
  const requests = [];
  const button = {
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
  const existingPath = 'C:\\Music\\Album\\01 - One.mp3';
  const newPath = 'C:\\Music\\Album\\02 - Two.mp3';
  const tagEditor = {
    album: { name: 'Album' },
    tracks: [{ path: existingPath, title: 'One' }],
    selectedPaths: [existingPath],
    anchorPath: existingPath,
    values: { [existingPath]: { title: 'Pending title' } },
  };
  const context = loadHelpers({
    state: { tagEditor },
    document: { getElementById: () => button },
    getTagEditorElements: () => ({ overlay: { hidden: false } }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            folder_path: 'C:\\Music\\Album',
            tracks: [
              { path: existingPath, title: 'One from disk' },
              { path: newPath, title: 'Two' },
            ],
          };
        },
      };
    },
  });
  let renderCount = 0;
  context.renderTagEditor = () => { renderCount += 1; };

  await context.loadTagEditorFolderFiles();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/utilities/tag-editor/folder-files');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.source_path, existingPath);
  assert.deepEqual(Array.from(tagEditor.selectedPaths), [existingPath]);
  assert.equal(tagEditor.anchorPath, existingPath);
  assert.equal(tagEditor.values[existingPath].title, 'Pending title');
  assert.equal(tagEditor.values[newPath].title, 'Two');
  assert.equal(tagEditor.tracks.length, 2);
  assert.equal(renderCount, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.attributes.has('aria-busy'), false);
});
