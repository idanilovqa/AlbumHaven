import { expect, test } from '../support/baseFixtures.js';
import {
  createWatchedAlbumFixture,
  stageLegacyTrackFileWithoutScanSource,
} from '../helpers/libraryFilesystemWatcherFixture.js';
import { queryPersistedAlbumTrackMetadata } from '../helpers/postgresAlbumIdentityHelpers.js';

const ARTIST = 'Offline Deletion Artist';
const ALBUM = 'Offline Deletion Album';
const YEAR = 2008;
const TRACKS = ['Removed Signal', 'Surviving Signal'];

test(
  'FTC-LIBROOTS-019 reconciles offline legacy deletions without stale active tracks',
  { tag: '@area:library-roots' },
  async ({
    appBarActions,
    context,
    galleryActions,
    managedAppLifecycle,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(300000);
    let fixture;
    let originalFailure;

    try {
      await stepLogger.step('Create and scan a two-track album', async () => {
        await managedAppLifecycle.stop();
        fixture = await createWatchedAlbumFixture({
          artist: ARTIST,
          albumArtist: ARTIST,
          album: ALBUM,
          year: YEAR,
          trackTitles: TRACKS,
          fixtureDirectory: 'watcher-offline-deletion',
          context,
          managedAppLifecycle,
        });
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
      });

      await stepLogger.step('Reconcile a source-less row deleted while the app is stopped', async () => {
        await managedAppLifecycle.stop();
        await stageLegacyTrackFileWithoutScanSource(fixture.tracks[0].path);
        fixture.deleteTrack(0);
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();

        const persisted = await queryPersistedAlbumTrackMetadata({ artist: ARTIST, album: ALBUM });
        expect(persisted.filter((track) => track.scan_cache_stale !== true).map((track) => track.title))
          .toEqual([TRACKS[1]]);
        expect(persisted.filter((track) => track.scan_cache_stale === true).map((track) => track.title))
          .toEqual([TRACKS[0]]);

        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumCardCount({ artist: ARTIST, album: ALBUM })).toBe(1);
        await galleryActions.selectAlbumDetailsByIdentity({ artist: ARTIST, album: ALBUM, year: YEAR });
        expect(await trackModalActions.readTrackTitles()).toEqual([TRACKS[1]]);
        await trackModalActions.close();
      });

      await stepLogger.step('Keep a fully removed album as an explicit missing card', async () => {
        await managedAppLifecycle.stop();
        await stageLegacyTrackFileWithoutScanSource(fixture.tracks[1].path);
        fixture.deleteTrack(1);
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();

        const persisted = await queryPersistedAlbumTrackMetadata({ artist: ARTIST, album: ALBUM });
        expect(persisted).toHaveLength(TRACKS.length);
        expect(persisted.every((track) => track.scan_cache_stale === true)).toBe(true);
        expect(await galleryActions.readAlbumCardCount({ artist: ARTIST, album: ALBUM })).toBe(1);
        await expect(galleryActions.galleryPage.albumCard.artboxByAlbumName(ALBUM))
          .toHaveAttribute('data-album-artbox-state', 'missing');

        await managedAppLifecycle.restart();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumCardCount({ artist: ARTIST, album: ALBUM })).toBe(1);
        await expect(galleryActions.galleryPage.albumCard.artboxByAlbumName(ALBUM))
          .toHaveAttribute('data-album-artbox-state', 'missing');
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
