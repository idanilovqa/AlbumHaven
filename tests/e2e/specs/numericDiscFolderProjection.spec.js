import { expect, test } from '../support/baseFixtures.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';

const ARTIST = 'Numeric Disc Folder Artist';
const ALBUM = 'Numeric Disc Folder Album';
const YEAR = 2007;
const TRACKS = [
  'Numeric Disc One',
  'Numeric Disc Two',
  'Numeric Disc Three',
  'Numeric Disc Four',
];

test(
  'FTC-ALBUM-DETAILS-027 numeric disc folders remain one release without duplicate versions',
  { tag: '@area:album-details' },
  async ({
    appBarActions,
    context,
    galleryActions,
    managedAppLifecycle,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(240000);
    let fixture;
    let originalFailure;

    try {
      await stepLogger.step('Create four tagged numeric disc folders and rebuild the library', async () => {
        await managedAppLifecycle.stop();
        fixture = await createWatchedAlbumFixture({
          artist: ARTIST,
          albumArtist: ARTIST,
          album: ALBUM,
          year: YEAR,
          trackTitles: TRACKS,
          discNumbers: [1, 2, 3, 4],
          fixtureDirectory: 'watcher-numeric-discs',
          context,
          managedAppLifecycle,
        });
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
      });

      const identity = { artist: ARTIST, album: ALBUM, year: YEAR };
      await stepLogger.step('Show one release with all four discs and no duplicate-source tabs', async () => {
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
        await galleryActions.selectAlbumDetailsByIdentity(identity);
        expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(TRACKS.length);
        expect(await trackModalActions.readTrackTitles()).toEqual(TRACKS);
        await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(0);
        expect(await trackModalActions.readReleaseTabLabels()).toEqual([]);
        await trackModalActions.close();
      });

      await stepLogger.step('Keep the consolidated release after an application restart', async () => {
        await managedAppLifecycle.restart();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
        await galleryActions.selectAlbumDetailsByIdentity(identity);
        expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(TRACKS.length);
        await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(0);
      });
    } catch (error) {
      originalFailure = error;
    } finally {
      if (fixture) {
        await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
      } else if (originalFailure) {
        throw originalFailure;
      }
    }
  },
);
