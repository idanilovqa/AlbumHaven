// Instant return in an ordinary browser (IAR-W cases): the server answers first; the copy kept on
// the device answers only when the server cannot be reached. Every case runs with the app's
// service worker allowed, through the real UI and the real server.
import { expect, test } from '../support/baseFixtures.js';
import { defineTimingBudget, expectTimingBudget } from '../helpers/timingBudget.js';
import { primeCopy, keptPages, visibleAlbumNames, LIBRARY_PATH } from '../helpers/instantReturnHelpers.js';

test.use({ serviceWorkers: 'allow' });

// The approved target: an unreachable server shows the saved view within 1000 ms (+400 ms grace).
const UNREACHABLE_VIEW_BUDGET = defineTimingBudget({ metricId: 'instant-return.unreachableSavedViewMs', targetMaximum: 1000, graceMs: 400 });

test('FTC-IAR-W01 a browser loads the library from the server and keeps a copy without file paths', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions }) => {
  await primeCopy(page, galleryActions);

  await expect(galleryActions.galleryPage.appCopyOfflineNotice).toBeHidden();
  const [kept] = (await keptPages(page)).filter(entry => entry.key === LIBRARY_PATH);
  expect(kept.html).toContain('content="cache"');
  expect(kept.html).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]|\/cover\?path=|"music_dir":\s*"[^"]|"cover_path":\s*"[^"]/);
});

test('FTC-IAR-W05 offline, the saved library appears at once, read-only, and recovers without a reload', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions, appBarActions }) => {
  const { galleryPage } = galleryActions;
  const scanControl = appBarActions.appBar.scanIndicator;
  await primeCopy(page, galleryActions);
  const albumsOnline = await visibleAlbumNames(galleryPage);
  expect(albumsOnline.length).toBeGreaterThan(0);
  // The library's scan control, one of the changes the read-only view hides.
  await expect(scanControl).toBeVisible();

  await context.setOffline(true);
  const started = Date.now();
  await page.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  expectTimingBudget(expect, Date.now() - started, UNREACHABLE_VIEW_BUDGET, 'saved library view with the server unreachable');

  await expect(galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  await expect(galleryPage.appCopyOfflineNotice).toBeVisible();
  await expect(galleryPage.appCopyOfflineNotice).toContainText('Offline');
  // The same albums in the same order; the notice above them may push the last ones below the fold.
  const albumsOffline = await visibleAlbumNames(galleryPage);
  expect(albumsOffline.length).toBeGreaterThan(0);
  expect(albumsOffline).toEqual(albumsOnline.slice(0, albumsOffline.length));
  // Changes are off while the server cannot be reached.
  await expect(scanControl).toBeHidden();

  // Back online: the notice goes and the same page stays (no reload).
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await context.setOffline(false);
  await expect(galleryPage.appCopyOfflineNotice).toBeHidden({ timeout: 35_000 });
  expect(navigations).toEqual([]);
  expect(await visibleAlbumNames(galleryPage)).toEqual(albumsOnline);
  await expect(scanControl).toBeVisible();
});
