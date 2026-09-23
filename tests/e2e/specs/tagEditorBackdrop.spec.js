import { InteractionSurfaces } from '../poms/interactionSurfaces.js';
import { expect, test } from '../support/baseFixtures.js';

const FIXTURE_ARTIST = 'E2E Rarity Artist';
const FIXTURE_ALBUM = 'Backdrop Tag Editor Fixture';
const FIXTURE_YEAR = '2026';
const DIRTY_ALBUM_VALUE = 'FTC-TAGS-016 Dirty Album Value';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(FIXTURE_ARTIST)}`;

test('FTC-TAGS-016 tag editor backdrop closes only when no tag changes are pending', { tag: '@area:tag-edit' }, async ({
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}, testInfo) => {
  await stepLogger.step('Open Edit Tags from the generated album details fixture', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FIXTURE_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: FIXTURE_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen();
  });

  await stepLogger.step('Use shared table and footer with immediate, uniform selection', async () => {
    const surfaces = new InteractionSurfaces(page);
    await expect(surfaces.tagTable).toBeVisible();
    await expect(surfaces.tagFooter).toBeVisible();
    const rows = surfaces.tagRows;
    expect(await rows.count()).toBeGreaterThan(1);
    for (const index of [0, 1, 0]) {
      await rows.nth(index).click();
      await expect(rows.nth(index)).toHaveAttribute('aria-pressed', 'true');
      await expect(rows.nth(index)).toHaveCSS('transition-duration', '0s');
      await expect(rows.nth(index)).not.toHaveCSS('box-shadow', 'none');
    }
  });

  await stepLogger.step('Close the clean editor with a real backdrop pointer gesture', async () => {
    await tagEditorActions.gestureOnBackdrop();
    await tagEditorActions.waitForClosed();
    await page.screenshot({
      path: testInfo.outputPath('clean-backdrop-closed-gallery.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Keep a dirty album edit open across the same backdrop gesture', async () => {
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen();
    await tagEditorActions.setAlbumName(DIRTY_ALBUM_VALUE);
    await tagEditorActions.gestureOnBackdrop();
    await tagEditorActions.waitForOpen();
    expect(await tagEditorActions.readEditableValues(['album'])).toEqual({
      album: DIRTY_ALBUM_VALUE,
    });
    await page.screenshot({
      path: testInfo.outputPath('dirty-backdrop-preserved-editor.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Close the dirty editor through the explicit Cancel control', async () => {
    await tagEditorActions.close();
    await page.screenshot({
      path: testInfo.outputPath('cancel-closed-gallery.png'),
      fullPage: true,
    });
  });
});
