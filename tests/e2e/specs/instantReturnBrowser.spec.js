// Instant return in an ordinary browser (IAR-W cases): the server answers first; the copy kept on
// the device answers only when the server cannot be reached. Every case runs with the app's
// service worker allowed, through the real UI and the real server.
import { expect, test } from '../support/baseFixtures.js';
import { defineTimingBudget, expectTimingBudget } from '../helpers/timingBudget.js';
import { GalleryActions } from '../actions/index.js';
import { GalleryPage } from '../poms/index.js';
import {
  primeCopy, keptPages, slowConnection, visibleAlbumNames, workerReady, LIBRARY_PATH,
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

// Owner report: "no flashing offline messaging when network is on". A connection slower than the
// old 1.5 s wait, still online, loads the server's page; the notice is never shown at any moment.
test('FTC-IAR-W11 a slow connection that is still online never shows the Offline notice while the library loads', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions }) => {
  const { galleryPage } = galleryActions;
  await primeCopy(page, galleryActions);

  const restore = await slowConnection(page, 2000);
  const shown = [];
  let samples = 0;
  let loading = true;
  const sampling = (async () => {
    while (loading) {
      samples += 1;
      if (await galleryPage.appCopyOfflineNotice.isVisible()) shown.push(Date.now());
    }
  })();
  try {
    await page.reload();
    await galleryActions.waitForGalleryReady();
    // Long enough for any account check started by the load to have answered through the delay.
    await page.waitForTimeout(5000);
  } finally {
    loading = false;
    await sampling;
    await restore();
  }

  expect(samples, 'the notice was sampled throughout the load').toBeGreaterThan(50);
  expect(shown, 'moments the Offline notice was visible').toEqual([]);
  await expect(galleryPage.appCopyMarker).toHaveAttribute('content', 'network');
  expect((await visibleAlbumNames(galleryPage)).length).toBeGreaterThan(0);
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
// kept. Owner D4: the page never lands on another kept view; it names the artist asked for and
// says the server cannot be reached.
test('FTC-IAR-W10 an offline reload of an artist opened after the last save names that artist and says it cannot load', {
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
  const { galleryPage } = galleryActions;
  await expect(galleryPage.unreachable).toBeVisible();
  expectTimingBudget(expect, Date.now() - started, UNREACHABLE_VIEW_BUDGET, `unreachable view after reloading ${artist} offline`);

  await expect(page).toHaveURL(artistUrl.href);
  await expect(galleryPage.galleryContextName).toHaveText(artist);
  await expect(galleryPage.unreachable).toContainText('Offline');
  await expect(galleryPage.unreachable).toContainText(`Can't load ${artist}. Check your network or try again later.`);
  await expect(galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  // One message only: the kept-library notice does not show above the artist's own.
  await expect(galleryPage.appCopyOfflineNotice).toBeHidden();
  expect(await visibleAlbumNames(galleryPage), 'no other view stands in for the artist').toEqual([]);
});

// Owner D4, server down: an album's details spun forever and tree entries quietly kept the view
// on screen. Offline in an open tab, each says the server cannot be reached and stops loading.
test('FTC-IAR-W13 offline, album details and an artist that cannot load say so instead of loading forever', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions, navigationPanelActions, trackModalActions }) => {
  await primeCopy(page, galleryActions);
  const { galleryPage } = galleryActions;
  const [album] = await visibleAlbumNames(galleryPage);
  await context.setOffline(true);

  await galleryActions.clickAlbumDetailsByAlbumName(album);
  const { trackModal } = trackModalActions;
  await expect(trackModal.unreachableAlert).toBeVisible();
  await expect(trackModal.unreachableAlert).toContainText('Offline');
  await expect(trackModal.unreachableAlert).toContainText("Can't load the details. Check your network or try again later.");
  await expect(trackModal.loadingRow).toHaveCount(0);
  await expect(trackModal.title).toContainText(album);
  await trackModalActions.close();

  // An artist further down the tree than the loaded albums: nothing on the device shows it.
  await navigationPanelActions.openArtistTree();
  const rendered = await navigationPanelActions.navigationPanel.sidebarArtists.count();
  const artist = await navigationPanelActions.selectSidebarArtistAt(rendered - 1);
  await expect(galleryPage.unreachable).toBeVisible();
  await expect(galleryPage.galleryContextName).toHaveText(artist);
  await expect(galleryPage.unreachable).toContainText(`Can't load ${artist}. Check your network or try again later.`);
  expect(await visibleAlbumNames(galleryPage), 'the previous view is never left on screen').toEqual([]);
  expect(new URL(page.url()).searchParams.get('artist')).toBe(artist);

  // Back online, the same artist loads as usual and the alert is gone.
  await context.setOffline(false);
  await navigationPanelActions.selectSidebarArtistByName(artist);
  await expect(galleryPage.unreachable).toHaveCount(0);
  await expect.poll(async () => (await visibleAlbumNames(galleryPage)).length).toBeGreaterThan(0);
});
