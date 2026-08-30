import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-015';
const PLAYING_ALBUM = 'Length And Repetition';
const PLAYING_TRACK_ARTIST = 'Playback Start Signals';

test(`${CASE_ID} allowed Chrome policy automatically continues playback after reload`, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  let playedTrack;
  let savedOffset;

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
    savedOffset = (await globalPlayerActions.waitForFullTrackTiming()).currentTime;
    expect(savedOffset).toBeGreaterThanOrEqual(2);
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
    await globalPlayerActions.waitForPlaybackState({
      paused: false,
      minimumCurrentTime: restored.initialRestore.currentTime + 0.01,
    });
  });
});
