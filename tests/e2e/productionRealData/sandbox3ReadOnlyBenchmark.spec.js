import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { expect, test as base } from '../support/baseFixtures.js';
import { createWorkerAuthentication } from '../../../scripts/playwright-worker-authentication.mjs';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
const require = createRequire(import.meta.url);
const { TARGET, validateEnvironment, installReadOnlyGuard, sanitizeTiming } = require('../support/sandbox3ReadOnlyGuard.cjs');

const test = base.extend({
  sandboxAuthentication: [async ({ browser }, use, workerInfo) => {
    const { username, password } = validateEnvironment(process.env, workerInfo.project.use.baseURL);
    if (workerInfo.config.workers !== 1) throw new Error('Sandbox3 benchmark requires exactly one worker.');
    const authentication = createWorkerAuthentication({
      browser, baseURL: TARGET,
      authenticate: async page => {
        const guard = await installReadOnlyGuard(page.context(), true);
        await page.goto('/login?return_to=%2Fhealth');
        await page.getByLabel('Username').fill(username);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(url => url.origin === TARGET && url.pathname !== '/login');
        guard.finishAuthentication();
        guard.assertClean();
      },
    });
    await use(authentication);
  }, { scope: 'worker' }],
  storageState: async ({ sandboxAuthentication }, use) => use(await sandboxAuthentication.getStorageState()),
  readOnlyGuard: [async ({ context }, use) => {
    const guard = await installReadOnlyGuard(context);
    await use(guard);
    guard.assertClean();
  }, { auto: true }],
});
test.use({ reuseAuthentication: false, requestInterceptionGuardEnabled: false, initialArtistTreeFolded: null });

test('Sandbox3 visible read-only journeys', async ({ page, galleryActions, navigationPanelActions, searchToolbarActions, trackModalActions, readOnlyGuard }, testInfo) => {
  const timings = [];
  const requestTimings = [];
  const pendingRequests = new Map();
  const onRequest = request => pendingRequests.set(request, performance.now());
  const onFinished = request => {
    const started = pendingRequests.get(request);
    if (started === undefined) return;
    pendingRequests.delete(request);
    const pathname = new URL(request.url()).pathname;
    const category = pathname === '/view-data' ? 'view-data' : pathname === '/album-details' ? 'album-details' : request.resourceType() === 'image' ? 'image' : 'other-read';
    const timing = request.timing();
    requestTimings.push({ category, durationMs: Math.round((performance.now() - started) * 10) / 10, responseWaitMs: timing.requestStart >= 0 && timing.responseStart >= 0 ? Math.round((timing.responseStart - timing.requestStart) * 10) / 10 : null, failed: request.failure() !== null });
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFinished);
  async function measure(scenario, action, budget, actionStarted) {
    const started = performance.now();
    let passed = false;
    try {
      await action();
      const durationMs = performance.now() - (actionStarted?.() ?? started);
      if (budget) expect.soft(durationMs).toBeLessThanOrEqual(budget);
      passed = !budget || durationMs <= budget;
    } finally {
      timings.push(sanitizeTiming({ scenario, durationMs: performance.now() - (actionStarted?.() ?? started), passed, budgetMs: budget }));
    }
  }
  const ui = new GalleryRegressions(page);
  const navigation = navigationPanelActions.navigationPanel;
  const modal = trackModalActions.trackModal;
  try {
    await measure('initial-navigation', async () => {
      await galleryActions.goto('/');
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForVisibleGalleryCoversLoaded();
    });
    await navigationPanelActions.openArtistTree();
    const baselineCount = (await navigation.allArtistsCount.innerText()).trim();
    expect(baselineCount).toMatch(/\d/);
    const baselineRows = await navigation.sidebarArtists.count();
    expect(baselineRows).toBeGreaterThan(1);
    const artist = await navigation.sidebarArtists.last().getAttribute('data-sidebar-artist');
    expect(artist).toBeTruthy();
    let submittedAt;
    await measure('search', async () => {
      await searchToolbarActions.search(artist, { clickApply: true, recordSubmissionBoundary: () => { submittedAt = performance.now(); } });
      await galleryActions.waitForSelectedArtistGallery(artist, { queryValue: artist });
      await galleryActions.waitForGalleryReady();
    }, 800, () => submittedAt);
    await measure('search-populated', async () => {
      await galleryActions.waitForVisibleGalleryCoversLoaded();
    }, 1200, () => submittedAt);
    await measure('clear-search', async () => {
      await searchToolbarActions.search('', { clickApply: true });
      await expect(navigation.allArtistsCount).toHaveText(baselineCount);
      await expect.poll(() => navigation.sidebarArtists.count()).toBeGreaterThan(1);
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForVisibleGalleryCoversLoaded();
    });
    await measure('artist-selection', async () => {
      await navigationPanelActions.selectSidebarArtistByName(artist);
      await galleryActions.waitForSelectedArtistGallery(artist);
      await galleryActions.waitForVisibleGalleryCoversLoaded();
    });
    await navigationPanelActions.clickAllArtists();
    await galleryActions.waitForGalleryReady();
    const row = navigation.sidebarArtistByName(artist);
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: 'right' });
    await expect(ui.scrollToArtistAction).toBeVisible();
    await measure('root-jump', async () => {
      await ui.scrollToArtistAction.click();
      await expect.poll(() => ui.readArtistJumpPlacement(artist)).toEqual({ rendered: true, chromeMatches: true, rowsAligned: true, firstCardUncut: true });
      await galleryActions.waitForVisibleGalleryCoversLoaded();
    }, 2000);
    await navigationPanelActions.clickAllArtists();
    await galleryActions.waitForGalleryReady();
    const cards = galleryActions.galleryPage.albumCard.cards;
    expect(await cards.count()).toBeGreaterThan(1);
    let previousIdentity;
    for (let index = 0; index < 2; index += 1) {
      const card = cards.nth(index);
      const title = (await card.locator('.album-title-button').first().innerText()).trim();
      const requestKey = await card.locator('[data-open-tracklist]').first().getAttribute('data-album-key');
      expect(requestKey).toBeTruthy();
      // Preflight does not populate the browser cache, but warms server-side details.
      // Request routing disables browser HTTP caching for the entire benchmark.
      const expectedDetails = await page.request.get(`${TARGET}/album-details?album_key=${encodeURIComponent(requestKey)}`, { maxRedirects: 0 });
      expect(expectedDetails.ok()).toBe(true);
      const expectedAlbum = (await expectedDetails.json()).album;
      const trackCount = expectedAlbum?.tracks?.length;
      expect(trackCount).toBeGreaterThan(0);
      await expectedDetails.dispose();

      await measure('album-details', async () => {
        await galleryActions.clickAlbumDetailsAt(index);
        if (previousIdentity && previousIdentity !== title && await modal.title.isVisible()) {
          expect((await modal.title.innerText()).trim()).not.toBe(previousIdentity);
        }
        await trackModalActions.waitForLoadedSummary();
        await expect(modal.title).toContainText(title);
        await expect(modal.trackRows).toHaveCount(trackCount);
        await expect.poll(() => modal.dialog.locator('[data-album-key]').evaluateAll((elements, key) => elements.some(element => element.getAttribute('data-album-key') === key), requestKey)).toBe(true);
        previousIdentity = (await modal.title.innerText()).trim();
      });
      await trackModalActions.close();
    }
    readOnlyGuard.assertClean();
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFinished);
    await fs.writeFile(testInfo.outputPath('sanitized-timings.json'), JSON.stringify({ metadata: { browserHttpCache: 'disabled-by-request-routing', albumDetailsServerState: 'warmed-by-read-only-preflight', unbudgetedActions: 'diagnostic-readiness-only' }, actions: timings, requests: requestTimings }, null, 2));
  }
});
