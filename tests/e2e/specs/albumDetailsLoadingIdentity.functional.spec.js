import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { observeAlbumDetailsRequests } from '../helpers/albumDetailsRequestTrace.js';

const FIRST_ALBUM = 'Featured Signal Collection';
const SECOND_ALBUM = 'Ordinary Numeric Disc Control';
const TRACE_ALBUM = 'Structured Soundtrack Cross-Credits';

async function traceCompositeDetails({ galleryActions, mobile, page, trackModalActions }, testInfo) {
  const network = await observeAlbumDetailsRequests(page);
  const evidence = { fixture: 'functional-core', latencyCertification: false, opens: [] };
  let albumKey;
  const detailsRequests = () => network.records.filter(record => record.kind === 'details' && record.albumKey === albumKey);
  const close = () => mobile ? trackModalActions.backFromMobilePage() : trackModalActions.close();
  const open = async (kind) => {
    const observation = await trackModalActions.trackModal.startVisibleContentObservation();
    const issuedAt = Date.now();
    try {
      await galleryActions.clickAlbumDetailsByAlbumName(TRACE_ALBUM);
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.title).toContain(TRACE_ALBUM);
      expect(summary.title).toContain('Sia');
      expect(summary.title).toContain('Soundtrack Signal Guest');
      expect(summary.trackRows).toBe(18);
      expect(await trackModalActions.readTrackTitles()).toEqual(
        Array.from({ length: 18 }, (_, index) => `Soundtrack Signal ${String(index + 1).padStart(2, '0')}`),
      );
      const firstRow = trackModalActions.trackModal.trackRows.first();
      await expect(firstRow).toBeVisible();
      const visibleTitle = mobile
        ? trackModalActions.trackModal.albumSurface.locator('#mobile-page-title')
        : trackModalActions.trackModal.title;
      await expect(visibleTitle).toBeVisible();
      await expect(visibleTitle).toContainText(TRACE_ALBUM);
      const [rowBox, titleBox, dialogBox] = await Promise.all([
        firstRow.boundingBox(), visibleTitle.boundingBox(),
        trackModalActions.trackModal.dialog.boundingBox(),
      ]);
      expect(rowBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(dialogBox).not.toBeNull();
      expect(rowBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      expect(rowBox.y).toBeGreaterThanOrEqual(dialogBox.y);
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(page.viewportSize().height);
      const renderedAt = Date.now();
      const samples = await observation.finish();
      const firstCompleteAt = samples.find(sample => !sample.loading && sample.tracks.length === 18)?.observedAt;
      expect(firstCompleteAt).toBeDefined();
      for (const sample of samples) {
        expect(sample.title).toContain(TRACE_ALBUM);
        if (sample.loading) {
          expect(sample.subtitle).toBe('Loading album details...');
          expect(sample.tracks).toEqual([]);
        }
      }
      evidence.opens.push({ kind, issuedAt, firstCompleteAt, renderedAt, samples });
    } finally {
      await observation.finish();
    }
  };
  try {
    await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(TRACE_ALBUM)}`);
    await galleryActions.waitForAlbumVisible(TRACE_ALBUM);
    albumKey = await galleryActions.readAlbumKeyByName(TRACE_ALBUM);
    expect(albumKey).not.toBe('');
    await open('cold-document');
    await trackModalActions.waitForDetailedCoverImageCheckpoint();
    evidence.opens.at(-1).artDecodedAt = Date.now();
    await close();
    const beforeWarm = detailsRequests().length;
    await open('immediate-reopen');
    expect(detailsRequests()).toHaveLength(beforeWarm);
    await close();

    await network.slowDetailsAndBlockArt();
    evidence.injectedConditions = { scenario: 'in-flight-speculative-with-blocked-art', detailsLatencyMs: 2000, artBlocked: true };
    const firstThrottledRequest = network.records.length;
    await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(TRACE_ALBUM)}`);
    await galleryActions.waitForAlbumVisible(TRACE_ALBUM);
    albumKey = await galleryActions.readAlbumKeyByName(TRACE_ALBUM);
    await expect.poll(() => network.records.slice(firstThrottledRequest)
      .some(record => record.kind === 'details' && record.albumKey === albumKey && !record.finished)).toBe(true);
    const requestsBeforeClick = detailsRequests().length;
    await open('in-flight-speculative-with-blocked-art');
    expect(detailsRequests()).toHaveLength(requestsBeforeClick);
    expect(evidence.opens.at(-1).samples.some(sample => sample.loading)).toBe(true);
    expect(network.records.slice(firstThrottledRequest).some(record => record.kind === 'art' && record.failure)).toBe(true);
  } finally {
    evidence.requests = network.records;
    await testInfo.attach('album-details-request-to-render.json', {
      body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
    });
    await network.dispose();
    if (await trackModalActions.trackModal.dialog.isVisible()) await close();
  }
}

async function verifyColdAlbumTransition({
 galleryActions,
 mobile,
 page,
 searchToolbarActions,
  stepLogger,
  trackModalActions,
}) {
 let observation = null;
 let mobileLayout = null;
 try {
 await stepLogger.step(`Open and close album A on ${mobile ? 'mobile' : 'desktop'}`, async () => {
 await galleryActions.goto('/?surface=albums');
 if (mobile) {
 mobileLayout = new MobileLayoutPage(page);
 await mobileLayout.libraryButton.click();
 await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
 await mobileLayout.allArtists.click();
 await expect(mobileLayout.home).toBeHidden();
 }
 await galleryActions.waitForGalleryReady();
 if (mobile) await mobileLayout.search(FIRST_ALBUM);
 else await searchToolbarActions.search(FIRST_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(FIRST_ALBUM);
      await galleryActions.waitForAlbumVisible(FIRST_ALBUM);
      await galleryActions.clickAlbumDetailsByAlbumName(FIRST_ALBUM);
      const firstSummary = await trackModalActions.waitForLoadedSummary();
      expect(firstSummary.title).toContain(FIRST_ALBUM);
      const firstTracks = await trackModalActions.readTrackTitles();
      expect(firstTracks.length).toBeGreaterThan(0);
      if (mobile) await trackModalActions.backFromMobilePage();
      else await trackModalActions.close();

 if (mobile) await mobileLayout.search(SECOND_ALBUM);
 else await searchToolbarActions.search(SECOND_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(SECOND_ALBUM);
      await galleryActions.waitForAlbumVisible(SECOND_ALBUM);

      observation = await trackModalActions.trackModal.startVisibleContentObservation();
      await galleryActions.clickAlbumDetailsByAlbumName(SECOND_ALBUM);
      await expect(trackModalActions.trackModal.dialog).toBeVisible();
      await expect(trackModalActions.trackModal.title).toContainText(SECOND_ALBUM);
      await expect(trackModalActions.trackModal.title).not.toContainText(FIRST_ALBUM);
      const immediateTracks = await trackModalActions.readTrackTitles();
      expect(immediateTracks.filter((title) => firstTracks.includes(title))).toEqual([]);

      const secondSummary = await trackModalActions.waitForLoadedSummary();
      expect(secondSummary.title).toContain(SECOND_ALBUM);
      const samples = await observation.finish();
      observation = null;
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(sample.title).toContain(SECOND_ALBUM);
        expect(`${sample.title} ${sample.subtitle}`).not.toContain(FIRST_ALBUM);
        expect(sample.tracks.filter((title) => firstTracks.includes(title))).toEqual([]);
        if (sample.loading) {
          expect(sample.subtitle).toBe('Loading album details...');
          expect(sample.tracks).toEqual([]);
        }
      }
    });
  } finally {
    if (observation) await observation.finish();
    if (await trackModalActions.trackModal.dialog.isVisible()) {
      if (mobile) await trackModalActions.backFromMobilePage();
      else await trackModalActions.close();
    }
  }
}

test('FTC-ALBUM-DETAILS-024 desktop identifies cold album B before its details settle without restoring album A', { tag: '@area:album-details' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}, testInfo) => {
  await verifyColdAlbumTransition({
    galleryActions,
    mobile: false,
    searchToolbarActions,
    stepLogger,
    trackModalActions,
  });
  await traceCompositeDetails({ galleryActions, mobile: false, page, trackModalActions }, testInfo);
});

test.describe('mobile album transition', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

 test('FTC-ALBUM-DETAILS-025 mobile identifies cold album B before its details settle without restoring album A', { tag: '@area:album-details' }, async ({
 galleryActions,
 page,
 searchToolbarActions,
    stepLogger,
    trackModalActions,
  }, testInfo) => {
 await verifyColdAlbumTransition({
 galleryActions,
 mobile: true,
 page,
 searchToolbarActions,
      stepLogger,
      trackModalActions,
    });
    await traceCompositeDetails({ galleryActions, mobile: true, page, trackModalActions }, testInfo);
  });
});
