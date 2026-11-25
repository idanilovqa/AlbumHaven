import { expect, test } from '../support/baseFixtures.js';

const SEARCH_ARTIST = 'Metallica';

test.describe('Artist Tree scroll during a search', () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test('FTC-NAV-TREE-SCROLL-001 a search shows no tree scrollbar while it runs or once its short results fit', { tag: '@area:gallery-search' }, async ({
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
  }) => {
    const rail = page.locator('#shell-navigation-rail');
    const scrollGeometry = () => rail.evaluate((node) => ({
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      pending: node.hasAttribute('data-search-pending'),
    }));
    await stepLogger.step('Scroll the long full Artist Tree', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.setArtistTreeFolded(false);
      const before = await scrollGeometry();
      expect(before.scrollHeight, JSON.stringify(before)).toBeGreaterThan(before.clientHeight + 100);
      await rail.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await expect.poll(async () => (await scrollGeometry()).scrollTop).toBeGreaterThan(100);
    });
    await stepLogger.step('While the search runs, the emptied tree has no scrollbar', async () => {
      // The search response is slowed (not changed) so the running state is observable on every frame.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditionsByRule', {
        matchedNetworkConditions: [{
          urlPattern: `${new URL(page.url()).origin}/view-data*`,
          latency: 1500,
          downloadThroughput: -1,
          uploadThroughput: -1,
        }],
      });
      // parity-check: allow-read-only-measurement-evaluate -- record the rail's scroll geometry on every frame
      await page.evaluate(() => {
        const node = document.getElementById('shell-navigation-rail');
        window.__treeScrollFrames = [];
        const read = () => {
          if (node.hasAttribute('data-search-pending')) {
            window.__treeScrollFrames.push({ scrollTop: node.scrollTop, overflow: node.scrollHeight - node.clientHeight });
          }
          if (!window.__treeScrollStop) requestAnimationFrame(read);
        };
        requestAnimationFrame(read);
      });
      await searchToolbarActions.search(SEARCH_ARTIST, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(SEARCH_ARTIST);
      await cdp.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
      await cdp.detach();
      const frames = await page.evaluate(() => { window.__treeScrollStop = true; return window.__treeScrollFrames; });
      expect(frames.length, 'the running search was observed').toBeGreaterThan(0);
      expect(frames.filter((frame) => frame.overflow > 0 || frame.scrollTop !== 0), JSON.stringify(frames.slice(0, 5))).toEqual([]);
    });
    await stepLogger.step('The short results fit: no scrollbar and the tree at its top', async () => {
      await expect(page.locator(`#sidebar-list [data-sidebar-artist="${SEARCH_ARTIST}"]`).first()).toBeVisible();
      const after = await scrollGeometry();
      expect(after.pending).toBe(false);
      expect(after.scrollHeight, JSON.stringify(after)).toBeLessThanOrEqual(after.clientHeight);
      expect(after.scrollTop).toBe(0);
    });
  });
});
