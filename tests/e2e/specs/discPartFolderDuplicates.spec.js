import { expect, test } from '../support/baseFixtures.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';

const ARTIST = 'Disc Part Folder Artist';
const PART_ALBUM = 'Disc Part Folder Album';
const COPIED_ALBUM = 'Disc Part Copied Album';
const YEAR = 2009;
// Owner report 2026-11-21: four "Часть N" disc folders with different tracks were shown as duplicate copies.
const PART_TRACKS = [
  'Part One Opening', 'Part One Closing',
  'Part Two Opening', 'Part Two Middle', 'Part Two Closing',
  'Part Three Opening', 'Part Three Closing',
  'Part Four Finale',
];
const PART_DISCS = [1, 1, 2, 2, 2, 3, 3, 4];
const COPIED_TRACKS = ['Copied First Song', 'Copied Second Song'];

async function openAlbumGallery(galleryActions) {
  await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
  await galleryActions.waitForGalleryReady();
}

async function expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions }) {
  const identity = { artist: ARTIST, album: PART_ALBUM, year: YEAR };
  expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
  await expect(galleryActions.galleryPage.albumCard.duplicateFilesBadgeByIdentity(ARTIST, PART_ALBUM, YEAR)).toHaveCount(0);
  await galleryActions.selectAlbumDetailsByIdentity(identity);
  expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(PART_TRACKS.length);
  expect(await trackModalActions.readTrackTitles()).toEqual(PART_TRACKS);
  expect((await trackModalActions.readDiscGroupPresentation()).headers).toEqual(['CD 1', 'CD 2', 'CD 3', 'CD 4']);
  await expect(trackModalActions.trackModal.duplicateWarning).toBeHidden();
  await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(0);
  expect(await trackModalActions.readReleaseTabLabels()).toEqual([]);
  await trackModalActions.close();
}

async function expectCopiedAlbumWithDuplicateWarning({ galleryActions, trackModalActions }) {
  const identity = { artist: ARTIST, album: COPIED_ALBUM, year: YEAR };
  expect(await galleryActions.readAlbumIdentityCardCount(identity)).toBe(1);
  await expect(galleryActions.galleryPage.albumCard.duplicateFilesBadgeByIdentity(ARTIST, COPIED_ALBUM, YEAR)).toBeVisible();
  await galleryActions.selectAlbumDetailsByIdentity(identity);
  await trackModalActions.waitForInteractiveSummary();
  const warning = trackModalActions.trackModal.duplicateWarning;
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Duplicate album files');
  await expect(warning.getByRole('button', { name: /^Folder \d$/u })).toHaveCount(2);
  await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await trackModalActions.trackModal.duplicateSourceTabs.nth(index).click();
    await expect(trackModalActions.trackModal.duplicateSourceTabs.nth(index)).toHaveClass(/\bis-active\b/u);
    await trackModalActions.waitForLoadedSummary();
    expect(await trackModalActions.readTrackTitles()).toEqual(COPIED_TRACKS);
  }
  await trackModalActions.close();
}

test(
  'FTC-ALBUM-DETAILS-031 localized disc-part folders are one release while a real folder copy stays a duplicate',
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
      await stepLogger.step('Create a four-part album in "Часть N" folders and an album copied into two folders', async () => {
        await managedAppLifecycle.stop();
        fixture = await createWatchedAlbumFixture({
          artist: ARTIST,
          albumArtist: ARTIST,
          album: PART_ALBUM,
          albumFolderName: `${YEAR} - ${PART_ALBUM}`,
          year: YEAR,
          trackTitles: PART_TRACKS,
          discNumbers: PART_DISCS,
          discFolderName: (discNumber) => `Часть ${discNumber}`,
          ownedDirectoryName: 'disc-part-folder-duplicates',
          context,
          managedAppLifecycle,
        });
        for (const folderName of [COPIED_ALBUM, `${COPIED_ALBUM} (second copy)`]) {
          await fixture.createSiblingAlbum({
            album: COPIED_ALBUM, folderName, year: YEAR, trackTitles: COPIED_TRACKS, discNumbers: [1, 1],
          });
        }
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
      });

      await stepLogger.step('Show the four-part album once with every disc and no duplicate warning', async () => {
        await openAlbumGallery(galleryActions);
        await expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions });
      });

      await stepLogger.step('Still warn about the album copied into two folders', async () => {
        await expectCopiedAlbumWithDuplicateWarning({ galleryActions, trackModalActions });
      });

      await stepLogger.step('Keep both results after an application restart', async () => {
        await managedAppLifecycle.restart();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await openAlbumGallery(galleryActions);
        await expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions });
        await expectCopiedAlbumWithDuplicateWarning({ galleryActions, trackModalActions });
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
