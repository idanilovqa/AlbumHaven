import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

// Owner rule: the drawer's mode buttons only switch which tree is shown; the gallery loads only when an item is
// chosen from the tree.
const LOADS = new Set(['/view-data', '/library/loose-tracks']);

test.describe('phone navigation tree mode buttons', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

  test('FTC-MOBILE-TREE-MODE-001 mode buttons switch the tree without loading; choosing an artist loads the gallery once', { tag: '@area:gallery-search' }, async ({
    galleryActions,
    page,
    stepLogger,
  }) => {
    const mobileLayout = new MobileLayoutPage(page);
    const rail = mobileLayout.artistRail;
    const loads = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (LOADS.has(url.pathname)) loads.push(`${url.pathname}${url.search}`);
    });
    const galleryCards = () => page.locator('#artist-groups [data-open-tracklist]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('data-album-key') || node.textContent.trim()),
    );
    let cardsBefore = [];

    await stepLogger.step('Open an artist gallery and the library drawer', async () => {
      await galleryActions.goto('/?surface=albums&artist=Metallica');
      await galleryActions.waitForGalleryReady();
      await expect(mobileLayout.galleryContextName).toHaveText('Metallica');
      cardsBefore = await galleryCards();
      expect(cardsBefore.length).toBeGreaterThan(0);
      await mobileLayout.libraryButton.click();
      await expect(rail).toHaveAttribute('aria-hidden', 'false');
      // parity-check: allow-read-only-measurement-evaluate -- count gallery DOM changes while the mode buttons are used
      await page.evaluate(() => {
        window.__treeModeGalleryMutations = 0;
        const gallery = document.getElementById('artist-groups');
        new MutationObserver((records) => { window.__treeModeGalleryMutations += records.length; })
          .observe(gallery, { childList: true, subtree: true });
      });
      loads.length = 0;
    });

    for (const [mode, shownTree, hiddenTree] of [
      ['collections', '#sidebar-collections', '#sidebar-list'],
      ['artists', '#sidebar-list', '#sidebar-collections'],
    ]) {
      await stepLogger.step(`The ${mode} mode button only switches the shown tree`, async () => {
        await rail.locator(`[data-navigation-mode="${mode}"]`).click();
        await expect(rail).toHaveAttribute('data-library-navigation-mode', mode);
        await expect(rail.locator(`[data-navigation-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator(shownTree)).toBeVisible();
        await expect(page.locator(hiddenTree)).toBeHidden();
        await expect(rail).toHaveAttribute('aria-hidden', 'false');
        await expect(page.locator('#non-album-modal')).toBeHidden();
        await page.waitForTimeout(500);
        expect(loads, 'a mode button never loads a gallery or Loose Tracks').toEqual([]);
        expect(await page.evaluate(() => window.__treeModeGalleryMutations)).toBe(0);
        expect(await galleryCards()).toEqual(cardsBefore);
        await expect(mobileLayout.galleryContextName).toHaveText('Metallica');
      });
    }

    await stepLogger.step('Choosing an artist from the tree loads its gallery exactly once', async () => {
      const target = rail.locator('#sidebar-list [data-sidebar-artist="Mastodon"]').first();
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await expect(mobileLayout.galleryContextName).toHaveText('Mastodon');
      await galleryActions.waitForGalleryReady();
      await page.waitForTimeout(500);
      const galleryLoads = loads.filter((entry) => entry.startsWith('/view-data') && new URLSearchParams(entry.split('?')[1]).get('artist') === 'Mastodon');
      expect(galleryLoads, JSON.stringify(loads)).toHaveLength(1);
      expect(loads.filter((entry) => entry.startsWith('/library/loose-tracks?') && !entry.includes('artist='))).toEqual([]);
    });
  });
});
