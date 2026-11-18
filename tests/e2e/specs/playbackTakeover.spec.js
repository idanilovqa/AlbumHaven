import { expect, test } from '../support/baseFixtures.js';
import { GalleryActions, GlobalPlayerActions } from '../actions/index.js';
import { startCpuLoad } from '../helpers/cpuLoad.js';
import { GalleryPage, GlobalPlayer } from '../poms/index.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';

// Comparison run on main (no #99, no #63), test-only: the same second-tab measurement under full
// CPU load as FTC-PLAYBACK-TAKEOVER-002, with main's "Playing in another tab" status in place of the
// overlay. It is never merged.
test('FTC-PLAYBACK-TAKEOVER-002 under full CPU load a second tab of the same browser opens promptly beside a playing tab, stays responsive, shows the overlay, and one Play here moves the song to it', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  test.setTimeout(8 * 60 * 1000);
  const LONGEST_TASK_MS = 3000;
  const OPENS_WITHIN_MS = 30_000;
  let load = null;
  let second = null;

  try {
    await stepLogger.step('The first tab plays a long song well past its start', async () => {
      await galleryActions.goto();
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      const path = String(await trackModalActions.trackModal.trackRowByTitle(TITLE).getAttribute('data-track-row-path') || '');
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await trackModalActions.close();
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 5 });
    });

    await stepLogger.step('Under full CPU load a second tab opens promptly and its page never stops answering', async () => {
      load = await startCpuLoad([page]);
      const tab = await page.context().newPage();
      await load.throttle(tab);
      await tab.addInitScript(() => {
        window.__longestTaskMs = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__longestTaskMs = Math.max(window.__longestTaskMs, entry.duration);
        }).observe({ type: 'longtask', buffered: true });
      });
      second = {
        page: tab,
        galleryActions: new GalleryActions(new GalleryPage(tab, testInfo)),
        globalPlayerActions: new GlobalPlayerActions(new GlobalPlayer(tab, testInfo)),
      };
      const openedAt = Date.now();
      const timings = {};
      const inFlight = new Map();
      const since = () => Date.now() - openedAt;
      page.context().on('request', (request) => inFlight.set(request, `${request.method()} ${new URL(request.url()).pathname}`));
      for (const event of ['requestfinished', 'requestfailed']) page.context().on(event, (request) => inFlight.delete(request));
      tab.on('request', (request) => {
        if (request.isNavigationRequest()) timings.documentAsked ??= { at: since(), inFlight: [...inFlight.values()] };
      });
      tab.on('response', (response) => {
        if (response.request().isNavigationRequest()) timings.documentAnswered ??= since();
      });
      tab.on('domcontentloaded', () => { timings.domContentLoaded ??= since(); });
      tab.on('load', () => { timings.loaded ??= since(); });
      const report = async (stage) => {
        const ownership = async (target) => target.evaluate(() => {
          const ownership = state.player?.ownership || {};
          return { lockStatus: ownership.lockStatus, blockedReason: ownership.blockedReason, claimed: Boolean(ownership.activeClaim) };
        }).catch((error) => String(error));
        console.log(`[second-tab main ${stage}] ${JSON.stringify({ ...timings, at: since(), stillInFlight: [...inFlight.values()],
          first: await ownership(page), second: await ownership(tab) })}`);
      };
      try {
        await second.galleryActions.goto();
        await report('goto');
        await second.galleryActions.waitForGalleryReady({ timeout: OPENS_WITHIN_MS });
        await report('gallery');
        await expect(second.globalPlayerActions.globalPlayer.time).toHaveText('Playing in another tab');
      } finally {
        await report('end');
      }
      const openMs = Date.now() - openedAt;
      const longestTaskMs = await tab.evaluate(() => window.__longestTaskMs);
      console.log(`[second-tab main result] ${JSON.stringify({ openMs, longestTaskMs })}`);
      expect(openMs, 'the second tab opens promptly').toBeLessThan(OPENS_WITHIN_MS);
      expect(longestTaskMs, 'the second tab never stops answering').toBeLessThan(LONGEST_TASK_MS);
    });
  } finally {
    await load?.stop();
    if (second) await second.page.close();
  }
});
