import { expect, test } from '../support/baseFixtures.js';
import { LibraryHomeFromSettings } from '../poms/libraryHomeFromSettings.js';

test('FTC-GALLERY-HOME-002 Home from the admin panel opens library Home, not the earlier search', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions, searchToolbarActions, settingsModalAppBarActions, stepLogger }) => {
  const home = new LibraryHomeFromSettings(page);

  await stepLogger.step('Search an artist with a family, then open the admin panel', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search('Neal Morse', { submitWithEnter: true });
    await expect(home.galleryTitle).toContainText('family');
    expect(home.viewParameters().query).toBe('Neal Morse');
    await settingsModalAppBarActions.openAdminPanel();
    await expect(home.settingsHost).toBeVisible();
  });

  await stepLogger.step('The app logo returns to Home with the search cleared and the tree reset', async () => {
    await home.homeLogo.click();
    await expect(home.settingsHost).toHaveCount(0);
    await expect(home.searchInput).toHaveValue('');
    await expect.poll(() => home.viewParameters()).toEqual({ path: '/', query: null, artist: null });
    await expect(home.galleryTitle).not.toContainText('family');
    await expect(home.albumCards.first()).toBeVisible();
  });
});
