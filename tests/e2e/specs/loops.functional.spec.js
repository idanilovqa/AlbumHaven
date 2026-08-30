import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-UTIL-LOOPS-021 / FTC-UTIL-LOOPS-023 / FTC-UTIL-LOOPS-024 / FTC-UTIL-LOOPS-026 / FTC-PLAYER-017 / FTC-PLAYER-011';
const LOOP_ALBUM_TARGET = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
const LOOP_TRACK_TITLE = 'Fake Loop Source';
const LOOP_PLAYER_TITLE = 'Album Haven Last.fm Fixture - Fake Loop Source /';
const MEDIA_DURATION_TOLERANCE_SECONDS = 0.15;
const HANDLE_POSITION_TOLERANCE_SECONDS = 0.25;

test(`${CASE_ID} fake-data bottom-player loop save and Utility Loops playback stay grouped under one track`, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  let nestedLoopDurationSeconds = 0;
  let fullTrackDurationSeconds = 0;
  let warmupLoopId = '';
  let warmupAudioHandle = null;
  let warmupIdleAction = null;
  let playingPlayerLayout = null;
  let selectedTrack;

  await stepLogger.step('Open the fake-data gallery and wait for the initial view to settle', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
  });

  await stepLogger.step('Prove the no-track scissors is natively disabled without a busy cursor or callback', async () => {
    const unavailable = await globalPlayerActions.expectUnavailableLoopAction();
    expect(unavailable.requestCount).toBe(0);
    expect(unavailable.visual.styles.state).toBe('disabled');
    expect(unavailable.visual.styles.enterDisabled).toBe(true);
    expect(unavailable.visual.styles.enterTitle).toBe('Start playing the track to edit the loop');
    expect(unavailable.visual.styles.enter.cursor).toBe('not-allowed');
    expect(unavailable.visual.coverCenterY).not.toBeNull();
    expect(Math.abs(unavailable.visual.coverCenterY - unavailable.visual.playCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(unavailable.visual.playCenterY - unavailable.visual.timelineCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(unavailable.visual.mainLeftGapFromPlay - 8)).toBeLessThanOrEqual(1);
    const hovered = await globalPlayerActions.hoverLoopAction();
    expect(hovered.styles.state).toBe('disabled');
    expect(hovered.podBounds).toEqual(unavailable.visual.podBounds);
  });

  await stepLogger.step('Select the exact signed journey album and start its fake loop source track', async () => {
    const selectedAlbum = await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
    expect(selectedAlbum).toEqual(LOOP_ALBUM_TARGET);
    const modal = await trackModalActions.waitForLoadedSummary();
    expect(modal.title).toBe('Album Haven Last.fm Fixture - Signed Scrobble Journey - 2026');
    const playbackMark = await playbackEvidence.playbackMark();
    selectedTrack = await trackModalActions.playTrackAt(0);
    expect(selectedTrack.title).toBe(LOOP_TRACK_TITLE);
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0 });
    const playback = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(playback).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await trackModalActions.close();
  });

  await stepLogger.step('Select the owner-approved waveform seekbar through Appearance and return to the gallery', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.selectSeekbarMode('waveform');
    await settingsModalAppBarActions.closeSettings();
    playingPlayerLayout = await globalPlayerActions.readLoopActionVisualState();
    expect(playingPlayerLayout.coverCenterY).not.toBeNull();
    expect(Math.abs(playingPlayerLayout.coverCenterY - playingPlayerLayout.playCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(playingPlayerLayout.playCenterY - playingPlayerLayout.timelineCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(playingPlayerLayout.mainLeftGapFromPlay - 8)).toBeLessThanOrEqual(1);
    expect(playingPlayerLayout.playerBounds.height).toBe(85);
    expect(playingPlayerLayout.titleTopGap).toBeGreaterThanOrEqual(6);
  });

  await stepLogger.step('Pause and resume the same bottom-player track with the app-body Space shortcut', async () => {
    const paused = await globalPlayerActions.togglePlaybackWithSpace({ paused: true });
    expect(paused).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Play',
      paused: true,
    });
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    const pausedAt = await globalPlayerActions.readDisplayedCurrentTimeSeconds();

    const playbackMark = await playbackEvidence.playbackMark();
    const resumed = await globalPlayerActions.togglePlaybackWithSpace({ paused: false });
    expect(resumed).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    expect(await globalPlayerActions.waitForDisplayedPlaybackAdvance(pausedAt)).toBeGreaterThan(pausedAt);
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    })).renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Reload with the full track duration and keep loop editing inactive', async () => {
    const beforeReload = await globalPlayerActions.waitForFullTrackTiming();
    fullTrackDurationSeconds = beforeReload.duration;
    expect(fullTrackDurationSeconds).toBeGreaterThan(0);

    const reloadPlaybackMark = await playbackEvidence.playbackMark();
    const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
    });
    expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
    expect(restoredPlayback.paused).toBe(false);
    expect(restoredPlayback.initialRestore.path).toBe(selectedTrack.path);
    const playbackEvidenceAfterReload = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
      path: selectedTrack.path,
    });
    expect(playbackEvidenceAfterReload.nonZeroSamples).toBeGreaterThan(0);
    expect(playbackEvidenceAfterReload.renderedFrameDelta).toBeGreaterThan(0);
    await globalPlayerActions.expectLoopEditorInactive();
    const restoredEditor = await globalPlayerActions.openLoopEditor();
    expect(restoredEditor.duration).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect(restoredEditor.startSeconds).toBe(0);
    expect(restoredEditor.endSeconds).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);

    const afterEscape = await globalPlayerActions.waitForFullTrackTiming();
    expect(afterEscape.duration).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect(afterEscape.currentTime).toBeGreaterThanOrEqual(0);
    expect(afterEscape.currentTime <= afterEscape.duration).toBe(true);
  });

  await stepLogger.step('Use the compact bottom-player scissors, shared range, cancellation, and naming workflow', async () => {
    const stereoBeforeEdit = await globalPlayerActions.waitForRenderedWaveform({ path: selectedTrack.path });
    expect(stereoBeforeEdit.leftBins).toBeGreaterThan(0);
    expect(stereoBeforeEdit.rightBins).toBe(stereoBeforeEdit.leftBins);
    expect(stereoBeforeEdit.leftPeaks).not.toEqual(stereoBeforeEdit.rightPeaks);
    await globalPlayerActions.pauseIfPlaying();
    const idle = await globalPlayerActions.moveAwayFromLoopAction();
    expect(idle.styles.state).toBe('idle');
    expect(idle.styles.engaged).toBe('false');
    expect(Math.abs(idle.coverCenterY - idle.playCenterY)).toBeLessThanOrEqual(1);
    expect(Math.abs(idle.playCenterY - idle.timelineCenterY)).toBeLessThanOrEqual(1);
    expect(Math.abs(idle.timelineCenterY - playingPlayerLayout.timelineCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(idle.mainAreaBounds.x - playingPlayerLayout.mainAreaBounds.x))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(idle.mainLeftGapFromPlay - 8)).toBeLessThanOrEqual(1);
    const idleHovered = await globalPlayerActions.hoverLoopAction();
    expect(idleHovered.styles.state).toBe('idle');
    expect(idleHovered.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(idleHovered.waveformBounds).toEqual(idle.waveformBounds);

    const opened = await globalPlayerActions.openLoopEditor();
    expect(opened.mainAreaBounds.width / opened.playerBounds.width).toBeGreaterThan(0.5);
    expect(opened.cursors.surface).toBe('default');
    expect(opened.cursors.selection).toBe('default');
    expect(opened.cursors.startHandle).toBe('grab');
    expect(opened.cursors.endHandle).toBe('grab');
    expect(opened.timeWaveformOverlap).toBe(false);
    expect(opened.metadataWaveformGap).toBeGreaterThanOrEqual(3);
    expect(opened.playerHeight).toBe(85);
    expect(opened.waveformHeight).toBe(36);
    expect(opened.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(opened.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    const keyboardDialog = await globalPlayerActions.openLoopNameDialogWithEnter();
    expect(keyboardDialog).toEqual({ visible: true, focused: true, error: '' });
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
    const createHovered = await globalPlayerActions.hoverLoopAction('create');
    expect(createHovered.styles.state).toBe('editing');
    expect(createHovered.styles.engaged).toBe('true');
    expect(createHovered.styles.divider.display).not.toBe('none');
    expect(createHovered.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(createHovered.waveformBounds).toEqual(idle.waveformBounds);
    const cancelHovered = await globalPlayerActions.hoverLoopAction('cancel');
    expect(cancelHovered.styles.cancel.color).not.toBe(createHovered.styles.cancel.color);
    const collapsed = await globalPlayerActions.moveAwayFromLoopAction();
    expect(collapsed.styles.engaged).toBe('false');
    expect(collapsed.podBounds).toEqual(idle.podBounds);
    expect(collapsed.podBounds.width).toBeLessThan(createHovered.podBounds.width);
    expect(collapsed.styles.create.color).not.toBe(createHovered.styles.create.color);
    expect(collapsed.styles.create.textShadow).not.toBe(createHovered.styles.create.textShadow);
    expect(collapsed.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(collapsed.waveformBounds).toEqual(idle.waveformBounds);
    await globalPlayerActions.pauseIfPlaying();
    const keyboardExpanded = await globalPlayerActions.focusLoopAction('create');
    expect(keyboardExpanded.styles.engaged).toBe('true');

    const waveformSeek = await globalPlayerActions.clickLoopRangeAt(0.2);
    expect(waveformSeek.after.startSeconds).toBeCloseTo(waveformSeek.before.startSeconds, 3);
    expect(waveformSeek.after.endSeconds).toBeCloseTo(waveformSeek.before.endSeconds, 3);
    expect(waveformSeek.timing.currentTime).toBeCloseTo(waveformSeek.targetSeconds, 0);

    await globalPlayerActions.dragLoopBoundary('end', 0.45);
    const outsideSelectionSeek = await globalPlayerActions.clickLoopRangeAt(0.8);
    expect(outsideSelectionSeek.after.startSeconds)
      .toBeCloseTo(outsideSelectionSeek.before.startSeconds, 3);
    expect(outsideSelectionSeek.after.endSeconds)
      .toBeCloseTo(outsideSelectionSeek.before.endSeconds, 3);
    expect(outsideSelectionSeek.timing.currentTime)
      .toBeCloseTo(outsideSelectionSeek.targetSeconds, 0);
    const emptySpaceDrag = await globalPlayerActions.dragLoopRangeFromTo(0.7, 0.65);
    expect(emptySpaceDrag.after.startHandleFraction).toBeCloseTo(0, 1);
    expect(emptySpaceDrag.after.endHandleFraction).toBeCloseTo(0.65, 1);
    const startCrossedRight = await globalPlayerActions.dragLoopBoundary('start', 0.85);
    expect(startCrossedRight.startValueNow).toBeLessThan(startCrossedRight.endValueNow);
    expect(startCrossedRight.startSeconds).toBeLessThan(startCrossedRight.endSeconds);
    expect(startCrossedRight.startHandleFraction).toBeLessThan(startCrossedRight.endHandleFraction);
    expect(startCrossedRight.dragSnapshot.cursors.startHandle).toBe('grabbing');
    expect(startCrossedRight.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.startHandleFraction, 3);
    expect(startCrossedRight.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.endHandleFraction, 3);
    expect(startCrossedRight.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    const endCrossedLeft = await globalPlayerActions.dragLoopBoundary('end', 0.1);
    expect(endCrossedLeft.startValueNow).toBeLessThan(endCrossedLeft.endValueNow);
    expect(endCrossedLeft.startSeconds).toBeLessThan(endCrossedLeft.endSeconds);
    expect(endCrossedLeft.startHandleFraction).toBeLessThan(endCrossedLeft.endHandleFraction);
    expect(endCrossedLeft.dragSnapshot.cursors.endHandle).toBe('grabbing');
    expect(endCrossedLeft.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.startHandleFraction, 3);
    expect(endCrossedLeft.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.endHandleFraction, 3);
    expect(endCrossedLeft.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.selectionEndErrorPixels).toBeLessThanOrEqual(1);

    expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    await globalPlayerActions.openLoopEditor();
    expect((await globalPlayerActions.disableStreamingLoop({ waitForStreaming: false })).requestCount)
      .toBe(0);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const selectedRange = await globalPlayerActions.openLoopEditor();
    const mainVisual = await globalPlayerActions.readMainLoopVisualState();
    expect(mainVisual.canvas.upperPixels).toBeGreaterThan(0);
    expect(mainVisual.canvas.lowerPixels).toBeGreaterThan(0);
    expect(mainVisual.timeline.visible).toBe(true);
    expect(mainVisual.timeline.opacity).toBeGreaterThanOrEqual(0.4);
    expect(Math.abs(mainVisual.selectionTopOvershoot - mainVisual.selectionBottomOvershoot))
      .toBeLessThanOrEqual(1);
    expect(selectedRange.legacyBoundaryTimeCount).toBe(0);
    expect(selectedRange.timeSlotCount).toBe(1);
    const dialog = await globalPlayerActions.openLoopNameDialog();
    expect(dialog).toEqual({ visible: true, focused: true, error: '' });
    expect(await globalPlayerActions.submitBlankLoopName()).not.toBe('');
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    const cancelledSummary = await utilityLoopsActions.readSummary();
    expect(cancelledSummary.groupCount).toBe(0);
    expect(cancelledSummary.entryCount).toBe(0);
    expect(cancelledSummary.emptyState).toContain('Create a loop from the bottom player');
    await settingsModalAppBarActions.closeSettings();

    const save = await globalPlayerActions.saveLoopWithName('Warmup Loop', { submitWithEnter: true });
    expect(save.requestCount).toBe(1);
    await globalPlayerActions.pauseIfPlaying();
  });

  await stepLogger.step('Open Utility Loops and confirm the first loop plays back', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 0,
      childLoopCount: 0,
    });
    await utilityLoopsActions.expandGroupByTitle(LOOP_TRACK_TITLE);
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 1,
      childLoopCount: 1,
    });
    await settingsModalAppBarActions.closeSettings();
    await settingsModalAppBarActions.openSettings();
    await utilityLoopsActions.waitForReady();
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 0,
      childLoopCount: 0,
    });
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const detail = await utilityLoopsActions.readDetailSummary();
    expect(detail.title).toBe(LOOP_TRACK_TITLE);
    expect(detail.entryCount).toBe(1);
    expect(detail.meta.some((value) => value.includes('1 saved loop'))).toBe(true);
    const initialEditor = await utilityLoopsActions.readLoopEditorStateByName('Warmup Loop');
    expect(initialEditor.visibility).toEqual({
      editor: false,
      waveform: false,
      timeSlot: true,
      startHandle: false,
      endHandle: false,
    });
    const compactLayout = await utilityLoopsActions.readCompactLoopLayoutByName('Warmup Loop');
    expect(compactLayout.entryBounds.height).toBeLessThan(140);
    expect(compactLayout.pitchBounds.y).toBeGreaterThanOrEqual(compactLayout.topRowBounds.y);
    expect(compactLayout.pitchBounds.y + compactLayout.pitchBounds.height)
      .toBeLessThanOrEqual(compactLayout.topRowBounds.y + compactLayout.topRowBounds.height + 1);
    expect(compactLayout.pitchText).toBe('- 0 pst +');
    expect(compactLayout.timeSlotCount).toBe(1);
    expect(compactLayout.legacyBoundaryTimeCount).toBe(0);
    expect(
      compactLayout.timelineBounds.y,
      'approved saved-loop two-row layout keeps the timeline below the timestamp row',
    )
      .toBeGreaterThanOrEqual(compactLayout.topRowBounds.y + compactLayout.topRowBounds.height);
    expect(
      compactLayout.timeBounds.y + compactLayout.timeBounds.height,
      'saved-loop timestamp row must finish before the waveform timeline begins',
    )
      .toBeLessThanOrEqual(compactLayout.timelineBounds.y);
    expect(
      compactLayout.timelineBounds.y + compactLayout.timelineBounds.height,
      'lowering the saved-loop timeline must keep it inside the compact player main area',
    )
      .toBeLessThanOrEqual(compactLayout.mainBounds.y + compactLayout.mainBounds.height + 1);
    const savedLoopTimelineCenterY = compactLayout.timelineBounds.y + (compactLayout.timelineBounds.height / 2);
    [compactLayout.playBounds, compactLayout.repeatBounds, compactLayout.speedBounds].forEach((bounds) => {
      const controlCenterY = bounds.y + (bounds.height / 2);
      expect(Math.abs(controlCenterY - savedLoopTimelineCenterY)).toBeLessThanOrEqual(1);
    });
    expect(compactLayout.firstEntryGap).toBeGreaterThanOrEqual(0);
    expect(compactLayout.firstEntryGap).toBeLessThanOrEqual(16);
    expect(compactLayout.scissorsBounds.x).toBeGreaterThan(compactLayout.playBounds.x);
    expect(compactLayout.scissorsBounds.y).toBeGreaterThan(compactLayout.playBounds.y);
    warmupIdleAction = await utilityLoopsActions.readLoopActionVisualStateByName('Warmup Loop');
    expect(warmupIdleAction.styles.state).toBe('idle');
    await utilityLoopsActions.pressSpaceBeforeLoopOwnership(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    await utilityLoopsActions.pressSpaceBeforeLoopOwnership(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    const ownedStart = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: false },
    );
    const loopId = ownedStart.loopId;
    expect(ownedStart.snapshot.paused).toBe(false);
    const ownedPause = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: true },
    );
    expect(ownedPause.snapshot.paused).toBe(true);
    const neutralResume = await utilityLoopsActions.pressNeutralSpaceForOwnedLoop(
      LOOP_TRACK_TITLE,
      loopId,
      { paused: false },
    );
    expect(neutralResume.paused).toBe(false);
    const loopSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(loopSamples.frameCount).toBeGreaterThan(0);
    expect(loopSamples.finiteSamples).toBeGreaterThan(0);
    expect(loopSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(loopSamples.peakSample).toBeGreaterThan(0);
    await utilityLoopsActions.waitForLoopProgress(loopId, {
      afterCurrentTime: neutralResume.currentTime,
      minimumDelta: 0.2,
      allowWrap: false,
    });
    await globalPlayerActions.resumeIfPaused();
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(false);
    expect((await utilityLoopsActions.readLoopPlaybackSnapshot(loopId)).paused).toBe(false);
    const playerSurfaceClick = await globalPlayerActions.clickOwnershipSurface();
    expect(playerSurfaceClick.after).toEqual(playerSurfaceClick.before);
    const loopAfterGlobalReclaim = await utilityLoopsActions.pressNeutralSpaceAfterGlobalReclaim(
      LOOP_TRACK_TITLE,
      loopId,
      { paused: false },
      { afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }) },
    );
    expect(loopAfterGlobalReclaim.paused).toBe(false);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const loopAfterFocusReclaim = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: true },
    );
    expect(loopAfterFocusReclaim.snapshot.paused).toBe(true);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const loopResumeAfterReclaim = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: false },
    );
    expect(loopResumeAfterReclaim.snapshot.paused).toBe(false);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const audioHandle = await utilityLoopsActions.captureLoopAudioHandle(loopId);
    warmupLoopId = loopId;
    warmupAudioHandle = audioHandle;
    await utilityLoopsActions.enableRepeatByName('Warmup Loop');
    const repeated = await utilityLoopsActions.waitForRepeatCycle(loopId);
    expect(repeated.paused).toBe(false);
    expect(repeated.currentTime).toBeGreaterThanOrEqual(0.2);
    const slowed = await utilityLoopsActions.setSpeedByName('Warmup Loop', 0.75);
    expect(slowed.paused).toBe(false);
    expect(slowed.playbackRate).toBeCloseTo(0.75, 2);
    const pitched = await utilityLoopsActions.stepPitchByName(
      'Warmup Loop',
      1,
      '+1 pst',
    );
    expect(pitched.progressed.paused).toBe(false);
    expect(pitched.progressed.pitch).toBe(1);
    expect(pitched.progressed.speed).toBeCloseTo(0.75, 2);
    expect(pitched.progressed.playbackRate).toBeCloseTo(0.75, 2);
    const pitchedSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(pitchedSamples.frameCount).toBeGreaterThan(0);
    expect(pitchedSamples.finiteSamples).toBeGreaterThan(0);
    expect(pitchedSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(await utilityLoopsActions.readRepeatPressedByName('Warmup Loop')).toBe(true);
    const repeatedAfterPitch = await utilityLoopsActions.waitForRepeatCycle(loopId);
    expect(repeatedAfterPitch.paused).toBe(false);
    expect(repeatedAfterPitch.currentTime).toBeGreaterThanOrEqual(0.2);
    const continuity = await utilityLoopsActions.readLoopContinuity(audioHandle, loopId);
    expect(continuity.sameNode).toBe(true);
    expect(continuity.snapshot.connected).toBe(true);
    expect(continuity.snapshot.paused).toBe(false);
  });

  await stepLogger.step('Use the inline combined waveform, crossing handles, cancellation, and nested naming workflow', async () => {
    const revealed = await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect(revealed.counts.waveform).toBe(1);
    expect(revealed.counts.startHandle).toBe(1);
    expect(revealed.counts.endHandle).toBe(1);
    expect(revealed.visibility.waveform).toBe(true);
    expect(revealed.visibility.timeSlot).toBe(true);
    expect(revealed.counts.legacyBoundaryTimes).toBe(0);
    expect(revealed.duration).toBeGreaterThan(0);
    expect(revealed.waveformPixels).toBeGreaterThan(0);
    expect(revealed.pitchVisible).toBe(false);
    expect(revealed.timestampVisible).toBe(true);
    expect(revealed.timeWaveformOverlap).toBe(false);
    expect(revealed.cursors.surfaceCursor).toBe('default');
    expect(revealed.cursors.selectionCursor).toBe('default');
    expect(revealed.cursors.startHandleCursor).toBe('grab');
    expect(revealed.cursors.endHandleCursor).toBe('grab');
    expect(revealed.playerHeight).toBeGreaterThan(revealed.waveformHeight);
    expect(revealed.waveformHeight).toBeGreaterThanOrEqual(32);
    expect(revealed.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(revealed.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(revealed.startHandleOverlapsEditControl).toBe(true);
    expect(revealed.editControlPaintsAboveStartHandle).toBe(true);
    expect((await utilityLoopsActions.escapeCreateAnotherLoopByName('Warmup Loop', {
      focusTarget: 'repeat',
    })).requestCount).toBe(0);
    const continuityAfterUntouchedEscape = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterUntouchedEscape.sameNode).toBe(true);
    expect(continuityAfterUntouchedEscape.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect((await utilityLoopsActions.readCompactLoopLayoutByName('Warmup Loop')).ordinaryTimelineVisible)
      .toBe(true);
    const savedCreateHovered = await utilityLoopsActions.hoverLoopActionByName('Warmup Loop', 'create');
    expect(savedCreateHovered.styles.state).toBe('editing');
    expect(savedCreateHovered.mainBounds).toEqual(warmupIdleAction.mainBounds);
    expect(savedCreateHovered.timelineBounds).toEqual(warmupIdleAction.timelineBounds);
    const savedCollapsed = await utilityLoopsActions.moveAwayFromLoopActionByName('Warmup Loop');
    expect(savedCollapsed.podBounds).toEqual(warmupIdleAction.podBounds);
    expect(savedCollapsed.podBounds.width).toBeLessThan(savedCreateHovered.podBounds.width);
    expect(savedCollapsed.mainBounds).toEqual(warmupIdleAction.mainBounds);
    expect(savedCollapsed.timelineBounds).toEqual(warmupIdleAction.timelineBounds);
    await utilityLoopsActions.hoverLoopActionByName('Warmup Loop', 'create');
    const savedLoopVisual = await utilityLoopsActions.readSavedLoopVisualStateByName('Warmup Loop');
    expect(savedLoopVisual.canvas.upperPixels).toBeGreaterThan(0);
    expect(savedLoopVisual.canvas.lowerPixels).toBeGreaterThan(0);
    expect(
      Math.abs(savedLoopVisual.canvas.upperPixels - savedLoopVisual.canvas.lowerPixels)
      / Math.max(savedLoopVisual.canvas.upperPixels, savedLoopVisual.canvas.lowerPixels),
    ).toBeLessThanOrEqual(0.1);
    expect(savedLoopVisual.timeline.visible).toBe(true);
    expect(savedLoopVisual.timeline.opacity).toBeGreaterThan(0);
    expect(savedLoopVisual.timeline.appearance).toBe('none');
    expect(savedLoopVisual.timeline.trackBackground).toBe('rgba(0, 0, 0, 0)');
    expect(savedLoopVisual.playhead.paintedRowRatio).toBeGreaterThanOrEqual(0.9);
    const progressedLoop = await utilityLoopsActions.waitForLoopProgress(revealed.loopId, {
      afterCurrentTime: savedLoopVisual.timeline.value,
      minimumDelta: 0.1,
    });
    const progressedVisual = await utilityLoopsActions.readSavedLoopVisualStateByName('Warmup Loop');
    expect(progressedVisual.timeline.value).toBeCloseTo(progressedLoop.currentTime, 0);

    const waveformSeek = await utilityLoopsActions.clickLoopRangeByName('Warmup Loop', 0.2);
    expect(waveformSeek.after.startSeconds).toBeCloseTo(waveformSeek.before.startSeconds, 3);
    expect(waveformSeek.after.endSeconds).toBeCloseTo(waveformSeek.before.endSeconds, 3);
    expect(waveformSeek.playback.currentTime).toBeCloseTo(waveformSeek.targetSeconds, 0);

    await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.45);
    const startCrossedRight = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'start', 0.85);
    expect(startCrossedRight.startSeconds).toBeLessThan(startCrossedRight.endSeconds);
    expect(startCrossedRight.startValueNow).toBeLessThan(startCrossedRight.endValueNow);
    expect(startCrossedRight.dragSnapshot.cursors.startHandleCursor).toBe('grabbing');
    expect(startCrossedRight.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.startHandleFraction, 3);
    expect(startCrossedRight.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.endHandleFraction, 3);
    const endCrossedLeft = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.1);
    expect(endCrossedLeft.startSeconds).toBeLessThan(endCrossedLeft.endSeconds);
    expect(endCrossedLeft.startValueNow).toBeLessThan(endCrossedLeft.endValueNow);
    expect(endCrossedLeft.dragSnapshot.cursors.endHandleCursor).toBe('grabbing');
    expect(endCrossedLeft.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.startHandleFraction, 3);
    expect(endCrossedLeft.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.endHandleFraction, 3);

    expect((await utilityLoopsActions.cancelCreateAnotherLoopByName('Warmup Loop')).requestCount).toBe(0);
    const continuityAfterRedCancel = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterRedCancel.sameNode).toBe(true);
    expect(continuityAfterRedCancel.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect((await utilityLoopsActions.escapeCreateAnotherLoopByName('Warmup Loop')).requestCount).toBe(0);
    const continuityAfterEscape = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterEscape.sameNode).toBe(true);
    expect(continuityAfterEscape.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');

    const afterStartDrag = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'start', 0.25);
    expect(afterStartDrag.startSeconds).toBeGreaterThan(0);
    expect(afterStartDrag.startSeconds).toBeLessThan(afterStartDrag.endSeconds);
    const startHandleAlignmentErrorSeconds = Math.abs(
      afterStartDrag.startSeconds
      - (afterStartDrag.startHandleFraction * afterStartDrag.duration)
    );
    expect(startHandleAlignmentErrorSeconds)
      .toBeLessThanOrEqual(HANDLE_POSITION_TOLERANCE_SECONDS);
    expect(afterStartDrag.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.selectionEndErrorPixels).toBeLessThanOrEqual(1);

    const afterEndDrag = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.75);
    expect(afterEndDrag.endSeconds).toBeGreaterThan(afterEndDrag.startSeconds);
    expect(afterEndDrag.endSeconds).toBeLessThanOrEqual(afterEndDrag.duration);
    const endHandleAlignmentErrorSeconds = Math.abs(
      afterEndDrag.endSeconds
      - (afterEndDrag.endHandleFraction * afterEndDrag.duration)
    );
    expect(endHandleAlignmentErrorSeconds)
      .toBeLessThanOrEqual(HANDLE_POSITION_TOLERANCE_SECONDS);
    expect(afterEndDrag.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    nestedLoopDurationSeconds = afterEndDrag.endSeconds - afterEndDrag.startSeconds;
    expect(nestedLoopDurationSeconds).toBeGreaterThan(0);

    await utilityLoopsActions.activateCreateAnotherLoopByName('Warmup Loop');
    expect(await globalPlayerActions.waitForLoopNameDialog()).toEqual({
      visible: true,
      focused: true,
      error: '',
    });
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
    expect((await utilityLoopsActions.readDetailSummary()).entryCount).toBe(1);
    const continuityAfterCancel = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterCancel.sameNode).toBe(true);
    expect(continuityAfterCancel.snapshot.connected).toBe(true);
    expect(continuityAfterCancel.snapshot.paused).toBe(false);

    await utilityLoopsActions.activateCreateAnotherLoopByName('Warmup Loop');
    await globalPlayerActions.waitForLoopNameDialog();
    const nestedSave = await globalPlayerActions.submitLoopName('Transition Loop');
    expect(nestedSave.requestCount).toBe(1);
    const immediateGroup = await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE);
    expect(immediateGroup.countText).toBe('2 loops');
    const immediateDetail = await utilityLoopsActions.readDetailSummary();
    expect(immediateDetail.title).toBe(LOOP_TRACK_TITLE);
    expect(immediateDetail.entryCount).toBe(2);
    expect(immediateDetail.meta.some((value) => value.includes('2 saved loops'))).toBe(true);
    const immediateWarmup = await utilityLoopsActions.resolveLoopEntryByName('Warmup Loop');
    const immediateTransition = await utilityLoopsActions.resolveLoopEntryByName('Transition Loop');
    expect(immediateWarmup.loopId).toBe(warmupLoopId);
    expect(immediateTransition.loopId).not.toBe('');
  });

  await stepLogger.step('Verify Utility Loops groups both saved loops under the same track with a loop count of two', async () => {
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const groupSummary = await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE);
    expect(groupSummary.countText).toBe('2 loops');
    const detail = await utilityLoopsActions.readDetailSummary();
    expect(detail.title).toBe(LOOP_TRACK_TITLE);
    expect(detail.entryCount).toBe(2);
    expect(detail.meta.some((value) => value.includes('2 saved loops'))).toBe(true);
    const loopId = await utilityLoopsActions.playLoopByName('Transition Loop');
    const audioHandle = await utilityLoopsActions.captureLoopAudioHandle(loopId);
    await utilityLoopsActions.waitForLoopProgress(loopId, {
      afterCurrentTime: 0,
      minimumDelta: 0.75,
      allowWrap: false,
    });
    const pitched = await utilityLoopsActions.stepPitchByName(
      'Transition Loop',
      1,
      '+1 pst',
    );
    expect(Math.abs(pitched.requested.duration - nestedLoopDurationSeconds))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(Math.abs(pitched.restored.duration - pitched.requested.duration))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(Math.abs(pitched.progressed.duration - pitched.requested.duration))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(pitched.requested.currentTime).toBeGreaterThanOrEqual(0.75);
    expect(pitched.restored.currentTime).toBeGreaterThanOrEqual(0);
    expect(pitched.restored.currentTime).toBeLessThanOrEqual(pitched.restored.duration);
    expect(pitched.restored.currentTime).toBeGreaterThanOrEqual(
      Math.max(0, pitched.requested.currentTime - 0.25),
    );
    expect(pitched.progressed.paused).toBe(false);
    expect(pitched.progressed.pitch).toBe(1);
    const transitionSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(transitionSamples.frameCount).toBeGreaterThan(0);
    expect(transitionSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(transitionSamples.peakSample).toBeGreaterThan(0);
    const spedUp = await utilityLoopsActions.setSpeedByName('Transition Loop', 1.25);
    expect(spedUp.paused).toBe(false);
    expect(spedUp.pitch).toBe(1);
    expect(spedUp.speed).toBeCloseTo(1.25, 2);
    expect(spedUp.playbackRate).toBeCloseTo(1.25, 2);
    const continuity = await utilityLoopsActions.readLoopContinuity(audioHandle, loopId);
    expect(continuity.sameNode).toBe(true);
    expect(continuity.snapshot.connected).toBe(true);
    expect(continuity.snapshot.paused).toBe(false);
  });

  await stepLogger.step('Reset loop Space priority after leaving and returning to Loops', async () => {
    await utilityTabBarActions.openTab('rules');
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const resetStart = await globalPlayerActions.readCurrentPlaybackSummary();
    const firstExpectedPaused = !resetStart.paused;
    await utilityLoopsActions.pressSpaceAfterLoopOwnershipReset(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: firstExpectedPaused }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: resetStart.title,
      playbackControl: firstExpectedPaused ? 'Play' : 'Pause',
      paused: firstExpectedPaused,
    });
    await utilityLoopsActions.pressSpaceAfterLoopOwnershipReset(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: resetStart.paused }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: resetStart.title,
      playbackControl: resetStart.paused ? 'Play' : 'Pause',
      paused: resetStart.paused,
    });
  });

  await stepLogger.step('Delete a saved loop through the app-owned No and Yes confirmation', async () => {
    const firstOpen = await utilityLoopsActions.openDeleteConfirmationByName('Transition Loop');
    expect(firstOpen.nativeDialogs).toEqual([]);
    expect(firstOpen.text).toBe('Remove "Transition Loop"? This will delete the saved loop file.');
    expect(firstOpen.stacking.deleteZIndex).toBeGreaterThan(firstOpen.stacking.utilityZIndex);
    expect(firstOpen.stacking.deleteOwnsTopElement).toBe(true);
    expect((await utilityLoopsActions.cancelDeleteConfirmationByName('Transition Loop')).requestCount)
      .toBe(0);

    const secondOpen = await utilityLoopsActions.openDeleteConfirmationByName('Transition Loop');
    expect(secondOpen.nativeDialogs).toEqual([]);
    expect((await utilityLoopsActions.confirmDeleteByName('Transition Loop')).requestCount).toBe(1);
    expect((await utilityLoopsActions.readDetailSummary()).entryCount).toBe(1);
    expect((await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE)).countText).toBe('1 loop');

    const consecutiveOpen = await utilityLoopsActions.openDeleteConfirmationByName('Warmup Loop');
    expect(consecutiveOpen.nativeDialogs).toEqual([]);
    expect(consecutiveOpen.text).toBe('Remove "Warmup Loop"? This will delete the saved loop file.');
    expect((await utilityLoopsActions.cancelDeleteConfirmationByName('Warmup Loop')).requestCount)
      .toBe(0);
  });

});

test('FTC-UTIL-LOOPS-026 delete confirmation foregrounds the open Utility modal', async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  const loopName = 'Foreground Delete Confirmation Loop';
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(loopName)).requestCount).toBe(1);

  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  const opened = await utilityLoopsActions.openDeleteConfirmationByName(loopName);
  expect(opened.nativeDialogs).toEqual([]);
  expect(opened.stacking.deleteZIndex).toBeGreaterThan(opened.stacking.utilityZIndex);
  expect(opened.stacking.deleteOwnsTopElement).toBe(true);
  expect(await utilityLoopsActions.selectDeleteConfirmationTextOutsideDialog())
    .toBe(`Remove "${loopName}"? This will delete the saved loop file.`);
  expect((await utilityLoopsActions.confirmDeleteByName(loopName)).requestCount).toBe(1);
});

test('FTC-UTIL-LOOPS-024 Enter opens naming from the active saved-loop editor', async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  const loopName = 'Saved Loop Enter Shortcut';
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(loopName)).requestCount).toBe(1);

  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  await utilityLoopsActions.revealCreateAnotherLoopEditorByName(loopName);
  expect((await utilityLoopsActions.activateCreateAnotherLoopWithEnterByName(loopName)).requestCount)
    .toBe(0);
  expect(await globalPlayerActions.waitForLoopNameDialog()).toEqual({
    visible: true,
    focused: true,
    error: '',
  });
  expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
  await utilityLoopsActions.expectCreateAnotherLoopEditorActiveByName(loopName);
  expect((await utilityLoopsActions.escapeCreateAnotherLoopByName(loopName)).requestCount).toBe(0);
  await utilityLoopsActions.openDeleteConfirmationByName(loopName);
  expect((await utilityLoopsActions.confirmDeleteByName(loopName)).requestCount).toBe(1);
});

test('FTC-PLAYER-017 scissors remains available after saving a loop', async ({
  galleryActions,
  globalPlayerActions,
  trackModalActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName('Reusable Scissors Loop')).requestCount).toBe(1);

  await globalPlayerActions.expectAvailableLoopAction();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);
});

test('FTC-PLAYER-017 loop-edit reload restores the active playhead', async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  trackModalActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 2 });
  await globalPlayerActions.openLoopEditor();
  const beforeReload = await globalPlayerActions.waitForFullTrackTiming();
  expect(beforeReload.currentTime).toBeGreaterThan(1);

  const reloadPlaybackMark = await playbackEvidence.playbackMark();
  const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
  });
  expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
  expect(restoredPlayback.paused).toBe(false);
  expect(restoredPlayback.initialRestore.path).toBe(selectedTrack.path);

  await globalPlayerActions.expectLoopEditorInactive();
  const restored = await globalPlayerActions.waitForFullTrackTiming();
  expect(restored.currentTime).toBeGreaterThanOrEqual(beforeReload.currentTime - 1);
  expect(restored.currentTime).toBeLessThanOrEqual(restored.duration);
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
    after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
    path: selectedTrack.path,
  });
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
});

test('FTC-PLAYER-017 paused reload restores the current waveform', async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.selectSeekbarMode('waveform');
  await settingsModalAppBarActions.closeSettings();

  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await globalPlayerActions.pauseIfPlaying();
  await trackModalActions.close();

  await globalPlayerActions.reloadAndWaitForRestoredTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
  }, { paused: true });

  const waveform = await globalPlayerActions.waitForRenderedWaveform({ path: selectedTrack.path });
  expect(waveform.nonPlayheadPixels).toBeGreaterThan(0);
  expect(waveform.leftBins).toBe(280);
  expect(waveform.rightBins).toBe(280);
});
