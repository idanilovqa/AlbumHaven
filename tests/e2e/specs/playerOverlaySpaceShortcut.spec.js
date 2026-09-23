import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-014';
const PLAYBACK_TARGET = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
let playerTitle = '';

function expectedPlayback(paused) {
  return {
    title: playerTitle,
    playbackControl: paused ? 'Play' : 'Pause',
    paused,
  };
}

test(`${CASE_ID} Space preserves native overlay actions and range playback across Album Details, notifications, and Settings`, { tag: '@area:playback' }, async ({
  coverLookupActions,
  galleryActions,
  globalPlayerActions,
  appBarActions,
  playbackEvidence,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
}) => {
  let playbackPath = '';
  await stepLogger.step('Start generated-media playback with Album Details left open', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PLAYBACK_TARGET)).toEqual(PLAYBACK_TARGET);
    const albumDetailsStack = await trackModalActions.trackModal
      .readStackingCheckpoint(appBarActions.appBar);
    expect(albumDetailsStack).toMatchObject({ appBarCoveredByAlbumDetails: true });
    expect(albumDetailsStack.modalZIndex).toBeGreaterThan(albumDetailsStack.appBarZIndex);
    const playbackMark = await playbackEvidence.playbackMark();
    const track = await trackModalActions.playTrackAt(0);
    playbackPath = track.path;
    expect(track.title).not.toBe('');
    playerTitle = `${PLAYBACK_TARGET.artist} - ${track.title} /`;
    await globalPlayerActions.waitForCurrentTrack({
      path: track.path,
      trackTitle: track.title,
      visibleTitle: playerTitle,
    });
    await globalPlayerActions.expectVisiblePlayer();
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0 });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  });

  // Task 4 explicitly preserves native button activation; range Space remains a playback shortcut.
  // Keep real PCM evidence so the shortcut cannot pass on a label-only state change.
  async function resumeWithRangeSpace() {
    const playbackMark = await playbackEvidence.playbackMark();
    expect(await globalPlayerActions.togglePlaybackWithSpace({ paused: false }))
      .toEqual(expectedPlayback(false));
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  }

  await stepLogger.step('Let full cover occlude the player while its native Space close preserves playback', async () => {
    await trackModalActions.openCoverLightbox();
    await trackModalActions.expectFullCoverAbovePlayer();
    const playbackMark = await playbackEvidence.playbackMark();
    await trackModalActions.pressSpaceOnFocusedLightboxClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Keep the player foregrounded and close Album Details with native Space without resuming', async () => {
    await globalPlayerActions.expectForegroundPlayerAndToggle('albumDetails', { paused: true });
    await globalPlayerActions.waitForPlaybackState({ paused: true });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await trackModalActions.pressSpaceOnFocusedCloseControl({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await resumeWithRangeSpace();
  });

  await stepLogger.step('Activate the focused Notifications opener with Space without pausing playback', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    await coverLookupActions.pressSpaceOnFocusedDrawerOpener({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).nonZeroSamples).toBeGreaterThan(0);
  });

  await stepLogger.step('Keep the player foregrounded and close Notifications with Space without resuming', async () => {
    await globalPlayerActions.expectForegroundPlayerAndToggle('notifications', { paused: true });
    await globalPlayerActions.waitForPlaybackState({ paused: true });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await coverLookupActions.pressSpaceOnFocusedDrawerClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await resumeWithRangeSpace();
  });

  await stepLogger.step('Open the account menu and Settings with native Space without pausing playback', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    await settingsModalAppBarActions.pressSpaceOnFocusedSettingsOpener({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).nonZeroSamples).toBeGreaterThan(0);
  });

  await stepLogger.step('Keep the player foregrounded and close Settings with Space without resuming', async () => {
    await globalPlayerActions.expectForegroundPlayerAndToggle('settings', { paused: true });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await settingsModalAppBarActions.pressSpaceOnFocusedSettingsClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await resumeWithRangeSpace();
  });

  await stepLogger.step('Preserve literal Space in editable search text', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    await searchToolbarActions.enterLiteralSpace();
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    await searchToolbarActions.clearSearch();
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).nonZeroSamples).toBeGreaterThan(0);
  });
});
