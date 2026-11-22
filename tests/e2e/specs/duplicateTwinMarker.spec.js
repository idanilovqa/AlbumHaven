import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/baseFixtures.js';
import { createDuplicateTwinFixture, removeDuplicateTwinFixture } from '../helpers/duplicateTwinFixture.js';

const TWIN_ALBUM = 'Twin Release';
const OTHER_ALBUM = 'Other Release';
// Album keys keep accents while duplicate identities fold them: renamed to this, the other
// album keeps its own album key and becomes the twin's duplicate copy.
const ACCENTED_TWIN_ALBUM = 'Twin Réléase';

let ownedFixture;

test.beforeEach(async ({ managedAppLifecycle, galleryActions, appBarActions }) => {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createDuplicateTwinFixture(`E2E Duplicate Twin ${randomUUID().replaceAll('-', '')}`);
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.afterEach(async ({ managedAppLifecycle, galleryActions, appBarActions }) => {
  await managedAppLifecycle.stop();
  try {
    if (ownedFixture) await removeDuplicateTwinFixture(ownedFixture);
  } finally {
    ownedFixture = null;
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test("FTC-TAGS-033 Editing an album's tags so its album artist, album and year match another album's shows the two copies as one album card with the Duplicate files marker at once; editing it back shows the two separate album cards again without the marker at once", { tag: '@area:tag-edit' }, async ({
  galleryActions, tagEditorActions, stepLogger,
}) => {
  test.setTimeout(240000);
  const albumCard = galleryActions.galleryPage.albumCard;
  const cards = () => albumCard.cards;
  const card = albumName => albumCard.cardByAlbumName(albumName);
  const marker = albumName => albumCard.duplicateMarkerByAlbumName(albumName);
  const openArtist = async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ownedFixture.artist)}`);
    await galleryActions.waitForGalleryReady();
  };
  // Each save is followed straight away by the artist's view: its first read must already
  // carry the saved duplicate state (no rescan, no background wait).
  const rename = async (fromAlbum, toAlbum) => {
    await galleryActions.openAlbumTagEditorFromContextMenu(fromAlbum);
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(toAlbum);
    expect((await tagEditorActions.applyAndWaitForSavedFiles()).save_task_status).toBe('completed');
    await openArtist();
  };

  await stepLogger.step('Show the two distinct albums as two cards without the Duplicate files marker', async () => {
    await openArtist();
    await expect(cards()).toHaveCount(2);
    await expect(card(TWIN_ALBUM)).toHaveCount(1);
    await expect(card(OTHER_ALBUM)).toHaveCount(1);
    await expect(marker(TWIN_ALBUM)).toHaveCount(0);
    await expect(marker(OTHER_ALBUM)).toHaveCount(0);
  });

  await stepLogger.step('Rename the other album to match the twin and see one card with the marker at once', async () => {
    await rename(OTHER_ALBUM, ACCENTED_TWIN_ALBUM);
    await expect(cards()).toHaveCount(1);
    await expect(card(OTHER_ALBUM)).toHaveCount(0);
    await expect(albumCard.cards.locator('.gallery-source-action--duplicate')).toHaveCount(1);
  });

  await stepLogger.step('Rename it back and see the two separate cards without the marker at once', async () => {
    await rename(ACCENTED_TWIN_ALBUM, OTHER_ALBUM);
    await expect(cards()).toHaveCount(2);
    await expect(card(TWIN_ALBUM)).toHaveCount(1);
    await expect(card(OTHER_ALBUM)).toHaveCount(1);
    await expect(marker(TWIN_ALBUM)).toHaveCount(0);
    await expect(marker(OTHER_ALBUM)).toHaveCount(0);
  });
});
