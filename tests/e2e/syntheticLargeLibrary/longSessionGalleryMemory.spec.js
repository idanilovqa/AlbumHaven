import { expect, test } from '../support/baseFixtures.js';
import { requirePostgresRuntimeEnv, waitForPostgresBrowseWarmRoot } from '../helpers/realAppBenchmarkHelpers.js';
import {
  evaluateTimingBudget,
  expectTimingBudgetOutcome,
  formatTimingBudgetOutcome,
  performanceTimingBudget,
} from '../helpers/timingBudget.js';

const FIRST_VISIBLE_DECODED_BUDGET = performanceTimingBudget(
  'gallery-artwork-diversity.firstVisibleDecodedMs',
);
const WINDOW_RECOVERY_BUDGET = performanceTimingBudget(
  'gallery-artwork-diversity.windowRecoveryMs',
);
const SOAK_MODE = process.env.ALBUM_HAVEN_GALLERY_ARTWORK_SOAK === '1';
const TRAVERSAL_STEPS = SOAK_MODE ? 400 : 160;
const TRAVERSAL_CYCLES = SOAK_MODE ? 2 : 1;
const MAX_RETAINED_HEAP_GROWTH_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_DOM_NODE_GROWTH = 1_500;
const MAX_ACTIVE_COVER_OBJECTS = 48;
const MAX_MOUNTED_GALLERY_CARDS = 48;

// Opt-in 400x2 diagnostic: set ALBUM_HAVEN_GALLERY_ARTWORK_SOAK=1 for a local/release run.

// PR mode gates first-cover readiness and memory bounds without forcing garbage collection.
test('FTC-GALLERY-NAV-036 diagnostic: sustained gallery traversal retains bounded cover objects', async ({
  galleryActions, navigationPanelActions, page, stepLogger,
}, testInfo) => {
  test.setTimeout(600000);
  requirePostgresRuntimeEnv('the sustained gallery memory diagnostic');
  const samples = [];
  const coverRecoveryTimings = [];
  const decodedSources = new Set();
  const encounteredCardKeys = new Set();
  const encounteredAlbumKeys = new Set();
  const pending = new WeakSet();
  const completedPageCursors = new Set();
  const traffic = { pending: 0, started: 0, finished: 0, failed: 0, galleryPages: 0 };
  let firstVisibleDecodedTiming = null;
  let slowestWindowRecoveryTiming = null;
  let origin = null;
  const onRequest = request => {
    if (!origin) return;
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    pending.add(request);
    traffic.pending += 1;
    traffic.started += 1;
    if (url.pathname === '/view-data' && url.searchParams.has('gallery_cursor')) traffic.galleryPages += 1;
  };
  const finish = (request, outcome) => {
    if (!pending.delete(request)) return;
    traffic.pending -= 1;
    traffic[outcome] += 1;
  };
  const onResponse = response => {
    if (response.status() !== 200 || !pending.has(response.request())) return;
    const url = new URL(response.url());
    if (url.pathname === '/view-data' && url.searchParams.has('gallery_cursor')) {
      completedPageCursors.add(url.searchParams.get('gallery_cursor'));
    }
  };
  const onFinished = request => finish(request, 'finished');
  const onFailed = request => finish(request, 'failed');
  const cdp = await page.context().newCDPSession(page);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  const sample = async (phase, step = 0) => {
    const [heap, domCounters, gallery] = await Promise.all([
      cdp.send('Runtime.getHeapUsage'),
      cdp.send('Memory.getDOMCounters'),
      // parity-check: allow-read-only-measurement-evaluate -- count existing gallery state and DOM without retaining nodes or mutating the app
      page.evaluate(({ cardSelector, scrollSelector }) => {
        const groups = Array.isArray(state.view?.artist_groups) ? state.view.artist_groups : [];
        const cards = document.querySelectorAll(cardSelector);
        const images = [...cards].flatMap(card => [...card.getElementsByTagName('img')]);
        const scroll = document.querySelector(scrollSelector);
        const cover = globalThis.__ALBUM_HAVEN_GALLERY_COVER_CACHE__;
        const scheduler = globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
        const previewCache = typeof galleryCoverPreviewCache === 'undefined' ? null : galleryCoverPreviewCache;
        const cardCache = typeof virtualGrid === 'undefined' ? null : virtualGrid.albumCardNodeCache;
        let retainedCardAncestry = null;
        if (cardCache) {
          const cached = [...cardCache.values()];
          const detached = cached.filter(card => !card.isConnected);
          const roots = new Set(detached.map(card => card.getRootNode()));
          let nodes = 0, retainedCards = 0, retainedImages = 0, decodedImages = 0, decodedPixels = 0;
          for (const root of roots) {
            nodes += 1 + root.getElementsByTagName('*').length;
            retainedCards += Number(root.classList?.contains('album-card') || false)
              + root.getElementsByClassName('album-card').length;
            const images = [...root.getElementsByTagName('img')];
            if (root instanceof HTMLImageElement) images.push(root);
            retainedImages += images.length;
            for (const image of images) {
              if (image.complete && image.naturalWidth > 0) {
                decodedImages += 1;
                decodedPixels += image.naturalWidth * image.naturalHeight;
              }
            }
          }
          retainedCardAncestry = {
            cacheEntries: cached.length, connectedCacheEntries: cached.length - detached.length,
            detachedCacheEntries: detached.length,
            detachedEntriesWithParent: detached.filter(card => card.parentNode).length,
            detachedRoots: roots.size, reachableNodes: nodes, reachableCards: retainedCards,
            reachableImages: retainedImages, decodedImages, decodedPixels,
          };
        }
        return {
          documentNodes: document.getElementsByTagName('*').length,
          mountedCards: cards.length, mountedImages: images.length,
          decodedMountedImages: images.filter(image => image.complete && image.naturalWidth > 0).length,
          decodedMountedImageDimensions: images.filter(image => image.complete && image.naturalWidth > 0)
            .map(image => ({ width: image.naturalWidth, height: image.naturalHeight })),
          loadedGroups: groups.length,
          loadedAlbumOccurrences: groups.reduce((count, group) => count + (group.albums?.length || 0), 0),
          scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
          hasMore: Boolean(state.view?.gallery_page?.has_more),
          activeCoverObjects: cover?.activeCount ?? null,
          coverFallbacks: cover?.fallbackCount ?? null,
          retainedCardAncestry,
          cachePersistence: {
            pendingWriteChainKeys: previewCache?.writeChains?.size ?? null,
            inFlightEntries: previewCache?.inFlight?.size ?? null,
            liveFetches: previewCache?.liveFetches?.size ?? null,
            trackedProductionUrlKeys: previewCache?.latestRequestedProductionUrls?.size ?? null,
            retainedObjectUrlConsumers: previewCache?.objectUrlConsumerCounts?.size ?? null,
            retiredObjectUrls: previewCache?.retiredObjectUrls?.size ?? null,
          },
          scheduler: scheduler ? {
            active: scheduler.active, queuedVisible: scheduler.queuedVisible,
            queuedNear: scheduler.queuedNear, queuedBackground: scheduler.queuedBackground,
          } : null,
        };
      }, { cardSelector: galleryActions.galleryPage.albumCard.cardSelector,
        scrollSelector: galleryActions.galleryPage.galleryScrollSelector }),
    ]);
    const result = { phase, step, at: Date.now(), heap, domCounters, gallery,
      traffic: { ...traffic, distinctSuccessfulGalleryPages: completedPageCursors.size },
      distinctDecodedCoverSources: decodedSources.size,
      distinctEncounteredCardOccurrences: encounteredCardKeys.size,
      distinctEncounteredAlbums: encounteredAlbumKeys.size };
    samples.push(result);
    return result;
  };
  const recordWindowEvidence = window => {
    for (const key of window.visibleCardOccurrenceKeys) encounteredCardKeys.add(key);
    for (const key of window.visibleCardKeys) encounteredAlbumKeys.add(key);
    for (const card of window.decodedCards) decodedSources.add(card.productionSrc);
  };
  const waitForDecodedWindow = async (
    phase,
    step = 0,
    coverStartedAt = null,
  ) => {
    const window = await galleryActions.galleryPage.waitForDecodedProductionCardWindow({
      allowIntentionalNoCoverWindow: true,
      requireEveryExpectedCoverDecoded: true,
    });
    const coverRecoveryMs = Number.isFinite(coverStartedAt)
      ? performance.now() - coverStartedAt
      : null;
    if (coverRecoveryMs !== null && window.candidateCount > 0) {
      coverRecoveryTimings.push({
        phase,
        step,
        timingMs: coverRecoveryMs,
        candidateCount: window.candidateCount,
        decodedCount: window.decodedCards.length,
      });
    }
    recordWindowEvidence(window);
    return window;
  };
  const checkpoint = async (phase, step = 0, decodedWindow = null) => {
    const window = decodedWindow || await waitForDecodedWindow(phase, step);
    const result = await sample(phase, step);
    stepLogger.note(`${phase} step ${step}: heap ${result.heap.usedSize} bytes, ${result.gallery.mountedCards} mounted cards, ${result.gallery.loadedAlbumOccurrences} loaded album occurrences`, 2);
    // Existing application cache contract, also exercised by FTC-COVERS-014.
    expect(result.gallery.activeCoverObjects).not.toBeNull();
    expect(result.gallery.activeCoverObjects).toBeLessThanOrEqual(MAX_ACTIVE_COVER_OBJECTS);
    expect(result.gallery.mountedCards).toBeLessThanOrEqual(MAX_MOUNTED_GALLERY_CARDS);
    expect(result.gallery.cachePersistence.retiredObjectUrls).not.toBeNull();
    expect(result.gallery.cachePersistence.retiredObjectUrls).toBeLessThanOrEqual(
      result.gallery.mountedImages + Number(result.gallery.retainedCardAncestry?.reachableImages || 0),
    );
    return { window };
  };
  const traverse = async (phase, direction) => {
    await stepLogger.step(phase, async () => {
      for (let step = 1; step <= TRAVERSAL_STEPS; step += 1) {
        let before = await galleryActions.readGalleryScrollState();
        if (direction < 0 && before.scrollTop <= 2) break;
        if (direction > 0 && before.scrollTop >= before.maxScrollTop - 2) {
          if (!before.hasMore) break;
          await galleryActions.galleryPage.waitForRootGalleryBoundaryProgress(before);
          before = await galleryActions.readGalleryScrollState();
        }
        const deadline = Date.now() + 5000;
        const coverStartedAt = performance.now();
        const wheel = () => galleryActions.scrollGalleryBy(
          direction * Math.max(240, Math.round(before.clientHeight * 0.75)),
          { timeout: Math.max(1, deadline - Date.now()) },
        );
        await wheel();
        await galleryActions.galleryPage.waitForGalleryScrollMovement(before.scrollTop, direction, {
          deadline, previousMaxScrollTop: before.maxScrollTop, onExtentExpanded: wheel,
        });
        const windowState = await waitForDecodedWindow(
          phase,
          step,
          coverStartedAt,
        );
        if (step % 8 === 0) await checkpoint(phase, step, windowState);
      }
      await checkpoint(`${phase}-end`);
    });
  };
  try {
    const firstVisibleDecodedStartedAt = performance.now();
    await galleryActions.goto('/?surface=albums');
    origin = new URL(page.url()).origin;
    await galleryActions.galleryPage.waitForFirstDecodedVisibleCover({
      timeout: FIRST_VISIBLE_DECODED_BUDGET.hardCeiling,
    });
    firstVisibleDecodedTiming = evaluateTimingBudget(
      performance.now() - firstVisibleDecodedStartedAt,
      FIRST_VISIBLE_DECODED_BUDGET,
    );
    await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
    await galleryActions.waitForInitialAllArtistsSections({ timeout: 120000 });
    const baselineWindow = await galleryActions.galleryPage.waitForDecodedProductionCardWindow({
      allowIntentionalNoCoverWindow: true,
      requireEveryExpectedCoverDecoded: true,
    });
    recordWindowEvidence(baselineWindow);
    const baseline = await checkpoint('baseline', 0, baselineWindow);
    await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    for (let cycle = 1; cycle <= TRAVERSAL_CYCLES; cycle += 1) {
      await traverse(`forward-${cycle}`, 1);
      await traverse(`reverse-${cycle}`, -1);
      await galleryActions.waitForCoverSchedulerIdle();
      await sample(`idle-${cycle}-start`);
      // Explicit idle observation window, not a readiness substitute or timing exclusion.
      await page.waitForTimeout(15000);
      await checkpoint(`idle-${cycle}-end`);
    }
    expect(completedPageCursors.size, 'Traversal must receive multiple distinct continuation pages.').toBeGreaterThanOrEqual(2);
    expect(decodedSources.size, 'Traversal must exceed the existing 48-object cover cache.').toBeGreaterThan(48);
    expect(encounteredCardKeys.size,
      `Traversal must encounter over ${SOAK_MODE ? 1000 : 300} distinct visible card occurrences, including no-art cards.`)
      .toBeGreaterThan(SOAK_MODE ? 1000 : 300);
    expect(coverRecoveryTimings.length, 'Traversal must time many decoded cover windows.').toBeGreaterThan(20);
    const baselineSample = samples.find(sample => sample.phase === 'baseline');
    const idleSamples = samples.filter(sample => /^idle-\d+-end$/u.test(sample.phase));
    const retainedSample = idleSamples.at(-1);
    expect(retainedSample.heap.usedSize - baselineSample.heap.usedSize)
      .toBeLessThanOrEqual(MAX_RETAINED_HEAP_GROWTH_BYTES);
    expect(retainedSample.domCounters.nodes - baselineSample.domCounters.nodes)
      .toBeLessThanOrEqual(MAX_RETAINED_DOM_NODE_GROWTH);
    if (SOAK_MODE) {
      expect(idleSamples).toHaveLength(2);
      expect(idleSamples[1].heap.usedSize - idleSamples[0].heap.usedSize)
        .toBeLessThanOrEqual(MAX_RETAINED_HEAP_GROWTH_BYTES);
      expect(idleSamples[1].domCounters.nodes - idleSamples[0].domCounters.nodes)
        .toBeLessThanOrEqual(MAX_RETAINED_DOM_NODE_GROWTH);
    }
    const slowestWindowRecovery = coverRecoveryTimings.reduce(
      (slowest, timing) => timing.timingMs > slowest.timingMs ? timing : slowest,
    );
    slowestWindowRecoveryTiming = evaluateTimingBudget(
      slowestWindowRecovery.timingMs,
      WINDOW_RECOVERY_BUDGET,
    );
    console.log(formatTimingBudgetOutcome(
      'First visible decoded gallery artwork',
      firstVisibleDecodedTiming,
    ));
    console.log(formatTimingBudgetOutcome(
      `Slowest decoded gallery window (${slowestWindowRecovery.phase} ${slowestWindowRecovery.step})`,
      slowestWindowRecoveryTiming,
    ));
    expect(baseline.window.decodedCards.length).toBeGreaterThan(0);
    expectTimingBudgetOutcome(expect, firstVisibleDecodedTiming, 'First visible decoded gallery artwork');
    // TODO(E3): make this budget blocking in PR mode after the storage/worker A/B removes the known slow windows.
    if (SOAK_MODE) {
      expectTimingBudgetOutcome(expect, slowestWindowRecoveryTiming, 'Slowest decoded gallery window');
    } else {
      console.log(`DIAGNOSTIC ONLY: ${formatTimingBudgetOutcome(
        'Slowest decoded gallery window',
        slowestWindowRecoveryTiming,
      )}`);
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    try {
      if (!page.isClosed()) await sample('final');
    } catch {
      samples.push({ phase: 'final', unavailable: true });
    }
    try {
      await testInfo.attach('gallery-memory-diagnostic', {
        body: Buffer.from(JSON.stringify({
          firstVisibleCoverReadinessGated: true, windowRecoveryBudgetGated: SOAK_MODE,
          memoryBoundsGated: true, forcedGarbageCollection: false,
          soakMode: SOAK_MODE, traversalSteps: TRAVERSAL_STEPS, traversalCycles: TRAVERSAL_CYCLES,
          firstVisibleDecodedTiming, slowestWindowRecoveryTiming, coverRecoveryTimings,
          unavailableMetrics: ['renderer-private-bytes: no reliable page PID mapping',
            'decoded-image-bytes', 'detached-DOM-node-count', 'observer-count'],
          cardCoverageScope: 'cumulative visible section-key plus card-key occurrences, including no-art; repeat visits count once; distinct album keys and retained occurrences are separate telemetry',
          domCountersScope: 'CDP document/node/listener totals; not a detached-node count',
          cachePersistenceScope: 'writeChains counts pending keys, not queued jobs; scheduler idle is separate',
          retainedCardAncestryScope: 'DOM reachable from detached cached cards; natural pixels are not measured image memory; temporary references discarded after snapshot',
          imageDimensionsScope: 'natural dimensions of currently decoded mounted images, not source art or retained image memory',
          samples,
        }, null, 2)), contentType: 'application/json',
      });
    } finally {
      try { await cdp.detach(); } catch (error) { if (!page.isClosed()) throw error; }
    }
  }
});
