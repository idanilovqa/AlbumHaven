// Same-name artists split per album by MusicBrainz (D2 item 3, approved b3-3): the server
// names each proven group "Amarok (Poland)"; the tree, the gallery headers and the album
// details header draw "Amarok" with "(Poland)" dimmed. Every other name is drawn as before.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const template = fs.readFileSync(
  path.join(repoRoot, 'music_app', 'templates', 'components', 'navigation-tree-item.html'),
  'utf8',
);
const sources = [
  'music_app/static/js/navigation-tree.js',
  'music_app/static/js/runtime/view-state-helpers.js',
  'music_app/static/js/runtime/browser-navigation-helpers.js',
  'music_app/static/js/runtime/render-markup-helpers.js',
  'music_app/static/js/button-component.js',
  'music_app/static/js/runtime/gallery-main-components.js',
  'music_app/static/js/runtime/alert-components.js',
  'music_app/static/js/runtime/album-details-components.js',
].map((relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

function load() {
  const context = {
    URL,
    URLSearchParams,
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    document: {
      getElementById(id) {
        return id === 'navigation-tree-item-template' ? { textContent: template } : null;
      },
    },
    state: { view: {} },
    location: { origin: 'http://localhost:5000' },
  };
  context.window = context;
  vm.createContext(context);
  sources.forEach((source) => vm.runInContext(source, context));
  return context;
}

const SPLIT = { 'Amarok (Poland)': 'Poland', 'Amarok (Spain)': 'Spain' };
const TREE = [
  { artist: 'Amarok', artist_display: 'Amarok', count: 1 },
  { artist: 'Amarok (Poland)', artist_display: 'Amarok (Poland)', count: 4 },
  { artist: 'Amarok (Spain)', artist_display: 'Amarok (Spain)', count: 3 },
  { artist: 'Angra', artist_display: 'Angra', count: 16 },
];

test('one helper splits a split label into its name and dimmed qualifier, and leaves every other name whole', () => {
  const context = load();
  context.setSplitArtistQualifiers(SPLIT);
  context.setRomanizedArtistNames({ '天門': 'Tenmon' });
  assert.deepEqual({ ...context.artistDisplayParts('Amarok (Poland)') },
    { name: 'Amarok', qualifier: '(Poland)', secondary: '(Poland)' });
  assert.deepEqual({ ...context.artistDisplayParts('Amarok') }, { name: 'Amarok', qualifier: '', secondary: '' });
  assert.deepEqual({ ...context.artistDisplayParts('天門') }, { name: '天門', qualifier: '', secondary: '(Tenmon)' });
  // A real artist named with parentheses is no split group unless the server says so.
  assert.deepEqual({ ...context.artistDisplayParts('Foo (Live)') }, { name: 'Foo (Live)', qualifier: '', secondary: '' });
  // An original-script split name keeps its romanized form before the qualifier.
  context.setSplitArtistQualifiers({ '天門 (Japan)': 'Japan' });
  assert.equal(context.artistDisplayParts('天門 (Japan)').secondary, '(Tenmon) (Japan)');
});

test('the tree shows one row per proven identity with the country dimmed, and the plain name undimmed', () => {
  const context = load();
  const before = context.buildSidebarHtml({ surface: { active: 'albums' } }, TREE, {});
  const signatureBefore = context.buildSidebarStructureSignature(TREE);
  context.setSplitArtistQualifiers(SPLIT);
  const html = context.buildSidebarHtml({ surface: { active: 'albums' } }, TREE, {});
  assert.match(html, /Amarok <span class="navigation-tree-label-secondary">\(Poland\)<\/span>/);
  assert.match(html, /Amarok <span class="navigation-tree-label-secondary">\(Spain\)<\/span>/);
  assert.equal((html.match(/navigation-tree-label-secondary/g) || []).length, 2, 'plain Amarok and Angra stay undimmed');
  // Rows stay addressed by their labels.
  assert.match(html, /data-sidebar-artist="Amarok \(Poland\)"/);
  assert.notEqual(context.buildSidebarStructureSignature(TREE), signatureBefore, 'the tree redraws when qualifiers arrive');
  // Unsplit names render byte-identically with or without the qualifier map.
  const unsplit = [TREE[0], TREE[3]];
  context.setSplitArtistQualifiers({});
  const plainBefore = context.buildSidebarHtml({ surface: { active: 'albums' } }, unsplit, {});
  context.setSplitArtistQualifiers(SPLIT);
  assert.equal(context.buildSidebarHtml({ surface: { active: 'albums' } }, unsplit, {}), plainBefore);
  assert.doesNotMatch(before, /navigation-tree-label-secondary/);
});

test('the gallery header and family headers show the split name with the qualifier dimmed', () => {
  const context = load();
  context.setSplitArtistQualifiers(SPLIT);
  const bar = context.buildGalleryBarHtml({ contextKind: 'artist', artist: 'Amarok (Poland)', albumCount: 4 });
  assert.match(bar, /<span data-gallery-context-name>Amarok<\/span><span class="gallery-artist-romanized" data-gallery-context-romanized>\(Poland\)<\/span><button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="Amarok \(Poland\)"/);
  const family = context.buildFamilyArtistHeaderHtml({ artist: 'Amarok (Spain)', albumCount: 3 });
  assert.match(family, /data-scroll-artist="Amarok \(Spain\)"/);
  assert.match(family, /<h2 class="artist-name">Amarok <span class="gallery-artist-romanized">\(Spain\)<\/span><\/h2>/);
  // The plain name and every unsplit artist keep their header exactly.
  for (const artist of ['Amarok', 'Angra']) {
    const plainBar = context.buildGalleryBarHtml({ contextKind: 'artist', artist, albumCount: 1 });
    assert.match(plainBar, new RegExp(`<span data-gallery-context-name>${artist}</span><span class="gallery-artist-romanized" data-gallery-context-romanized hidden></span>`));
    assert.match(context.buildFamilyArtistHeaderHtml({ artist, albumCount: 1 }), new RegExp(`<h2 class="artist-name">${artist}</h2>`));
  }
});

test('the album details header shows the album group with the qualifier dimmed', () => {
  const context = load();
  context.setSplitArtistQualifiers(SPLIT);
  const album = { album_artist: 'Amarok', musicbrainz_artist: { split: true, canonical_name: 'Amarok', group_label: 'Amarok (Poland)' } };
  assert.equal(context.albumDisplayArtist(album), 'Amarok (Poland)');
  for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
    const html = context.buildAlbumDetailsHeaderHtml({ layout, artist: context.albumDisplayArtist(album), album: 'Hunt', year: '2017' });
    assert.match(html, /Amarok <span class="album-details-header__aka">\(Poland\)<\/span>/, layout);
  }
  // An undecided album of the split name, and any unsplit album, keep the tag undimmed.
  assert.equal(context.albumDisplayArtist({ album_artist: 'Amarok', musicbrainz_artist: null }), 'Amarok');
  assert.equal(context.albumDisplayArtist({ album_artist: 'Angra', musicbrainz_artist: { split: false, canonical_name: 'Angra' } }), 'Angra');
  const plain = context.buildAlbumDetailsHeaderHtml({ layout: 'classic_bar', artist: 'Angra', album: 'Angels Cry' });
  assert.doesNotMatch(plain, /album-details-header__aka/);
});

test('the qualifiers arrive with the romanized names, and their absence clears them', async () => {
  const context = load();
  let payload = { names: {}, split_artists: SPLIT };
  context.fetch = async () => ({ ok: true, json: async () => payload });
  context.renderSidebar = () => {};
  context.updateGalleryMainChrome = () => {};
  assert.equal(await context.refreshRomanizedArtistNames(), true);
  assert.equal(context.artistDisplayParts('Amarok (Poland)').name, 'Amarok');
  payload = { names: {} };
  context.Date = { now: () => Date.now() + 600001 };
  assert.equal(await context.refreshRomanizedArtistNames(), true, 'the split went away: redraw');
  assert.equal(context.artistDisplayParts('Amarok (Poland)').name, 'Amarok (Poland)');
});
