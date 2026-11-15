const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  countedCollection,
  createInteractionCounter,
  measureScalePair,
} = require('../helpers/bounded-interaction-counter');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const RUNTIME_FILES = [
  'markup-format-helpers.js',
  'album-artbox.js',
  'gallery-main-components.js',
  'gallery-main-state.js',
  'gallery-main-interactions.js',
];
const SECTION_HEIGHT = 300;

function element() {
  return {
    dataset: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    style: {},
    setAttribute() {},
    remove() {},
    insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 54 }),
  };
}

// The all-artists gallery: one virtual-grid section per loaded artist group.
function loadGallery(artistCount) {
  const counter = createInteractionCounter();
  const groups = Array.from({ length: artistCount }, (_, index) => ({
    artist: `Artist ${String(index).padStart(5, '0')}`,
    albums: [{ key: `album-${index}-a`, source: 'main_library' }, { key: `album-${index}-b`, source: 'main_library' }],
  }));
  const sections = groups.map((group, index) => ({ kind: 'artist', group, top: index * SECTION_HEIGHT }));
  const barParts = {
    '[data-gallery-context-name]': element(),
    '[data-gallery-context-summary]': element(),
  };
  const bar = { ...element(), querySelector: selector => barParts[selector] || null };
  const scroll = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => null,
  };
  const context = {
    console,
    escapeHtml: value => String(value ?? ''),
    state: {
      gallery: {},
      ui: {},
      view: { artist_groups: countedCollection(groups, counter), artist_count: artistCount, album_count: artistCount * 2 },
    },
    virtualGrid: { sections: countedCollection(sections, counter), sectionHeaderHeight: 40 },
    document: {
      querySelector: selector => (selector === '[data-gallery-bar-instance="gallery"]' ? bar : null),
      querySelectorAll: () => [],
      getElementById: id => (id === 'albums-scroll' ? scroll : null),
    },
    window: { innerWidth: 1400 },
  };
  vm.createContext(context);
  for (const file of RUNTIME_FILES) {
    const sourcePath = path.join(runtimeRoot, file);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  context.updateGalleryMainControls = () => {};
  return { context, counter, scroll, barParts };
}

// One scroll frame that moves from one artist's section to the next.
async function adjacentScrollFrame(artistCount) {
  const { context, counter, scroll, barParts } = loadGallery(artistCount);
  context.updateGalleryMainChrome();
  const middle = Math.floor(artistCount / 2);
  scroll.scrollTop = middle * SECTION_HEIGHT + 50;
  context.updateGalleryMainScrollContext();
  scroll.scrollTop = (middle + 1) * SECTION_HEIGHT + 50;
  const counts = await counter.measure(() => context.updateGalleryMainScrollContext());
  assert.equal(barParts['[data-gallery-context-name]'].textContent, `Artist ${String(middle + 1).padStart(5, '0')}`);
  return counts;
}

test('BI gallery scroll frame finds the visible artist by binary search at production scale', async () => {
  const { small, large } = await measureScalePair({
    id: 'js:runtime/gallery-main-interactions.js#initGalleryMain',
    small: 20,
    large: 14000,
    run: adjacentScrollFrame,
    budgets: { itemsVisited: 32, renderCommits: 0, requests: 0 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 24 },
  });
  assert.ok(large.itemsVisited <= 2 * Math.ceil(Math.log2(14000)), `large frame visited ${large.itemsVisited}`);
  assert.ok(small.itemsVisited > 0);
});

test('gallery scroll context falls back to a full chrome update when the view changed', () => {
  const { context, scroll, barParts } = loadGallery(20);
  context.updateGalleryMainChrome();
  context.state.view = { ...context.state.view, artist_count: 3 };
  scroll.scrollTop = 0;
  context.updateGalleryMainScrollContext();
  assert.match(barParts['[data-gallery-context-summary]'].textContent, /^3 artists/);
});
