import { expect, test } from '../support/performanceFixtures.js';
import {
  analyzeNativeScrollGesture,
  GalleryRegressions,
  keepWheelActiveUntilResponseBoundary as startWheelInputUntilResponseBoundary,
  normalizeCdpResponseEpoch,
  nativeScrollDisplacementMatchesCommand,
  nativeScrollStepsMatchCommand,
} from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import {
  failureIncludes,
  finalizeResponseOverlapCleanup,
} from '../helpers/failureSafeCleanup.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';

const PREFETCH_VIEWPORTS = 8;
const FULL_REFRESH_SEARCH_QUERY = 'Neal Morse';
const TOUCH_ACTIVATION_DISTANCE = 15;
const STATIONARY_TOUCH_FRAMES = 12;
const RESPONSE_BOUNDARY_TIMEOUT_MS = 15_000;

function isRootContinuationUrl(candidateUrl) {
  const url = new URL(candidateUrl);
  return url.pathname.endsWith('/view-data') && url.searchParams.has('gallery_cursor');
}

function isRootContinuation(response) {
  return isRootContinuationUrl(response.url());
}

function isFullSearchRefreshUrl(candidateUrl, query) {
  const url = new URL(candidateUrl);
  return url.pathname.endsWith('/view-data')
    && !url.searchParams.has('gallery_cursor')
    && String(url.searchParams.get('q') || '').trim() === query;
}

function isFullSearchRefresh(response, query) {
  return isFullSearchRefreshUrl(response.url(), query);
}

async function observeResponseBoundary(cdp, matchesUrl) {
  await cdp.send('Network.enable');
  let onResponse;
  const responseAt = new Promise((resolve, reject) => {
    onResponse = (event) => {
      if (!matchesUrl(String(event.response?.url || ''))) return;
      const epoch = normalizeCdpResponseEpoch(event.response.responseTime);
      if (epoch === null) {
        reject(new Error('Browser response boundary requires a valid responseTime.'));
        return;
      }
      resolve(epoch);
    };
    cdp.on('Network.responseReceived', onResponse);
  });
  return {
    responseAt,
    dispose() {
      cdp.off('Network.responseReceived', onResponse);
    },
  };
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
  return page.evaluate(() => flattenVisibleAlbums().length);
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

function keepWheelActiveUntilResponseBoundary(ui, page, responseAt, onWheel) {
  return startWheelInputUntilResponseBoundary(
    ui,
    page,
    responseAt,
    onWheel,
    { timeoutMs: RESPONSE_BOUNDARY_TIMEOUT_MS },
  );
}

function expectStableOverlap(samples, commandedDistance, maximumForwardStep) {
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter(sample => !sample.connected)).toEqual([]);
  const evidence = analyzeNativeScrollGesture(samples, 1);
  expect(evidence.anchorReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.maxReverseVisibleDrift, JSON.stringify(samples)).toBe(0);
  expect(evidence.firstMovementIndex, JSON.stringify({ evidence, samples })).toBeGreaterThan(0);
  expect(
    nativeScrollDisplacementMatchesCommand(evidence.signedTotalDisplacement, commandedDistance),
    JSON.stringify({ commandedDistance, evidence, samples }),
  ).toBe(true);
  expect(
    nativeScrollStepsMatchCommand(evidence.signedStepDeltas, maximumForwardStep),
    JSON.stringify({ maximumForwardStep, evidence, samples }),
  ).toBe(true);
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
      const loadedBefore = await readLoadedAlbumCount(page);
      await expect.poll(
        async () => readLoadedAlbumCount(page),
        { intervals: [16, 32, 64], timeout: RESPONSE_BOUNDARY_TIMEOUT_MS },
      ).toBeGreaterThan(loadedBefore);
      continue;
    }
    await page.mouse.wheel(0, Math.min(480, Math.max(32, geometry.remaining - upper)));
    await expect.poll(
      async () => (await ui.readContinuationGeometry()).remaining,
      { intervals: [0, 8, 16, 32], timeout: 2000 },
    ).toBeLessThan(geometry.remaining);
  }
  throw new Error('Desktop preposition did not reach the continuation boundary.');
}

async function dispatchTouchSwipe(ui, cdp, point, startY, endY) {
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
    await ui.waitForAnimationFrame();
  }
  for (let frame = 0; frame < STATIONARY_TOUCH_FRAMES; frame += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(endY)],
    });
    await ui.waitForAnimationFrame();
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
    const distance = Math.min(
      280 + TOUCH_ACTIVATION_DISTANCE,
      Math.max(40 + TOUCH_ACTIVATION_DISTANCE, geometry.remaining - upper + TOUCH_ACTIVATION_DISTANCE),
    );
    await dispatchTouchSwipe(ui, cdp, point, lowerY, lowerY - distance);
    await expect.poll(
      async () => (await ui.readContinuationGeometry()).remaining,
      { intervals: [0, 8, 16, 32], timeout: 2000 },
    ).toBeLessThan(geometry.remaining);
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
    const activatedY = lowerY - TOUCH_ACTIVATION_DISTANCE;
    const touchEndY = upperY - TOUCH_ACTIVATION_DISTANCE;
    let responseBoundary;
      let touchActive = false;
      let observation;
    let originalFailure = null;
      let samples;
      try {
        await positionWithTouchBeforeContinuation(ui, page, cdp, point, lowerY);
        const loadedBefore = await readLoadedAlbumCount(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [point(lowerY)],
      });
      touchActive = true;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [point(activatedY)],
      });
      await ui.waitForAnimationFrame();
      await ui.waitForNativeScrollSettled();
      responseBoundary = await observeResponseBoundary(cdp, isRootContinuationUrl);
        const diagnosticSequenceBeforeInput = await readLatestDiagnosticSequence(galleryActions);
        const anchor = await ui.captureMiddleVisibleCard();
        observation = await ui.startNativeScrollFrameObservation(anchor);
        const responsePromise = page.waitForResponse(isRootContinuation);
        const inputStartedAt = await ui.readBrowserEpoch();
        for (let step = 1; step <= 24; step += 1) {
        const y = Math.round(activatedY + ((touchEndY - activatedY) * step) / 24);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [point(y)],
          });
          await ui.waitForAnimationFrame();
          await ui.waitForAnimationFrame();
        }
      const [response, responseAt] = await Promise.all([
        responsePromise,
        responseBoundary.responseAt,
      ]);
        expect(response.ok()).toBe(true);
        const deferredEvent = await waitForDeferredGroupUpdate(
          galleryActions,
          diagnosticSequenceBeforeInput,
        );
      expect(deferredEvent.touchGestureActive).toBe(true);
      for (let frame = 0; frame < STATIONARY_TOUCH_FRAMES; frame += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point(touchEndY)],
        });
        await ui.waitForAnimationFrame();
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        touchActive = false;
        const inputEndedAt = await ui.readBrowserEpoch();
        expect(responseAt).toBeGreaterThanOrEqual(inputStartedAt);
        expect(responseAt).toBeLessThanOrEqual(inputEndedAt);
      expect(Number(deferredEvent.epoch)).toBeGreaterThanOrEqual(responseAt);
      expect(Number(deferredEvent.epoch)).toBeLessThanOrEqual(inputEndedAt);
        await waitForDeferredReplay(galleryActions, deferredEvent);
        await expect.poll(() => readLoadedAlbumCount(page)).toBeGreaterThan(loadedBefore);
      await page.waitForTimeout(300);
    } catch (error) {
      originalFailure = error;
      } finally {
      await finalizeResponseOverlapCleanup(originalFailure, [
        async () => {
          if (touchActive) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
        },
        async () => {
          if (observation) samples = await observation.finish();
        },
        async () => responseBoundary?.dispose(),
        async () => cdp.detach(),
        async () => {
          if (samples) {
            await testInfo.attach('mobile-real-continuation-overlap', {
              body: JSON.stringify({ samples }), contentType: 'application/json',
            });
          }
        },
      ], 'Mobile continuation overlap scenario and cleanup failed.');
      }
      const commandedDistance = lowerY - upperY;
    const maximumForwardStep = Math.ceil(commandedDistance / 24);
    expectStableOverlap(samples, commandedDistance, maximumForwardStep);
    });
  });

  test.describe('desktop Cards', () => {
    test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

    test('full preserve-scroll response during wheel sequence keeps gallery coordinates stable', async ({
      context, galleryActions, managedAppLifecycle, navigationPanelActions, page,
      searchToolbarActions,
    }, testInfo) => {
      const ui = await openRootGallery(page, galleryActions, navigationPanelActions, 'cards');
      const initialResponsePromise = page.waitForResponse(
        response => isFullSearchRefresh(response, FULL_REFRESH_SEARCH_QUERY),
      );
      await searchToolbarActions.search(FULL_REFRESH_SEARCH_QUERY);
      const initialResponse = await initialResponsePromise;
      expect(initialResponse.ok()).toBe(true);
      await searchToolbarActions.waitForQuery(FULL_REFRESH_SEARCH_QUERY);
      const loadedBefore = await readLoadedAlbumCount(page);
      expect(loadedBefore).toBeGreaterThan(1);

      const searchInput = searchToolbarActions.searchToolbar.input;
      await searchInput.focus();
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const cdp = await page.context().newCDPSession(page);
    let responseBoundary = null;
    let diagnosticSequenceBeforeInput = 0;
    let anchor = null;
      let watcherFixture = null;
      let originalFailure = null;
      let observation = null;
      let samples;
      let response = null;
    let responseSummary = null;
    let stateAfterReplay = null;
      let responseAt = null;
      let deferredEvent = null;
    let commandedDistance = 0;
      let inputStartedAt;
      let inputEndedAt;
    let activeInput;
      try {
      watcherFixture = await createWatchedAlbumFixture({
        ownedDirectoryName: 'gallery-native-response-overlap',
        artist: FULL_REFRESH_SEARCH_QUERY,
        album: `Gallery Refresh ${Date.now()}`,
        year: 2026,
        createLocalArt: true,
        context,
        managedAppLifecycle,
      });
      await expect.poll(
        () => readLoadedAlbumCount(page),
        { intervals: [100, 250, 500], timeout: 60_000 },
      ).toBe(loadedBefore + 1);
      responseBoundary = await observeResponseBoundary(
        cdp,
        candidateUrl => isFullSearchRefreshUrl(candidateUrl, FULL_REFRESH_SEARCH_QUERY),
      );
      diagnosticSequenceBeforeInput = await readLatestDiagnosticSequence(galleryActions);
      anchor = await ui.captureMiddleVisibleCard();
        observation = await ui.startNativeScrollFrameObservation(anchor);
        inputStartedAt = await ui.readBrowserEpoch();
      const responseOverlap = page.waitForResponse(
        candidate => isFullSearchRefresh(candidate, FULL_REFRESH_SEARCH_QUERY),
        { timeout: RESPONSE_BOUNDARY_TIMEOUT_MS },
      );
      const fixtureMutation = watcherFixture.renameTrack(
        0,
        `Watcher First Signal ${Date.now()}`,
      );
      activeInput = keepWheelActiveUntilResponseBoundary(
        ui, page, responseBoundary.responseAt,
        distance => { commandedDistance += distance; },
      );
      const [responseResult, fixtureResult, boundaryResult] = await Promise.allSettled([
        responseOverlap,
        fixtureMutation,
        activeInput.completion,
      ]);
      const overlapFailures = [responseResult, fixtureResult, boundaryResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (overlapFailures.length > 1) {
        throw new AggregateError(overlapFailures, 'Full-refresh response and fixture mutation failed.');
      }
      if (overlapFailures.length) throw overlapFailures[0];
      response = responseResult.value;
      responseAt = boundaryResult.value;
      const responsePayload = await response.json();
      responseSummary = {
        viewDataSource: responsePayload?.view_data_source || null,
        query: responsePayload?.query || null,
        albumCount: responsePayload?.album_count ?? null,
        groupAlbumCount: (responsePayload?.artist_groups || [])
          .reduce((count, group) => count + (group.albums || []).length, 0),
      };
        deferredEvent = await waitForDeferredGroupUpdate(
          galleryActions,
          diagnosticSequenceBeforeInput,
        );
      inputEndedAt = await ui.readBrowserEpoch();
        expect(response, 'native wheel sequence must overlap a full search refresh response').not.toBeNull();
        expect(deferredEvent, 'full refresh must reach the production deferred group-update path').not.toBeNull();
        expect(deferredEvent.touchGestureActive).toBe(false);
        expect(response.ok()).toBe(true);
        expect(watcherFixture.tracks).toHaveLength(2);
        const responseUrl = new URL(response.url());
        expect(responseUrl.searchParams.has('gallery_cursor')).toBe(false);
        expect(responseAt).toBeGreaterThanOrEqual(inputStartedAt);
        expect(responseAt).toBeLessThanOrEqual(inputEndedAt);
        expect(Number(deferredEvent.epoch)).toBeGreaterThanOrEqual(responseAt);
        expect(Number(deferredEvent.epoch)).toBeLessThanOrEqual(inputEndedAt);
        await waitForDeferredReplay(galleryActions, deferredEvent);
      // parity-check: allow-read-only-measurement-evaluate -- diagnose authoritative post-scan view ownership
      stateAfterReplay = await page.evaluate(() => ({
        query: state.view?.query || '',
        albumCount: state.view?.album_count ?? null,
        groupAlbumCount: (state.view?.artist_groups || [])
          .reduce((count, group) => count + (group.albums || []).length, 0),
        pendingScanCompletionViewRefresh: Boolean(state.ui?.pendingScanCompletionViewRefresh),
      }));
      await expect.poll(() => readLoadedAlbumCount(page)).toBe(loadedBefore + 1);
        await page.waitForTimeout(300);
      } catch (error) {
        originalFailure = error;
      } finally {
      let activeInputFailure = null;
      try {
        activeInput?.stop();
        await activeInput?.completion;
      } catch (error) {
        if (!failureIncludes(originalFailure, error)) activeInputFailure = error;
      }
        let reportingFailure = null;
        try {
          if (observation) {
            samples = await observation.finish();
            await testInfo.attach('desktop-full-refresh-overlap', {
              body: JSON.stringify({ responseSummary, stateAfterReplay, samples }),
              contentType: 'application/json',
            });
          }
        } catch (error) {
          reportingFailure = error;
        } finally {
        let boundaryFailure = null;
        try {
          responseBoundary?.dispose();
          await cdp.detach();
        } catch (error) {
          boundaryFailure = error;
        }
        const failures = [
          originalFailure,
          activeInputFailure,
          reportingFailure,
          boundaryFailure,
        ].filter(Boolean);
          const failureBeforeCleanup = failures.length > 1
            ? new AggregateError(failures, 'Full-refresh overlap scenario and reporting failed.')
            : failures[0] || null;
          if (watcherFixture) {
            await watcherFixture.cleanup({
              context,
              managedAppLifecycle,
              originalFailure: failureBeforeCleanup,
            });
          } else if (failureBeforeCleanup) {
            throw failureBeforeCleanup;
          }
        }
      }
    expectStableOverlap(samples, commandedDistance, 1);
    });

    test('real continuation response during wheel sequence keeps gallery coordinates stable', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openRootGallery(page, galleryActions, navigationPanelActions, 'cards');
      await positionWithWheelBeforeContinuation(ui, page);
      const loadedBefore = await readLoadedAlbumCount(page);
      const diagnosticSequenceBeforeInput = await readLatestDiagnosticSequence(galleryActions);
      const anchor = await ui.captureMiddleVisibleCard();
      const observation = await ui.startNativeScrollFrameObservation(anchor);
    const cdp = await page.context().newCDPSession(page);
    const responseBoundary = await observeResponseBoundary(cdp, isRootContinuationUrl);
      let samples;
      let response = null;
      let responseAt = null;
      let deferredEvent = null;
      let commandedDistance = 0;
    let originalFailure = null;
      const inputStartedAt = await ui.readBrowserEpoch();
      let inputEndedAt;
    let activeInput;
      try {
      const responseOverlap = page.waitForResponse(isRootContinuation, {
        timeout: RESPONSE_BOUNDARY_TIMEOUT_MS,
      });
        const geometry = await ui.readContinuationGeometry();
        let distanceToThreshold = Math.max(
          1,
          Math.floor(geometry.remaining - geometry.viewport * PREFETCH_VIEWPORTS) + 1,
        );
        while (distanceToThreshold > 0) {
          const wheelDelta = Math.min(32, distanceToThreshold);
          commandedDistance += wheelDelta;
          await page.mouse.wheel(0, wheelDelta);
          distanceToThreshold -= wheelDelta;
        }
      activeInput = keepWheelActiveUntilResponseBoundary(
        ui, page, responseBoundary.responseAt,
        distance => { commandedDistance += distance; },
      );
      [response, responseAt] = await Promise.all([
        responseOverlap,
        activeInput.completion,
      ]);
        deferredEvent = await waitForDeferredGroupUpdate(
          galleryActions,
          diagnosticSequenceBeforeInput,
        );
        inputEndedAt = await ui.readBrowserEpoch();
        expect(response, 'native wheel sequence must overlap a real continuation response').not.toBeNull();
        expect(deferredEvent, 'real continuation must reach the production deferred group-update path').not.toBeNull();
        expect(deferredEvent.touchGestureActive).toBe(false);
        expect(response.ok()).toBe(true);
        expect(responseAt).toBeGreaterThanOrEqual(inputStartedAt);
        expect(responseAt).toBeLessThanOrEqual(inputEndedAt);
        expect(Number(deferredEvent.epoch)).toBeGreaterThanOrEqual(responseAt);
        expect(Number(deferredEvent.epoch)).toBeLessThanOrEqual(inputEndedAt);
        await waitForDeferredReplay(galleryActions, deferredEvent);
        await expect.poll(() => readLoadedAlbumCount(page)).toBeGreaterThan(loadedBefore);
      await page.waitForTimeout(300);
    } catch (error) {
      originalFailure = error;
      } finally {
      await finalizeResponseOverlapCleanup(originalFailure, [
        async () => {
          activeInput?.stop();
          await activeInput?.completion;
        },
        async () => {
          samples = await observation.finish();
        },
        async () => responseBoundary.dispose(),
        async () => cdp.detach(),
        async () => {
          if (samples) {
            await testInfo.attach('desktop-real-continuation-overlap', {
              body: JSON.stringify({ samples }), contentType: 'application/json',
            });
          }
        },
      ], 'Desktop continuation overlap scenario and cleanup failed.');
      }
      expectStableOverlap(samples, commandedDistance, commandedDistance);
    });
  });
});
