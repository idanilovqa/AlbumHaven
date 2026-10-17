import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

const FIRST_ALBUM = 'Featured Signal Collection';
const SECOND_ALBUM = 'Ordinary Numeric Disc Control';

async function verifyColdAlbumTransition({
 galleryActions,
 mobile,
 page,
 searchToolbarActions,
  stepLogger,
  trackModalActions,
}) {
 let observation = null;
 let mobileLayout = null;
 try {
 await stepLogger.step(`Open and close album A on ${mobile ? 'mobile' : 'desktop'}`, async () => {
 await galleryActions.goto('/?surface=albums');
 if (mobile) {
 mobileLayout = new MobileLayoutPage(page);
 await mobileLayout.libraryButton.click();
 await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
 await mobileLayout.allArtists.click();
 await expect(mobileLayout.home).toBeHidden();
 }
 await galleryActions.waitForGalleryReady();
 if (mobile) await mobileLayout.search(FIRST_ALBUM);
 else await searchToolbarActions.search(FIRST_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(FIRST_ALBUM);
      await galleryActions.waitForAlbumVisible(FIRST_ALBUM);
      await galleryActions.clickAlbumDetailsByAlbumName(FIRST_ALBUM);
      const firstSummary = await trackModalActions.waitForLoadedSummary();
      expect(firstSummary.title).toContain(FIRST_ALBUM);
      const firstTracks = await trackModalActions.readTrackTitles();
      expect(firstTracks.length).toBeGreaterThan(0);
      if (mobile) await trackModalActions.backFromMobilePage();
      else await trackModalActions.close();

 if (mobile) await mobileLayout.search(SECOND_ALBUM);
 else await searchToolbarActions.search(SECOND_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(SECOND_ALBUM);
      await galleryActions.waitForAlbumVisible(SECOND_ALBUM);

      observation = await trackModalActions.trackModal.startVisibleContentObservation();
      await galleryActions.clickAlbumDetailsByAlbumName(SECOND_ALBUM);
      await expect(trackModalActions.trackModal.dialog).toBeVisible();
      await expect(trackModalActions.trackModal.title).toContainText(SECOND_ALBUM);
      await expect(trackModalActions.trackModal.title).not.toContainText(FIRST_ALBUM);
      const immediateTracks = await trackModalActions.readTrackTitles();
      expect(immediateTracks.filter((title) => firstTracks.includes(title))).toEqual([]);

      const secondSummary = await trackModalActions.waitForLoadedSummary();
      expect(secondSummary.title).toContain(SECOND_ALBUM);
      const samples = await observation.finish();
      observation = null;
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(sample.title).toContain(SECOND_ALBUM);
        expect(`${sample.title} ${sample.subtitle}`).not.toContain(FIRST_ALBUM);
        expect(sample.tracks.filter((title) => firstTracks.includes(title))).toEqual([]);
        if (sample.loading) {
          expect(sample.subtitle).toBe('Loading album details...');
          expect(sample.tracks).toEqual([]);
        }
      }
    });
  } finally {
    if (observation) await observation.finish();
    if (await trackModalActions.trackModal.dialog.isVisible()) {
      if (mobile) await trackModalActions.backFromMobilePage();
      else await trackModalActions.close();
    }
  }
}

test('FTC-ALBUM-DETAILS-024 desktop identifies cold album B before its details settle without restoring album A', { tag: '@area:album-details' }, async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await verifyColdAlbumTransition({
    galleryActions,
    mobile: false,
    searchToolbarActions,
    stepLogger,
    trackModalActions,
  });
});

test.describe('mobile album transition', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

 test('FTC-ALBUM-DETAILS-025 mobile identifies cold album B before its details settle without restoring album A', { tag: '@area:album-details' }, async ({
 galleryActions,
 page,
 searchToolbarActions,
    stepLogger,
    trackModalActions,
  }) => {
 await verifyColdAlbumTransition({
 galleryActions,
 mobile: true,
 page,
 searchToolbarActions,
      stepLogger,
      trackModalActions,
    });
  });
});
