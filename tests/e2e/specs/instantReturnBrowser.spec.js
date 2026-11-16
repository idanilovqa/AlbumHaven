// Instant return in an ordinary browser (IAR-W cases): the server answers first; the copy kept on
// the device answers only when the server cannot be reached. Every case runs with the app's
// service worker allowed, through the real UI and the real server.
import { expect, test } from '../support/baseFixtures.js';
import { primeCopy, keptPages, visibleAlbumNames, COPY_MARKER, LIBRARY_PATH, OFFLINE_NOTICE } from '../helpers/instantReturnHelpers.js';

test.use({ serviceWorkers: 'allow' });

// The approved targets: an unreachable server shows the saved view within 1000 ms (+400 ms grace).
const UNREACHABLE_VIEW_BUDGET_MS = 1400;

test('FTC-IAR-W01 a browser loads the library from the server and keeps a copy without file paths', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions }) => {
  await primeCopy(page, galleryActions);

  await expect(page.locator(OFFLINE_NOTICE)).toBeHidden();
  const [kept] = (await keptPages(page)).filter(entry => entry.key === LIBRARY_PATH);
  expect(kept.html).toContain('content="cache"');
  expect(kept.html).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]|\/cover\?path=|"music_dir":\s*"[^"]|"cover_path":\s*"[^"]/);
});

test('FTC-IAR-W05 offline, the saved library appears at once, read-only, and recovers without a reload', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions }) => {
  await primeCopy(page, galleryActions);
  const albumsOnline = await visibleAlbumNames(galleryActions.galleryPage);
  expect(albumsOnline.length).toBeGreaterThan(0);

  await context.setOffline(true);
  const started = Date.now();
  await page.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  const elapsed = Date.now() - started;

  await expect(page.locator(COPY_MARKER)).toHaveAttribute('content', 'cache');
  await expect(page.locator(OFFLINE_NOTICE)).toBeVisible();
  await expect(page.locator(OFFLINE_NOTICE)).toContainText('Offline');
  // The same albums in the same order; the notice above them may push the last ones below the fold.
  const albumsOffline = await visibleAlbumNames(galleryActions.galleryPage);
  expect(albumsOffline.length).toBeGreaterThan(0);
  expect(albumsOffline).toEqual(albumsOnline.slice(0, albumsOffline.length));
  // Changes are off: the album menu has no Edit Tags while the server cannot be reached.
  await galleryActions.openAlbumContextMenu(albumsOnline[0]);
  await expect(galleryActions.galleryPage.albumCard.contextEditTags).toBeHidden();
  await galleryActions.dismissAlbumContextMenu();
  expect(elapsed, `saved view took ${elapsed} ms`).toBeLessThanOrEqual(UNREACHABLE_VIEW_BUDGET_MS);

  // Back online: the notice goes and the same page stays (no reload).
  await page.evaluate(() => { window.__iarSamePage = true; });
  await context.setOffline(false);
  await expect(page.locator(OFFLINE_NOTICE)).toBeHidden({ timeout: 35_000 });
  expect(await page.evaluate(() => window.__iarSamePage)).toBe(true);
  expect(await visibleAlbumNames(galleryActions.galleryPage)).toEqual(albumsOnline);
  await galleryActions.openAlbumContextMenu(albumsOnline[0]);
  await expect(galleryActions.galleryPage.albumCard.contextEditTags).toBeVisible();
  await galleryActions.dismissAlbumContextMenu();
});
