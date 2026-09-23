import { expect, test } from '../support/baseFixtures.js';

const ARTIST = 'E2E Rarity Artist';
const ALBUM = 'Backdrop Tag Editor Fixture';
const YEAR = '2026';
const tracks = Array.from(
  { length: 34 },
  (_, index) => `${String(index + 1).padStart(2, '0')} - Backdrop Track ${index + 1}.mp3`,
);

test('FTC-TAGS-025 preserves selection and reorder semantics through cancel and apply', { tag: '@area:tag-edit' }, async ({
  galleryActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  const openEditor = () => tagEditorActions.openForAlbum({
    album: ALBUM,
    artist: ARTIST,
    expectedTrackCount: tracks.length,
    galleryActions,
    trackModalActions,
    year: YEAR,
  });
  let saveAttempted = false;

  try {
    await stepLogger.step('Open the production editor and exercise pointer, Ctrl, and Shift selection', async () => {
      await galleryActions.goto('/');
      await galleryActions.waitForGalleryReady();
      await openEditor();
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(tracks);

      await tagEditorActions.dragTrackWithoutGrip(tracks[0], tracks[4]);
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(tracks);
      await tagEditorActions.dragSelectTracksByFilenames(tracks.slice(1, 5));
      await tagEditorActions.selectTrackWithModifier(tracks[7], 'Control');
      await tagEditorActions.expectSelectedTrackFilenames([...tracks.slice(1, 5), tracks[7]]);
      await tagEditorActions.selectTrackByFilename(tracks[10]);
      await tagEditorActions.selectTrackWithModifier(tracks[13], 'Shift');
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));
      await tagEditorActions.dropReorderOutsideList(tracks[0]);
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(tracks);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));
    });

    await stepLogger.step('Reorder from first, middle, last, below-list, and keyboard grip boundaries', async () => {
      await tagEditorActions.dragReorderBefore(tracks[0], tracks[4]);
      expect((await tagEditorActions.readSummary()).trackFilenames.slice(0, 5))
        .toEqual([tracks[1], tracks[2], tracks[3], tracks[0], tracks[4]]);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));

      await tagEditorActions.dragReorderBefore(tracks[10], tracks[1]);
      expect((await tagEditorActions.readSummary()).trackFilenames[0]).toBe(tracks[10]);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));

      await tagEditorActions.dragReorderBefore(tracks.at(-1), tracks[10]);
      expect((await tagEditorActions.readSummary()).trackFilenames[0]).toBe(tracks.at(-1));
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));

      await tagEditorActions.dragReorderBelowList(tracks[2]);
      expect((await tagEditorActions.readSummary()).trackFilenames.at(-1)).toBe(tracks[2]);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));

      await tagEditorActions.reorderWithKeyboard(tracks[2], 'ArrowUp');
      expect((await tagEditorActions.readSummary()).trackFilenames.at(-2)).toBe(tracks[2]);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));
      const beforeEscape = (await tagEditorActions.readSummary()).trackFilenames;
      await tagEditorActions.cancelActiveReorder(tracks[5], tracks[8]);
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(beforeEscape);
      await tagEditorActions.expectSelectedTrackFilenames(tracks.slice(10, 14));
    });

    await stepLogger.step('Cancel rolls staged order back when the editor is reopened', async () => {
      await tagEditorActions.close();
      await trackModalActions.close();
      await openEditor();
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(tracks);
    });

    await stepLogger.step('Apply persists one grip reorder and the saved order survives reopen', async () => {
      await tagEditorActions.dragReorderBefore(tracks[3], tracks[0]);
      const expectedOrder = [tracks[3], tracks[0], tracks[1], tracks[2], ...tracks.slice(4)];
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(expectedOrder);
      saveAttempted = true;
      await tagEditorActions.applyAndWaitForSavedFiles();
      await trackModalActions.closeIfOpen();
      await openEditor();
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(expectedOrder);
    });
  } finally {
    if (saveAttempted) {
      await tagEditorActions.closeIfOpen();
      await trackModalActions.closeIfOpen();
      await galleryActions.goto('/');
      await galleryActions.waitForGalleryReady();
      await openEditor();
      const restoredOrder = (await tagEditorActions.readSummary()).trackFilenames;
      let changed = false;
      for (const [index, filename] of tracks.entries()) {
        if (restoredOrder[index] === filename) continue;
        await tagEditorActions.dragReorderBefore(filename, restoredOrder[index]);
        const [moved] = restoredOrder.splice(restoredOrder.indexOf(filename), 1);
        restoredOrder.splice(index, 0, moved);
        changed = true;
      }
      if (changed) {
        await tagEditorActions.applyAndWaitForSavedFiles();
      }
      expect(restoredOrder).toEqual(tracks);
    }
  }
});
