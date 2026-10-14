import { expect, test } from '../support/baseFixtures.js';
import { requirePostgresRuntimeEnv, waitForPostgresBrowseWarmRoot } from '../helpers/realAppBenchmarkHelpers.js';

// Diagnostic only: no new memory budget and no forced garbage collection.
test('diagnostic: sustained gallery traversal retains bounded cover objects', async ({
  galleryActions, navigationPanelActions, page, stepLogger,
}, testInfo) => {
  test.setTimeout(600000);
  requirePostgresRuntimeEnv('the sustained gallery memory diagnostic');
  const samples = [];
  const decodedSources = new Set();
  const pending = new WeakSet();
  const completedPageCursors = new Set();
  const traffic = { pending: 0, started: 0, finished: 0, failed: 0, galleryPages: 0 };
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
        const images = [...cards].flatMap(card => [...card.querySelectorAll('img')]);
        const scroll = document.querySelector(scrollSelector);
        const cover = globalThis.__ALBUM_HAVEN_GALLERY_COVER_CACHE__;
        const scheduler = globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
        return {
          documentNodes: document.getElementsByTagName('*').length,
          mountedCards: cards.length, mountedImages: images.length,
          decodedMountedImages: images.filter(image => image.complete && image.naturalWidth > 0).length,
          loadedGroups: groups.length,
          loadedAlbumOccurrences: groups.reduce((count, group) => count + (group.albums?.length || 0), 0),
          scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
          hasMore: Boolean(state.view?.gallery_page?.has_more),
          activeCoverObjects: cover?.activeCount ?? null,
          coverFallbacks: cover?.fallbackCount ?? null,
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
      distinctDecodedCoverSources: decodedSources.size };
    samples.push(result);
    return result;
  };
  const checkpoint = async (phase, step = 0) => {
    const window = await galleryActions.galleryPage.waitForDecodedProductionCardWindow();
    for (const card of window.decodedCards) decodedSources.add(card.productionSrc);
    const result = await sample(phase, step);
    stepLogger.note(`${phase} step ${step}: heap ${result.heap.usedSize} bytes, ${result.gallery.mountedCards} mounted cards, ${result.gallery.loadedAlbumOccurrences} loaded album occurrences`, 2);
    // Existing application cache contract, also exercised by FTC-COVERS-014.
    expect(result.gallery.activeCoverObjects).not.toBeNull();
    expect(result.gallery.activeCoverObjects).toBeLessThanOrEqual(48);
  };
  const traverse = async (phase, direction) => {
    await stepLogger.step(phase, async () => {
      for (let step = 1; step <= 48; step += 1) {
        let before = await galleryActions.readGalleryScrollState();
        if (direction < 0 && before.scrollTop <= 2) break;
        if (direction > 0 && before.scrollTop >= before.maxScrollTop - 2) {
          if (!before.hasMore) break;
          await galleryActions.galleryPage.waitForRootGalleryBoundaryProgress(before);
          before = await galleryActions.readGalleryScrollState();
        }
        const deadline = Date.now() + 5000;
        const wheel = () => galleryActions.scrollGalleryBy(
          direction * Math.max(240, Math.round(before.clientHeight * 0.75)),
          { timeout: Math.max(1, deadline - Date.now()) },
        );
        await wheel();
        await galleryActions.galleryPage.waitForGalleryScrollMovement(before.scrollTop, direction, {
          deadline, previousMaxScrollTop: before.maxScrollTop, onExtentExpanded: wheel,
        });
        if (step % 8 === 0) await checkpoint(phase, step);
      }
      await checkpoint(`${phase}-end`);
    });
  };
  try {
    await galleryActions.goto('/?surface=albums');
    origin = new URL(page.url()).origin;
    await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    await checkpoint('baseline');
    for (let cycle = 1; cycle <= 2; cycle += 1) {
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
          diagnosticOnly: true, forcedGarbageCollection: false,
          unavailableMetrics: ['renderer-private-bytes: no reliable page PID mapping',
            'decoded-image-bytes', 'detached-DOM-node-count', 'observer-count'],
          domCountersScope: 'CDP document/node/listener totals; not a detached-node count',
          samples,
        }, null, 2)), contentType: 'application/json',
      });
    } finally {
      try { await cdp.detach(); } catch (error) { if (!page.isClosed()) throw error; }
    }
  }
});
