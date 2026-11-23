import { expect, test } from '../support/baseFixtures.js';
import { startCpuLoad } from '../helpers/cpuLoad.js';
import { startNetworkRelay } from '../helpers/networkRelay.js';
import { assertTitleFollowsSound, observeSwitchPresentation } from '../helpers/index.js';
import { defineTimingBudget, expectTimingBudget } from '../helpers/timingBudget.js';

// A seek's place is painted within a few frames even at full load; a regression held the page for seconds.
// The limit is the one this check always had, below 500 ms: 500 itself fails, as the helper passes its ceiling.
// The target only sets where the report says the grace began; it is no new approved budget.
const SEEK_PAINT_BUDGET = defineTimingBudget({ targetMaximum: 299.999, graceMs: 200 });

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';
const OTHER_TITLE = 'Medium Cold Signal 07';
// Just above the fixture song's own rate (1.2 MB over about five minutes, 4 KB/s): it plays without
// stalling, but only its first part has arrived when the network goes, as on a weak mobile network.
const PLAYBACK_BYTES_PER_SECOND = 6 * 1024;

const displayedSeconds = (text) => {
  const match = String(text || '').match(/^(\d+):(\d{2})/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

// Every painted frame for [ms] from now: [locator]'s text and its painted seek progress (%), with the
// browser's own timing of a press in that time (Event Timing: when the pointer went down, when the
// click's handlers ended). Start it, press, then await it.
function samplePressPaint(locator, ms = 1500) {
  // parity-check: allow-read-only-measurement-evaluate -- frame-by-frame reading of the player after a press
  return locator.evaluate((element, duration) => new Promise((resolve) => {
    const frames = [];
    const events = [];
    const started = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (['pointerdown', 'mousedown', 'click'].includes(entry.name)) {
          events.push({ name: entry.name, startTime: entry.startTime, processingEnd: entry.processingEnd });
        }
      }
    });
    observer.observe({ type: 'event', durationThreshold: 16 });
    const sample = () => {
      frames.push({ at: performance.now(), text: String(element.textContent || ''),
        progress: parseFloat(element.style.getPropertyValue('--player-seek-progress')) || 0,
        current: element.classList.contains('is-current') });
      if (performance.now() - started < duration) {
        requestAnimationFrame(sample);
        return;
      }
      observer.disconnect();
      resolve({ started, frames, events });
    };
    requestAnimationFrame(sample);
  }), ms);
}

// The frames painted after the press, timed from it.
function framesAfterPress({ started, frames, events }) {
  const pressedAt = events.find(({ name }) => name !== 'click')?.startTime ?? started;
  const clickEnded = events.find(({ name }) => name === 'click')?.processingEnd ?? pressedAt;
  return frames.filter(({ at }) => at > pressedAt).map((frame) => ({ ...frame, afterMs: frame.at - pressedAt,
    afterClick: frame.at > clickEnded }));
}

// A seek past the received audio keeps the player on play, as on mobile, silent until the network is
// back; then it plays on by itself, and Play works with one press.
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

  // Wi-Fi off: the browser reports itself offline (no requests leave it, the
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

// On a laptop, a click past the received audio stops the music at once and moves the time there,
// Play never pauses by itself, and after the network is back one press starts another song or Play.
// A laptop that keeps another network interface (a VPN or a virtual
// adapter) never reports `offline`, and connections made before the outage stay dead afterwards.
test('FTC-PLAYBACK-OFFLINE-002 with no offline event, a seek past the received audio falls silent at once and stays playing, and after the network returns one press plays the current or another song', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  test.setTimeout(8 * 60 * 1000);
  const OTHER_TITLE = 'Medium Cold Signal 07';
  // One press must start within this, counted from the press.
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

// On a laptop with the CPU at 100%: a click past the received audio takes, shows its place at once
// and moves the head there with the first click; the waveform stays; playback goes on when the
// network is back; one press starts another song after it. A full CPU excuses none of it.
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

  // This laptop never reports `offline`; connections made before the outage stay dead.
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
    // parity-check: allow-read-only-measurement-evaluate -- read the painted seekbar waveform's pixels
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

// A click in the received audio plays at once, the head never resets to the start, the song goes on
// when the network is back, Play works then, and one press starts another song. The laptop here
// serves the app through a Cloudflare tunnel:
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
    // parity-check: allow-read-only-measurement-evaluate -- read how much of the song the player received before the outage
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

// With the network on, a seek never stops playback, resets the head to the start or dims Play. It did:
// the third seek stopped playback with an
// AudioWorklet protocol rejection, a late chunk of the stream the seek had just replaced.
test('FTC-PLAYBACK-SEEK-001 under full CPU load ten rapid seeks forward and back each show their place, never reset to the start, never stop or disable Play, and the last one plays', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }) => {
  test.setTimeout(6 * 60 * 1000);
  const player = globalPlayerActions.globalPlayer;
  let load = null;
  let path = '';
  let durationSeconds = 0;

  try {
    await stepLogger.step('The long song plays under full CPU load', async () => {
      await galleryActions.goto();
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      path = String(await trackModalActions.trackModal.trackRowByTitle(TITLE).getAttribute('data-track-row-path') || '');
      load = await startCpuLoad([page]);
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
      await trackModalActions.close();
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 5 });
      durationSeconds = (await player.readPlaybackTiming()).duration;
      expect(durationSeconds).toBeGreaterThan(120);
    });

    // A seek shows the head at its new place at once, as on main.
    await stepLogger.step('Ten rapid seeks: each paints its place within two frames, never the start, and Play stays playing and enabled', async () => {
      const fractions = [0.8, 0.3, 0.65, 0.15, 0.9, 0.5, 0.7, 0.2, 0.85, 0.4];
      const bounds = await player.timeline.boundingBox();
      for (const fraction of fractions) {
        const target = Math.floor(durationSeconds * fraction);
        const paint = samplePressPaint(player.timeline);
        await player.timeline.click({ position: { x: bounds.width * fraction, y: bounds.height / 2 } });
        const frames = framesAfterPress(await paint)
          .map((frame) => ({ ...frame, seconds: frame.progress / 100 * durationSeconds }));
        const painted = frames.findIndex(({ seconds }) => Math.abs(seconds - target) <= 2);
        expect(painted, `the seek to ${target}s is on the bar in the first or second frame: ${JSON.stringify(frames.slice(0, 3))}`)
          .toBeGreaterThanOrEqual(0);
        expect(painted).toBeLessThanOrEqual(1);
        expectTimingBudget(expect, frames[painted].afterMs, SEEK_PAINT_BUDGET, `the seek to ${target}s painted after the click`);
        await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 2000 })
          .toBeGreaterThanOrEqual(target - 2);
        for (let read = 0; read < 4; read += 1) {
          await page.waitForTimeout(150);
          const shown = displayedSeconds(await player.time.textContent());
          expect(shown, `after the seek to ${target}s the head never resets`).toBeGreaterThanOrEqual(target - 2);
          await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
          await expect(player.playButton).toBeEnabled();
        }
      }
    });

    await stepLogger.step('The last seek plays on from its place', async () => {
      const target = Math.floor(durationSeconds * 0.4);
      const mark = await playbackEvidence.playbackMark();
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path }, { timeout: 8000 });
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 8000 })
        .toBeGreaterThan(target + 1);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    });

    // Instant even at 100% CPU: while a song plays and decodes under full load, a press on another
    // song shows on its row in the first frame after its click. The player follows the sound: it
    // keeps the playing song's title until the pressed song sounds, then shows the pressed one.
    await stepLogger.step('Under the same load, a press on another song shows on its row in the first frame after the click, and in the player when it sounds', async () => {
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      const observer = await observeSwitchPresentation(page, player.titleSelector);
      try {
        const mark = await playbackEvidence.playbackMark();
        const paint = samplePressPaint(trackModalActions.trackModal.trackRowByTitle(OTHER_TITLE), 2000);
        const pressed = await trackModalActions.playTrackByTitle(OTHER_TITLE);
        const frames = framesAfterPress(await paint);
        const firstAfterClick = frames.find(({ afterClick }) => afterClick);
        expect(firstAfterClick?.current, `the pressed row in the first frame after the click: ${JSON.stringify(frames.slice(0, 3))}`).toBe(true);
        await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: pressed.path }, { timeout: 8000 });
        await expect(player.title).toContainText(OTHER_TITLE);
        const samples = await observer.finish();
        assertTitleFollowsSound(expect, { before: samples[0], pressed, samples });
      } finally {
        await observer.finish();
      }
      await trackModalActions.close();
    });
  } finally {
    await load?.stop();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
  }
});

// A click past the received audio leaves Play playing and enabled, the head still for lack of data,
// and the song continues on its own when the network returns.
test('FTC-PLAYBACK-OFFLINE-006 offline, seeks forward and back inside the received audio play, seeks past it wait silently at their place, Play is never dimmed or disabled, and the song plays on by itself when the network returns', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }, testInfo) => {
  test.setTimeout(8 * 60 * 1000);
  const appPort = Number(new URL(testInfo.project.use.baseURL).port);
  const relay = await startNetworkRelay(appPort, { playbackBytesPerSecond: PLAYBACK_BYTES_PER_SECOND });
  const player = globalPlayerActions.globalPlayer;
  let path = '';
  let durationSeconds = 0;

  const wifiOff = async () => {
    await page.context().setOffline(true);
    relay.stall();
  };
  const wifiOn = async () => {
    await relay.restore({ revive: false });
    await page.context().setOffline(false);
  };
  const expectPlayingEnabled = async () => {
    await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(player.playButton).toBeEnabled();
  };
  const seekTo = async (target) => {
    const bounds = await player.timeline.boundingBox();
    await player.timeline.click({ position: { x: bounds.width * (target / durationSeconds), y: bounds.height / 2 } });
    await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 2000 })
      .toBeGreaterThanOrEqual(target - 1);
  };
  const expectPlaysFrom = async (target) => {
    const mark = await playbackEvidence.playbackMark();
    await seekTo(target);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path }, { timeout: 4000 });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 4000 })
      .toBeGreaterThan(target);
    await expectPlayingEnabled();
  };
  const expectWaitsSilentlyAt = async (target) => {
    await seekTo(target);
    await page.waitForTimeout(1000);
    const silentFrom = await playbackEvidence.playbackMark();
    for (let read = 0; read < 4; read += 1) {
      await page.waitForTimeout(1000);
      const shown = displayedSeconds(await player.time.textContent());
      expect(shown, 'the head stays where it was put').toBeGreaterThanOrEqual(target - 1);
      expect(shown).toBeLessThanOrEqual(target + 1);
      await expectPlayingEnabled();
    }
    expect((await playbackEvidence.playbackMark()).renderedFrame, 'silent while it waits').toBe(silentFrom.renderedFrame);
  };

  // How far the song had arrived when the network went (all of it: Infinity).
  // parity-check: allow-read-only-measurement-evaluate -- read how much of the song the player received before the outage
  const receivedThroughSeconds = () => page.evaluate(() => {
    const engine = state.player?.streaming;
    const detached = engine?.detached;
    if (!detached) return null;
    if (detached.kind === 'offline') return Number.POSITIVE_INFINITY;
    return Number.isFinite(detached.spliceFrame) ? detached.spliceFrame / engine.sampleRate : 0;
  });
  let received = 0;

  try {
    await stepLogger.step('The long song plays through a slow network for three seconds', async () => {
      await page.goto(`${relay.origin}/?surface=albums`);
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await navigationPanelActions.waitForSidebarSelection(ARTIST);
      await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await trackModalActions.waitForInteractiveSummary();
      path = String(await trackModalActions.trackModal.trackRowByTitle(TITLE).getAttribute('data-track-row-path') || '');
      const mark = await playbackEvidence.playbackMark();
      await trackModalActions.playTrackByTitle(TITLE);
      await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
      await trackModalActions.close();
      durationSeconds = (await player.readPlaybackTiming()).duration;
      expect(durationSeconds).toBeGreaterThan(120);
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(3);
    });

    await stepLogger.step('Offline: back and forward inside the received audio, each plays at once', async () => {
      await wifiOff();
      await expect.poll(receivedThroughSeconds, { timeout: 10_000 }).not.toBeNull();
      received = await receivedThroughSeconds();
      // The measured range decides which places are inside and which are past it.
      expect(received, 'only part of the song arrived before the outage').toBeLessThan(durationSeconds * 0.7);
      expect(received).toBeGreaterThan(15);
      await expectPlaysFrom(1);
      await expectPlaysFrom(Math.floor(received - 6));
    });

    await stepLogger.step('Still offline: forward and back past the received audio, each waits silently at its place, playing and enabled', async () => {
      await expectWaitsSilentlyAt(Math.floor(durationSeconds * 0.95));
      await expectWaitsSilentlyAt(Math.floor((received + durationSeconds * 0.95) / 2));
    });

    await stepLogger.step('The network returns: the song plays on from the place by itself', async () => {
      const heldAt = displayedSeconds(await player.time.textContent());
      const mark = await playbackEvidence.playbackMark();
      await wifiOn();
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path }, { timeout: 15_000 });
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      await expect.poll(async () => displayedSeconds(await player.time.textContent()), { timeout: 15_000 })
        .toBeGreaterThan(heldAt);
      expect(displayedSeconds(await player.time.textContent())).toBeLessThan(heldAt + 20);
      await expectPlayingEnabled();
    });
  } finally {
    await page.context().setOffline(false);
    await relay.restore();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
    relay.close();
  }
});
