import { measureActionTime } from './performanceHelpers.js';
import { waitForLibraryStartupEntryVisible } from './realAppBenchmarkHelpers.js';

export async function readStartupDiagnostics(page, selectors) {
  const diagnosticsHandle = await page.waitForFunction((selectors) => {
    const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
    const navigationEntry = performance.getEntriesByType('navigation')[0];
    const paintEntries = performance.getEntriesByType('paint');
    const resourceEntries = performance.getEntriesByType('resource');
    const firstContentfulPaint = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
    const rootResources = resourceEntries.filter((entry) => {
      const url = new URL(entry.name, window.location.href);
      return url.origin === window.location.origin
        && ['/bootstrap-data', '/view-data'].includes(url.pathname)
        && !url.searchParams.has('artist')
        && !url.searchParams.has('q');
    });
    const decodedArtworkTimes = [...document.querySelectorAll(selectors.coverImageSelector)]
      .filter((element) => element.hasAttribute('data-cover-decoded-at-ms'))
      .map((element) => Number(element.getAttribute('data-cover-decoded-at-ms')))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const rootPayloadReadyMs = Number(
      metrics.marks?.bootstrap_payload_ready?.atMs
      ?? rootResources[0]?.responseEnd
      ?? navigationEntry?.responseEnd,
    );
    return {
      metrics,
      navigation: navigationEntry
        ? {
            domContentLoadedEventEnd: Math.round(navigationEntry.domContentLoadedEventEnd),
            requestStart: Math.round(navigationEntry.requestStart),
            responseStart: Math.round(navigationEntry.responseStart),
            loadEventEnd: Math.round(navigationEntry.loadEventEnd),
            responseEnd: Math.round(navigationEntry.responseEnd),
            firstContentfulPaint: firstContentfulPaint
              ? Math.round(firstContentfulPaint.startTime)
              : null,
          }
        : null,
      rootResources: rootResources.map((entry) => ({
        pathname: new URL(entry.name, window.location.href).pathname,
        requestStart: Math.round(entry.startTime),
        responseStart: Math.round(entry.responseStart),
        responseEnd: Math.round(entry.responseEnd),
      })),
      phases: {
        navigationRequestStartMs: Number.isFinite(navigationEntry?.requestStart)
          ? Math.round(navigationEntry.requestStart)
          : null,
        serverResponseMs: Number.isFinite(navigationEntry?.responseEnd)
          ? Math.round(navigationEntry.responseEnd)
          : null,
        appShellRenderMs: Number.isFinite(firstContentfulPaint?.startTime)
          ? Math.round(firstContentfulPaint.startTime)
          : null,
        initialUiFeedbackMs: Number.isFinite(Number(metrics.marks?.startup_ui_feedback_visible?.atMs))
          ? Math.round(Number(metrics.marks.startup_ui_feedback_visible.atMs))
          : null,
        rootPayloadReadyMs: Number.isFinite(rootPayloadReadyMs)
          ? Math.round(rootPayloadReadyMs)
          : null,
        treeReadyMs: null,
        galleryReadyMs: Number.isFinite(Number(metrics.marks?.initial_visible_refresh_complete?.atMs))
          ? Math.round(Number(metrics.marks.initial_visible_refresh_complete.atMs))
          : null,
        firstDecodedArtworkMs: decodedArtworkTimes.length
          ? Math.round(Math.min(...decodedArtworkTimes))
          : null,
      },
    };
  }, selectors);
  return diagnosticsHandle.jsonValue();
}

function startAllArtistsAppOpenFullSidebarProof(galleryActions, navigationPanelActions) {
  const timeout = 120000;
  let treeReadyAtMs = null;
  const fullSidebarMsPromise = measureActionTime(
    async () => {},
    async () => {
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
      // parity-check: allow-read-only-measurement-evaluate -- retain the browser-monotonic full-tree boundary
      treeReadyAtMs = await galleryActions.galleryPage.page.evaluate(() => performance.now());
    },
  );
  const countSynchronizedMsPromise = measureActionTime(
    async () => {},
    async () => navigationPanelActions.waitForSidebarAndAllArtistsCountSynchronized({ timeout }),
  );
  const initialRefreshMsPromise = measureActionTime(
    async () => {},
    async () => galleryActions.waitForInitialRefreshCompleted({ timeout }),
  );

  return async () => {
    const [fullSidebarMs, countSynchronizedMs, initialRefreshMs] = await Promise.all([
      fullSidebarMsPromise,
      countSynchronizedMsPromise,
      initialRefreshMsPromise,
    ]);
    return { fullSidebarMs, countSynchronizedMs, initialRefreshMs, treeReadyAtMs };
  };
}

export async function measureAllArtistsAppOpenVisibleReadiness(galleryActions, navigationPanelActions) {
  const timeout = 120000;
  const startedAt = Date.now();
  let startupEntryState = null;
  let gotoMs = 0;
  let startupSignalMs = 0;
  const navigationMs = await measureActionTime(
    async () => {
      const gotoStartedAt = Date.now();
      await galleryActions.goto('/');
      gotoMs = Date.now() - gotoStartedAt;
    },
    async () => {
      const startupSignalStartedAt = Date.now();
      startupEntryState = await waitForLibraryStartupEntryVisible(
        galleryActions.galleryPage.page,
        galleryActions,
        navigationPanelActions,
        { timeout },
      );
      startupSignalMs = Date.now() - startupSignalStartedAt;
    },
  );
  const awaitFullSidebarProof = startAllArtistsAppOpenFullSidebarProof(
    galleryActions,
    navigationPanelActions,
  );
  const visibleRefreshMs = await measureActionTime(
    async () => {},
    async () => galleryActions.waitForInitialVisibleRefreshCompleted({ timeout }),
  );
  const firstSectionsMs = await measureActionTime(
    async () => {},
    async () => galleryActions.waitForInitialAllArtistsSections({
      timeout,
      minimumHeadingCount: 1,
      requireScrollable: false,
    }),
  );
  const coversMs = await measureActionTime(
    async () => {},
    async () => galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 2,
      timeout,
    }),
  );
  return {
    appOpenTimings: {
      startupEntryVisibleMs: navigationMs,
      visibleUiReadyMs: Date.now() - startedAt,
      navigationMs,
      gotoMs,
      startupSignalMs,
      visibleRefreshMs,
      firstSectionsMs,
      coversMs,
    },
    startupEntryState,
    awaitFullSidebarProof,
  };
}
