import { measureActionTime } from './performanceHelpers.js';
import { waitForLibraryStartupEntryVisible } from './realAppBenchmarkHelpers.js';

export async function readStartupDiagnostics(page) {
  const diagnosticsHandle = await page.waitForFunction(() => {
    const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
    const navigationEntry = performance.getEntriesByType('navigation')[0];
    return {
      metrics,
      navigation: navigationEntry
        ? {
            domContentLoadedEventEnd: Math.round(navigationEntry.domContentLoadedEventEnd),
            loadEventEnd: Math.round(navigationEntry.loadEventEnd),
            responseEnd: Math.round(navigationEntry.responseEnd),
          }
        : null,
    };
  });
  return diagnosticsHandle.jsonValue();
}

function startAllArtistsAppOpenFullSidebarProof(galleryActions, navigationPanelActions) {
  const timeout = 120000;
  const fullSidebarMsPromise = measureActionTime(
    async () => {},
    async () => navigationPanelActions.waitForSidebarFullyHydrated({ timeout }),
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
    return { fullSidebarMs, countSynchronizedMs, initialRefreshMs };
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
