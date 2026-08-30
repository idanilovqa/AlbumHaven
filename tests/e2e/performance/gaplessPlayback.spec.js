import { expect, test } from '../support/performanceFixtures.js';
import {
  assertActiveReplacementContract,
  assertAudibleBoundaryCapture,
  assertGaplessBoundaryCapture,
  assertLongWaveformTimingBudget,
  assertNearEndSeekContract,
  assertPersistentWaveformCacheContract,
  createPlaybackLifecycleObserver,
  createStreamingReplacementDiagnosticsObserver,
  observeWaveformTraffic,
  readGaplessPlaybackDiagnostics,
  waitForActivePlaybackWindow,
  waitForGaplessBoundary,
} from '../helpers/index.js';

test('FTC-PLAYER-016 production playback crosses a sample-exact stable-stream boundary', async ({
  galleryActions,
  gaplessPlaybackFixture,
  gaplessPlaybackReport,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  const traffic = playbackEvidence;
  {
    await stepLogger.step('Open the generated lossless-boundary album through visible controls', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('appearance');
      await utilityAppearanceActions.waitForReady();
      await utilityAppearanceActions.selectSeekbarMode('waveform');
      await settingsModalAppBarActions.closeSettings();
      await searchToolbarActions.search(gaplessPlaybackFixture.album, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(gaplessPlaybackFixture.album);
      await galleryActions.waitForAlbumVisible(gaplessPlaybackFixture.album);
      await galleryActions.clickAlbumDetailsByAlbumName(gaplessPlaybackFixture.album);
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.title).toContain(
        `${gaplessPlaybackFixture.artist} - ${gaplessPlaybackFixture.album}`,
      );
      expect(summary.trackRows).toBeGreaterThanOrEqual(2);
    });

    const outgoing = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'boundary-outgoing');
    const incoming = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'boundary-incoming');
    const replacement = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'very-short');
    const longLoop = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'long');
    const longLoopIndex = gaplessPlaybackFixture.tracks.findIndex((track) => track.kind === 'long');
    const nearEnd = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'near-end-seek');
    const nearEndSuccessor = gaplessPlaybackFixture.tracks.find((track) => track.kind === 'near-end-successor');
    const nearEndIndex = gaplessPlaybackFixture.tracks.findIndex((track) => track.kind === 'near-end-seek');
    const encodedChain = ['encoded-chain-a', 'encoded-chain-b', 'encoded-chain-c']
      .map((kind) => gaplessPlaybackFixture.tracks.find((track) => track.kind === kind));
    const encodedChainIndex = gaplessPlaybackFixture.tracks.findIndex(
      (track) => track.kind === 'encoded-chain-a',
    );
    expect(outgoing).toBeTruthy();
    expect(incoming).toBeTruthy();
    expect(replacement).toBeTruthy();
    expect(longLoop).toBeTruthy();
    expect(longLoopIndex).toBeGreaterThanOrEqual(0);
    expect(nearEnd).toBeTruthy();
    expect(nearEndSuccessor).toBeTruthy();
    expect(nearEndIndex).toBeGreaterThanOrEqual(0);
    expect(gaplessPlaybackFixture.tracks[nearEndIndex + 1]?.path).toBe(nearEndSuccessor.path);
    expect(encodedChain.every(Boolean)).toBe(true);
    expect(encodedChainIndex).toBeGreaterThanOrEqual(0);
    expect(gaplessPlaybackFixture.tracks.slice(encodedChainIndex, encodedChainIndex + 3)
      .map((track) => track.path)).toEqual(encodedChain.map((track) => track.path));

    let continuityOpen = null;
    await stepLogger.step('Select the outgoing row and observe production streaming roles', async () => {
      const selected = await trackModalActions.playTrackAt(0);
      expect(selected.path).toBe(outgoing.path);
      await globalPlayerActions.waitForCurrentTrack({ path: outgoing.path, trackTitle: outgoing.title });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      continuityOpen = await traffic.waitForControl({ type: 'open', role: 'continuity' });
      const diagnostics = await readGaplessPlaybackDiagnostics(page);
      expect(diagnostics.firstFrameAtEpochMs).toBeGreaterThan(0);
      expect(diagnostics.roleOpenedAtEpochMs.continuity).toBeGreaterThanOrEqual(
        diagnostics.firstFrameAtEpochMs,
      );
      expect(diagnostics.activeRoles).toEqual(['current', 'continuity']);
      expect(diagnostics.decodedTrackCacheSize).toBe(0);
      expect(diagnostics.bufferedFrames.current).toBeLessThanOrEqual(
        diagnostics.currentCapacityFrames,
      );
    });

    const diagnostics = await stepLogger.step(
      'Capture the same-quantum lossless boundary from the production worklet',
      async () => waitForGaplessBoundary(page, {
        expectedPromotedStreamId: continuityOpen.streamId,
      }),
    );
    const outgoingSamples = outgoing.expectedBoundarySamples || {};
    const incomingSamples = incoming.expectedBoundarySamples || {};
    assertGaplessBoundaryCapture(expect, diagnostics.boundaryCapture, {
      tolerance: 1 / 32768,
      outgoing: {
        left: Array.from(outgoingSamples.left || []),
        right: Array.from(outgoingSamples.right || []),
      },
      incoming: {
        left: Array.from(incomingSamples.left || []),
        right: Array.from(incomingSamples.right || []),
      },
    });

    const controls = traffic.snapshotSince(0);
    const opens = controls.filter((control) => control.type === 'open');
    const promotion = controls.find((control) => control.type === 'promote');
    const replacementOpen = opens[2];
    expect(diagnostics.underruns).toBe(0);
    expect(opens).toHaveLength(3);
    expect(opens.map((control) => control.role)).toEqual([
      'current',
      'continuity',
      'continuity',
    ]);
    expect(opens[0]?.path).toBe(outgoing.path);
    expect(opens[1]?.path).toBe(incoming.path);
    expect(promotion?.streamId).toBe(continuityOpen.streamId);
    expect(replacementOpen?.path).toBe(replacement.path);
    expect(replacementOpen?.streamId).not.toBe(opens[0]?.streamId);
    expect(replacementOpen?.streamId).not.toBe(opens[1]?.streamId);
    expect(controls.indexOf(replacementOpen)).toBeGreaterThan(controls.indexOf(promotion));
    expect(diagnostics.currentStreamId).toBe(continuityOpen.streamId);
    expect(diagnostics.continuityStreamId).toBe(replacementOpen.streamId);
    expect(diagnostics.activeRoles).toEqual(['current', 'continuity']);
    expect(
      diagnostics.bufferedFrames.current + diagnostics.inFlightFrames.current,
    ).toBeLessThanOrEqual(diagnostics.currentCapacityFrames);
    expect(
      diagnostics.bufferedFrames.continuity + diagnostics.inFlightFrames.continuity,
    ).toBeLessThanOrEqual(diagnostics.continuityCapacityFrames);
    gaplessPlaybackReport.recordBoundary({ diagnostics, controls });

    await stepLogger.step('Honor a visible near-end seek, move its waveform cursor, and keep playing into queued-next', async () => {
      const selected = await trackModalActions.playTrackAt(nearEndIndex);
      expect(selected.path).toBe(nearEnd.path);
      await globalPlayerActions.waitForCurrentTrack({ path: nearEnd.path, trackTitle: nearEnd.title });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      const waveform = await globalPlayerActions.waitForRenderedWaveform({ path: nearEnd.path });
      expect(waveform.path).toBe(nearEnd.path);
      expect(waveform.leftBins).toBe(280);
      expect(waveform.rightBins).toBe(280);
      expect(waveform.nonTransparentPixels).toBeGreaterThan(0);
      expect(waveform.nonPlayheadPixels).toBeGreaterThan(0);

      const cursorTarget = Math.max(0.5, Number(nearEnd.durationSeconds) - 2);
      await globalPlayerActions.seekToSeconds(cursorTarget, {
        toleranceSeconds: 0.25,
      });
      await globalPlayerActions.togglePlaybackWithSpace({ paused: true });
      const playhead = await globalPlayerActions.waitForWaveformPlayheadAt(cursorTarget, {
        path: nearEnd.path,
        toleranceSeconds: 0.5,
      });
      expect(Math.abs(playhead.timelineValue - cursorTarget)).toBeLessThanOrEqual(0.5);
      expect(playhead.topPlayheadPixels).toBeGreaterThan(0);
      const resumeMark = await traffic.playbackMark();
      await globalPlayerActions.togglePlaybackWithSpace({ paused: false });
      const resumeEvidence = await traffic.waitForTrackPlaybackEvidence({
        after: resumeMark,
        path: nearEnd.path,
      });
      expect(resumeEvidence.nonZeroSamples).toBeGreaterThan(0);
      expect(resumeEvidence.renderedFrameDelta).toBeGreaterThan(0);

      const nearEndTrafficMark = traffic.mark();
      const seekTarget = Number(nearEnd.durationSeconds) - 0.5;
      const seekResult = await globalPlayerActions.seekToSeconds(seekTarget, {
        toleranceSeconds: 0.25,
      });
      await globalPlayerActions.waitForStreamingContinuity(nearEndSuccessor.path, {
        generation: seekResult.generation,
      });
      const nearEndDiagnostics = await readGaplessPlaybackDiagnostics(page);
      expect(nearEndDiagnostics.underruns).toBe(diagnostics.underruns);
      const nearEndControls = traffic.snapshotSince(nearEndTrafficMark);
      assertNearEndSeekContract(expect, {
        activeSocketCount: traffic.activeSocketCount(),
        controls: nearEndControls,
        currentAlreadySelected: true,
        diagnostics: nearEndDiagnostics,
        path: nearEnd.path,
        seekResult,
        socketCount: traffic.socketCount(),
        successorPath: nearEndSuccessor.path,
        expectedSeekCapture: nearEnd.expectedSeekCapture,
      });

      const successorOpen = nearEndControls.findLast((control) => (
        control.type === 'open'
          && control.role === 'continuity'
          && control.path === nearEndSuccessor.path
      ));
      expect(successorOpen).toBeTruthy();
      const successorBoundary = await waitForGaplessBoundary(page, {
        expectedPromotedStreamId: successorOpen.streamId,
      });
      await globalPlayerActions.waitForCurrentTrack({
        path: nearEndSuccessor.path,
        trackTitle: nearEndSuccessor.title,
      });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      assertAudibleBoundaryCapture(expect, successorBoundary.boundaryCapture);
      expect(successorBoundary.underruns).toBe(diagnostics.underruns);
      expect(traffic.activeSocketCount()).toBe(1);
    });

    await stepLogger.step('Replace active Album Details playback without pausing or restarting resources', async () => {
      const eventMark = traffic.eventMark();
      const beforeDiagnostics = await readGaplessPlaybackDiagnostics(page);
      const lifecycle = await createPlaybackLifecycleObserver(page);
      try {
        const selected = await trackModalActions.playTrackAt(longLoopIndex);
        expect(selected.path).toBe(longLoop.path);
        await globalPlayerActions.waitForCurrentTrack({
          path: longLoop.path,
          trackTitle: longLoop.title,
        });
        await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
        const replacementStart = await readGaplessPlaybackDiagnostics(page);
        const afterDiagnostics = await waitForActivePlaybackWindow(
          page,
          replacementStart.currentTime,
        );
        assertActiveReplacementContract(expect, {
          activeSocketCount: traffic.activeSocketCount(),
          afterDiagnostics,
          beforeDiagnostics,
          events: traffic.eventsSince(eventMark),
          lifecycle: await lifecycle.checkpoint(),
          path: longLoop.path,
          socketCount: traffic.socketCount(),
        });
        const longWaveform = await globalPlayerActions.waitForRenderedWaveform({
          path: longLoop.path,
          timeout: 5000,
        });
        expect(longWaveform.firstFrameAtMs).toBeGreaterThan(0);
        gaplessPlaybackReport.recordTimingOutcome(
          assertLongWaveformTimingBudget(expect.soft, longWaveform),
        );
        expect(longWaveform.nonPlayheadPixels).toBeGreaterThan(0);
      } finally {
        await lifecycle.stop();
      }
    });

    await stepLogger.step('Seek and cross two gapless boundaries through three consecutive encoded tracks', async () => {
      const selected = await trackModalActions.playTrackAt(encodedChainIndex);
      expect(selected.path).toBe(encodedChain[0].path);
      await globalPlayerActions.waitForCurrentTrack({
        path: encodedChain[0].path,
        trackTitle: encodedChain[0].title,
      });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      const firstWaveform = await globalPlayerActions.waitForRenderedWaveform({
        path: encodedChain[0].path,
      });
      expect(firstWaveform.nonPlayheadPixels).toBeGreaterThan(0);

      for (let index = 0; index < encodedChain.length - 1; index += 1) {
        const currentTrack = encodedChain[index];
        const nextTrack = encodedChain[index + 1];
        const trafficMark = traffic.mark();
        const seekTarget = Number(currentTrack.durationSeconds) - 0.5;
        const seekResult = await globalPlayerActions.seekToSeconds(seekTarget, {
          toleranceSeconds: 0.25,
        });
        await globalPlayerActions.waitForStreamingContinuity(nextTrack.path, {
          generation: seekResult.generation,
        });
        const seekDiagnostics = await readGaplessPlaybackDiagnostics(page);
        const transitionControls = traffic.snapshotSince(trafficMark);
        assertNearEndSeekContract(expect, {
          activeSocketCount: traffic.activeSocketCount(),
          controls: transitionControls,
          currentAlreadySelected: true,
          diagnostics: seekDiagnostics,
          path: currentTrack.path,
          seekResult,
          socketCount: traffic.socketCount(),
          successorPath: nextTrack.path,
        });
        const nextOpen = transitionControls.find((control) => (
          control.type === 'open'
            && control.role === 'continuity'
            && control.path === nextTrack.path
        ));
        expect(nextOpen).toBeTruthy();
        const boundary = await waitForGaplessBoundary(page, {
          expectedPromotedStreamId: nextOpen.streamId,
        });
        await globalPlayerActions.waitForCurrentTrack({
          path: nextTrack.path,
          trackTitle: nextTrack.title,
        });
        await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
        assertAudibleBoundaryCapture(expect, boundary.boundaryCapture, {
          outgoing: currentTrack.expectedSampleSign,
          incoming: nextTrack.expectedSampleSign,
        });
        expect(boundary.underruns).toBe(diagnostics.underruns);
        expect(traffic.activeSocketCount()).toBe(1);
        const nextWaveform = await globalPlayerActions.waitForRenderedWaveform({ path: nextTrack.path });
        expect(nextWaveform.path).toBe(nextTrack.path);
        expect(nextWaveform.nonPlayheadPixels).toBeGreaterThan(0);
      }
    });

    await stepLogger.step('Reload and render the persisted six-minute waveform from one cache-only response', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(gaplessPlaybackFixture.album, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(gaplessPlaybackFixture.album);
      await galleryActions.waitForAlbumVisible(gaplessPlaybackFixture.album);
      await galleryActions.clickAlbumDetailsByAlbumName(gaplessPlaybackFixture.album);
      await trackModalActions.waitForInteractiveSummary();

      const waveformTraffic = observeWaveformTraffic(page);
      try {
        const mark = waveformTraffic.mark();
        const cacheResponsePromise = waveformTraffic.waitForResponse({
          cachedOnly: true,
          path: longLoop.path,
          status: 200,
        }, { afterMark: mark });
        const playbackMark = await traffic.playbackMark();
        const selected = await trackModalActions.playTrackAt(longLoopIndex);
        expect(selected.path).toBe(longLoop.path);
        const cacheResponse = await cacheResponsePromise;
        const rendered = await globalPlayerActions.waitForRenderedWaveform({
          path: longLoop.path,
          timeout: 5000,
        });
        expect(rendered.path).toBe(longLoop.path);
        expect(rendered.nonPlayheadPixels).toBeGreaterThan(0);
        await globalPlayerActions.waitForCurrentTrack({
          path: longLoop.path,
          trackTitle: longLoop.title,
        });
        await globalPlayerActions.waitForPlaybackState({
          paused: false,
          minimumCurrentTime: 0.02,
        });
        const cachePlaybackStart = await readGaplessPlaybackDiagnostics(page);
        await waitForActivePlaybackWindow(page, cachePlaybackStart.currentTime);
        const evidence = await traffic.waitForTrackPlaybackEvidence({
          after: playbackMark,
          path: longLoop.path,
        });
        expect(evidence.nonZeroSamples).toBeGreaterThan(0);
        expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
        assertPersistentWaveformCacheContract(expect, {
          rendered,
          requests: waveformTraffic.snapshotSince(mark)
            .filter((request) => request.path === longLoop.path),
          response: cacheResponse,
        });
      } finally {
        waveformTraffic.stop();
      }
    });
    gaplessPlaybackReport.recordContractCompletion();
  }
});

test('FTC-PLAYER-013 immediate Album Details replacement stays audible', async ({
  galleryActions,
  gaplessPlaybackFixture,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}, testInfo) => {
  await stepLogger.step('Open the generated album through visible controls', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(gaplessPlaybackFixture.album, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(gaplessPlaybackFixture.album);
    await galleryActions.waitForAlbumVisible(gaplessPlaybackFixture.album);
    await galleryActions.clickAlbumDetailsByAlbumName(gaplessPlaybackFixture.album);
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.trackRows).toBeGreaterThanOrEqual(5);
  });

  const firstIndex = gaplessPlaybackFixture.tracks.findIndex((track) => track.kind === 'vbr');
  const replacementIndex = gaplessPlaybackFixture.tracks.findIndex((track) => track.kind === 'long');
  const firstTrack = gaplessPlaybackFixture.tracks[firstIndex];
  const replacementTrack = gaplessPlaybackFixture.tracks[replacementIndex];
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(replacementIndex).toBeGreaterThanOrEqual(0);

  await stepLogger.step('Replace the first audible row without waiting', async () => {
    const firstMark = await playbackEvidence.playbackMark();
    expect((await trackModalActions.playTrackAt(firstIndex)).path).toBe(firstTrack.path);
    await playbackEvidence.waitForTrackPlaybackEvidence({
      after: firstMark,
      path: firstTrack.path,
    });

    const beforeReplacement = await readGaplessPlaybackDiagnostics(page);
    const eventMark = playbackEvidence.eventMark();
    const lifecycle = await createPlaybackLifecycleObserver(page);
    const replacementDiagnostics = await createStreamingReplacementDiagnosticsObserver(page);
    const replacementMark = await playbackEvidence.playbackMark();
    try {
      expect((await trackModalActions.playTrackAt(replacementIndex)).path).toBe(replacementTrack.path);
      await globalPlayerActions.waitForCurrentTrack({
        path: replacementTrack.path,
        trackTitle: replacementTrack.title,
      });
      await playbackEvidence.waitForTrackPlaybackEvidence({
        after: replacementMark,
        path: replacementTrack.path,
      });
      const replacementStart = await readGaplessPlaybackDiagnostics(page);
      const afterReplacement = await waitForActivePlaybackWindow(
        page,
        replacementStart.currentTime,
        { seconds: 2 },
      );

      const diagnosticTimeline = await replacementDiagnostics.finish();
      const replacementEvents = playbackEvidence.eventsSince(eventMark);
      await testInfo.attach('temporary-replacement-diagnostics', {
        body: Buffer.from(JSON.stringify({
          afterReplacement,
          beforeReplacement,
          diagnosticTimeline,
          lifecycle: await lifecycle.checkpoint(),
          replacementEvents,
          replacementStart,
        }, null, 2)),
        contentType: 'application/json',
      });

      assertActiveReplacementContract(expect, {
        activeSocketCount: playbackEvidence.activeSocketCount(),
        afterDiagnostics: afterReplacement,
        beforeDiagnostics: beforeReplacement,
        events: replacementEvents,
        lifecycle: await lifecycle.checkpoint(),
        path: replacementTrack.path,
        socketCount: playbackEvidence.socketCount(),
      });
    } finally {
      const diagnosticTimeline = await replacementDiagnostics.finish();
      if (diagnosticTimeline.length) {
        await testInfo.attach('temporary-replacement-diagnostics-finally', {
          body: Buffer.from(JSON.stringify({
            diagnosticTimeline,
            replacementEvents: playbackEvidence.eventsSince(eventMark),
          }, null, 2)),
          contentType: 'application/json',
        });
      }
      await lifecycle.stop();
    }
  });
});
