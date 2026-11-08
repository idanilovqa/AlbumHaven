import { expect, test } from '../support/baseFixtures.js';

test('FTC-ARTIST-TREE-002 preserves collapsed and expanded preferences after reload', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const navigation = navigationPanelActions.navigationPanel;
  await stepLogger.step('Expand the account preference through the normal control', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
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

test('FTC-ARTIST-TREE-003 keeps the web navigation-tree header free of buttons and Loose Tracks as one side-bar button', {
  tag: '@area:gallery-search',
}, async ({ artistPageSettingsActions, galleryActions, navigationPanelActions, page, stepLogger }) => {
  // Owner rule (11-08): no buttons in the web navigation-tree header; a new side-bar entry goes vertically under
  // the existing side-bar buttons; one control in one place; never an empty or icon-less button.
  const navigation = navigationPanelActions.navigationPanel;
  await stepLogger.step('Expanded panel: only the fold control in the header, no Loose Tracks entry', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.navigationTreeHeaderButtons).toHaveCount(1);
    await expect(navigation.navigationTreeHeaderButtons.first()).toHaveAccessibleName('Collapse Artist Tree');
    await expect(navigation.looseTracksEntryPoints).toHaveCount(0);
    await expect(page.locator('#sidebar-collections')).toBeHidden();
  });
  await stepLogger.step('Folded panel: Loose Tracks is one drawn button directly under Artist Tree', async () => {
    await navigationPanelActions.setArtistTreeFolded(true);
    await expect(navigation.looseTracksEntryPoints).toHaveCount(1);
    await expect(navigation.looseTracksSideBarButton).toBeVisible();
    const geometry = await page.evaluate(() => {
      const box = (node) => node.getBoundingClientRect();
      const tree = box(document.getElementById('artist-tree-navigation-button'));
      const loose = document.querySelector('#shell-navigation-compact [data-open-non-album-tracks]');
      const icon = loose.querySelector('svg');
      const iconBox = box(icon);
      const style = getComputedStyle(icon);
      return {
        below: box(loose).top >= tree.bottom, aligned: Math.abs(box(loose).left - tree.left) <= 1,
        iconWidth: iconBox.width, iconHeight: iconBox.height, shapes: icon.querySelectorAll('path, circle').length,
        stroke: style.stroke, visible: style.visibility === 'visible' && Number(style.opacity) > 0,
      };
    });
    expect(geometry).toMatchObject({ below: true, aligned: true, visible: true });
    expect(geometry.iconWidth).toBeGreaterThan(12);
    expect(geometry.iconHeight).toBeGreaterThan(12);
    expect(geometry.shapes).toBeGreaterThan(0);
    expect(geometry.stroke).not.toBe('none');
  });
  await stepLogger.step('The side-bar button opens library-wide Loose Tracks', async () => {
    await artistPageSettingsActions.openLibraryWideNonAlbumTracks();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksModal).toBeVisible();
  });
});
