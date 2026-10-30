import { expect, test } from '../support/baseFixtures.js';
import { queryPersistedAlbumIdentity } from '../helpers/postgresAlbumIdentityHelpers.js';
import {
  clearTrackSubtitleProjectionEditions,
  createTrackSubtitleProjectionFixture,
  removeTrackSubtitleProjectionFixture,
} from '../helpers/trackSubtitleProjectionFixture.js';

let ownedFixture;

test.beforeEach(async ({ appBarActions, galleryActions, managedAppLifecycle }) => {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createTrackSubtitleProjectionFixture();
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.afterEach(async ({ appBarActions, galleryActions, managedAppLifecycle }) => {
  try {
    if (ownedFixture) await removeTrackSubtitleProjectionFixture(ownedFixture);
    ownedFixture = null;
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
  } finally {
    ownedFixture = null;
    await managedAppLifecycle.stop();
    await managedAppLifecycle.restart();
  }
});

test(
  'FTC-ALBUM-DETAILS-026 rebuild drops track subtitle and part frames from album editions',
  { tag: '@area:album-details' },
  async ({
    appBarActions,
    freshBrowserSession,
    galleryActions,
    managedAppLifecycle,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(240000);

    await stepLogger.step('Confirm the fixture starts as explicit persisted editions', async () => {
      for (const album of ownedFixture.albums) {
        for (const track of album.tracks) {
          const persisted = await queryPersistedAlbumIdentity({
            artist: album.artist,
            album: album.album,
            year: album.year,
            edition: track.edition,
          });
          expect(persisted.album_ids).toHaveLength(1);
          expect(persisted.track_counts).toEqual([1]);
        }
      }
    });

    await stepLogger.step('Rebuild after removing only explicit album-edition frames', async () => {
      await managedAppLifecycle.stop();
      try {
        await clearTrackSubtitleProjectionEditions(ownedFixture);
      } finally {
        await managedAppLifecycle.restart();
      }
      await galleryActions.goto();
      await galleryActions.waitForGalleryReady();
      await appBarActions.triggerFullRescanAndWait();
      await appBarActions.waitForScanAndCoverRefreshIdle();
    });

    for (const album of ownedFixture.albums) {
      await stepLogger.step(`Keep ${album.artist} / ${album.album} as one release`, async () => {
        const identity = {
          artist: album.artist,
          album: album.album,
          year: album.year,
        };
        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(album.artist)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
        await galleryActions.selectAlbumDetailsByIdentity(identity);
        expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(album.tracks.length);
        expect(await trackModalActions.readReleaseTabLabels()).toEqual([]);
        expect(await trackModalActions.readTrackTitles()).toEqual(
          album.tracks.map((track) => track.title),
        );
        await trackModalActions.close();

        const persisted = await queryPersistedAlbumIdentity(identity);
        expect(persisted.album_ids).toHaveLength(1);
        expect(persisted.track_counts).toEqual([album.tracks.length]);
        for (const track of album.tracks) {
          const staleEdition = await queryPersistedAlbumIdentity({
            ...identity,
            edition: track.edition,
          });
          // Historical album identities are retained until the user explicitly
          // removes missing albums. They must no longer own tracks or project as
          // active releases after the scan adopts those tracks into the base album.
          expect(staleEdition.album_ids).toHaveLength(1);
          expect(staleEdition.album_keys).toHaveLength(1);
          expect(staleEdition.track_counts).toEqual([0]);
        }
      });
    }

    await stepLogger.step('Retain collapsed releases in a fresh browser session', async () => {
      const session = await freshBrowserSession.create();
      for (const album of ownedFixture.albums) {
        const identity = {
          artist: album.artist,
          album: album.album,
          year: album.year,
        };
        await session.galleryActions.goto(
          `/?surface=albums&artist=${encodeURIComponent(album.artist)}`,
        );
        await session.galleryActions.waitForGalleryReady();
        expect(await session.galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
        await session.galleryActions.selectAlbumDetailsByIdentity(identity);
        expect((await session.trackModalActions.waitForInteractiveSummary()).trackRows)
          .toBe(album.tracks.length);
        expect(await session.trackModalActions.readReleaseTabLabels()).toEqual([]);
        await session.trackModalActions.close();
      }
    });
  },
);

test(
  'FTC-LIBROOTS-020 watcher collapses track subtitle and part frames without Full Scan',
  { tag: ['@area:library-roots', '@area:album-details'] },
  async ({
    galleryActions,
    libraryFilesystemWatcherActions,
    stepLogger,
    trackModalActions,
  }) => {
    test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
    test.setTimeout(180000);

    const status = await libraryFilesystemWatcherActions.readStatus();
    expect(status.scan_in_progress).toBe(false);

    await stepLogger.step('Remove explicit editions and wait for watcher publication', async () => {
      await clearTrackSubtitleProjectionEditions(ownedFixture);
      const committed = await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      expect(committed.scan_in_progress).toBe(false);
      expect(committed.scan_generation).toBe(status.scan_generation);
    });

    for (const album of ownedFixture.albums) {
      await stepLogger.step(`Project ${album.artist} / ${album.album} as one release`, async () => {
        const identity = {
          artist: album.artist,
          album: album.album,
          year: album.year,
        };
        await expect.poll(async () => {
          const persisted = await queryPersistedAlbumIdentity(identity);
          return persisted.track_counts;
        }, { timeout: 60000, intervals: [250, 500, 1000] }).toEqual([album.tracks.length]);

        await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(album.artist)}`);
        await galleryActions.waitForGalleryReady();
        expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
        await galleryActions.selectAlbumDetailsByIdentity(identity);
        expect((await trackModalActions.waitForInteractiveSummary()).trackRows)
          .toBe(album.tracks.length);
        expect(await trackModalActions.readReleaseTabLabels()).toEqual([]);
        expect(await trackModalActions.readTrackTitles()).toEqual(
          album.tracks.map((track) => track.title),
        );
        await trackModalActions.close();
      });
    }

    const finalStatus = await libraryFilesystemWatcherActions.readStatus();
    expect(finalStatus.scan_in_progress).toBe(false);
    expect(finalStatus.scan_generation).toBe(status.scan_generation);
  },
);
