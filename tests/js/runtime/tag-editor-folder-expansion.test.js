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
    ButtonComponent: require(path.join(root, 'music_app', 'static', 'js', 'button-component.js')),
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

test('tag editor shows folder path beside artwork with its open-folder action', () => {
  const template = fs.readFileSync(
    path.join(root, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(root, 'music_app', 'static', 'css', 'runtime', 'utilities.css'),
    'utf8',
  );

  assert.doesNotMatch(template, /data-load-tag-editor-folder/, 'the load action is rendered under the folder path, not in the track footer');
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
  assert.match(artwork.innerHTML, /tag-editor-folder-path[^>]*>[^<]*<\/div><\/div><button[^>]*class="[^"]*action-button[^"]*tag-editor-open-folder"[^>]*aria-label="Open this folder in File Explorer"/);
  assert.match(artwork.innerHTML, /data-open-tag-editor-folder="C:\\Music\\Album\\02 - Two\.mp3"/);
  assert.doesNotMatch(artwork.innerHTML, / disabled/);
  assert.match(artwork.innerHTML, /<button[^>]*class="[^"]*action-button--bare[^"]*tag-editor-open-folder/, 'UI-6: the folder button has no outline');

  // UI-6 (owner, 11-08 evening): a client that cannot open folders sees the path without any folder button.
  context.window = { AlbumHavenCapabilities: { allows: () => false } };
  context.renderTagEditorArtwork(['C:\\Music\\Album\\01 - One.mp3']);
  assert.match(artwork.innerHTML, /tag-editor-folder-path/);
  assert.doesNotMatch(artwork.innerHTML, /tag-editor-open-folder|data-open-tag-editor-folder/);
});

test('the Edit Tags open-folder action opens the focused track folder through the shared location route', () => {
  const source = fs.readFileSync(path.join(root, 'music_app', 'static', 'js', 'runtime', 'bootstrap-utility-event-handlers.js'), 'utf8');
  assert.match(source, /closest\('\[data-open-tag-editor-folder\]'\)[\s\S]*?openAlbumInExplorer\(\{ name: '', tracks: \[\{ path: trackPath \}\] \}\)/);
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
    album: { key: 'artist::album', name: 'Album' },
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
  assert.equal(payload.album.key, 'artist::album');
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

test('Load all tracks from the folder sits under the path only while the album folder has unloaded tracks', async () => {
  const artwork = { innerHTML: '' };
  const one = 'C:/Music/Album/CD2/01.mp3';
  const tagEditor = { album: { key: 'a::b' }, anchorPath: one, tracks: [{ path: one }], selectedPaths: [one], values: {} };
  const context = loadHelpers({
    state: { tagEditor },
    getTagEditorElements: () => ({ artwork, overlay: { hidden: false } }),
    getSelectedTagEditorPaths: () => [one],
    fetch: async (url, options) => ({ ok: true, async json() {
      assert.equal(JSON.parse(options.body).paths_only, true);
      return { ok: true, folder_path: 'C:/Music/Album', paths: ['C:/Music/Album/CD1/01.mp3', one] };
    } }),
  });
  context.renderTagEditorArtwork([one]);
  assert.doesNotMatch(artwork.innerHTML, /data-load-tag-editor-folder/, 'hidden until the app knows tracks are missing');
  await context.refreshTagEditorFolderCompleteness(tagEditor);
  assert.equal(tagEditor.folderHasUnloadedTracks, true, 'only CD2 is loaded, so CD1 is missing');
  assert.match(artwork.innerHTML, /class="tag-editor-folder-copy"><div class="tag-editor-folder-path"[^>]*>[^<]*<\/div><button[^>]*data-load-tag-editor-folder="1"[^>]*><span class="ui-button__content">Load all tracks from the folder<\/span>/);

  tagEditor.tracks.push({ path: 'C:/Music/Album/CD1/01.mp3' });
  await context.refreshTagEditorFolderCompleteness(tagEditor);
  assert.equal(tagEditor.folderHasUnloadedTracks, false);
  assert.doesNotMatch(artwork.innerHTML, /data-load-tag-editor-folder/);
});

// Edit Tags names discs with the shared album disc rule (REC-005), owned by the tag-editor module.
function loadDiscNumberRule() {
  const sourcePath = path.join(root, 'music_app', 'static', 'js', 'runtime', 'tag-editor-and-optimistic-updates.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const start = source.indexOf('function getPositiveAlbumTrackSortNumber');
  const helperEnd = source.indexOf('\n}', start) + 2;
  const ruleStart = source.indexOf('const ALBUM_TRACK_DISC_FOLDER_PATTERN');
  const end = source.indexOf('\n}', source.indexOf('function getAlbumTrackDiscNumber')) + 2;
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, helperEnd)}\n${source.slice(ruleStart, end)}\nthis.getAlbumTrackDiscNumber = getAlbumTrackDiscNumber;`, context);
  return context.getAlbumTrackDiscNumber;
}

test('loading the folder puts CD1 files before CD2 files and marks each file with its disc', async () => {
  const cd2 = 'C:/Music/Album/CD2/01 - Late.mp3';
  const cd1a = 'C:/Music/Album/Disc 1/01 - Early.mp3';
  const cd1b = 'C:/Music/Album/Disc 1/02 - Middle.mp3';
  const tagEditor = { album: { key: 'a::b' }, anchorPath: cd2, tracks: [{ path: cd2 }], selectedPaths: [cd2], values: {}, folderHasUnloadedTracks: true };
  const list = { innerHTML: '', setAttribute() {}, querySelectorAll: () => [] };
  const context = loadHelpers({
    state: { tagEditor },
    getTagEditorElements: () => ({ overlay: { hidden: false }, list, form: { querySelectorAll: () => [], querySelector: () => null }, artwork: { innerHTML: '' } }),
    getSelectedTagEditorPaths: () => [cd2],
    getTrackTagInitialValues: (track) => ({ title: track.title }),
    getFileTypeFromPath: () => 'MP3',
    getAlbumTrackDiscNumber: loadDiscNumberRule(),
    syncTagEditorCollectionFields() {},
    syncTagEditorPendingChanges() {},
    fetch: async () => ({ ok: true, async json() {
      return { ok: true, folder_path: 'C:/Music/Album', tracks: [{ path: cd1a, title: 'Early' }, { path: cd1b, title: 'Middle' }, { path: cd2, title: 'Late' }] };
    } }),
  });
  await context.loadTagEditorFolderFiles();
  assert.deepEqual(JSON.parse(JSON.stringify(tagEditor.tracks.map((track) => track.path))), [cd1a, cd1b, cd2]);
  assert.equal(tagEditor.folderHasUnloadedTracks, false);
  assert.match(list.innerHTML, /01 - Early\.mp3<\/span><span class="tag-editor-track-folder">CD 1<\/span>/);
  assert.match(list.innerHTML, /01 - Late\.mp3<\/span><span class="tag-editor-track-folder">CD 2<\/span>/);
  assert.doesNotMatch(list.innerHTML, /tag-editor-track-folder">C:/, 'the folder name, never its path');
});
