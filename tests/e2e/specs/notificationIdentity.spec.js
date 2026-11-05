import { expect, test } from '../support/baseFixtures.js';
import { readGeneratedMp3AlbumTags } from '../helpers/physicalTagHelpers.js';

const RENAMED_TASK = 'fixture-history-missing-renamed';
const SPLIT_TASK = 'fixture-history-missing-split';
const DELETED_TASK = 'fixture-history-missing-deleted';
const MAIN_ALBUM = 'Folder Expansion Main Album';
const UPDATED_ALBUM = 'Notification Current Release';
const FESTIVAL_ALBUM = 'Folder Expansion Festival Album';

test('FTC-COVERS-044 saved notification tracks recover missing identity history without duplicating cards', { tag: ['@area:tag-edit', '@area:cover-providers'] }, async ({
  coverLookupActions, galleryActions, tagEditorActions, trackModalActions, stepLogger,
}) => {
  test.setTimeout(180_000);
  const lookup = coverLookupActions.coverLookup;
  let originalOrder;
  const expectCurrentDetails = async (album) => {
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(`Compilation Signal Lead • ${album} • 2026`);
    expect(summary.trackRows).toBe(14);
    const firstRow = trackModalActions.trackModal.trackRows.first();
    await expect(firstRow.getByText('Main 01', { exact: true })).toBeVisible();
    const [rowBox, titleBox, dialogBox] = await Promise.all([
      firstRow.boundingBox(), trackModalActions.trackModal.title.boundingBox(),
      trackModalActions.trackModal.dialog.boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    expect(rowBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
  };

  await stepLogger.step('Show both recoverable historical cards and exclude the deleted release', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await expect(lookup.drawerBadge).toHaveText('2');
    await expect(lookup.taskOpenButtons).toHaveCount(2);
    await expect(lookup.taskCardById(RENAMED_TASK)).toBeVisible();
    await expect(lookup.taskCardById(SPLIT_TASK)).toBeVisible();
    await expect(lookup.taskCardById(DELETED_TASK)).toHaveCount(0);
    originalOrder = await coverLookupActions.readVisibleTaskIds();
    expect(new Set(originalOrder)).toEqual(new Set([RENAMED_TASK, SPLIT_TASK]));
  });

  await stepLogger.step('Open the renamed album through its saved tracks and edit its current title', async () => {
    await coverLookupActions.openTaskById(RENAMED_TASK);
    await coverLookupActions.waitForModalResultsReady();
    await expect(lookup.albumDetailsLink).toHaveText(MAIN_ALBUM);
    await lookup.albumDetailsLink.click();
    await expect(lookup.modal).toBeHidden();
    await expect(lookup.drawer).toBeVisible();
    await expectCurrentDetails(MAIN_ALBUM);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 14 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(UPDATED_ALBUM);
    expect((await tagEditorActions.applyAndWaitForSavedFiles()).save_task_status).toBe('completed');
    const tags = await readGeneratedMp3AlbumTags({
      artist: 'Folder Expansion Lead', album: 'Folder Expansion Release/CD 1 - Main',
    });
    expect(tags).toHaveLength(14);
    for (const track of tags) expect(track.albumValues).toEqual([UPDATED_ALBUM]);
    await trackModalActions.closeIfOpen();
    await expect(lookup.drawer).toBeVisible();
    await expect(lookup.drawerBadge).toHaveText('2');
    expect(await coverLookupActions.readVisibleTaskIds()).toEqual(originalOrder);
    await coverLookupActions.openTaskById(RENAMED_TASK);
    await coverLookupActions.waitForModalResultsReady();
    await expect(lookup.albumDetailsLink).toHaveText(UPDATED_ALBUM);
    await coverLookupActions.closeModal();
  });

  await stepLogger.step('Keep the split card and require a visible release choice before opening details', async () => {
    await coverLookupActions.openTaskById(SPLIT_TASK);
    await coverLookupActions.waitForCurrentReleaseChoices([UPDATED_ALBUM, FESTIVAL_ALBUM]);
    await coverLookupActions.chooseCurrentRelease(UPDATED_ALBUM);
    await expect(lookup.albumDetailsLink).toHaveText(UPDATED_ALBUM);
    await lookup.albumDetailsLink.click();
    await expectCurrentDetails(UPDATED_ALBUM);
    await trackModalActions.closeIfOpen();
    await expect(lookup.drawer).toBeVisible();
    await expect(lookup.drawerBadge).toHaveText('2');
    await expect(lookup.taskOpenButtons).toHaveCount(2);
    await expect(lookup.taskCardById(DELETED_TASK)).toHaveCount(0);
    expect(await coverLookupActions.readVisibleTaskIds()).toEqual(originalOrder);
    for (const taskId of originalOrder) {
      await expect(lookup.taskStatusById(taskId)).not.toHaveText(/art chosen/i);
    }
  });
});
