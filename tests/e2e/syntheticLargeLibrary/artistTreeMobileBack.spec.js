import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import {
  waitForLibraryStartupEntryVisible,
} from '../helpers/realAppBenchmarkHelpers.js';

test.describe('FTC-GALLERY-NAV-033 synthetic-large mobile anchored gallery restoration', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  const scenarios = [
    { label: 'Cards', view: 'cards' },
    { label: 'Covers', view: 'covers' },
    { label: 'Rows', view: 'list' },
  ].flatMap(({ label, view }) => [false, true].map((scrollBeyondJump) => ({
    label, view, scrollBeyondJump,
  })));

  for (const { label, view, scrollBeyondJump } of scenarios) {
    test(`mobile ${label} › ${scrollBeyondJump
      ? 'long-press Scroll, ordinary scroll to another artist, album, Back retains the new position'
      : 'long-press Scroll, album, Back restores an artist beyond the first root page'}`, async ({
      galleryActions,
      navigationPanelActions,
      page,
    }) => {
      const ui = new GalleryRegressions(page);
      const layout = new MobileLayoutPage(page);
      await galleryActions.goto();
      await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
        timeout: 120000,
      });
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
      await galleryActions.waitForInitialAllArtistsSections({
        requireScrollable: false,
        timeout: 120000,
      });
      await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
      await page.waitForFunction(() => (
        typeof state !== 'undefined'
        && !state.busy
        && !String(state.ui?.activeViewRequestUrl || '').trim()
      ), null, { timeout: 120000 });

      await layout.selectView(view);

      await navigationPanelActions.openArtistTree();
      const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
      expect(artists.length).toBeGreaterThan(250);
      const requestedArtist = artists[200];
      expect(await ui.sidebarArtistSourceIndex(requestedArtist)).toBeGreaterThan(50);
      const row = await ui.revealArtistWithWheel(requestedArtist);
      await ui.longPressArtist(row);
      await expect(ui.scrollToArtistAction).toBeVisible();
      await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
      await ui.scrollToArtistAction.click();

      await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist))
        .toMatchObject({ anchorArtist: requestedArtist });
      const renderedArtist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist || requestedArtist;
      const expectedPlacement = {
        rendered: true,
        chromeMatches: true,
        rowsAligned: true,
        firstCardUncut: true,
      };
      await expect.poll(() => ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);

      const target = scrollBeyondJump
        ? await ui.scrollToDifferentGalleryArtist(renderedArtist)
        : { artist: renderedArtist, albumKey: await ui.firstAlbumKeyForArtist(renderedArtist) };
      const originatingArtist = target.artist;
      expect(originatingArtist).toBeTruthy();
      if (scrollBeyondJump) expect(originatingArtist).not.toBe(renderedArtist);

      const albumKey = target.albumKey;
      expect(albumKey).not.toBe('');
      const albumMetadata = ui.albumMetadataByKey(albumKey);
      await expect(albumMetadata).toBeInViewport({ ratio: 1 });
      const returnAnchor = await ui.captureSemanticVisibleCardAnchor(albumKey);
      expect(returnAnchor.albumKey).not.toBe('');
      expect(returnAnchor.artist).toBe(originatingArtist);
      expect(returnAnchor.top).not.toBeNull();
      await albumMetadata.click();
      await expect(ui.mobileAlbum).toBeVisible();
      const anchoredBackRequests = [];
      const viewTimeline = [];
      const responseReads = [];
      const recordViewResponse = response => {
        const url = new URL(response.url());
        if (!scrollBeyondJump || !url.pathname.endsWith('/view-data')) return;
        const entry = { kind: 'response', at: Date.now(), url: url.pathname + url.search, status: response.status() };
        viewTimeline.push(entry);
        responseReads.push(response.json().then(payload => {
          const groups = payload.artist_groups || payload.view?.artist_groups;
          entry.artists = Array.isArray(groups) ? groups.map(group => group.artist) : [];
        }).catch(error => { entry.bodyError = error.message; }));
      };
      const recordAnchoredBackRequest = (request) => {
        const url = new URL(request.url());
        if (scrollBeyondJump && url.pathname.endsWith('/view-data')) viewTimeline.push({ kind: 'request', at: Date.now(), url: url.pathname + url.search });
        if (
          url.pathname.endsWith('/view-data')
          && url.searchParams.get('gallery_anchor_artist') === requestedArtist
        ) anchoredBackRequests.push(url.href);
      };
      page.on('request', recordAnchoredBackRequest);
      page.on('response', recordViewResponse);
      let observation;
      let returnObservation;
      let samples = [];
      try {
        returnObservation = await ui.startVisibleCardAnchorObservation(returnAnchor, {
          waitUntilGalleryVisible: true,
        });
        await ui.mobileBack.click();
        await expect(ui.mobileAlbum).toBeHidden();
        await expect.poll(() => ui.readSemanticVisibleCardAnchorContinuity(returnAnchor)).toEqual({
          connected: true,
          delta: 0,
        });
        if (!scrollBeyondJump) expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
        expect(new URL(page.url()).searchParams.has('gallery_anchor_artist')).toBe(false);

        observation = scrollBeyondJump
          ? await ui.startVisibleCardAnchorObservation(returnAnchor)
          : await ui.startArtistJumpPlacementObservation(renderedArtist);
        await page.waitForTimeout(15000);
        const returnSamples = await returnObservation.finish();
        expect(returnSamples.length).toBeGreaterThan(30);
        expect(returnSamples.filter(sample => !sample.stable)).toEqual([]);
        samples = await observation.finish();
        expect(samples.length).toBeGreaterThan(30);
        expect(samples.filter(sample => !sample.stable)).toEqual([]);
        expect(await ui.readSemanticVisibleCardAnchorContinuity(returnAnchor)).toEqual({
          connected: true,
          delta: 0,
        });
        if (!scrollBeyondJump) expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
        expect(anchoredBackRequests).toEqual([]);
      } finally {
        try {
          await returnObservation?.finish();
          await observation?.finish();
        }
        finally {
          page.off('request', recordAnchoredBackRequest);
          page.off('response', recordViewResponse);
          await Promise.allSettled(responseReads);
          if (scrollBeyondJump) await test.info().attach('mobile-back-passive-diagnostics', {
            body: Buffer.from(JSON.stringify({ anchor: returnAnchor, samples, viewTimeline })),
            contentType: 'application/json',
          });
        }
      }
    });
  }
});
