import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

const SEARCH_ARTIST = 'Metallica';
const selectedTreeRows = (page) => page.locator(
  '#sidebar-list [data-navigation-tree-item][aria-current], #sidebar-list .artist-link.active',
);

test.describe('Loose Tracks navigation on the web', () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test('FTC-LOOSE-NAV-001 the navigation-tree header sits on the Gallery title baseline', { tag: '@area:gallery-search' }, async ({
    galleryActions,
    navigationPanelActions,
    page,
    stepLogger,
  }) => {
    await stepLogger.step('Open the Gallery with the Artist Tree expanded', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.setArtistTreeFolded(false);
      await expect(page.locator('#navigation-tree-heading')).toHaveText('Artists');
      await expect(page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]')).toBeVisible();
    });
    await stepLogger.step('"Artists" shares the Gallery title text baseline within 1px', async () => {
      // parity-check: allow-read-only-measurement-evaluate -- a zero-size inline probe reads each text baseline
      const baselines = await page.evaluate(() => {
        const baseline = (node) => {
          const probe = document.createElement('span');
          probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
          node.appendChild(probe);
          const value = probe.getBoundingClientRect().bottom;
          probe.remove();
          return value;
        };
        return {
          heading: baseline(document.getElementById('navigation-tree-heading')),
          gallery: baseline(document.querySelector('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]')),
        };
      });
      expect(Math.abs(baselines.heading - baselines.gallery), JSON.stringify(baselines)).toBeLessThanOrEqual(1);
    });
  });

  test('FTC-LOOSE-NAV-002 reopening the Artist Tree over Loose Tracks selects no artist after a search', { tag: '@area:gallery-search' }, async ({
    artistPageSettingsActions,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
  }) => {
    await stepLogger.step('Search for one band: the tree selects it', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.setArtistTreeFolded(false);
      await searchToolbarActions.search(SEARCH_ARTIST, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(SEARCH_ARTIST);
      await expect(selectedTreeRows(page).first()).toBeVisible();
    });
    await stepLogger.step('Open library-wide Loose Tracks', async () => {
      await artistPageSettingsActions.openLibraryWideNonAlbumTracks();
      await expect(page.getByRole('heading', { name: 'Loose Tracks', exact: true })).toBeVisible();
    });
    await stepLogger.step('Reopen the Artist Tree: Loose Tracks stays the page and no tree row is selected', async () => {
      await navigationPanelActions.setArtistTreeFolded(false);
      await expect(page.locator('#sidebar-list')).toBeVisible();
      await expect(page.locator(`#sidebar-list [data-sidebar-artist="${SEARCH_ARTIST}"]`).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Loose Tracks', exact: true })).toBeVisible();
      await expect(selectedTreeRows(page)).toHaveCount(0);
    });
  });
});

test.describe('Loose Tracks navigation on a phone', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('FTC-LOOSE-NAV-003 Loose Tracks opened from the drawer shows the hamburger that reopens the tree', { tag: '@area:gallery-search' }, async ({
    galleryActions,
    page,
    stepLogger,
  }) => {
    const mobileLayout = new MobileLayoutPage(page);
    const header = page.locator('#mobile-page-header');
    const hamburger = header.getByRole('button', { name: 'Open library navigation', exact: true });
    await stepLogger.step('Open Loose Tracks from the library drawer', async () => {
      await galleryActions.goto('/?surface=albums');
      await mobileLayout.openLooseTracksFromDrawer();
      await expect(page.locator('#mobile-page-title')).toHaveText('Loose Tracks');
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'true');
    });
    await stepLogger.step('The page header shows the hamburger and no Back', async () => {
      await expect(hamburger).toBeVisible();
      await expect(mobileLayout.backButton).toBeHidden();
      const [menu, title] = await Promise.all([hamburger.boundingBox(), page.locator('#mobile-page-title').boundingBox()]);
      expect(menu.x + menu.width).toBeLessThanOrEqual(title.x);
    });
    await stepLogger.step('The hamburger reopens the navigation tree over Loose Tracks', async () => {
      await hamburger.click();
      await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
      await expect(page.locator('#sidebar-collections [data-navigation-tree-item]').first()).toBeVisible();
    });
  });
});
