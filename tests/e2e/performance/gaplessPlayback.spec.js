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
  forgetKeptStreamingTracks,
  observeWaveformTraffic,
  readGaplessPlaybackDiagnostics,
  runWithPlaybackEventWindowAttachment,
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
}, testInfo) => {
  const traffic = playbackEvidence;
  // LOCAL DIAGNOSTICS ONLY (never pushed): observe waveform traffic and engine state.
  const diagT0 = Date.now();
  const diagFs = await import('node:fs');
  const diagServerLog = (await import('node:path')).join(process.cwd(), 'album-haven-diag-ftc016.log');
  try { diagFs.rmSync(diagServerLog, { force: true }); } catch { /* diagnostic only */ }
  const diagWaveform = [];
  const diagSamples = [];
  const diagIsWave = (url) => url.includes('/playback/waveform');
  const diagShort = (url) => {
    const u = new URL(url);
    return `${u.searchParams.get('bins')}${u.searchParams.get('cachedOnly') === '1' ? ' cachedOnly' : ''} ${String(u.searchParams.get('path') || '').split(/[\\/]/).pop()}`;
  };
  page.on('request', (r) => { if (diagIsWave(r.url())) diagWaveform.push({ t: Date.now() - diagT0, ev: 'request', q: diagShort(r.url()) }); });
  page.on('requestfinished', async (r) => {
    if (!diagIsWave(r.url())) return;
    const res = await r.response().catch(() => null);
    diagWaveform.push({ t: Date.now() - diagT0, ev: 'finished', status: res?.status(), q: diagShort(r.url()) });
  });
  page.on('requestfailed', (r) => { if (diagIsWave(r.url())) diagWaveform.push({ t: Date.now() - diagT0, ev: 'failed', err: r.failure()?.errorText, q: diagShort(r.url()) }); });
  const diagEngine = () => page.evaluate(() => {
    const e = (typeof state !== 'undefined' && state.player?.streaming) || {};
    const name = (track) => (track?.path ? String(track.path).split(/[\\/]/).pop() : null);
    return {
      generation: e.generation, mode: e.mode,
      pendingContinuityTrack: name(e.pendingContinuityTrack),
      pendingPromotion: Boolean(e.pendingPromotion),
      bufferedFrames: e.diagnostics?.bufferedFrames, inFlightFrames: e.diagnostics?.inFlightFrames,
      firstFrameAtMs: e.diagnostics?.firstFrameAtMs, buffering: e.diagnostics?.buffering,
      snapshotPaused: e.snapshot?.paused, renderedFrame: e.snapshot?.renderedFrame,
      currentFirstFrameNotified: e.roles?.current?.firstFrameNotified,
      currentBoundaryNotified: e.roles?.current?.boundaryNotified,
      currentTrack: name(e.roles?.current?.track), continuityTrack: name(e.roles?.continuity?.track),
      sampleRate: e.sampleRate,
    };
  });
  const diagTimer = setInterval(() => {
    diagEngine().then((s) => diagSamples.push({ t: Date.now() - diagT0, ...s })).catch(() => {});
  }, 500);
  const diagDump = async (label) => {
    clearInterval(diagTimer);
    const finalEngine = await diagEngine().catch((error) => ({ error: String(error) }));
    const controls = traffic.snapshotSince(0).map(({ path: _p, ...control }) => control);
    let server = [];
    try {
      server = diagFs.readFileSync(diagServerLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) { server = [{ unavailable: String(error), diagServerLog }]; }
    const body = JSON.stringify({ label, t0EpochMs: diagT0, waveform: diagWaveform, server, controls, samples: diagSamples, finalEngine });
    console.log(`[DIAG-FTC016] ${body}`);
    try { diagFs.writeFileSync(testInfo.outputPath('diag-ftc016.json'), body); } catch { /* diagnostic only */ }
    if (process.env.DIAG_OUT) diagFs.writeFileSync(process.env.DIAG_OUT, body);
  };
  {
    await stepLogger.step('Open the generated lossless-boundary album through visible controls', async () => {
      await galleryActions.goto('/?surface=albums');
      await forgetKeptStreamingTracks(page);
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('appearance');
      await utilityAppearanceActions.waitForReady();
      await utilityAppearanceActions.saveSeekbarMode('waveform');
      await settingsModalAppBarActions.closeSettings();
      await searchToolbarActions.search(gaplessPlaybackFixture.album, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(gaplessPlaybackFixture.album);
      await galleryActions.waitForAlbumVisible(gaplessPlaybackFixture.album);
      await galleryActions.clickAlbumDetailsByAlbumName(gaplessPlaybackFixture.album);
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.title).toContain(
        `${gaplessPlaybackFixture.artist} • ${gaplessPlaybackFixture.album}`,
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
    const untaggedChain = ['untagged-chain-a', 'untagged-chain-b']
      .map((kind) => gaplessPlaybackFixture.tracks.find((track) => track.kind === kind));
    const untaggedChainIndex = gaplessPlaybackFixture.tracks.findIndex(
      (track) => track.kind === 'untagged-chain-a',
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
    expect(untaggedChain.every(Boolean)).toBe(true);
    expect(gaplessPlaybackFixture.tracks.slice(untaggedChainIndex, untaggedChainIndex + 2)
      .map((track) => track.path)).toEqual(untaggedChain.map((track) => track.path));

    let continuityOpen = null;
    await stepLogger.step('Select the outgoing row and observe production streaming roles', async () => {
      const initialStartDiagnostics = await createStreamingReplacementDiagnosticsObserver(page);
      try {
        const selected = await trackModalActions.playTrackAt(0);
        expect(selected.path).toBe(outgoing.path);
        await globalPlayerActions.waitForCurrentTrack({
          path: outgoing.path,
          trackTitle: outgoing.title,
        });
      } catch (error) {
        let failureState;
        let timeline = [];
        try {
          timeline = await initialStartDiagnostics.finish();
          const { src: _privateSource, ...diagnostics } = await readGaplessPlaybackDiagnostics(page);
          failureState = {
            diagnostics,
            protocolControls: traffic.snapshotSince(0).map(({ path: _privatePath, ...control }) => control),
            timeline,
          };
        } catch (diagnosticError) {
          failureState = {
            diagnosticsUnavailable: {
              message: String(diagnosticError?.message || diagnosticError),
              name: String(diagnosticError?.name || 'Error'),
            },
            timeline,
          };
        }
        await testInfo.attach('initial-playback-start-failure-state', {
          body: Buffer.from(JSON.stringify(failureState, null, 2)),
          contentType: 'application/json',
        });
        throw error;
      }
      await initialStartDiagnostics.finish();
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      try {
        continuityOpen = await traffic.waitForControl({ type: 'open', role: 'continuity' });
      } finally {
        await diagDump(continuityOpen ? 'continuity-opened' : 'continuity-missing');
      }
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

    await traffic.waitForControl({
      type: 'open',
      role: 'continuity',
      path: replacement.path,
    });
    const settledDiagnostics = await readGaplessPlaybackDiagnostics(page);

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
    expect(settledDiagnostics.currentStreamId).toBe(continuityOpen.streamId);
    expect(settledDiagnostics.continuityStreamId).toBe(replacementOpen.streamId);
    expect(settledDiagnostics.activeRoles).toEqual(['current', 'continuity']);
    expect(
      settledDiagnostics.bufferedFrames.current + settledDiagnostics.inFlightFrames.current,
    ).toBeLessThanOrEqual(settledDiagnostics.currentCapacityFrames);
    expect(
      settledDiagnostics.bufferedFrames.continuity + settledDiagnostics.inFlightFrames.continuity,
    ).toBeLessThanOrEqual(settledDiagnostics.continuityCapacityFrames);
    gaplessPlaybackReport.recordBoundary({ diagnostics, settledDiagnostics, controls });

    await stepLogger.step('Honor a visible near-end seek, move its waveform cursor, and keep playing into queued-next', async () => {
      const nearEndEventMark = traffic.eventMark();
      let preparedSuccessorStreamId = 0;
      await runWithPlaybackEventWindowAttachment({
        attach: (eventWindow) => testInfo.attach('near-end-successor-protocol-events', {
          body: Buffer.from(JSON.stringify(eventWindow, null, 2)),
          contentType: 'application/json',
        }),
        events: () => traffic.eventsSince(nearEndEventMark),
        streamId: () => preparedSuccessorStreamId,
      }, async () => {
        const selected = await trackModalActions.playTrackAt(nearEndIndex);
        expect(selected.path).toBe(nearEnd.path);
        await globalPlayerActions.waitForCurrentTrack({ path: nearEnd.path, trackTitle: nearEnd.title });
        await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
        const waveform = await globalPlayerActions.waitForRenderedWaveform({ path: nearEnd.path });
        expect(waveform.path).toBe(nearEnd.path);
        expect(waveform.leftBins).toBe(720);
        expect(waveform.rightBins).toBe(720);
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

        const preNearEndDiagnostics = await readGaplessPlaybackDiagnostics(page);
        await globalPlayerActions.waitForStreamingContinuity(nearEndSuccessor.path, {
          generation: preNearEndDiagnostics.generation,
        });
        await expect.poll(async () => (
          await readGaplessPlaybackDiagnostics(page)
        ).bufferedFrames.continuity).toBeGreaterThan(0);
        const preparedNearEndDiagnostics = await readGaplessPlaybackDiagnostics(page);
        preparedSuccessorStreamId = preparedNearEndDiagnostics.continuityStreamId;
        const nearEndTrafficMark = traffic.mark();
        const seekTarget = Number(nearEnd.durationSeconds) - 0.5;
        const seekResult = await globalPlayerActions.seekToSeconds(seekTarget, {
          toleranceSeconds: 0.25,
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
          preservedCurrentStreamId: preparedNearEndDiagnostics.currentStreamId,
          preservedContinuityStreamId: preparedNearEndDiagnostics.continuityStreamId,
        });

        const successorOpen = traffic.snapshotSince(0).findLast((control) => (
          control.type === 'open'
            && control.role === 'continuity'
            && control.streamId === preparedNearEndDiagnostics.continuityStreamId
        ));
        expect(successorOpen).toBeTruthy();
        await traffic.waitForControl({
          type: 'promote',
          streamId: preparedNearEndDiagnostics.continuityStreamId,
        });
        const successorBoundary = await waitForGaplessBoundary(page, {
          expectedPromotedStreamId: preparedNearEndDiagnostics.continuityStreamId,
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
        const preSeekDiagnostics = await readGaplessPlaybackDiagnostics(page);
        await globalPlayerActions.waitForStreamingContinuity(nextTrack.path, {
          generation: preSeekDiagnostics.generation,
        });
        await expect.poll(async () => (
          await readGaplessPlaybackDiagnostics(page)
        ).bufferedFrames.continuity).toBeGreaterThan(0);
        const preparedDiagnostics = await readGaplessPlaybackDiagnostics(page);
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
          preservedCurrentStreamId: preparedDiagnostics.currentStreamId,
          preservedContinuityStreamId: preparedDiagnostics.continuityStreamId,
        });
        const nextOpen = traffic.snapshotSince(0).findLast((control) => (
          control.type === 'open'
            && control.role === 'continuity'
            && control.streamId === preparedDiagnostics.continuityStreamId
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

    await stepLogger.step('Cross a natural album boundary between untagged MP3s without decoder padding', async () => {
      const [outgoingTrack, incomingTrack] = untaggedChain;
      const selected = await trackModalActions.playTrackAt(untaggedChainIndex);
      expect(selected.path).toBe(outgoingTrack.path);
      await globalPlayerActions.waitForCurrentTrack({
        path: outgoingTrack.path,
        trackTitle: outgoingTrack.title,
      });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      const startDiagnostics = await readGaplessPlaybackDiagnostics(page);
      await globalPlayerActions.waitForStreamingContinuity(incomingTrack.path, {
        generation: startDiagnostics.generation,
      });
      await expect.poll(async () => (
        await readGaplessPlaybackDiagnostics(page)
      ).bufferedFrames.continuity).toBeGreaterThan(0);
      const preparedDiagnostics = await readGaplessPlaybackDiagnostics(page);
      const seekResult = await globalPlayerActions.seekToSeconds(
        Number(outgoingTrack.durationSeconds) - 0.5,
        { toleranceSeconds: 0.25 },
      );
      await globalPlayerActions.waitForStreamingContinuity(incomingTrack.path, {
        generation: seekResult.generation,
      });
      const seekDiagnostics = await readGaplessPlaybackDiagnostics(page);
      const incomingOpen = traffic.snapshotSince(0).findLast((control) => (
        control.type === 'open'
          && control.role === 'continuity'
          && control.streamId === seekDiagnostics.continuityStreamId
      ));
      expect(incomingOpen).toBeTruthy();
      const outgoingStreamId = seekDiagnostics.currentStreamId;
      const boundary = await waitForGaplessBoundary(page, {
        expectedPromotedStreamId: incomingOpen.streamId,
      });
      await globalPlayerActions.waitForCurrentTrack({
        path: incomingTrack.path,
        trackTitle: incomingTrack.title,
      });
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.02 });
      // A trim stops at the first sample at or above -40 dBFS, so the last frame heard before the
      // boundary and the first after it are real audio; untrimmed, both would be decoder padding.
      // (A tone's MP3 rings as it starts, so the window's mean sign proves nothing here.)
      const capture = boundary.boundaryCapture;
      assertAudibleBoundaryCapture(expect, capture);
      const louder = (side, index) => Math.max(
        Math.abs(Number(capture[side].left[index])),
        Math.abs(Number(capture[side].right[index])),
      );
      expect(louder('outgoing', Number(capture.outgoing.frames) - 1)).toBeGreaterThanOrEqual(0.01);
      expect(louder('incoming', 0)).toBeGreaterThanOrEqual(0.01);
      const padding = (await readGaplessPlaybackDiagnostics(page)).boundaryPadding;
      expect(padding?.suffix).toMatchObject({ streamId: outgoingStreamId, confident: true });
      expect(padding?.prefix).toMatchObject({ streamId: incomingOpen.streamId, confident: true });
      expect(padding.suffix.removableFrames).toBeGreaterThan(0);
      expect(padding.prefix.removableFrames).toBeGreaterThan(0);
      expect(padding.prefix.removableFrames).toBeLessThanOrEqual(Math.round(0.064 * seekDiagnostics.sampleRate));
      expect(boundary.underruns).toBe(preparedDiagnostics.underruns);
      expect(traffic.activeSocketCount()).toBe(1);
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
    await forgetKeptStreamingTracks(page);
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

    // The prepared successor may have arrived whole and been kept; the replacement contract below is
    // the server stream, so the kept copy is forgotten before the click.
    await forgetKeptStreamingTracks(page);
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
