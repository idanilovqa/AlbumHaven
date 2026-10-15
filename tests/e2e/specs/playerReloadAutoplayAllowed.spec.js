import { expect, test } from '../support/baseFixtures.js';
import {
  PLAYBACK_START_TIMING_BUDGET,
  assertSustainedPlaybackContract,
  measureSustainedPlaybackWindow,
} from '../helpers/index.js';

const CASE_ID = 'FTC-PLAYER-015';
const PLAYING_ALBUM = 'Length And Repetition';
const PLAYING_TRACK_ARTIST = 'Playback Start Signals';
const SUSTAINED_PLAYBACK_SECONDS = 12;
const LONG_SUSTAINED_PLAYBACK_SECONDS = 60;

test(`${CASE_ID} allowed Chrome policy automatically continues playback after reload`, { tag: '@area:playback' }, async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  let playedTrack;

  await stepLogger.step('Start real playback from the generated featured collection', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(PLAYING_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(PLAYING_ALBUM);
    await galleryActions.waitForAlbumVisible(PLAYING_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(PLAYING_ALBUM);
    const playbackMark = await playbackEvidence.playbackMark();
    playedTrack = await trackModalActions.playTrackAt(0);
    expect(playedTrack.artist).toBe(PLAYING_TRACK_ARTIST);
    await globalPlayerActions.waitForCurrentTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 2 });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    const sustained = await measureSustainedPlaybackWindow(page, playbackEvidence, {
      seconds: SUSTAINED_PLAYBACK_SECONDS,
    });
    assertSustainedPlaybackContract(expect, sustained);
    await trackModalActions.close();
  });

  await stepLogger.step('Reload and automatically continue at the restored offset', async () => {
    const reloadMark = await playbackEvidence.playbackMark();
    const restored = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    }, { requireAutoplay: true });

    expect(restored.reloadOutcome).toBe('autoplay');
    expect(restored.paused).toBe(false);
    expect(restored.initialRestore.path).toBe(playedTrack.path);
    expect(restored.initialRestore.contextState).toBe('running');
    expect(restored.initialRestore.generation).toBeGreaterThan(0);
    expect(restored.initialRestore.streamId).toBeGreaterThan(0);
    expect(Math.abs(
      restored.initialRestore.currentTime - restored.preReload.currentTime,
    )).toBeLessThan(1);

    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: { ...reloadMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    const sustained = await measureSustainedPlaybackWindow(page, playbackEvidence, {
      seconds: SUSTAINED_PLAYBACK_SECONDS,
    });
    assertSustainedPlaybackContract(expect, sustained);
  });

  await stepLogger.step('Reload a paused snapshot and sustain playback after explicit Play', async () => {
    await globalPlayerActions.pauseIfPlaying();
    const pausedOffset = (await globalPlayerActions.waitForFullTrackTiming()).currentTime;
    const pausedRestore = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    }, { paused: true });

    expect(pausedRestore.paused).toBe(true);
    expect(pausedRestore.playbackControl).toBe('Play');
    const restoredTiming = await globalPlayerActions.waitForFullTrackTiming();
    expect(Math.abs(restoredTiming.currentTime - pausedOffset)).toBeLessThan(1);

    const explicitPlayMark = await playbackEvidence.playbackMark();
    const explicitPlayStartedAtMs = await page.evaluate(() => performance.now());
    await globalPlayerActions.resumeIfPaused();
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: explicitPlayMark,
      path: playedTrack.path,
    });
    const explicitPlayStartupMs = evidence.observedAtMs - explicitPlayStartedAtMs;
    expect(
      explicitPlayStartupMs,
      `Explicit Play took ${Math.round(explicitPlayStartupMs)} ms to render audible PCM.`,
    ).toBeLessThanOrEqual(PLAYBACK_START_TIMING_BUDGET.hardCeiling);
    const sustained = await measureSustainedPlaybackWindow(page, playbackEvidence, {
      seconds: LONG_SUSTAINED_PLAYBACK_SECONDS,
      timeout: (LONG_SUSTAINED_PLAYBACK_SECONDS * 1_000) + 10_000,
    });
    assertSustainedPlaybackContract(expect, sustained);
  });
});
