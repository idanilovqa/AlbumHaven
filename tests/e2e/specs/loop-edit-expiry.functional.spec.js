import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-017 / FTC-UTIL-LOOPS-024';
const LOOP_ALBUM_TARGET = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
const SAVED_LOOP_NAME = 'Expiry Lease Loop';

function visiblePlayerTitle(trackTitle) {
  return `${LOOP_ALBUM_TARGET.artist} - ${trackTitle} /`;
}

test(`${CASE_ID} loop creation expires through the shared production session controller`, { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  let selectedTrack;

  await stepLogger.step('Create one saved loop through the production bottom player', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET))
      .toEqual(LOOP_ALBUM_TARGET);
    const playbackMark = await playbackEvidence.playbackMark();
    selectedTrack = await trackModalActions.playTrackAt(0);
    expect(selectedTrack.title).not.toBe('');
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: selectedTrack.title,
      visibleTitle: visiblePlayerTitle(selectedTrack.title),
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await trackModalActions.close();
    await globalPlayerActions.openLoopEditor();
    await globalPlayerActions.moveAwayFromLoopAction();
    await globalPlayerActions.dragLoopBoundary('end', 0.03);
    expect((await globalPlayerActions.saveLoopWithName(SAVED_LOOP_NAME)).requestCount).toBe(1);
  });

  await stepLogger.step('Open the real saved-loop player and install the scoped expiry clock', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(selectedTrack.title);
    await utilityLoopsActions.playLoopByName(SAVED_LOOP_NAME);
    await utilityLoopsActions.enableRepeatByName(SAVED_LOOP_NAME);
    await globalPlayerActions.resumeIfPaused();
    await globalPlayerActions.installLoopEditExpiryClock();
  });

  await stepLogger.step('Keep an untouched whole range through one cycle and expire 15 seconds into the second', async () => {
    const untouchedEditor = await utilityLoopsActions.revealCreateAnotherLoopEditorByName(SAVED_LOOP_NAME);
    await utilityLoopsActions.waitForRepeatCycle(untouchedEditor.loopId);
    await globalPlayerActions.advanceLoopEditExpiryClock(13000);
    expect((await utilityLoopsActions.expectCreateAnotherLoopEditorActiveByName(SAVED_LOOP_NAME)).paused)
      .toBe(false);
    await globalPlayerActions.advanceLoopEditExpiryClock(2000);
    expect((await utilityLoopsActions.waitForAutomaticLoopEditorExpiryByName(SAVED_LOOP_NAME)).paused)
      .toBe(true);
  });

  await stepLogger.step('Renew the bottom-player lease once, then expire and stop playback', async () => {
    await settingsModalAppBarActions.closeSettings();
    await globalPlayerActions.resumeIfPaused();
    await globalPlayerActions.openLoopEditor();
    await globalPlayerActions.moveAwayFromLoopAction();
    await globalPlayerActions.dragLoopBoundary('end', 0.8);
    await globalPlayerActions.advanceLoopEditExpiryClock(299000);
    await globalPlayerActions.expectLoopEditorActive();
    await globalPlayerActions.dragLoopBoundary('end', 0.75);
    await globalPlayerActions.advanceLoopEditExpiryClock(299000);
    await globalPlayerActions.expectLoopEditorActive();
    await globalPlayerActions.resumeIfPaused();
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(false);
    await globalPlayerActions.advanceLoopEditExpiryClock(1000);
    expect((await globalPlayerActions.waitForAutomaticLoopEditorExpiry()).paused).toBe(true);
  });

  await stepLogger.step('Remove the fixture-owned saved loop before the next independently schedulable case', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(selectedTrack.title);
    await utilityLoopsActions.openDeleteConfirmationByName(SAVED_LOOP_NAME);
    expect((await utilityLoopsActions.confirmDeleteByName(SAVED_LOOP_NAME)).requestCount).toBe(1);
  });
});

test(`${CASE_ID} page reload exits bottom-player loop edit mode`, { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  stepLogger,
  trackModalActions,
}) => {
  let selectedTrack;

  await stepLogger.step('Enter loop edit mode on a playing production track', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET))
      .toEqual(LOOP_ALBUM_TARGET);
    selectedTrack = await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: selectedTrack.title,
      visibleTitle: visiblePlayerTitle(selectedTrack.title),
    });
    await trackModalActions.close();
    await globalPlayerActions.openLoopEditor();
  });

  await stepLogger.step('Reload with the track restored but the loop editor closed', async () => {
    const reloadPlaybackMark = await playbackEvidence.playbackMark();
    const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: selectedTrack.path,
      trackTitle: selectedTrack.title,
      visibleTitle: visiblePlayerTitle(selectedTrack.title),
    });
    expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
    expect(restoredPlayback.paused).toBe(false);
    expect(restoredPlayback.initialRestore.path).toBe(selectedTrack.path);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
      path: selectedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    expect((await globalPlayerActions.expectLoopEditorInactive()).paused).toBe(false);
  });
});

test(`${CASE_ID} returning to a suspended tab reconciles an overdue loop edit lease`, { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Enter loop edit mode with the scoped clock installed', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET))
      .toEqual(LOOP_ALBUM_TARGET);
    const selectedTrack = await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: selectedTrack.title,
      visibleTitle: visiblePlayerTitle(selectedTrack.title),
    });
    await trackModalActions.close();
    await globalPlayerActions.installLoopEditExpiryClock();
    await globalPlayerActions.openLoopEditor();
    await globalPlayerActions.moveAwayFromLoopAction();
    await globalPlayerActions.dragLoopBoundary('end', 0.8);
  });

  await stepLogger.step('Let five wall-clock minutes pass without timer delivery, then reactivate the app', async () => {
    await globalPlayerActions.elapseLoopEditExpiryClockWithoutTimers(300000);
    await globalPlayerActions.expectLoopEditorActive();
    await globalPlayerActions.reactivateAfterBackgrounding();
    expect((await globalPlayerActions.waitForAutomaticLoopEditorExpiry()).paused).toBe(true);
  });
});
