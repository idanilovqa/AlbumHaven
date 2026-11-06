import { expect, test } from '../support/baseFixtures.js';

const QUERY = 'neal morse';
const FAMILY_ARTIST = 'Neal Morse';
const PASTED_QUERY_URL = `/?surface=albums&q=${encodeURIComponent(QUERY)}&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals`;

test.afterEach(async ({ appBarActions }) => {
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test(
  'FTC-SEARCH-NAV-035 a pasted search URL without an artist loads its results while a full rescan runs',
  { tag: '@area:gallery-search' },
  async ({ appBarActions, galleryActions, navigationPanelActions, page, searchToolbarActions, stepLogger }) => {
    test.setTimeout(180000);
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();

    await stepLogger.step('Open a q-only search URL as a new document while the rescan is still running', async () => {
      let servedDuringScan = false;
      for (let attempt = 0; attempt < 3 && !servedDuringScan; attempt += 1) {
        await appBarActions.triggerFullRescanAndWaitForBusy();
        await galleryActions.goto(PASTED_QUERY_URL);
        servedDuringScan = await page.evaluate(() => Boolean(bootstrap?.scanInProgress));
        if (!servedDuringScan) await appBarActions.waitForScanAndCoverRefreshIdle();
      }
      // The defect only exists while a scan runs; the case must observe that state.
      expect(servedDuringScan).toBe(true);
    });

    await stepLogger.step('Render the same selected family the search box selects, not Nothing found', async () => {
      await searchToolbarActions.waitForQuery(QUERY);
      await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
      await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, { queryValue: QUERY });
      // The empty-state loader stays mounted with its text; it must not be shown.
      await expect(page.getByText('Nothing found', { exact: true })).toBeHidden();
      expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(FAMILY_ARTIST);
      const canonicalState = await searchToolbarActions.readCanonicalSearchState({ source: 'bootstrap' });
      expect(canonicalState.query).toBe(QUERY);
      expect(canonicalState.selectedArtist).toBe(FAMILY_ARTIST);
    });

    await stepLogger.step('Keep the results after the rescan finishes and the page reloads', async () => {
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await page.reload();
      await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
      await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, { queryValue: QUERY });
    });
  },
);
