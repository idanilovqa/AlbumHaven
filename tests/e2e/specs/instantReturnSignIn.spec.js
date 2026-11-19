// Instant return in an ordinary browser, from signing in (IAR-W12). Owner D2, round 7: signed in,
// the connection lost at once, then a new tab showed "This site can't be reached". The sign-in
// page installs the copy's worker, so the library page that follows is kept as it arrives and no
// wait for the copy is needed. The case signs in on its own session through the real form.
import { expect, test } from '../support/baseFixtures.js';
import { GalleryActions } from '../actions/index.js';
import { GalleryPage } from '../poms/index.js';
import { PERFORMANCE_AUTH_USERNAME, PERFORMANCE_AUTH_PASSWORD } from '../support/performanceAuthentication.js';
import { visibleAlbumNames } from '../helpers/instantReturnHelpers.js';

test.use({ reuseAuthentication: false, serviceWorkers: 'allow', viewport: { width: 1024, height: 480 } });

test('FTC-IAR-W12 signed in and offline at once, a new tab shows the saved library and more albums say why they cannot load', {
  tag: '@area:gallery-search',
}, async ({ page, context }, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
  await Promise.all([
    page.waitForURL(url => new URL(url).pathname === '/', { waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  // No wait for the copy: the connection is lost as soon as the library page is there.
  await context.setOffline(true);

  const tab = await context.newPage();
  const library = new GalleryActions(new GalleryPage(tab, testInfo));
  await tab.goto('/');
  await library.waitForGalleryReady();
  const { galleryPage } = library;
  await expect(galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  await expect(galleryPage.appCopyOfflineNotice).toBeVisible();
  await expect(galleryPage.appCopyOfflineNotice).toContainText('Offline');
  expect((await visibleAlbumNames(galleryPage)).length).toBeGreaterThan(0);

  // Owner D4: scrolling for albums the server cannot send says why, not only "Unable to load".
  const { maxScrollTop } = await library.readGalleryScrollState();
  expect(maxScrollTop, 'the saved first page scrolls toward more albums').toBeGreaterThan(0);
  await library.scrollGalleryBy(maxScrollTop);
  await expect(galleryPage.unreachableMoreAlbumsToast).toBeVisible();
  await expect(galleryPage.unreachableMoreAlbumsToast).toContainText("Offline. Can't load more albums. Check your network or try again later.");
  await context.setOffline(false);
});
