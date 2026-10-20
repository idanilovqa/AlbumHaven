import { expect, test } from '../support/baseFixtures.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';
import { queryPersistedAlbumIdentity } from '../helpers/postgresAlbumIdentityHelpers.js';

const ARTIST = 'Year Distinct Release Artist';
const ALBUM = 'Year Distinct Release Album';
const RELEASES = [
  { year: 2004, tracks: ['Original First', 'Original Second'] },
  { year: 2016, tracks: ['Reissue First', 'Reissue Second'] },
];

test(
  'FTC-ALBUM-DETAILS-028 year-distinct folders remain separate releases',
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
      await stepLogger.step('Create two same-name releases with distinct years', async () => {
        await managedAppLifecycle.stop();
        fixture = await createWatchedAlbumFixture({
          artist: ARTIST,
          albumArtist: ARTIST,
          album: ALBUM,
          albumFolderName: `${ALBUM} (2004)`,
          year: RELEASES[0].year,
          trackTitles: RELEASES[0].tracks,
          fixtureDirectory: 'watcher-year-distinct-releases',
          context,
          managedAppLifecycle,
        });
        await fixture.createSiblingAlbum({
          album: ALBUM,
          folderName: `${ALBUM} (2016)`,
          year: RELEASES[1].year,
          trackTitles: RELEASES[1].tracks,
        });
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
      });

      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.readAlbumCardCount({ artist: ARTIST, album: ALBUM }))
        .toBe(RELEASES.length);
      for (const release of RELEASES) {
        await stepLogger.step(`Project ${release.year} as its own complete release`, async () => {
          const identity = { artist: ARTIST, album: ALBUM, year: release.year };
          expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
          await galleryActions.selectAlbumDetailsByIdentity(identity);
          expect((await trackModalActions.waitForInteractiveSummary()).trackRows)
            .toBe(release.tracks.length);
          expect(await trackModalActions.readTrackTitles()).toEqual(release.tracks);
          await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(0);
          await trackModalActions.close();

          const persisted = await queryPersistedAlbumIdentity(identity);
          expect(persisted.album_ids).toHaveLength(1);
          expect(persisted.track_counts).toEqual([release.tracks.length]);
          expect(persisted.album_keys[0]).toMatch(new RegExp(`::year::${release.year}$`));
        });
      }

      await stepLogger.step('Keep both releases separate after restart', async () => {
        await managedAppLifecycle.restart();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumCardCount({ artist: ARTIST, album: ALBUM }))
          .toBe(RELEASES.length);
        for (const release of RELEASES) {
          const identity = { artist: ARTIST, album: ALBUM, year: release.year };
          expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
          await galleryActions.selectAlbumDetailsByIdentity(identity);
          expect((await trackModalActions.waitForInteractiveSummary()).trackRows)
            .toBe(release.tracks.length);
          await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(0);
          await trackModalActions.close();
        }
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
