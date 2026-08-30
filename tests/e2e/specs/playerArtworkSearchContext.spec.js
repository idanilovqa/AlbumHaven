import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-015';
const PLAYING_ALBUM = 'Featured Signal Collection';
const PLAYING_ALBUM_ARTIST = 'Various Artists';
const PLAYING_TRACK_ARTIST = 'Solo Voice';
const UNRELATED_ARTIST = 'Album Haven Last.fm Fixture';
const UNRELATED_ALBUM = 'Signed Scrobble Journey';

test(`${CASE_ID} player artwork reopens the playing album after selecting an unrelated search result`, async ({
  galleryActions,
  globalPlayerActions,
  navigationPanelActions,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  let playedTrack;
  let reloadPlaybackMark;

  await stepLogger.step('Start playback from the generated Various Artists fixture', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(PLAYING_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(PLAYING_ALBUM);
    await galleryActions.waitForAlbumVisible(PLAYING_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(PLAYING_ALBUM);
    expect((await trackModalActions.waitForLoadedSummary()).title)
      .toContain(`${PLAYING_ALBUM_ARTIST} - ${PLAYING_ALBUM}`);
    const playbackMark = await playbackEvidence.playbackMark();
    playedTrack = await trackModalActions.playTrackAt(0);
    expect(playedTrack.artist).toBe(PLAYING_TRACK_ARTIST);
    await globalPlayerActions.waitForCurrentTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await trackModalActions.close();
  });

  await stepLogger.step('Reload and restore the same playing track before changing search context', async () => {
    reloadPlaybackMark = await playbackEvidence.playbackMark();
    const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    });
    expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
    expect(restoredPlayback.paused).toBe(false);
    expect(restoredPlayback.initialRestore.path).toBe(playedTrack.path);
    expect(restoredPlayback.initialRestore.generation).toBeGreaterThan(0);
    expect(restoredPlayback.initialRestore.streamId).toBeGreaterThan(0);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Search for and select an unrelated artist while playback continues', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    await searchToolbarActions.search(UNRELATED_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(UNRELATED_ARTIST);
    await navigationPanelActions.selectSidebarArtistByName(UNRELATED_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(UNRELATED_ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(UNRELATED_ARTIST, UNRELATED_ALBUM, {
      expectedQuery: UNRELATED_ARTIST,
    });
    await galleryActions.waitForAlbumHidden(PLAYING_ALBUM);
    await globalPlayerActions.waitForCurrentTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Open player artwork and recover the original playing album and track', async () => {
    await globalPlayerActions.openCurrentAlbumFromCover();
    const reopened = await trackModalActions.waitForLoadedSummary();
    expect(reopened.title).toContain(`${PLAYING_ALBUM_ARTIST} - ${PLAYING_ALBUM}`);
    expect((await trackModalActions.readTrackAt(0)).path).toBe(playedTrack.path);
  });
});
