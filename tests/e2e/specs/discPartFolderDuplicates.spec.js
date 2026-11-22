import path from 'node:path';
import { expect, test } from '../support/baseFixtures.js';
import { coverPathForReference } from '../helpers/coverReferences.js';
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
// The owner's album keeps four covers in the album folder above its "Часть N" folders.
const PART_ALBUM_COVERS = ['cover.jpg', 'cover-existing-1.jpg', 'cover-existing-2.jpg', 'cover-existing-3.jpg'];
const SAVED_IMAGE_NAME = 'album-haven-cloud-vinyl.png';
const SAVED_IMAGE_PATH = path.resolve('music_app', 'static', 'images', SAVED_IMAGE_NAME);

async function openAlbumGallery(galleryActions) {
  await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
  await galleryActions.waitForGalleryReady();
}

async function expectLocalCoversInAlbumFolder(coverLookupActions, albumDirectory, count) {
  await coverLookupActions.waitForModalResultsReady();
  const candidates = await coverLookupActions.readLocalCoverCandidates();
  expect(candidates).toHaveLength(count);
  for (const candidate of candidates) {
    expect(path.dirname(path.resolve(candidate.sourcePath))).toBe(path.resolve(albumDirectory));
  }
  return candidates;
}

async function saveComposerCover({ coverLookupActions, page }) {
  const lookup = coverLookupActions.coverLookup;
  await coverLookupActions.chooseComposerImages([SAVED_IMAGE_PATH]);
  await expect(lookup.pendingAttachmentByName(SAVED_IMAGE_NAME)).toBeVisible();
  await lookup.manualExtractButton.click();
  const stagedCover = lookup.stagedCoverCardByName(SAVED_IMAGE_NAME);
  await expect(stagedCover).toBeVisible();
  await coverLookupActions.selectOnlyCover(stagedCover);
  const saveResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/utilities/cover-lookup/pasted-image-save'
  ));
  await lookup.saveRemoteButton.click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(200);
  const payload = await saveResponse.json();
  expect(payload.ok).toBe(true);
  await expect(lookup.modal).toBeHidden();
  return coverPathForReference(payload.selected_cover_ref);
}

async function expectAlbumDetailsCover({ coverLookupActions, trackModalActions }, coverPath) {
  const shown = await coverLookupActions.readDisplayedImageEvidence(
    trackModalActions.trackModal.detailedCoverImage, 'saved album cover', { expectedCoverPath: coverPath },
  );
  expect(shown.coverPath).toBe(coverPath);
}

async function expectPartAlbumCoversAfterSave(actions, albumDirectory, savedCoverPath) {
  const { coverLookupActions, galleryActions, trackModalActions } = actions;
  await openAlbumGallery(galleryActions);
  await galleryActions.selectAlbumDetailsByIdentity({ artist: ARTIST, album: PART_ALBUM, year: YEAR });
  await trackModalActions.waitForInteractiveSummary();
  await expectAlbumDetailsCover(actions, savedCoverPath);
  await trackModalActions.openCoverLookup();
  const candidates = await expectLocalCoversInAlbumFolder(
    coverLookupActions, albumDirectory, PART_ALBUM_COVERS.length + 1,
  );
  expect(candidates.filter(candidate => candidate.isActive).map(candidate => candidate.sourcePath))
    .toEqual([savedCoverPath]);
  await coverLookupActions.closeModal();
  await trackModalActions.close();
}

async function expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions }) {
  const identity = { artist: ARTIST, album: PART_ALBUM, year: YEAR };
  await openAlbumGallery(galleryActions);
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
  await openAlbumGallery(galleryActions);
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
  'FTC-ALBUM-DETAILS-031 localized disc-part folders are one release with every album-folder cover while a real folder copy stays a duplicate',
  { tag: '@area:album-details' },
  async ({
    appBarActions,
    context,
    coverLookupActions,
    galleryActions,
    managedAppLifecycle,
    page,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(300000);
    const actions = { coverLookupActions, galleryActions, trackModalActions };
    let fixture;
    let savedCoverPath;
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
          localArtNames: PART_ALBUM_COVERS,
          ownedDirectoryName: 'disc-part-folder-duplicates',
          context,
          managedAppLifecycle,
        });
        for (const folderName of [COPIED_ALBUM, `${COPIED_ALBUM} (second copy)`]) {
          await fixture.createSiblingAlbum({
            album: COPIED_ALBUM, folderName, year: YEAR, trackTitles: COPIED_TRACKS, discNumbers: [1, 1], localArtNames: [],
          });
        }
        await managedAppLifecycle.restart();
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await appBarActions.waitForScanAndCoverRefreshIdle();
      });

      await stepLogger.step('Show the four-part album once with every disc and no duplicate warning', async () => {
        await expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions });
      });

      await stepLogger.step('List the four album-folder covers in Cover Look Up and save a new one beside them', async () => {
        await openAlbumGallery(galleryActions);
        await galleryActions.selectAlbumDetailsByIdentity({ artist: ARTIST, album: PART_ALBUM, year: YEAR });
        await trackModalActions.waitForInteractiveSummary();
        await trackModalActions.openCoverLookup();
        await expectLocalCoversInAlbumFolder(coverLookupActions, fixture.albumDirectory, PART_ALBUM_COVERS.length);
        savedCoverPath = await saveComposerCover({ coverLookupActions, page });
        expect(path.dirname(path.resolve(savedCoverPath))).toBe(path.resolve(fixture.albumDirectory));
        await expectAlbumDetailsCover(actions, savedCoverPath);
        await trackModalActions.close();
        await expectPartAlbumCoversAfterSave(actions, fixture.albumDirectory, savedCoverPath);
      });

      await stepLogger.step('Still warn about the album copied into two folders', async () => {
        await expectCopiedAlbumWithDuplicateWarning({ galleryActions, trackModalActions });
      });

      await stepLogger.step('Keep both results after an application restart', async () => {
        await managedAppLifecycle.restart();
        await appBarActions.waitForScanAndCoverRefreshIdle();
        await expectPartAlbumWithoutDuplicateWarning({ galleryActions, trackModalActions });
        await expectPartAlbumCoversAfterSave(actions, fixture.albumDirectory, savedCoverPath);
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
