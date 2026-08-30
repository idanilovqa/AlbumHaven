import { expect, test } from '../support/performanceFixtures.js';
import {
  evaluatePlaybackStartBudget,
  expectTimingBudgetOutcome,
  formatTimingBudgetOutcome,
  measureAlbumTrackPlaybackStart,
  summarizePlaybackStartAttempts,
} from '../helpers/index.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const ATTEMPTS = [
  { label: 'cold short', rowIndex: 2 },
  { label: 'cold long', rowIndex: 0 },
  { label: 'repeated medium A', rowIndex: 4, cohort: 'repeated-use' },
  { label: 'repeated medium B', rowIndex: 6, cohort: 'repeated-use' },
  { label: 'repeated medium C', rowIndex: 8, cohort: 'repeated-use' },
  { label: 'repeated medium D', rowIndex: 10, cohort: 'repeated-use' },
  { label: 'repeated medium E', rowIndex: 12, cohort: 'repeated-use' },
  { label: 'repeated medium F', rowIndex: 14, cohort: 'repeated-use' },
];

test('FTC-PLAYER-013 album-detail playback starts promptly regardless of song length or prior use', async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  playbackStartReport,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  const traffic = playbackEvidence;
  const attempts = [];
  {
    await stepLogger.step('Open the generated playback-start album through normal search and album details', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(ALBUM);
      await galleryActions.waitForAlbumVisible(ALBUM);
      await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.title).toContain(`${ARTIST} - ${ALBUM}`);
      expect(summary.trackRows).toBeGreaterThan(ATTEMPTS.at(-1).rowIndex);
    });

    for (const attemptDefinition of ATTEMPTS) {
      const attempt = await stepLogger.step(`Measure ${attemptDefinition.label} playback start`, async () => (
        measureAlbumTrackPlaybackStart({
          page,
          trackModalActions,
          globalPlayerActions,
          traffic,
          ...attemptDefinition,
        })
      ));
      attempts.push(attempt);
      playbackStartReport.recordAttempt(attempt);
      expect(attempt.track.path).not.toEqual('');
      expect(attempt.diagnostics.currentPath).toBe(attempt.track.path);
      expect(attempt.diagnostics.currentTitle).toBe(attempt.track.title);
      expect(attempt.diagnostics.paused).toBe(false);
      expect(attempt.diagnostics.currentTime).toBeGreaterThanOrEqual(0.02);
      expect(attempt.selectedTrackTraffic.length).toBeGreaterThan(0);
      expect(attempt.playbackEvidence.pcmFrames).toBeGreaterThan(0);
      expect(attempt.playbackEvidence.nonZeroSamples).toBeGreaterThan(0);
      expect(attempt.playbackEvidence.renderedFrameDelta).toBeGreaterThan(0);
      expect(
        attempt.eagerPlaybackRoles,
        `${attempt.label} must not open a neighbour role before the selected stream first renders.`,
      ).toEqual([]);
      expect(attempt.diagnostics.decodedTrackCacheSize).toBe(0);
      expect(attempt.diagnostics.activeRoles).toContain('current');
      expect(attempt.diagnostics.activeRoles.length).toBeLessThanOrEqual(2);
      expect(
        attempt.diagnostics.activeRoles.every(
          (role) => ['current', 'continuity'].includes(role),
        ),
      ).toBe(true);
      expect(
        attempt.diagnostics.bufferedFrames.current + attempt.diagnostics.inFlightFrames.current,
      ).toBeLessThanOrEqual(
        attempt.diagnostics.currentCapacityFrames,
      );
      await traffic.waitForBackgroundSettled();
    }

    const summary = summarizePlaybackStartAttempts(attempts);
    const budget = evaluatePlaybackStartBudget(summary);
    playbackStartReport.recordSummary(summary);
    playbackStartReport.recordBudget(budget);
    stepLogger.note(
      formatTimingBudgetOutcome('Maximum playback start', budget.maximumStart),
      1,
    );
    stepLogger.note(
      `Repeated-use degradation ${Math.round(budget.degradation.actualMs)} ms; limit ${budget.degradation.maximumAllowedMs} ms.`,
      1,
    );
    await stepLogger.step('Preserve automatic queue handoff through the streaming player', async () => {
      const shortTrack = await trackModalActions.readTrackAt(2);
      const nextTrack = await trackModalActions.readTrackAt(3);
      const mark = await traffic.playbackMark();
      const handoffEvidence = traffic.waitForTrackPlaybackEvidence({ after: mark, path: nextTrack.path });
      await trackModalActions.playTrackAt(2);
      await globalPlayerActions.waitForCurrentTrack({
        path: shortTrack.path,
        trackTitle: shortTrack.title,
      });
      await globalPlayerActions.waitForCurrentTrack({
        path: nextTrack.path,
        trackTitle: nextTrack.title,
      }, { timeout: 30000 });
      await globalPlayerActions.waitForPlaybackState({
        paused: false,
        minimumCurrentTime: 0.02,
      });
      const evidence = await handoffEvidence;
      expect(evidence.pcmFrames).toBeGreaterThan(0);
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    });

    expect(
      budget.degradation.passed,
      `Repeated-use playback start degraded by ${Math.round(budget.degradation.actualMs)} ms; limit ${budget.degradation.maximumAllowedMs} ms.`,
    ).toBe(true);
    expect(summary.finalDecodedTrackCacheSize).toBe(0);
    playbackStartReport.recordContractCompletion();
    expectTimingBudgetOutcome(expect, budget.maximumStart, 'Maximum playback start');

  }
});
