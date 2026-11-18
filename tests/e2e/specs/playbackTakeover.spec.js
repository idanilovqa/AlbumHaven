import { expect, test } from '../support/baseFixtures.js';
import { GalleryActions, GlobalPlayerActions } from '../actions/index.js';
import { startCpuLoad } from '../helpers/cpuLoad.js';
import { observePlaybackPcmTraffic } from '../helpers/gaplessPlaybackHelpers.js';
import { GalleryPage, GlobalPlayer } from '../poms/index.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';

const displayedSeconds = (text) => {
  const match = String(text || '').match(/^(\d+):(\d{2})/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

// Owner, 2026-11-17: "Once that message playing in another tab is shown the play button should be
// actionable, because if it would be dim it is not clear to the user that it can be pressed." Play
// takes playback over (playback.claim.takeover): the other device's song continues here from where
// it was, the other device stops and shows "Playing in another tab".
test('FTC-PLAYBACK-TAKEOVER-001 Play on the playing-elsewhere overlay continues the other device\'s song here at its place and stops the other device', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  let track;
  let heardAt = 0;

  await stepLogger.step('The first device plays a long song well past its start', async () => {
    for (const session of [first, second]) {
      await session.galleryActions.goto();
      await session.galleryActions.waitForGalleryReady();
    }
    await first.navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await first.navigationPanelActions.waitForSidebarSelection(ARTIST);
    await first.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await first.trackModalActions.waitForInteractiveSummary();
    const row = first.trackModalActions.trackModal.trackRowByTitle(TITLE);
    track = { path: String(await row.getAttribute('data-track-row-path') || '') };
    expect(track.path).not.toBe('');
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackByTitle(TITLE);
    await first.trackModalActions.close();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    const player = first.globalPlayerActions.globalPlayer;
    const bounds = await player.timeline.boundingBox();
    await player.timeline.click({ position: { x: bounds.width * 0.3, y: bounds.height / 2 } });
    await first.globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 60 });
  });

  await stepLogger.step('The second device shows the song under the overlay, with Play pressable above it', async () => {
    await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
  });

  await stepLogger.step('One Play press continues the song here at about its place; the first device stops', async () => {
    const firstPlayer = first.globalPlayerActions.globalPlayer;
    const secondPlayer = second.globalPlayerActions.globalPlayer;
    const mark = await second.playbackEvidence.playbackMark();
    heardAt = displayedSeconds(await firstPlayer.time.textContent());
    await secondPlayer.playButton.click();

    const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(secondPlayer.elsewhereOverlay).toBeHidden();
    await expect(secondPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(secondPlayer.title).toContainText(TITLE);
    const startedAt = displayedSeconds(await secondPlayer.time.textContent());
    expect(startedAt, 'continues where the first device was, not from the start').toBeGreaterThanOrEqual(heardAt - 3);
    expect(startedAt).toBeLessThanOrEqual(heardAt + 15);

    // The first device hears nothing more and shows the second device's song as playing elsewhere.
    await first.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
    const silent = await first.playbackEvidence.playbackMark();
    await first.page.waitForTimeout(3000);
    expect((await first.playbackEvidence.playbackMark()).renderedFrame).toBe(silent.renderedFrame);
  });

  await stepLogger.step('The first device takes it back the same way', async () => {
    const mark = await first.playbackEvidence.playbackMark();
    await first.globalPlayerActions.globalPlayer.playButton.click();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
  });
});

// Owner retest round 6 (2026-11-18), with the CPU at 100%, verbatim: "It is weird, but second tab
// can't load - I get black screen and then even browser message alert that site is not responding.
// Probably has to do with my CPU 100% load." On the load: "Long cpu 100% is no execuse".
test('FTC-PLAYBACK-TAKEOVER-002 under full CPU load a second tab of the same browser opens promptly beside a playing tab, stays responsive, shows the overlay, and one Play here moves the song to it', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  test.setTimeout(8 * 60 * 1000);
  // Chromium asks whether to wait for a page whose main thread is stuck for some seconds.
  const LONGEST_TASK_MS = 3000;
  const OPENS_WITHIN_MS = 30_000;
  let load = null;
  let second = null;
  let track;

  try {
    await stepLogger.step('The first tab plays a long song well past its start', async () => {
      await galleryActions.goto();
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      track = { path: String(await trackModalActions.trackModal.trackRowByTitle(TITLE).getAttribute('data-track-row-path') || '') };
      expect(track.path).not.toBe('');
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await trackModalActions.close();
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
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
        playbackEvidence: observePlaybackPcmTraffic(tab),
      };
      const firstHeard = await playbackEvidence.playbackMark();
      const openedAt = Date.now();
      // Where the time goes, in the log: the page's own loading, and what both tabs had in flight.
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
        console.log(`[second-tab ${stage}] ${JSON.stringify({ ...timings, at: since(), stillInFlight: [...inFlight.values()],
          first: await ownership(page), second: await ownership(tab) })}`);
      };
      try {
        await second.galleryActions.goto();
        await report('goto');
        await second.galleryActions.waitForGalleryReady({ timeout: OPENS_WITHIN_MS });
        await report('gallery');
        await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
      } finally {
        await report('end');
      }
      const openMs = Date.now() - openedAt;
      const longestTaskMs = await tab.evaluate(() => window.__longestTaskMs);
      await testInfo.attach('second-tab-open', {
        body: JSON.stringify({ openMs, longestTaskMs }, null, 2), contentType: 'application/json',
      });
      expect(openMs, 'the second tab opens promptly').toBeLessThan(OPENS_WITHIN_MS);
      expect(longestTaskMs, 'the second tab never stops answering').toBeLessThan(LONGEST_TASK_MS);
      // The first tab played on meanwhile.
      expect((await playbackEvidence.playbackMark()).renderedFrame).toBeGreaterThan(firstHeard.renderedFrame);
    });

    await stepLogger.step('One Play here in the second tab moves the song to it; the first tab stops', async () => {
      const player = second.globalPlayerActions.globalPlayer;
      const mark = await second.playbackEvidence.playbackMark();
      await player.playButton.click();
      const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
      await expect(player.elsewhereOverlay).toBeHidden();
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      await globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
      expect(await second.page.evaluate(() => window.__longestTaskMs), 'still answering').toBeLessThan(LONGEST_TASK_MS);
    });
  } finally {
    await load?.stop();
    if (second) {
      await second.globalPlayerActions.pauseToReleasePlaybackClaim();
      second.playbackEvidence.stop();
      await second.page.close();
    }
  }
});
