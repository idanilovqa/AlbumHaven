import { expect, test } from '../support/baseFixtures.js';
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
