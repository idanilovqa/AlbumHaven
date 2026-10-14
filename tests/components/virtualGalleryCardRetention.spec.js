const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/virtual-artist-grid.js'), 'utf8');

async function mountCacheFixture(page) {
  await page.setContent('<main id="artist-groups"></main>');
  await page.addScriptTag({ content: `${source.slice(0, source.indexOf('const virtualGrid ='))}; window.Grid = VirtualArtistGrid;` });
  await page.evaluate(() => {
    // Real DOM component fixture: exercise production patch/cache methods with decoded images.
    window.grid = Object.assign(Object.create(window.Grid.prototype), {
      containerEl: document.getElementById('artist-groups'),
      albumCardNodeCache: new Map(), _renderGeneration: 1, _preserveExistingChildrenGeneration: -1,
    });
    window.cardMarkup = (key, covered = true) => `<article class="album-card" data-gallery-card-key="${key}" data-gallery-card-render-key="${key}"><div class="cover">${covered ? '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%222%22 height=%222%22/%3E" data-production-cover-src="/cover?path=fixture">' : '<span>No cover</span>'}</div></article>`;
    window.record = (key, cards) => ({ key, html: `<section><div class="artist-rows">${cards}</div></section>` });
    window.decodeMounted = () => Promise.all([...grid.containerEl.querySelectorAll('img')].map(image => image.decode()));
  });
}

for (const pathKind of ['section-removal', 'section-update']) {
  test(`cached cards release detached ancestor siblings after ${pathKind}`, async ({ page }) => {
    await mountCacheFixture(page);
    const result = await page.evaluate(async pathKind => {
      const original = record('artist:original', cardMarkup('retained') + cardMarkup('survivor') + cardMarkup('uncached', false));
      grid.patchRenderedSections([original]);
      await decodeMounted();
      const retained = grid.containerEl.querySelector('[data-gallery-card-key="retained"]');
      const image = retained.querySelector('img');
      const survivor = grid.containerEl.querySelector('[data-gallery-card-key="survivor"]');
      grid.rememberRenderedAlbumCards(grid.containerEl);
      const liveCardsStayedMounted = retained.isConnected && survivor.isConnected;
      const next = pathKind === 'section-update'
        ? record('artist:original', cardMarkup('survivor'))
        : record('artist:next', cardMarkup('new'));
      grid.patchRenderedSections([next]);
      const detachedParent = retained.parentNode;
      const mountedSurvivorPreserved = pathKind !== 'section-update'
        || grid.containerEl.querySelector('[data-gallery-card-key="survivor"]') === survivor;
      const isolatedCachedNodes = [...grid.albumCardNodeCache.values()]
        .filter(card => !card.isConnected).every(card => card.parentNode === null);
      grid.patchRenderedSections([original]);
      return {
        liveCardsStayedMounted, isolatedCachedNodes, mountedSurvivorPreserved,
        retainedParentAbsent: detachedParent === null,
        reusedCard: grid.containerEl.querySelector('[data-gallery-card-key="retained"]') === retained,
        reusedImage: retained.querySelector('img') === image,
        decodedImagePreserved: image.complete && image.naturalWidth === 2,
        reattached: retained.isConnected,
      };
    }, pathKind);
    expect(result).toEqual({
      liveCardsStayedMounted: true, isolatedCachedNodes: true, mountedSurvivorPreserved: true,
      retainedParentAbsent: true, reusedCard: true, reusedImage: true,
      decodedImagePreserved: true, reattached: true,
    });
  });
}

test('cache eviction cannot keep obsolete sibling cards reachable through retained ancestors', async ({ page }) => {
  await mountCacheFixture(page);
  const result = await page.evaluate(async () => {
    grid.patchRenderedSections([record('artist:many', Array.from({ length: 60 }, (_, i) => cardMarkup(`album-${i}`)).join(''))]);
    await decodeMounted();
    grid.patchRenderedSections([record('artist:next', cardMarkup('next', false))]);
    const cached = [...grid.albumCardNodeCache.values()];
    const roots = new Set(cached.map(card => {
      let ancestor = card;
      while (ancestor.parentNode) ancestor = ancestor.parentNode;
      return ancestor;
    }));
    const reachableCards = new Set();
    roots.forEach(ancestor => {
      if (ancestor.matches?.('.album-card')) reachableCards.add(ancestor);
      ancestor.querySelectorAll('.album-card').forEach(card => reachableCards.add(card));
    });
    return {
      cached: cached.length, roots: roots.size, reachableCards: reachableCards.size,
      isolated: cached.every(card => !card.isConnected && card.parentNode === null),
      obsoleteReachable: [...reachableCards].some(card => Number(card.dataset.galleryCardKey.replace('album-', '')) < 12),
      mountedNext: grid.containerEl.querySelector('[data-gallery-card-key="next"]').isConnected,
    };
  });
  expect(result).toEqual({ cached: 48, roots: 48, reachableCards: 48, isolated: true, obsoleteReachable: false, mountedNext: true });
});
