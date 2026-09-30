import { expect, test } from '../support/baseFixtures.js';

test('FTC-ARTIST-TREE-002 preserves collapsed and expanded preferences after reload', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const navigation = navigationPanelActions.navigationPanel;
  await stepLogger.step('Start with the isolated expanded account preference', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await expect(navigation.artistTreeFoldButton).toBeVisible();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: false, transitioning: false });
  });
  await stepLogger.step('Collapse through the control and retain it after reload', async () => {
    await navigationPanelActions.setArtistTreeFolded(true);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await expect(navigation.artistTreeNavigationButton).toBeVisible();
    await expect(navigation.artistTreeFoldButton).toBeHidden();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: true, transitioning: false });
  });
  await stepLogger.step('Expand through the control and retain it after reload', async () => {
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await expect(navigation.artistTreeFoldButton).toBeVisible();
    await expect(navigation.artistTreeNavigationButton).toBeHidden();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: false, transitioning: false });
  });
});
