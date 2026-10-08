const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

function locatorPage({ names = [null], contextName = '', contextKind = 'single-artist' } = {}) {
  const sections = names.map((name, index) => ({
    kind: 'section', id: index, children: name === null ? [] : [{ kind: 'heading', text: name }],
  }));
  const gallery = { kind: 'gallery', children: sections };
  const bar = { kind: 'bar', children: [{ kind: 'context', text: contextName }] };
  const descendants = node => (node.children || []).flatMap(child => [child, ...descendants(child)]);
  const all = [gallery, bar, ...descendants(gallery), ...descendants(bar)];
  class Locator {
    constructor(nodes) { this.nodes = nodes; }
    filter({ has, hasText }) {
      return new Locator(this.nodes.filter(node => has
        ? descendants(node).some(child => has.nodes.includes(child))
        : hasText.test(node.text || '')));
    }
    or(other) { return new Locator([...new Set([...this.nodes, ...other.nodes])]); }
    first() { return new Locator(this.nodes.slice(0, 1)); }
    locator(selector) {
      if (selector === 'xpath=following::*[@id="artist-groups"][1]') {
        return new Locator(this.nodes.some(node => node === bar) ? [gallery] : []);
      }
      assert.equal(selector, ':scope > .artist-section:only-child:not(:has(.artist-name))');
      return new Locator(this.nodes.flatMap(node => node.children.length === 1
        && node.children[0].kind === 'section' && node.children[0].children.length === 0
        ? node.children : []));
    }
  }
  return {
    locator(selector) {
      const kinds = {
        '#artist-groups .artist-section': 'section', '.artist-name': 'heading',
        '[data-gallery-context-name]': 'context',
        '[data-gallery-bar-instance="gallery"][data-gallery-context-kind="single-artist"]': 'bar',
      };
      const kind = kinds[selector];
      return new Locator(all.filter(node => node.kind === kind
        && (kind !== 'bar' || contextKind === 'single-artist')));
    },
  };
}

const load = () => import(pathToFileURL(path.resolve(__dirname, '../e2e/poms/albumCard.js')).href);

for (const artist of ['Northlight', 'L\'Étranger "東京"']) {
  test(`headerless single-artist scope requires the exact GalleryBar identity: ${artist}`, async () => {
    const { AlbumCard } = await load();
    const cards = new AlbumCard(locatorPage({ contextName: artist }));
    assert.deepEqual(cards.sectionByArtistHeading(artist).nodes.map(node => node.id), [0]);
    assert.deepEqual(cards.sectionByArtistHeading(`${artist} family`).nodes, []);
  });
}

test('a mismatched or non-single GalleryBar cannot name a headerless section', async () => {
  const { AlbumCard } = await load();
  for (const options of [{ contextName: 'Other' }, { contextName: 'Northlight', contextKind: 'artist' }]) {
    assert.deepEqual(new AlbumCard(locatorPage(options)).sectionByArtistHeading('Northlight').nodes, []);
  }
});

test('multiple headerless sections cannot masquerade as a single artist', async () => {
  const { AlbumCard } = await load();
  const cards = new AlbumCard(locatorPage({ names: [null, null], contextName: 'Northlight' }));
  assert.deepEqual(cards.sectionByArtistHeading('Northlight').nodes, []);
});

test('multi-artist sections keep their own exact headings independently of GalleryBar', async () => {
  const { AlbumCard } = await load();
  const cards = new AlbumCard(locatorPage({ names: ['Neal Morse', 'Neal Morse Band'], contextName: 'Other', contextKind: 'family' }));
  assert.deepEqual(cards.sectionByArtistHeading('Neal Morse').nodes.map(node => node.id), [0]);
  assert.deepEqual(cards.sectionByArtistHeading('Neal Morse Band').nodes.map(node => node.id), [1]);
  assert.deepEqual(cards.sectionByArtistHeading('Neal').nodes, []);
});

test('single-card artist lookup forwards visible-card ownership to the shared locator', async () => {
  const { AlbumCard } = await load();
  const cards = new AlbumCard(locatorPage());
  const calls = [];
  const expectedCard = {};
  cards.cardsByArtistAndAlbum = (artistName, albumName, options) => {
    calls.push({ artistName, albumName, options });
    return { first: () => expectedCard };
  };

  const card = cards.cardByArtistAndAlbum('Neal Morse', 'Sola Scriptura', { visible: true });

  assert.equal(card, expectedCard);
  assert.deepEqual(calls, [{
    artistName: 'Neal Morse',
    albumName: 'Sola Scriptura',
    options: { visible: true },
  }]);
});

async function observeGalleryCount({ heading = null, contextName = 'Northlight', sectionCount = 1 } = {}) {
  const { GalleryPage } = await import(pathToFileURL(path.resolve(__dirname, '../e2e/poms/galleryPage.js')).href);
  const vm = require('node:vm');
  const cards = ['One', 'One', 'Two'].map(title => ({
    querySelector(selector) { return { textContent: selector === '.album-year' ? '2005' : title }; },
  }));
  const element = {
    querySelector(selector) {
      if (selector === '.artist-name') return heading ? { textContent: heading } : null;
      return heading ? { textContent: '14 albums' } : null;
    },
    querySelectorAll: () => cards,
  };
  const bar = { querySelector: selector => ({ textContent: selector === '[data-gallery-context-name]' ? contextName : '14 albums' }) };
  const document = {
    querySelector: () => bar,
    querySelectorAll: () => Array(sectionCount).fill(element),
  };
  return GalleryPage.prototype.readProductionVisibleAlbumObservation.call({
    sectionByArtistHeading(name) {
      assert.equal(name, 'Northlight');
      return { evaluate(callback, selectors) {
        return vm.runInNewContext(`(${callback.toString()})(element, selectors)`, { element, selectors, document });
      } };
    },
    albumCardWithinSectionSelector: '.album-card',
    albumTitleButtonWithinSectionSelector: '.album-title-button',
    artistSectionSelector: '#artist-groups .artist-section',
    albumCard: { yearWithinCardSelector: '.album-subtitle', singleArtistContextSelector: '.single-artist' },
  }, 'Northlight', ['One', 'Two']);
}

for (const heading of [null, 'Northlight']) {
  test(`visible album counts preserve duplicates and total counts with ${heading ? 'section' : 'GalleryBar'} ownership`, async () => {
    const observation = await observeGalleryCount({ heading });
    assert.equal(observation.albumCount, 14);
    assert.deepEqual(JSON.parse(JSON.stringify(observation.renderedIdentities)), [
      { album: 'One', year: '2005' }, { album: 'One', year: '2005' }, { album: 'Two', year: '2005' },
    ]);
  });
}

test('headerless count observation rejects a stale context and multiple sections', async () => {
  await assert.rejects(observeGalleryCount({ contextName: 'Other' }), /exact visible artist album count/);
  await assert.rejects(observeGalleryCount({ sectionCount: 2 }), /exact visible artist album count/);
});
