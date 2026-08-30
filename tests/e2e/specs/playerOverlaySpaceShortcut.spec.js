import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-014';
const PLAYBACK_TARGET = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
const TRACK_TITLE = 'Fake Loop Source';
const PLAYER_TITLE = 'Album Haven Last.fm Fixture - Fake Loop Source /';

function expectedPlayback(paused) {
  return {
    title: PLAYER_TITLE,
    playbackControl: paused ? 'Play' : 'Pause',
    paused,
  };
}

test(`${CASE_ID} Space controls background playback across Album Details, notifications, and Settings`, async ({
  coverLookupActions,
  galleryActions,
  globalPlayerActions,
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
    const playbackMark = await playbackEvidence.playbackMark();
    const track = await trackModalActions.playTrackAt(0);
    playbackPath = track.path;
    expect(track.title).toBe(TRACK_TITLE);
    await globalPlayerActions.waitForCurrentTrack({
      path: track.path,
      trackTitle: TRACK_TITLE,
      visibleTitle: PLAYER_TITLE,
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

  await stepLogger.step('Let full cover occlude the player lane while Space remains global playback', async () => {
    await trackModalActions.openCoverLightbox();
    await trackModalActions.expectFullCoverAbovePlayer();
    await trackModalActions.pressSpaceOnFocusedLightboxClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await trackModalActions.closeCoverLightbox();
    const playbackMark = await playbackEvidence.playbackMark();
    expect(await globalPlayerActions.togglePlaybackWithSpace({ paused: false }))
      .toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Keep the player foregrounded and intercept Album Details close-control Space', async () => {
    await globalPlayerActions.expectForegroundPlayerAndToggle('albumDetails', { paused: true });
    await globalPlayerActions.waitForPlaybackState({ paused: true });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    const playbackMark = await playbackEvidence.playbackMark();
    await trackModalActions.pressSpaceOnFocusedCloseControl({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).nonZeroSamples).toBeGreaterThan(0);
    await trackModalActions.close();
  });

  await stepLogger.step('Intercept the focused Notifications opener before native activation', async () => {
    await coverLookupActions.pressSpaceOnFocusedDrawerOpener({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
  });

  await stepLogger.step('Keep the player foregrounded and intercept Notifications close-control Space', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    await globalPlayerActions.expectForegroundPlayerAndToggle('notifications', { paused: false });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).renderedFrameDelta).toBeGreaterThan(0);
    await coverLookupActions.pressSpaceOnFocusedDrawerClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Intercept the focused Settings opener before native activation', async () => {
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

  await stepLogger.step('Keep the player foregrounded and intercept Settings close-control Space', async () => {
    await globalPlayerActions.expectForegroundPlayerAndToggle('settings', { paused: true });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(true));
    const playbackMark = await playbackEvidence.playbackMark();
    await settingsModalAppBarActions.pressSpaceOnFocusedSettingsClose({
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual(expectedPlayback(false));
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playbackPath,
    })).renderedFrameDelta).toBeGreaterThan(0);
    await settingsModalAppBarActions.closeSettings();
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
