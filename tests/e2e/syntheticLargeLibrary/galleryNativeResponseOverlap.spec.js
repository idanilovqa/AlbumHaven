import { expect, test } from '../support/performanceFixtures.js';
import {
  analyzeNativeScrollGesture,
  GalleryRegressions,
  nativeOverlapWheelDelta,
} from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

const PREFETCH_VIEWPORTS = 8;

function isRootContinuation(response) {
  const url = new URL(response.url());
  return url.pathname.endsWith('/view-data') && url.searchParams.has('gallery_cursor');
}

async function openRootGallery(page, galleryActions, navigationPanelActions, view) {
  const ui = new GalleryRegressions(page);
  await galleryActions.goto('/?surface=albums&all_artists=1');
  await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
    timeout: 120000,
  });
  await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
  await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
  await new MobileLayoutPage(page).selectView(view);
  return ui;
}

async function readLoadedAlbumCount(page) {
  // parity-check: allow-read-only-measurement-evaluate -- prove production continuation merges after native input settles
  return page.evaluate(() => (state.view.artist_groups || [])
    .reduce((count, group) => count + (group.albums || []).length, 0));
}

async function readDeferredGroupUpdate(galleryActions, afterSequence) {
  const diagnostics = await galleryActions.readVirtualGridDiagnostics();
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events : [];
  return events.find(event => (
    event.type === 'group-update-deferred'
    && Number(event.sequence || 0) > Number(afterSequence || 0)
  )) || null;
}

async function readLatestDiagnosticSequence(galleryActions) {
  const diagnostics = await galleryActions.readVirtualGridDiagnostics();
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events : [];
  return events.reduce(
    (latest, event) => Math.max(latest, Number(event.sequence || 0)),
    0,
  );
}

async function waitForDeferredGroupUpdate(galleryActions, afterSequence) {
  let deferredEvent = null;
  await expect.poll(async () => {
    deferredEvent = await readDeferredGroupUpdate(galleryActions, afterSequence);
    return Boolean(deferredEvent);
  }, {
    intervals: [0, 8, 16, 32],
    timeout: 2000,
  }).toBe(true);
  return deferredEvent;
}

async function waitForDeferredReplay(galleryActions, deferredEvent) {
  await expect.poll(async () => {
    const diagnostics = await galleryActions.readVirtualGridDiagnostics();
    return Number(diagnostics?.latestRender?.renderGeneration || 0);
  }, {
    intervals: [16, 32, 64],
    timeout: 5000,
  }).toBeGreaterThan(Number(deferredEvent?.renderGeneration || 0));
}

function expectStableOverlap(samples) {
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter(sample => !sample.connected)).toEqual([]);
  const evidence = analyzeNativeScrollGesture(samples, 1);
  expect(evidence.anchorReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.originalNodeReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.maxContentDrift, JSON.stringify(samples)).toBeLessThanOrEqual(1);
  expect(
    evidence.signedStepDeltas.filter(delta => delta < -0.5),
    JSON.stringify({ evidence, samples }),
  ).toEqual([]);
}

async function positionWithWheelBeforeContinuation(ui, page) {
  const box = await ui.galleryScroll.boundingBox();
  if (!box) throw new Error('Gallery scroll surface is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 100; step += 1) {
    const geometry = await ui.readContinuationGeometry();
    const lower = geometry.viewport * (PREFETCH_VIEWPORTS + 0.15);
    const upper = geometry.viewport * (PREFETCH_VIEWPORTS + 0.35);
    if (geometry.remaining >= lower && geometry.remaining <= upper) return;
    if (geometry.remaining < lower) {
      throw new Error('Desktop preposition crossed the continuation boundary.');
    }
    await page.mouse.wheel(0, Math.min(480, Math.max(32, geometry.remaining - upper)));
    await page.waitForTimeout(40);
  }
  throw new Error('Desktop preposition did not reach the continuation boundary.');
}

async function dispatchTouchSwipe(page, cdp, point, startY, endY) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(startY)],
  });
  for (let step = 1; step <= 12; step += 1) {
    const y = Math.round(startY + ((endY - startY) * step) / 12);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(y)],
    });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function positionWithTouchBeforeContinuation(ui, page, cdp, point, lowerY) {
  for (let step = 0; step < 100; step += 1) {
    const geometry = await ui.readContinuationGeometry();
    const lower = geometry.viewport * (PREFETCH_VIEWPORTS + 0.1);
    const upper = geometry.viewport * (PREFETCH_VIEWPORTS + 0.3);
    if (geometry.remaining >= lower && geometry.remaining <= upper) return;
    if (geometry.remaining < lower) {
      throw new Error('Mobile preposition crossed the continuation boundary.');
    }
    const distance = Math.min(280, Math.max(40, geometry.remaining - upper + 15));
    await dispatchTouchSwipe(page, cdp, point, lowerY, lowerY - distance);
    await page.waitForTimeout(40);
  }
  throw new Error('Mobile preposition did not reach the continuation boundary.');
}

test.describe('FTC-GALLERY-NAV-035 synthetic-large native response overlap', () => {
  test.describe('mobile Cards', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('real continuation response during held touch keeps gallery coordinates stable', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openRootGallery(page, galleryActions, navigationPanelActions, 'cards');
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      const cdp = await page.context().newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      const point = y => ({ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 });
      const lowerY = Math.round(box.y + box.height * 0.72);
      const upperY = Math.round(box.y + box.height * 0.34);
      let touchActive = false;
      let observation;
      let samples;
      try {
        const loadedBefore = await readLoadedAlbumCount(page);
        await positionWithTouchBeforeContinuation(ui, page, cdp, point, lowerY);
        expect(await readLoadedAlbumCount(page)).toBe(loadedBefore);
        const diagnosticSequenceBeforeInput = await readLatestDiagnosticSequence(galleryActions);
        const anchor = await ui.captureMiddleVisibleCard();
        observation = await ui.startNativeScrollFrameObservation(anchor);
        const responsePromise = page.waitForResponse(isRootContinuation);
        const inputStartedAt = Date.now();
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [point(lowerY)],
        });
        touchActive = true;
        for (let step = 1; step <= 24; step += 1) {
          const y = Math.round(lowerY + ((upperY - lowerY) * step) / 24);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [point(y)],
          });
          await page.waitForTimeout(12);
        }
        const response = await responsePromise;
        const responseAt = Date.now();
        expect(response.ok()).toBe(true);
        const deferredEvent = await waitForDeferredGroupUpdate(
          galleryActions,
          diagnosticSequenceBeforeInput,
        );
        const deferredObservedAt = Date.now();
        expect(deferredEvent.touchGestureActive).toBe(true);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        touchActive = false;
        const inputEndedAt = Date.now();
        expect(responseAt).toBeGreaterThanOrEqual(inputStartedAt);
        expect(responseAt).toBeLessThanOrEqual(inputEndedAt);
        expect(deferredObservedAt).toBeGreaterThanOrEqual(responseAt);
        expect(deferredObservedAt).toBeLessThanOrEqual(inputEndedAt);
        await waitForDeferredReplay(galleryActions, deferredEvent);
        await expect.poll(() => readLoadedAlbumCount(page)).toBeGreaterThan(loadedBefore);
        await page.waitForTimeout(300);
      } finally {
        if (touchActive) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        }
        if (observation) samples = await observation.finish();
        await cdp.detach();
        if (samples) {
          await testInfo.attach('mobile-real-continuation-overlap', {
            body: JSON.stringify({ samples }), contentType: 'application/json',
          });
        }
      }
      expectStableOverlap(samples);
    });
  });

  test.describe('desktop Cards', () => {
    test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

    test('real continuation response during wheel sequence keeps gallery coordinates stable', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openRootGallery(page, galleryActions, navigationPanelActions, 'cards');
      const loadedBefore = await readLoadedAlbumCount(page);
      await positionWithWheelBeforeContinuation(ui, page);
      expect(await readLoadedAlbumCount(page)).toBe(loadedBefore);
      const diagnosticSequenceBeforeInput = await readLatestDiagnosticSequence(galleryActions);
      const anchor = await ui.captureMiddleVisibleCard();
      const observation = await ui.startNativeScrollFrameObservation(anchor);
      let samples;
      let response = null;
      let responseAt = null;
      let deferredEvent = null;
      let deferredObservedAt = null;
      const onResponse = candidate => {
        if (response || !isRootContinuation(candidate)) return;
        response = candidate;
        responseAt = Date.now();
      };
      page.on('response', onResponse);
      const inputStartedAt = Date.now();
      let inputEndedAt;
      let continuationThresholdCrossed = false;
      try {
        for (let step = 0; step < 60 && !deferredEvent; step += 1) {
          let wheelDelta = 1;
          if (!continuationThresholdCrossed) {
            const geometry = await ui.readContinuationGeometry();
            wheelDelta = nativeOverlapWheelDelta(
              geometry.remaining,
              geometry.viewport,
              PREFETCH_VIEWPORTS,
            );
            continuationThresholdCrossed = (
              geometry.remaining - wheelDelta
              <= geometry.viewport * PREFETCH_VIEWPORTS
            );
          }
          await page.mouse.wheel(0, wheelDelta);
          await page.waitForTimeout(20);
          deferredEvent = await readDeferredGroupUpdate(
            galleryActions,
            diagnosticSequenceBeforeInput,
          );
          if (deferredEvent) deferredObservedAt = Date.now();
        }
        if (deferredEvent) {
          await page.mouse.wheel(0, 1);
          await page.waitForTimeout(20);
        }
        inputEndedAt = Date.now();
        expect(response, 'native wheel sequence must overlap a real continuation response').not.toBeNull();
        expect(deferredEvent, 'real continuation must reach the production deferred group-update path').not.toBeNull();
        expect(deferredEvent.touchGestureActive).toBe(false);
        expect(response.ok()).toBe(true);
        expect(responseAt).toBeGreaterThanOrEqual(inputStartedAt);
        expect(responseAt).toBeLessThanOrEqual(inputEndedAt);
        expect(deferredObservedAt).toBeGreaterThanOrEqual(responseAt);
        expect(deferredObservedAt).toBeLessThanOrEqual(inputEndedAt);
        await waitForDeferredReplay(galleryActions, deferredEvent);
        await expect.poll(() => readLoadedAlbumCount(page)).toBeGreaterThan(loadedBefore);
        await page.waitForTimeout(300);
      } finally {
        page.off('response', onResponse);
        samples = await observation.finish();
        await testInfo.attach('desktop-real-continuation-overlap', {
          body: JSON.stringify({ samples }), contentType: 'application/json',
        });
      }
      expectStableOverlap(samples);
    });
  });
});
