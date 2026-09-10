import { expect, test } from '../support/baseFixtures.js';

const ALBUM = 'Mulan';
const ARTIST = 'Compilation Signal Lead';
const GALLERY_DURATION = '56m 18s';

// Fixture: 13 x 240s + 258s = 3378s, eight credited artists plus Various Artists.
// Equal durations must remain separate tracks; SUM(DISTINCT duration) is invalid.
test('FTC-GALLERY-030 counts each Mulan soundtrack track once across artist credits', async ({
  page, galleryActions, searchToolbarActions, navigationPanelActions,
  trackModalActions, stepLogger,
}) => {
  const cards = galleryActions.galleryPage.albumCard;
  const mulan = cards.cardByAlbumName(ALBUM).first();
  const checkCard = async () => {
    await expect(mulan.locator(cards.trackCountWithinCardSelector)).toHaveText('14 tracks');
    await expect.soft(mulan.locator(cards.durationWithinCardSelector)).toHaveText(GALLERY_DURATION);
  };

  await stepLogger.step('Unfiltered gallery counts each soundtrack track once', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(ARTIST, ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    await checkCard();
  });

  await stepLogger.step('Search the multi-artist soundtrack and count its duration once', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisible(ALBUM);
    await checkCard();
  });

  await stepLogger.step('Album Details independently shows 14 tracks totaling 56m 18s', async () => {
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    await expect(trackModalActions.trackModal.dialog).toBeVisible();
    await expect(trackModalActions.trackModal.trackRows).toHaveCount(14);
    await expect(trackModalActions.trackModal.albumTrackTable.total).toHaveText('Total Length: 56m 18s');
    await trackModalActions.trackModal.closeButton.click();
  });

  await stepLogger.step('Artist navigation and reload preserve the same gallery total', async () => {
    await searchToolbarActions.search('', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await navigationPanelActions.waitForSidebarSelection(ARTIST);
    await galleryActions.waitForAlbumVisible(ALBUM);
    await checkCard();
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisible(ALBUM);
    await checkCard();
  });
});

