import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

const treeArtists = (mobileLayout) => mobileLayout.artistTreeEntries.evaluateAll(
  (nodes) => nodes.map((node) => node.getAttribute('data-sidebar-artist')),
);

test.describe('mobile Home reset', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('FTC-MOBILE-HOME-001 mobile Home clears an active search and resets the Artists tree', { tag: '@area:gallery-search' }, async ({
    galleryActions,
    page,
    searchToolbarActions,
    stepLogger,
  }) => {
    const mobileLayout = new MobileLayoutPage(page);
    let fullTree = [];
    let target = '';

    await stepLogger.step('Select an artist low in the full Artists tree', async () => {
      await galleryActions.goto('/?surface=albums');
      await mobileLayout.libraryButton.click();
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
      await mobileLayout.allArtists.click();
      await galleryActions.waitForGalleryReady();
      await mobileLayout.libraryButton.click();
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
      fullTree = await treeArtists(mobileLayout);
      expect(fullTree.length).toBeGreaterThan(3);
      target = fullTree.at(-1);
      await mobileLayout.artist(target).scrollIntoViewIfNeeded();
      await mobileLayout.artist(target).click();
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'true');
      await expect(mobileLayout.artistTreeEntries.and(page.locator('[aria-current="true"]'))).toHaveAttribute('data-sidebar-artist', target);
    });

    await stepLogger.step('Search filters the tree and marks Artists with the results dot', async () => {
      await mobileLayout.search(target);
      await searchToolbarActions.waitForQuery(target);
      await expect(mobileLayout.libraryButton).toHaveAttribute('data-search-results', 'true');
      await expect.poll(() => treeArtists(mobileLayout)).not.toContain(fullTree[0]);
    });

    await stepLogger.step('Home clears the search and resets the tree', async () => {
      await mobileLayout.homeLink.click();
      await expect(mobileLayout.home).toBeVisible();
      await expect(mobileLayout.searchInput).toHaveValue('');
      await expect(mobileLayout.libraryButton).not.toHaveAttribute('data-search-results', /.*/);
      await expect.poll(() => new URL(page.url()).searchParams.get('q') || '').toBe('');
      await expect.poll(() => treeArtists(mobileLayout)).toEqual(fullTree);

      await mobileLayout.libraryButton.click();
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
      await expect(mobileLayout.artistTreeEntries.and(page.locator('[aria-current="true"]'))).toHaveCount(0);
      const first = mobileLayout.artist(fullTree[0]);
      await expect(first).toBeVisible();
      await expect(first).toBeInViewport();
      const [railBox, firstBox] = await Promise.all([mobileLayout.artistRail.boundingBox(), first.boundingBox()]);
      expect(firstBox.y).toBeGreaterThanOrEqual(railBox.y);
    });
  });
});
