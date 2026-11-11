const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');

function loadModalHelpers(overrides = {}) {
  const elements = {};
  const context = {
    state: {
      view: { primary_artist_groups: [], family_artist_groups: [], artist_groups: [] },
      lightbox: {},
    },
    document: {
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      createElement: () => ({}),
      getElementById: (id) => elements[id] || null,
    },
    window: {},
    console,
    URL,
    URLSearchParams,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(runtime, 'modal-and-overlay-helpers.js'), 'utf8'),
    context,
  );
  Object.assign(context, overrides);
  return { context, elements };
}

function loadTrackHelpers() {
  class Element {
    constructor(index) { this.index = index; }
    getAttribute(name) { return name === 'data-selected-cover-index' ? String(this.index) : ''; }
  }
  const album = { key: 'first', name: 'First' };
  const context = { state: { ui: {} }, document: {}, window: {}, console, HTMLElement: Element };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(runtime, 'track-modal-lightbox-helpers.js'), 'utf8'),
    context,
  );
  context.resolveTrackModalActionAlbum = () => album;
  context.getAlbumPathSignature = () => 'first';
  context.getAlbumIdentity = () => 'first';
  return { context, Element };
}

test('lightbox expands each album in saved cover order and keeps unavailable slots', () => {
  const first = {
    key: 'first',
    name: 'First',
    selected_covers_loaded: true,
    selected_covers: [
      { selection_id: 'front', image_url: '/cover?selection_id=front' },
      { selection_id: 'back', image_url: '/cover?selection_id=back' },
      { selection_id: 'insert', unavailable: true },
    ],
  };
  const second = { key: 'second', name: 'Second' };
  const { context } = loadModalHelpers({
    albumHasDisplayCover: () => true,
    getAlbumPathSignature: (album) => album.key,
    buildAlbumLightboxCoverUrl: (album) => `/full/${album.key}`,
    buildAlbumDisplayCoverUrl: (album) => `/preview/${album.key}`,
    resolveAlbumDetailsCoverSlots: (album) => (album.selected_covers || []).map((slot) => ({
      selectionId: slot.selection_id,
      imageUrl: slot.image_url || '',
      unavailable: slot.unavailable === true || !slot.image_url,
    })),
  });
  context.state.view.artist_groups = [{ albums: [first, second] }];
  const savedOrder = first.selected_covers.map((slot) => slot.selection_id);

  const items = JSON.parse(JSON.stringify(context.getLightboxGalleryItems()));

  assert.deepEqual(items.map((item) => item.key), [
    'first',
    'first::selected-cover:1',
    'first::selected-cover:2',
    'second',
  ]);
  assert.deepEqual(items.map((item) => item.src), [
    '/cover?selection_id=front',
    '/cover?selection_id=back',
    '',
    '/full/second',
  ]);
  assert.equal(items[2].unavailable, true);
  assert.deepEqual(first.selected_covers.map((slot) => slot.selection_id), savedOrder);
});

test('unavailable lightbox slots show an error instead of substituting another cover', () => {
  const image = {
    hidden: false,
    src: '',
    alt: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    removeAttribute(name) { if (name === 'src') this.src = ''; },
  };
  const loading = { hidden: true };
  const error = { hidden: true };
  const status = { textContent: '' };
  const retry = { hidden: true, textContent: '' };
  const overlay = { style: {}, dataset: {} };
  const { context, elements } = loadModalHelpers();
  Object.assign(elements, {
    'image-lightbox': overlay,
    'image-lightbox-image': image,
    'image-lightbox-loading': loading,
    'image-lightbox-error': error,
    'image-lightbox-status': status,
    'image-lightbox-retry': retry,
  });
  context.state.lightbox.items = [{
    key: 'first::selected-cover:2',
    src: '',
    previewSrc: '',
    unavailable: true,
    alt: 'Cover 3 unavailable',
  }];

  assert.equal(context.showLightboxItem(0), true);
  assert.equal(context.state.lightbox.currentIndex, 0);
  assert.equal(error.hidden, false);
  assert.equal(status.textContent, 'Cover could not be loaded.');
  assert.equal(image.src, '');
});

test('Album Details opens the lightbox at the displayed selected-cover index', () => {
  const { context, Element } = loadTrackHelpers();
  const items = [
    { key: 'first', src: '/cover?selection_id=front' },
    { key: 'first::selected-cover:1', src: '/cover?selection_id=back' },
  ];

  assert.equal(context.getTrackModalLightboxSourceAlbumKey(new Element(0)), 'first');
  assert.equal(
    context.getTrackModalLightboxSourceAlbumKey(new Element(1)),
    'first::selected-cover:1',
  );
  assert.equal(
    context.getLightboxOpeningIndex(items, '/cover?selection_id=back', 'first'),
    1,
  );
});

test('full-size selected-cover navigation stays small, transparent and frameless', () => {
  const css = fs.readFileSync(
    path.join(runtime, '../../css/runtime/track-modal-and-lightbox.css'),
    'utf8',
  );
  assert.match(
    css,
    /\.image-lightbox-nav\s*\{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*border:\s*0[^}]*background:\s*transparent/s,
  );
  assert.match(css, /\.image-lightbox-nav svg\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s);
});
