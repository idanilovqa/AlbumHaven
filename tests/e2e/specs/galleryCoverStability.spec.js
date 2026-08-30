import { expect, test } from '../support/baseFixtures.js';
import {
  expectAlbumCardCoverPresentationReady,
  expectDecodedCheckpoint,
  expectJosephCoverRouteResponse,
  expectJosephFixtureCheckpoint,
  expectZoomedJosephDetailScreenshot,
  observeExactCoverTraffic,
  readDecodedImageCheckpoint,
  readPagePerformanceNow,
  temporarilyMakeJosephCoverUnavailable,
} from '../helpers/galleryCoverStabilityHelpers.js';
import {
  expectTimingBudget,
  formatTimingBudgetOutcome,
} from '../helpers/timingBudget.js';

const ARTIST = 'Neal Morse';
const ALBUM = 'Joseph: Part One - The Dreamer';
const YEAR = '2023';
const VISIBLE_COVER_BUDGET = Object.freeze({ targetMaximum: 1000, graceMs: 200 });

test('FTC-COVERS-014 keeps a decoded gallery cover stable across real gallery interactions', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  page,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  const coverTraffic = observeExactCoverTraffic(page);
  let baseline;
  let baselineAlbumKey = '';
  let baselineCardHandle;
  let visibleCoverStartedAt = 0;
  let visibleCoverElapsedMs = 0;

  await stepLogger.step('Find Neal Morse through normal search and record Joseph\'s stable cover identity', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search('Joseph', {
      submitWithEnter: true,
      async recordSubmissionBoundary() {
        visibleCoverStartedAt = await readPagePerformanceNow(page);
      },
    });
    await searchToolbarActions.waitForQuery('Joseph');
    expect((await galleryActions.waitForGalleryScrollAtStart()).scrollTop).toBeLessThanOrEqual(2);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    baseline = await readDecodedImageCheckpoint(galleryActions.albumCoverByName(ALBUM), {
      startedAtMs: visibleCoverStartedAt,
    });
    visibleCoverElapsedMs = baseline.decodedElapsedMs;
    baselineAlbumKey = await galleryActions.readAlbumKeyByName(ALBUM);
    baselineCardHandle = await galleryActions.captureAlbumCardHandleByName(ALBUM);
    expectDecodedCheckpoint(expect, baseline);
    expectAlbumCardCoverPresentationReady(expect, baseline);
    expectJosephFixtureCheckpoint(expect, baseline);
    const baselineResponse = await coverTraffic.waitForResponse(baseline.productionSrc);
    expectJosephCoverRouteResponse(expect, baselineResponse);
    expect(baselineAlbumKey).not.toEqual('');
    const timingOutcome = expectTimingBudget(
      expect,
      visibleCoverElapsedMs,
      VISIBLE_COVER_BUDGET,
      'Visible Joseph cover',
    );
    stepLogger.note(formatTimingBudgetOutcome('Visible Joseph cover', timingOutcome), 2);
  });

  await stepLogger.step('Traverse more than 48 decoded production cards so Joseph leaves the bounded DOM-node cache', async () => {
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.clickAllArtists({ expectArtistQueryCleared: true });
    await galleryActions.waitForInitialAllArtistsSections({ minimumHeadingCount: 4 });
    const traversed = await galleryActions.traverseDistinctDecodedGalleryCards(48, {
      excludeKeys: [baselineAlbumKey],
      untilCoverEvicted: baseline.productionSrc,
    });
    expect(traversed.length).toBe(48);
    expect(new Set(traversed.map((entry) => entry.productionSrc)).size).toBe(48);
    const cacheState = await galleryActions.readCoverCacheState(baseline.productionSrc);
    expect(cacheState.active).toBe(false);
    expect(cacheState.activeCount).toBe(48);
    expect(cacheState.cached).toBe(true);
    expect(cacheState.cachedStatus).toBe(200);
    expect(cacheState.cachedType).toMatch(/^image\//);
  });

  await stepLogger.step('Return to the evicted Joseph card without a second production cover request', async () => {
    await searchToolbarActions.search('Joseph', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('Joseph');
    expect((await galleryActions.waitForGalleryScrollAtStart()).scrollTop).toBeLessThanOrEqual(2);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    const checkpoint = await readDecodedImageCheckpoint(galleryActions.albumCoverByName(ALBUM));
    expectDecodedCheckpoint(expect, checkpoint);
    expectAlbumCardCoverPresentationReady(expect, checkpoint);
    expect(checkpoint.productionSrc).toBe(baseline.productionSrc);
    expect(checkpoint.pixelHash).toBe(baseline.pixelHash);
    expect(await galleryActions.readAlbumKeyByName(ALBUM)).toBe(baselineAlbumKey);
    expect(await galleryActions.isSameAlbumCardHandle(baselineCardHandle, ALBUM)).toBe(false);
    expect(coverTraffic.requestCount(baseline.productionSrc)).toBe(1);
    expect(coverTraffic.responseCount(baseline.productionSrc)).toBe(1);
  });

  await stepLogger.step('Finish selected-family background caching before down/back and family filtering', async () => {
    await navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await navigationPanelActions.waitForSidebarSelection(ARTIST);
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await galleryActions.waitForSelectedArtistGallery(ARTIST);
    await galleryActions.waitForCoverSchedulerIdle({ timeout: 30000 });
    const requestsAfterBackgroundFill = coverTraffic.totalRequestCount();
    await galleryActions.scrollToAlbumUnderHeading(ARTIST, ALBUM);
    const awayState = await galleryActions.scrollAlbumAwayFromViewport(ARTIST, ALBUM);
    await galleryActions.returnToAlbumAfterScrollAway(ARTIST, ALBUM, awayState);
    await artistFamilyActions.waitForVisible();
    await artistFamilyActions.expand();
    await artistFamilyActions.clickChipByName('The Neal Morse Band');
    await artistFamilyActions.waitForChipActive('The Neal Morse Band');
    await artistFamilyActions.clickChipByName('The Neal Morse Band');
    await artistFamilyActions.waitForChipActive('The Neal Morse Band', false);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    await galleryActions.waitForCoverSchedulerIdle({ timeout: 30000 });
    const checkpoint = await readDecodedImageCheckpoint(galleryActions.albumCoverByName(ALBUM));
    expectDecodedCheckpoint(expect, checkpoint);
    expectAlbumCardCoverPresentationReady(expect, checkpoint);
    expect(checkpoint.productionSrc).toBe(baseline.productionSrc);
    expect(checkpoint.pixelHash).toBe(baseline.pixelHash);
    expect(await galleryActions.readAlbumKeyByName(ALBUM)).toBe(baselineAlbumKey);
    expect(coverTraffic.totalRequestCount()).toBe(requestsAfterBackgroundFill);
  });

  await stepLogger.step('Open and close album details without re-requesting or blanking the gallery cover', async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(ARTIST);
    expect(summary.title).toContain(ALBUM);
    expect(summary.title).toContain(YEAR);
    await trackModalActions.close();
    await galleryActions.waitForCoverSchedulerIdle({ timeout: 30000 });
    const checkpoint = await readDecodedImageCheckpoint(galleryActions.albumCoverByName(ALBUM));
    expectDecodedCheckpoint(expect, checkpoint);
    expectAlbumCardCoverPresentationReady(expect, checkpoint);
    expect(checkpoint.productionSrc).toBe(baseline.productionSrc);
    expect(checkpoint.pixelHash).toBe(baseline.pixelHash);
    expect(await galleryActions.readAlbumKeyByName(ALBUM)).toBe(baselineAlbumKey);
    expect(coverTraffic.requestCount(baseline.productionSrc)).toBe(1);
    expect(coverTraffic.responseCount(baseline.productionSrc)).toBe(1);
    coverTraffic.stop();
  });
});

test('FTC-COVERS-015 shows the exact Joseph 2023 cover decoded in the card, modal, and fullscreen lightbox', async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  const coverTraffic = observeExactCoverTraffic(page);
  let lightboxSources;
  let unavailableCover;
  await stepLogger.step('Find the exact Neal Morse Joseph album through normal search', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search('Joseph', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('Joseph');
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    const checkpoint = await readDecodedImageCheckpoint(galleryActions.albumCoverByName(ALBUM));
    expectJosephFixtureCheckpoint(expect, checkpoint);
    expectAlbumCardCoverPresentationReady(expect, checkpoint);
  });

  await stepLogger.step('Open its normal album modal and verify the decoded non-placeholder cover', async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ARTIST} - ${ALBUM}`);
    expect(summary.title).toContain(YEAR);
    expect(summary.coverLoaded).toBe(true);
    expect(summary.coverPlaceholderVisible).toBe(false);
    lightboxSources = await trackModalActions.readCoverLightboxSources();
    const previewUrl = new URL(lightboxSources.preview, page.url()).href;
    expect(new URL(previewUrl).searchParams.get('size')).toBe('480');
    expect(new URL(lightboxSources.full, page.url()).searchParams.get('size')).toBeNull();
    const modalCover = await trackModalActions.waitForDetailedCoverImageCheckpoint();
    expect(modalCover.complete).toBe(true);
    expect(modalCover.naturalWidth).toBe(480);
    expect(modalCover.naturalHeight).toBe(480);
    expect(modalCover.currentSrc.startsWith('blob:')).toBe(true);
    expect(modalCover.currentSrc).not.toBe(previewUrl);
    expect(new URL(modalCover.productionSrc, page.url()).href).toBe(previewUrl);
    const previewResponse = await coverTraffic.waitForResponse(previewUrl);
    expectJosephCoverRouteResponse(expect, previewResponse);
  });

  await stepLogger.step('Fall back to the real 480 preview when the test-owned full source is unavailable', async () => {
    unavailableCover = temporarilyMakeJosephCoverUnavailable(lightboxSources.full, page.url());
    try {
      await trackModalActions.openCoverLightbox();
      const failedFullResponse = await coverTraffic.waitForResponse(
        new URL(lightboxSources.full, page.url()).href,
        { status: 404, requireBodyHash: false },
      );
      expect(failedFullResponse.status).toBe(404);
      const fallbackCheckpoint = await readDecodedImageCheckpoint(trackModalActions.trackModal.lightboxImage);
      expectJosephFixtureCheckpoint(expect, fallbackCheckpoint);
      expect(new URL(fallbackCheckpoint.src, page.url()).href).toBe(
        new URL(lightboxSources.preview, page.url()).href,
      );
    } finally {
      unavailableCover.restore();
    }
  });

  await stepLogger.step('Reopen through real controls and decode the restored 1200 source with exact zoom detail', async () => {
    await trackModalActions.closeCoverLightbox();
    await trackModalActions.openCoverLightbox();
    const fullUrl = new URL(lightboxSources.full, page.url()).href;
    const fullResponse = await coverTraffic.waitForResponse(fullUrl);
    expectJosephCoverRouteResponse(expect, fullResponse, { fullscreen: true });
    const checkpoint = await readDecodedImageCheckpoint(trackModalActions.trackModal.lightboxImage);
    expectJosephFixtureCheckpoint(expect, checkpoint, { fullscreen: true });
    expect(new URL(checkpoint.src, page.url()).href).toBe(fullUrl);
    expect(new URL(checkpoint.src, page.url()).searchParams.get('size')).toBeNull();
    expect(checkpoint.src.startsWith('blob:')).toBe(false);
    await trackModalActions.zoomCoverLightbox();
    await expectZoomedJosephDetailScreenshot(expect, page, trackModalActions.trackModal.lightbox);
    await trackModalActions.closeCoverLightbox();
    await trackModalActions.close();
    coverTraffic.stop();
  });
});

test('FTC-PLAYER-010 keeps player artwork decoded and limits its full-art view to the active album', async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  let expectedCoverPath = '';
  let track;

  await stepLogger.step('Open the known Joseph release and start playback through its real track control', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search('Joseph', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('Joseph');
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ALBUM);
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ARTIST} - ${ALBUM}`);
    const modalCover = await trackModalActions.waitForDetailedCoverImageCheckpoint();
    expectedCoverPath = new URL(modalCover.productionSrc, page.url()).searchParams.get('path') || '';
    expect(expectedCoverPath).not.toEqual('');
    const playbackMark = await playbackEvidence.playbackMark();
    track = await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: track.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Verify the player cover decoded from the same production album artwork', async () => {
    const playerCover = await globalPlayerActions.waitForDecodedCover();
    expect(playerCover.hidden).toBe(false);
    expect(playerCover.width).toBeGreaterThan(0);
    expect(playerCover.height).toBeGreaterThan(0);
    expect(playerCover.naturalWidth).toBeGreaterThan(0);
    expect(playerCover.naturalHeight).toBeGreaterThan(0);
    const playerCoverUrl = new URL(playerCover.sourceUrl);
    expect(playerCoverUrl.pathname).toBe('/cover');
    expect(playerCoverUrl.searchParams.get('path')).toBe(expectedCoverPath);
  });

  await stepLogger.step('Restore the multi-album artist gallery before opening the player artwork', async () => {
    await trackModalActions.close();
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await galleryActions.waitForGalleryReady({ minimumCards: 2 });
    await galleryActions.waitForSelectedArtistGallery(ARTIST);
    await galleryActions.waitForMinimumAlbumCountByHeading(ARTIST, 2);
    const albumNames = await galleryActions.readAlbumNamesByHeading(ARTIST);
    expect(albumNames.length).toBeGreaterThan(1);
  });

  await stepLogger.step('Keep full-gallery navigation when the album is opened through the ordinary gallery', async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    const galleryModal = await trackModalActions.waitForLoadedSummary();
    expect(galleryModal.title).toContain(`${ARTIST} - ${ALBUM}`);
    await trackModalActions.openCoverLightbox();
    await trackModalActions.expectCoverLightboxNavigationAvailable();
    await trackModalActions.closeCoverLightbox();
    await trackModalActions.close();
  });

  await stepLogger.step('Open the player album and show only its cover in the full-art view', async () => {
    await globalPlayerActions.openCurrentAlbumFromCover();
    const reopened = await trackModalActions.waitForLoadedSummary();
    expect(reopened.title).toContain(`${ARTIST} - ${ALBUM}`);
    expect(reopened.title).toContain(YEAR);
    await trackModalActions.openCoverLightbox();
    const fullscreenCover = await readDecodedImageCheckpoint(trackModalActions.trackModal.lightboxImage);
    expectJosephFixtureCheckpoint(expect, fullscreenCover, { fullscreen: true });
    expect(new URL(fullscreenCover.src, page.url()).searchParams.get('path')).toBe(expectedCoverPath);
    await trackModalActions.expectCoverLightboxNavigationUnavailable();
    await trackModalActions.closeCoverLightbox();
    await trackModalActions.close();
  });
});
