import { expect, test } from '../support/baseFixtures.js';
import { startCpuLoad } from '../helpers/cpuLoad.js';
import { startNetworkRelay } from '../helpers/networkRelay.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';
// Just above the fixture song's own rate (1.2 MB over about five minutes, 4 KB/s): it plays without
// stalling, but only its first part has arrived when the network goes, as on a weak mobile network.
const PLAYBACK_BYTES_PER_SECOND = 6 * 1024;

const displayedSeconds = (text) => {
  const match = String(text || '').match(/^(\d+):(\d{2})/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

// Owner retest B-D4 round 4 (2026-11-17), verbatim: "As i seeked into the zone that was not cached,
// the player went into paused mode. I believe it should behave as on mobile - still be on play, just
// not play. Because of that when I returned wifi it didn't start playing automatically. Also, even
// when I pressed the button several times playback did not continue."
test('FTC-PLAYBACK-OFFLINE-001 a seek past the received audio offline stays playing silently, resumes by itself when the network returns, and one Play press continues a paused one', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  // Two plays of a song with two outages, each watched for several seconds.
  test.setTimeout(8 * 60 * 1000);
  const appPort = Number(new URL(testInfo.project.use.baseURL).port);
  const relay = await startNetworkRelay(appPort, { playbackBytesPerSecond: PLAYBACK_BYTES_PER_SECOND });
  const player = globalPlayerActions.globalPlayer;
  let track;
  let durationSeconds = 0;

  // Wi-Fi off, as the owner did: the browser reports itself offline (no requests leave it, the
  // `offline` event fires), and the open sockets go silent without closing. Wi-Fi on reverses both.
  const wifiOff = async () => {
    await page.context().setOffline(true);
    relay.stall();
  };
  const wifiOn = async () => {
    await relay.restore();
    await page.context().setOffline(false);
  };
  const playFromTheStart = async () => {
    const mark = await playbackEvidence.playbackMark();
    await trackModalActions.playTrackByTitle(TITLE);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
  };
  const expectHeldSilentlyAt = async (expectedLabel, targetSeconds) => {
    // The control keeps the state the listener chose, and the place stays where it was put.
    await expect(player.playButton).toHaveAttribute('aria-label', expectedLabel);
    await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 10000 })
      .toBeGreaterThanOrEqual(targetSeconds - 1);
    const heldAt = displayedSeconds(await player.time.textContent());
    const mark = await playbackEvidence.playbackMark();
    await page.waitForTimeout(4000);
    expect(displayedSeconds(await player.time.textContent())).toBe(heldAt);
    await expect(player.playButton).toHaveAttribute('aria-label', expectedLabel);
    await expect(player.playButton).toBeEnabled();
    expect((await playbackEvidence.playbackMark()).renderedFrame).toBe(mark.renderedFrame);
    return heldAt;
  };
  const expectPlayingOnFrom = async (heldAt) => {
    const mark = await playbackEvidence.playbackMark();
    await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 30000 })
      .toBeGreaterThan(heldAt);
    expect(displayedSeconds(await player.time.textContent())).toBeLessThan(heldAt + 20);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
  };

  try {
    await stepLogger.step('Open the long song through a network that delivers it slowly', async () => {
      await page.goto(`${relay.origin}/?surface=albums`);
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      const row = trackModalActions.trackModal.trackRowByTitle(TITLE);
      track = { path: String(await row.getAttribute('data-track-row-path') || '') };
      expect(track.path).not.toBe('');
    });

    await stepLogger.step('Playing: the network goes, and a seek past the received audio stays playing in silence', async () => {
      await playFromTheStart();
      await trackModalActions.close();
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
      durationSeconds = (await player.readPlaybackTiming()).duration;
      expect(durationSeconds).toBeGreaterThan(40);
      await wifiOff();
      // The seek comes at once, before the page has noticed its socket is gone, as a listener does.
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      const target = Math.floor(durationSeconds * 0.85);
      const bounds = await player.timeline.boundingBox();
      await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });
      const heldAt = await expectHeldSilentlyAt('Pause', target);

      await wifiOn();
      // Nobody presses anything: the song goes on from where the head was put.
      await expectPlayingOnFrom(heldAt);
    });

    await stepLogger.step('Paused: the network goes, a seek past the received audio waits, and one Play continues it', async () => {
      // The song still plays on from step 1: back near its start online, so only that part has arrived.
      const startBounds = await player.timeline.boundingBox();
      await player.timeline.click({ position: { x: startBounds.width * 0.02, y: startBounds.height / 2 } });
      await expectPlayingOnFrom(0);
      expect(displayedSeconds(await player.time.textContent())).toBeLessThan(durationSeconds * 0.5);
      await wifiOff();
      await page.waitForTimeout(1500);
      await player.playButton.click();
      await expect(player.playButton).toHaveAttribute('aria-label', 'Play');
      const target = Math.floor(durationSeconds * 0.85);
      const bounds = await player.timeline.boundingBox();
      await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });
      const heldAt = await expectHeldSilentlyAt('Play', target);

      await wifiOn();
      await page.waitForTimeout(3000);
      expect(displayedSeconds(await player.time.textContent())).toBe(heldAt);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Play');
      // One press, once: it is never ignored or needs repeating.
      await player.playButton.click();
      await expectPlayingOnFrom(heldAt);
    });
  } finally {
    // The page reaches the app only through the relay: give the claim back before closing it.
    await wifiOn();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
    relay.close();
  }
});

// Owner retest B-D4 round 5 (2026-11-17), laptop, verbatim: "when I clicked into the zone that
// wasn't downloaded, music did not stop immediately. it was playing apparently from the last
// available moment. The time did not ticked. Then play button became paused, even though I did not
// press anything. After network is back I tried to plahy completely different track and it took me
// 4 or 5 tries [...] clicking play in the player also is not taken fast enough and sometimes needs
// to be clicked several times". A laptop that keeps another network interface (a VPN or a virtual
// adapter) never reports `offline`, and connections made before the outage stay dead afterwards.
test('FTC-PLAYBACK-OFFLINE-002 with no offline event, a seek past the received audio falls silent at once and stays playing, and after the network returns one press plays the current or another song', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  test.setTimeout(8 * 60 * 1000);
  const OTHER_TITLE = 'Medium Cold Signal 07';
  // One press must start within this, counted from the press (owner: "taken fast enough").
  const ONE_PRESS_BUDGET_MS = 8000;
  const appPort = Number(new URL(testInfo.project.use.baseURL).port);
  const relay = await startNetworkRelay(appPort, { playbackBytesPerSecond: PLAYBACK_BYTES_PER_SECOND });
  const player = globalPlayerActions.globalPlayer;
  const paths = {};

  // Wi-Fi off on such a laptop: nothing reaches the server, but the browser never says so.
  const wifiOff = () => relay.stall();
  // Wi-Fi back: new connections work; the ones made before stay dead without closing.
  const wifiOn = () => relay.restore({ revive: false });
  const audibleAfter = async (mark, path) => {
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  };
  const openAlbum = async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await trackModalActions.waitForInteractiveSummary();
  };

  try {
    await stepLogger.step('Open the album through a network that delivers songs slowly', async () => {
      await page.goto(`${relay.origin}/?surface=albums`);
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await openAlbum();
      for (const title of [TITLE, OTHER_TITLE]) {
        paths[title] = String(await trackModalActions.trackModal.trackRowByTitle(title).getAttribute('data-track-row-path') || '');
        expect(paths[title]).not.toBe('');
      }
    });

    await stepLogger.step('Playing: a seek past the received audio falls silent at once and the button stays Pause', async () => {
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await audibleAfter(mark, paths[TITLE]);
      await trackModalActions.close();
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
      const durationSeconds = (await player.readPlaybackTiming()).duration;
      wifiOff();
      const target = Math.floor(durationSeconds * 0.85);
      const bounds = await player.timeline.boundingBox();
      await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });

      // The old audio stops within a second of the seek; nothing renders after that.
      await page.waitForTimeout(1200);
      const silentFrom = await playbackEvidence.playbackMark();
      await page.waitForTimeout(3000);
      expect((await playbackEvidence.playbackMark()).renderedFrame, 'no old audio after the seek').toBe(silentFrom.renderedFrame);
      const heldAt = displayedSeconds(await player.time.textContent());
      expect(heldAt).toBeGreaterThanOrEqual(target - 1);
      expect(heldAt).toBeLessThanOrEqual(target + 1);
      // Longer than the socket keepalive: nothing turns the button to Play by itself.
      for (let waited = 0; waited < 35_000; waited += 2500) {
        await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
        expect(displayedSeconds(await player.time.textContent())).toBe(heldAt);
        await page.waitForTimeout(2500);
      }

      const resumed = await playbackEvidence.playbackMark();
      wifiOn();
      // Nobody presses anything: it plays on from the head.
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: ONE_PRESS_BUDGET_MS })
        .toBeGreaterThan(heldAt);
      await audibleAfter(resumed, paths[TITLE]);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    });

    await stepLogger.step('Paused through an outage: one Play after the network returns plays on at once', async () => {
      wifiOff();
      await player.playButton.click();
      await expect(player.playButton).toHaveAttribute('aria-label', 'Play');
      await page.waitForTimeout(5000);
      wifiOn();
      await page.waitForTimeout(1000);
      const heldAt = displayedSeconds(await player.time.textContent());
      const mark = await playbackEvidence.playbackMark();
      const pressedAt = Date.now();
      await player.playButton.click();
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: ONE_PRESS_BUDGET_MS })
        .toBeGreaterThan(heldAt);
      await audibleAfter(mark, paths[TITLE]);
      expect(Date.now() - pressedAt).toBeLessThan(ONE_PRESS_BUDGET_MS + 2000);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    });

    await stepLogger.step('Paused through an outage: one press on another song after the network returns plays it', async () => {
      wifiOff();
      await player.playButton.click();
      await expect(player.playButton).toHaveAttribute('aria-label', 'Play');
      await page.waitForTimeout(5000);
      wifiOn();
      await page.waitForTimeout(1000);
      await openAlbum();
      const mark = await playbackEvidence.playbackMark();
      const pressedAt = Date.now();
      await trackModalActions.playTrackByTitle(OTHER_TITLE);
      await audibleAfter(mark, paths[OTHER_TITLE]);
      expect(Date.now() - pressedAt, 'one press starts it promptly').toBeLessThan(ONE_PRESS_BUDGET_MS);
      await expect(player.title).toContainText(OTHER_TITLE);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    });
  } finally {
    await relay.restore();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
    relay.close();
  }
});

// Owner retest B-D4 round 6 (2026-11-18), laptop with the CPU at 100%, verbatim: "1. When I clicked
// past the moment that was donwloaded click/seek did nto even take. It started to behave as it was
// lagging 2. Now it has delay before displaying where I clicked + I have to do 2 clicks: first
// clicks moves playhead slightly, noit relevant ot where I click, second click moves it where I
// want 2. Waveform disappeared, so I am left with no visual where I move it 3. Play button did not
// become paused, but the playback did not continue when network came back 4. I had to click into
// another song 6 TIMES before it started to play after Network came back." On the load: "Long cpu
// 100% is no execuse".
test('FTC-PLAYBACK-OFFLINE-003 under full CPU load, each seek past the received audio in an outage shows its place at once with one click and keeps the waveform, playback goes on by itself when the network returns, and one press plays another song', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, settingsModalAppBarActions, stepLogger, trackModalActions, utilityAppearanceActions, utilityTabBarActions }, testInfo) => {
  test.setTimeout(10 * 60 * 1000);
  const OTHER_TITLE = 'Medium Cold Signal 07';
  // A click shows its place within this: at once for a listener, under load included.
  const SHOWN_WITHIN_MS = 1000;
  const ONE_PRESS_BUDGET_MS = 8000;
  const appPort = Number(new URL(testInfo.project.use.baseURL).port);
  const relay = await startNetworkRelay(appPort, { playbackBytesPerSecond: PLAYBACK_BYTES_PER_SECOND });
  const player = globalPlayerActions.globalPlayer;
  const paths = {};
  let load = null;
  let durationSeconds = 0;

  // The owner's laptop never reports `offline`; connections made before the outage stay dead.
  const wifiOff = () => relay.stall();
  const wifiOn = () => relay.restore({ revive: false });
  const audibleAfter = async (mark, path) => {
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  };
  const openAlbum = async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await trackModalActions.waitForInteractiveSummary();
  };
  // The song's waveform is painted across the seekbar, not only the playhead line.
  const expectWaveformShown = async (why) => {
    const shown = await page.evaluate(({ selector, path }) => {
      const canvas = document.querySelector(selector);
      const peaks = state.player?.waveform?.compactPeaks;
      if (!(canvas instanceof HTMLCanvasElement) || canvas.hidden || !canvas.width || !canvas.height
          || String(peaks?.path || '') !== path || !Array.isArray(peaks?.data?.left)) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const columns = new Set();
      for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
        if (pixels[(pixel * 4) + 3] > 0) columns.add(pixel % canvas.width);
      }
      return columns.size > canvas.width / 2;
    }, { selector: player.waveformCanvasSelector, path: paths[TITLE] });
    expect(shown, `waveform shown ${why}`).toBe(true);
  };
  // One click: the head shows the clicked place at once and stays there, silent, with the waveform.
  const expectOneClickHeldAt = async (target) => {
    const bounds = await player.timeline.boundingBox();
    await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });
    const clickedAt = Date.now();
    await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: SHOWN_WITHIN_MS })
      .toBeGreaterThanOrEqual(target - 1);
    expect(Date.now() - clickedAt, 'the place shows at once').toBeLessThan(SHOWN_WITHIN_MS + 500);
    expect(displayedSeconds(await player.time.textContent())).toBeLessThanOrEqual(target + 1);
    await expectWaveformShown('right after the click');
    await page.waitForTimeout(1500);
    const silentFrom = await playbackEvidence.playbackMark();
    for (let waited = 0; waited < 6000; waited += 1500) {
      await page.waitForTimeout(1500);
      const shownAt = displayedSeconds(await player.time.textContent());
      expect(shownAt, 'stays where it was put').toBeGreaterThanOrEqual(target - 1);
      expect(shownAt).toBeLessThanOrEqual(target + 1);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      await expectWaveformShown('while it waits for the network');
    }
    expect((await playbackEvidence.playbackMark()).renderedFrame, 'no old audio after the seek').toBe(silentFrom.renderedFrame);
  };

  try {
    await stepLogger.step('Waveform seekbar, and the album through a network that delivers songs slowly', async () => {
      await page.goto(`${relay.origin}/?surface=albums`);
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('appearance');
      await utilityAppearanceActions.waitForReady();
      await utilityAppearanceActions.saveSeekbarMode('waveform');
      await settingsModalAppBarActions.closeSettings();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await openAlbum();
      for (const title of [TITLE, OTHER_TITLE]) {
        paths[title] = String(await trackModalActions.trackModal.trackRowByTitle(title).getAttribute('data-track-row-path') || '');
        expect(paths[title]).not.toBe('');
      }
    });

    await stepLogger.step('Under full CPU load the long song plays with its waveform', async () => {
      load = await startCpuLoad([page]);
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await audibleAfter(mark, paths[TITLE]);
      await trackModalActions.close();
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
      durationSeconds = (await player.readPlaybackTiming()).duration;
      expect(durationSeconds).toBeGreaterThan(40);
      await globalPlayerActions.waitForRenderedWaveform({ path: paths[TITLE] });
    });

    await stepLogger.step('The network goes: one click past the received audio, at once, shows its place and falls silent', async () => {
      wifiOff();
      await expectOneClickHeldAt(Math.floor(durationSeconds * 0.85));
    });

    await stepLogger.step('Still out, the outage noticed: one more click elsewhere past the received audio moves there at once', async () => {
      await expectOneClickHeldAt(Math.floor(durationSeconds * 0.6));
    });

    await stepLogger.step('The network returns: the song plays on from the place by itself, with its waveform', async () => {
      const heldAt = displayedSeconds(await player.time.textContent());
      const resumed = await playbackEvidence.playbackMark();
      wifiOn();
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: ONE_PRESS_BUDGET_MS })
        .toBeGreaterThan(heldAt);
      await audibleAfter(resumed, paths[TITLE]);
      expect(displayedSeconds(await player.time.textContent())).toBeLessThan(heldAt + 20);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      await expectWaveformShown('after the network returned');
    });

    await stepLogger.step('Playing through another outage: after the network returns one press plays another song', async () => {
      wifiOff();
      await page.waitForTimeout(10_000);
      wifiOn();
      await page.waitForTimeout(1000);
      await openAlbum();
      const mark = await playbackEvidence.playbackMark();
      const pressedAt = Date.now();
      await trackModalActions.playTrackByTitle(OTHER_TITLE);
      await audibleAfter(mark, paths[OTHER_TITLE]);
      expect(Date.now() - pressedAt, 'one press starts it promptly').toBeLessThan(ONE_PRESS_BUDGET_MS);
      await expect(player.title).toContainText(OTHER_TITLE);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    });
  } finally {
    await load?.stop();
    await relay.restore();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
    relay.close();
  }
});

// Owner retest B-D4 round 7 (2026-11-18), verbatim: "Even first click into the zone that supposedly
// was dowloaded leaves player without audip. Then playhead is being reset into the beginning of the
// track. The song does not restart when network is back. A track that was playing does not even want
// to start playing after network restart when I click on PLAY button in the player. And it took 6
// clicks for another song to try." The owner's laptop serves the app through a Cloudflare tunnel:
// Wi-Fi off cuts the browser and the server alike, and for about a minute after it returns the
// tunnel answers every request with a 530 error page.
for (const { id, serverBackAfterMs, outcome } of [
  { id: '004', serverBackAfterMs: 0, outcome: 'with Wi-Fi off and on' },
  { id: '005', serverBackAfterMs: 60_000, outcome: 'with the server answering 530 for a minute after Wi-Fi returns' },
]) {
  test(`FTC-PLAYBACK-OFFLINE-${id} owner round 7 ${outcome}: a click in the received audio plays at once, the head never jumps to the start, the song plays on by itself when the server is back, one Play continues it, and one press plays another song`, {
    tag: '@area:playback',
  }, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, settingsModalAppBarActions, stepLogger, trackModalActions, utilityAppearanceActions, utilityTabBarActions }, testInfo) => {
    test.setTimeout(12 * 60 * 1000);
    const OTHER_TITLE = 'Medium Cold Signal 07';
    const SHOWN_WITHIN_MS = 1000;
    const AUDIBLE_WITHIN_MS = 3000;
    const ONE_PRESS_BUDGET_MS = 8000;
    const appPort = Number(new URL(testInfo.project.use.baseURL).port);
    const relay = await startNetworkRelay(appPort);
    const player = globalPlayerActions.globalPlayer;
    const paths = {};
    let load = null;
    let durationSeconds = 0;
    let stopWatching = null;

    const shownSeconds = async () => displayedSeconds(await player.time.textContent());
    // The head is watched all along: it may never show a place before the one the listener put it at.
    const watchHead = () => {
      let lowest = Number.POSITIVE_INFINITY;
      let stopped = false;
      const loop = (async () => {
        while (!stopped) {
          const shown = await shownSeconds().catch(() => Number.NaN);
          if (Number.isFinite(shown)) lowest = Math.min(lowest, shown);
          await page.waitForTimeout(250);
        }
      })();
      stopWatching = async () => {
        stopped = true;
        stopWatching = null;
        await loop;
        return lowest;
      };
    };
    const lowestShown = () => stopWatching();
    const wifiOff = async () => {
      await page.context().setOffline(true);
      relay.stall();
    };
    const wifiOn = async () => {
      await page.context().setOffline(false);
      if (serverBackAfterMs) await relay.serverUnreachable();
      else await relay.restore({ revive: false });
    };
    const serverBack = () => relay.restore({ revive: false });
    const audibleWithin = async (mark, path, timeout) => {
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path }, { timeout });
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    };
    // How far the song had arrived when the network went (all of it: Infinity).
    const receivedThroughSeconds = () => page.evaluate(() => {
      const engine = state.player?.streaming;
      const detached = engine?.detached;
      if (!detached) return null;
      if (detached.kind === 'offline') return Number.POSITIVE_INFINITY;
      return Number.isFinite(detached.spliceFrame) ? detached.spliceFrame / engine.sampleRate : 0;
    });
    const clickAt = async (target) => {
      const bounds = await player.timeline.boundingBox();
      await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });
    };
    const clickOnceOffline = async (target, settleMs) => {
      const received = await receivedThroughSeconds();
      const mark = await playbackEvidence.playbackMark();
      await clickAt(target);
      watchHead();
      await expect.poll(shownSeconds, { timeout: SHOWN_WITHIN_MS }).toBeGreaterThanOrEqual(target - 1);
      if (target < received) await audibleWithin(mark, paths[TITLE], AUDIBLE_WITHIN_MS);
      await page.waitForTimeout(settleMs);
      expect(await lowestShown(), 'the head never went back before the clicked place').toBeGreaterThanOrEqual(target - 1);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    };

    try {
      await stepLogger.step('Waveform seekbar; the long song plays half a minute', async () => {
        await page.goto(`${relay.origin}/?surface=albums`);
        await galleryActions.waitForGalleryReady();
        await settingsModalAppBarActions.openSettings();
        await utilityTabBarActions.openTab('appearance');
        await utilityAppearanceActions.waitForReady();
        await utilityAppearanceActions.saveSeekbarMode('waveform');
        await settingsModalAppBarActions.closeSettings();
        await navigationPanelActions.selectSidebarArtistByName(ARTIST);
        await navigationPanelActions.waitForSidebarSelection(ARTIST);
        await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
        await trackModalActions.waitForInteractiveSummary();
        for (const title of [TITLE, OTHER_TITLE]) {
          paths[title] = String(await trackModalActions.trackModal.trackRowByTitle(title).getAttribute('data-track-row-path') || '');
          expect(paths[title]).not.toBe('');
        }
        if (process.env.CI) load = await startCpuLoad([page]);
        const mark = await playbackEvidence.playbackMark();
        await trackModalActions.playTrackByTitle(TITLE);
        await audibleWithin(mark, paths[TITLE], 60_000);
        await trackModalActions.close();
        durationSeconds = (await player.readPlaybackTiming()).duration;
        expect(durationSeconds).toBeGreaterThan(180);
        await expect.poll(shownSeconds, { timeout: 60_000 }).toBeGreaterThanOrEqual(30);
      });

      await stepLogger.step('Wi-Fi off; one click a minute before the end plays at once if received, else waits there; 40 s on the head never went back', async () => {
        await wifiOff();
        await expect.poll(receivedThroughSeconds, { timeout: 10_000 }).not.toBeNull();
        await clickOnceOffline(Math.floor(durationSeconds - 60), 40_000);
      });

      await stepLogger.step('Still off: one click two minutes before the end does the same', async () => {
        await clickOnceOffline(Math.floor(durationSeconds - 120), 5000);
      });

      await stepLogger.step('Wi-Fi on: once the server answers again the song plays on by itself, nothing pressed', async () => {
        const heldAt = await shownSeconds();
        watchHead();
        await wifiOn();
        if (serverBackAfterMs) {
          await page.waitForTimeout(serverBackAfterMs);
          await expect(player.playButton, 'still on play while the server is away').toHaveAttribute('aria-label', 'Pause');
          await serverBack();
        }
        const mark = await playbackEvidence.playbackMark();
        await audibleWithin(mark, paths[TITLE], ONE_PRESS_BUDGET_MS);
        expect(await lowestShown(), 'the head never went back').toBeGreaterThanOrEqual(heldAt - 1);
        await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      });

      await stepLogger.step('After the network returned, Pause then one Play continues the song from its place', async () => {
        await player.playButton.click();
        await expect(player.playButton).toHaveAttribute('aria-label', 'Play');
        const pausedAt = await shownSeconds();
        const mark = await playbackEvidence.playbackMark();
        await player.playButton.click();
        await audibleWithin(mark, paths[TITLE], ONE_PRESS_BUDGET_MS);
        await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
        expect(await shownSeconds()).toBeGreaterThanOrEqual(pausedAt);
      });

      await stepLogger.step('Wi-Fi off 10 s and on; one press on another song plays it once the server answers', async () => {
        await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
        await trackModalActions.waitForInteractiveSummary();
        await wifiOff();
        await page.waitForTimeout(10_000);
        await wifiOn();
        await page.waitForTimeout(1000);
        const mark = await playbackEvidence.playbackMark();
        await trackModalActions.playTrackByTitle(OTHER_TITLE);
        if (serverBackAfterMs) {
          await page.waitForTimeout(serverBackAfterMs);
          await serverBack();
        }
        await audibleWithin(mark, paths[OTHER_TITLE], ONE_PRESS_BUDGET_MS);
        await expect(player.title).toContainText(OTHER_TITLE);
        await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
      });
    } finally {
      await stopWatching?.();
      await load?.stop();
      await page.context().setOffline(false);
      await relay.restore();
      await globalPlayerActions.pauseToReleasePlaybackClaim();
      relay.close();
    }
  });
}
