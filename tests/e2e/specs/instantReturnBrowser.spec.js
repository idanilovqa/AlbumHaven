// Instant return in an ordinary browser (IAR-W cases): the server answers first; the copy kept on
// the device answers only when the server cannot be reached. Every case runs with the app's
// service worker allowed, through the real UI and the real server.
import { expect, test } from '../support/baseFixtures.js';
import { defineTimingBudget, expectTimingBudget } from '../helpers/timingBudget.js';
import { GalleryActions } from '../actions/index.js';
import { GalleryPage } from '../poms/index.js';
import {
  primeCopy, keptPages, visibleAlbumNames, workerReady, LIBRARY_PATH,
} from '../helpers/instantReturnHelpers.js';

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

// The owner's D2 retest: the first visit with the copy on, then airplane mode without leaving the
// tab (so it is never hidden while online), then a new tab to the site's address.
test('FTC-IAR-W09 after the first visit, a new tab opened offline shows the saved library, never a connection error', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions }, testInfo) => {
  await galleryActions.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await workerReady(page);
  const albumsOnline = await visibleAlbumNames(galleryActions.galleryPage);
  expect(albumsOnline.length).toBeGreaterThan(0);
  // The worker keeps the view and Home on its own once it is running; nothing hides the tab.
  await expect.poll(async () => (await keptPages(page)).map(kept => kept.key), { timeout: 15_000 }).toContain('/');

  await context.setOffline(true);
  // A second tab in the test's own guarded context, so it shares the worker and the offline state.
  const tab = await page.context().newPage();
  const tabGallery = new GalleryActions(new GalleryPage(tab, testInfo));
  const started = Date.now();
  await tab.goto('/');
  await tabGallery.waitForGalleryReady();
  expectTimingBudget(expect, Date.now() - started, UNREACHABLE_VIEW_BUDGET, 'saved library in a new offline tab');

  await expect(tabGallery.galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  await expect(tabGallery.galleryPage.appCopyOfflineNotice).toBeVisible();
  await expect(tabGallery.galleryPage.appCopyOfflineNotice).toContainText('Offline');
  expect((await visibleAlbumNames(tabGallery.galleryPage)).length).toBeGreaterThan(0);
});

// Reloading, offline, an artist opened in the app after the last save: that address was never
// kept, so the last view kept is shown instead of a connection error.
test('FTC-IAR-W10 an offline reload of an artist opened after the last save shows the last saved view', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions, navigationPanelActions }) => {
  await primeCopy(page, galleryActions);
  const artist = await navigationPanelActions.selectSidebarArtistAt(0);
  await expect.poll(() => new URL(page.url()).search).not.toBe(new URL(LIBRARY_PATH, page.url()).search);
  const artistUrl = new URL(page.url());
  expect((await keptPages(page)).map(kept => kept.key)).not.toContain(`${artistUrl.pathname}${artistUrl.search}`);

  await context.setOffline(true);
  const started = Date.now();
  await page.reload();
  await galleryActions.waitForGalleryReady();
  expectTimingBudget(expect, Date.now() - started, UNREACHABLE_VIEW_BUDGET, `saved view after reloading ${artist} offline`);

  // The address bar names the view shown: the last one kept, never the artist with an empty page.
  await expect(page).toHaveURL(new URL(LIBRARY_PATH, artistUrl).href);
  await expect(galleryActions.galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  await expect(galleryActions.galleryPage.appCopyOfflineNotice).toBeVisible();
  expect((await visibleAlbumNames(galleryActions.galleryPage)).length).toBeGreaterThan(0);
});
