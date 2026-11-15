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
const LABEL_BOTTOM = 40;
const RENDERED_SECTIONS = 4;

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
    addEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 54 }),
  };
}

// The all-artists gallery after initGalleryMain: one virtual-grid section per loaded artist
// group, and artist labels rendered only for the sections around the viewport.
function loadGallery(artistCount) {
  const counter = createInteractionCounter();
  const groups = Array.from({ length: artistCount }, (_, index) => ({
    artist: `Artist ${String(index).padStart(5, '0')}`,
    albums: [{ key: `album-${index}-a`, source: 'main_library' }, { key: `album-${index}-b`, source: 'main_library' }],
    artist_image_url: `/artist-images/${index}.jpg`,
  }));
  const sections = groups.map((group, index) => ({ kind: 'artist', group, top: index * SECTION_HEIGHT }));
  const barParts = {
    '[data-gallery-context-name]': element(),
    '[data-gallery-context-summary]': element(),
  };
  const bar = { ...element(), querySelector: selector => barParts[selector] || null };
  const scrollListeners = [];
  const labelSelector = /^\[data-scroll-artist="(.+)"\] \.artist-name$/;
  const scroll = {
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener(type, listener) { if (type === 'scroll') scrollListeners.push(listener); },
    querySelector(selector) {
      counter.count('domQueries');
      const index = groups.findIndex(group => group.artist === selector.match(labelSelector)?.[1]);
      const firstRendered = Math.floor(scroll.scrollTop / SECTION_HEIGHT) - 1;
      if (index < firstRendered || index > firstRendered + RENDERED_SECTIONS) return null;
      const bottom = index * SECTION_HEIGHT + LABEL_BOTTOM - scroll.scrollTop;
      return { getBoundingClientRect: () => ({ top: bottom - 20, bottom }) };
    },
  };
  const frames = [];
  const documentListeners = {};
  const prefetchedImages = [];
  const context = {
    console,
    escapeHtml: value => String(value ?? ''),
    cssEscape: value => String(value),
    state: {
      gallery: {},
      ui: {},
      view: { artist_groups: countedCollection(groups, counter), artist_count: artistCount, album_count: artistCount * 2 },
    },
    virtualGrid: { sections: countedCollection(sections, counter), sectionHeaderHeight: LABEL_BOTTOM },
    document: {
      querySelector: selector => (selector === '[data-gallery-bar-instance="gallery"]' ? bar : null),
      querySelectorAll: () => [],
      getElementById: id => (id === 'albums-scroll' ? scroll : null),
      addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); },
    },
    Image: function Image() { prefetchedImages.push(this); },
    window: { innerWidth: 1400, addEventListener() {} },
    requestAnimationFrame: (callback) => { counter.count('animationFrames'); frames.push(callback); return frames.length; },
  };
  vm.createContext(context);
  for (const file of RUNTIME_FILES) {
    const sourcePath = path.join(runtimeRoot, file);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  context.updateGalleryMainControls = () => {};
  context.initGalleryMain();
  assert.equal(scrollListeners.length, 1, 'initGalleryMain installs one gallery scroll listener');
  // A browser scroll event, then the animation frame it requested.
  const scrollTo = (scrollTop) => {
    scroll.scrollTop = scrollTop;
    scrollListeners.forEach(listener => listener({ type: 'scroll' }));
    while (frames.length) frames.shift()();
  };
  // A pointer entering an artist's info button.
  const hoverInfo = artist => (documentListeners.pointerover || []).forEach(listener => listener({
    type: 'pointerover',
    target: { closest: selector => (selector === '[data-artist-info-trigger]' ? { dataset: { artist } } : null) },
  }));
  return { context, counter, scrollTo, barParts, hoverInfo, prefetchedImages };
}

// One scroll frame that moves from one artist's section to the next.
async function adjacentScrollFrame(artistCount) {
  const { counter, scrollTo, barParts } = loadGallery(artistCount);
  const middle = Math.floor(artistCount / 2);
  scrollTo(middle * SECTION_HEIGHT + 50);
  assert.equal(barParts['[data-gallery-context-name]'].textContent, `Artist ${String(middle).padStart(5, '0')}`);
  const counts = await counter.measure(() => scrollTo((middle + 1) * SECTION_HEIGHT + 50));
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
  assert.equal(large.domQueries, small.domQueries, 'label measurement stays at the visible section');
});

test('a scrolled label that has not passed the viewport keeps the previous artist', () => {
  const { scrollTo, barParts } = loadGallery(20);
  // Inside Artist 00006's section but above its label: Artist 00005 still owns the bar.
  scrollTo(6 * SECTION_HEIGHT + 10);
  assert.equal(barParts['[data-gallery-context-name]'].textContent, 'Artist 00005');
});

test('gallery scroll context falls back to a full chrome update when the view changed', () => {
  const { context, scrollTo, barParts } = loadGallery(20);
  context.state.view = { ...context.state.view, artist_count: 3 };
  scrollTo(0);
  assert.match(barParts['[data-gallery-context-summary]'].textContent, /^3 artists/);
});

test('gallery scroll context falls back to a full chrome update after an in-place filter change', () => {
  const { context, scrollTo } = loadGallery(20);
  let fullUpdates = 0;
  context.updateGalleryMainControls = () => { fullUpdates += 1; };
  scrollTo(SECTION_HEIGHT);
  assert.equal(fullUpdates, 0, 'an unchanged gallery scrolls without a full chrome update');
  context.ensureGalleryMainState().sources.hoard = false;
  scrollTo(2 * SECTION_HEIGHT);
  assert.equal(fullUpdates, 1);
  context.ensureGalleryMainState().view = 'covers';
  scrollTo(3 * SECTION_HEIGHT);
  assert.equal(fullUpdates, 2);
});

const artistName = index => `Artist ${String(index).padStart(5, '0')}`;

// The second hover of a loaded gallery: the first one indexed the groups.
async function portraitPrefetchHover(artistCount) {
  const { counter, hoverInfo, prefetchedImages } = loadGallery(artistCount);
  hoverInfo(artistName(0));
  const counts = await counter.measure(() => hoverInfo(artistName(artistCount - 1)));
  assert.deepEqual(prefetchedImages.map(image => image.src), ['/artist-images/0.jpg', `/artist-images/${artistCount - 1}.jpg`]);
  return counts;
}

test('BI gallery info hover prefetches a portrait through the artist index at production scale', async () => {
  const { small, large } = await measureScalePair({
    id: 'js:runtime/gallery-main-interactions.js#initGalleryMain',
    small: 20,
    large: 14000,
    run: portraitPrefetchHover,
    budgets: { itemsVisited: 32, renderCommits: 0, requests: 0 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 24 },
  });
  assert.equal(large.itemsVisited, small.itemsVisited, 'a hover reads one indexed group whatever the library size');
  assert.equal(large.itemsVisited, 1);
});

test('gallery info hover follows groups replaced, appended, or swapped after indexing', () => {
  const { context, hoverInfo, prefetchedImages } = loadGallery(3);
  hoverInfo(artistName(1));
  context.state.view.artist_groups[1] = { artist: artistName(1), artist_image_url: '/artist-images/replaced.jpg' };
  hoverInfo(artistName(1));
  context.state.view.artist_groups.push({ artist: 'Late Artist', artist_image_url: '/artist-images/late.jpg' });
  hoverInfo('Late Artist');
  context.state.view = { ...context.state.view, artist_groups: [{ artist: 'Next View', artist_image_url: '/artist-images/next.jpg' }] };
  hoverInfo('Next View');
  hoverInfo(artistName(2));
  assert.deepEqual(prefetchedImages.map(image => image.src), [
    '/artist-images/1.jpg',
    '/artist-images/replaced.jpg',
    '/artist-images/late.jpg',
    '/artist-images/next.jpg',
  ]);
});
