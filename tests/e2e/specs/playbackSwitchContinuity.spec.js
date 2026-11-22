import { expect, test } from '../support/baseFixtures.js';
import { startNetworkRelay } from '../helpers/networkRelay.js';
import {
  assertSwitchKeepsSongSounding,
  defineTimingBudget,
  expectTimingBudget,
  findPromotedPreparedReplacement,
  forgetKeptStreamingTracks,
  measureAlbumTrackPlaybackStart,
  observeSwitchPresentation,
  readGaplessPlaybackDiagnostics,
} from '../helpers/index.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
// The album's rows by index: a long song and the song after it, songs to switch to, and a short song
// that the album moves on from by itself.
const LONG_ROW = 0;
const NEXT_ROW = 1;
const SHORT_ROW = 2;
const AFTER_SHORT_ROW = 3;
const FIRST_SWITCH_ROW = 4;
const OVERTAKEN_ROW = 6;
const LAST_PRESSED_ROW = 8;
const AFTER_AUTO_ROW = 10;
const CPU_SLOWDOWN = 4;
// About twice the fixture songs' own byte rate: they play without stalling, and a switch still waits
// for its audio long enough that the next press lands during it.
const PLAYBACK_BYTES_PER_SECOND = 8 * 1024;
const PREPARED_PRESS_BUDGET = defineTimingBudget({
  metricId: 'playback-start.preparedNextClickToSoundUnderCpuLoadMs',
  targetMaximum: 1000,
  graceMs: 300,
});

async function openAlbum({ galleryActions, navigationPanelActions, page, trackModalActions }, origin = '') {
  await page.goto(`${origin}/?surface=albums`);
  await forgetKeptStreamingTracks(page);
  await galleryActions.waitForGalleryReady();
  await navigationPanelActions.selectSidebarArtistByName(ARTIST);
  await navigationPanelActions.waitForSidebarSelection(ARTIST);
  await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
  await trackModalActions.waitForInteractiveSummary();
}

async function playUntilHeard({ playbackEvidence, trackModalActions }, rowIndex) {
  const mark = await playbackEvidence.playbackMark();
  const track = await trackModalActions.playTrackAt(rowIndex);
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  return track;
}

test('FTC-PLAYER-028 A press on the next track of the playing album starts it as soon as the server confirms the press', { tag: '@area:playback' }, async ({
  galleryActions,
  globalPlayerActions,
  navigationPanelActions,
  page,
  playbackEvidence,
  stepLogger,
  trackModalActions,
}) => {
  await openAlbum({ galleryActions, navigationPanelActions, page, trackModalActions });
  const next = await trackModalActions.readTrackAt(NEXT_ROW);
  await stepLogger.step('Play a song until the album has prepared the next one', async () => {
    await playUntilHeard({ playbackEvidence, trackModalActions }, LONG_ROW);
    const { generation, sampleRate } = await readGaplessPlaybackDiagnostics(page);
    await globalPlayerActions.waitForStreamingContinuity(next.path, { generation });
    await expect.poll(async () => (await readGaplessPlaybackDiagnostics(page)).bufferedFrames.continuity, {
      timeout: 30000,
    }).toBeGreaterThanOrEqual(sampleRate);
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  let observer = null;
  try {
    await stepLogger.step('Press that next song on a busy CPU', async () => {
      const before = await readGaplessPlaybackDiagnostics(page);
      observer = await observeSwitchPresentation(page, globalPlayerActions.globalPlayer.titleSelector);
      const eventMark = playbackEvidence.eventMark();
      const attempt = await measureAlbumTrackPlaybackStart({
        page, trackModalActions, traffic: playbackEvidence, rowIndex: NEXT_ROW, label: 'prepared next',
      });
      const after = await readGaplessPlaybackDiagnostics(page);
      const samples = await observer.finish();
      const events = playbackEvidence.eventsSince(eventMark);
      const prior = playbackEvidence.eventsSince(0).slice(0, eventMark);

      expect(attempt.track.path).toBe(next.path);
      expect(attempt.diagnostics.paused).toBe(false);
      expect(attempt.playbackEvidence.renderedFrameDelta).toBeGreaterThan(0);
      const promoted = findPromotedPreparedReplacement(prior, events, next.path);
      expect(promoted, 'the prepared song sounds only after the server confirmed the press').toBeTruthy();
      expect(after.currentStreamId).toBe(promoted.open.streamId);
      expect(
        events.filter((event) => event.direction === 'sent' && event.type === 'open' && event.path === next.path),
        'the prepared song is not downloaded again',
      ).toEqual([]);
      assertSwitchKeepsSongSounding(expect, { before, after, pressed: next, samples });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 1 });
      stepLogger.note(`prepared next: ${Math.round(attempt.elapsedMs)} ms`, 1);
      expectTimingBudget(expect, attempt.elapsedMs, PREPARED_PRESS_BUDGET, 'Prepared next click to sound');
    });
  } finally {
    await observer?.finish();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    await globalPlayerActions.pauseIfPlaying();
  }
});

test('FTC-PLAYER-029 The playing song keeps sounding through a press until the pressed song starts', { tag: '@area:playback' }, async ({
  galleryActions,
  globalPlayerActions,
  navigationPanelActions,
  page,
  playbackEvidence,
  stepLogger,
  trackModalActions,
}, testInfo) => {
  // Three switches and one song played to its end, through a slow connection.
  test.setTimeout(4 * 60 * 1000);
  const appPort = Number(new URL(testInfo.project.use.baseURL).port);
  const relay = await startNetworkRelay(appPort, { playbackBytesPerSecond: PLAYBACK_BYTES_PER_SECOND });
  let observer = null;
  const switchTo = async (...rows) => {
    const before = await readGaplessPlaybackDiagnostics(page);
    observer = await observeSwitchPresentation(page, globalPlayerActions.globalPlayer.titleSelector);
    const mark = await playbackEvidence.playbackMark();
    const presses = [];
    for (const row of rows) presses.push(await trackModalActions.playTrackAt(row));
    const pressed = presses.at(-1);
    await globalPlayerActions.waitForCurrentTrack({ path: pressed.path, trackTitle: pressed.title });
    await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: pressed.path });
    const after = await readGaplessPlaybackDiagnostics(page);
    const samples = await observer.finish();
    assertSwitchKeepsSongSounding(expect, { before, after, pressed, samples });
    return { presses, samples };
  };

  try {
    await openAlbum({ galleryActions, navigationPanelActions, page, trackModalActions }, relay.origin);

    await stepLogger.step('Press another song right after one started', async () => {
      await playUntilHeard({ playbackEvidence, trackModalActions }, LONG_ROW);
      await switchTo(FIRST_SWITCH_ROW);
    });

    await stepLogger.step('Press a third song while a switch still waits', async () => {
      const { presses, samples } = await switchTo(OVERTAKEN_ROW, LAST_PRESSED_ROW);
      const [overtaken, last] = presses.map(({ path }) => path);
      const waited = samples.findIndex((sample) => sample.switchingTo === overtaken);
      expect(waited, 'the first switch must still have waited at the second press').toBeGreaterThanOrEqual(0);
      expect(samples.findIndex((sample) => sample.switchingTo === last)).toBeGreaterThan(waited);
    });

    await stepLogger.step('Press a song just after the album moved on by itself', async () => {
      await playUntilHeard({ playbackEvidence, trackModalActions }, SHORT_ROW);
      const following = await trackModalActions.readTrackAt(AFTER_SHORT_ROW);
      await globalPlayerActions.waitForCurrentTrack({ path: following.path, trackTitle: following.title });
      await switchTo(AFTER_AUTO_ROW);
    });
  } finally {
    await observer?.finish();
    await globalPlayerActions.pauseIfPlaying();
    relay.close();
  }
});
