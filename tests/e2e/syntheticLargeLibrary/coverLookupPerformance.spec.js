import { expect, test } from '../support/performanceFixtures.js';
import {
  expectTimingBudget,
  measureInteractionToPaint,
  performanceTimingBudget,
} from '../helpers/index.js';
import { COVER_LOOKUP_TEST_TARGETS } from '../helpers/coverLookupFixtureData.js';

const CASE_ID = 'FTC-COVERS-019P';
const TARGET = COVER_LOOKUP_TEST_TARGETS.performanceInteractions;
const TIMING_BUDGETS = Object.freeze(Object.fromEntries([
  'modalVisibleMs',
  'candidateReadyMs',
  'candidateSelectionMs',
  'saveAcceptedMs',
].map((key) => [key, Object.freeze(performanceTimingBudget(`cover-lookup.${key}`))])));
const MAX_INTERACTION_LONG_TASK_MS = 200;

test.describe(`${CASE_ID} Cover Lookup interaction timing`, () => {
  test('opens, renders a candidate, selects it, and accepts Save within the interaction budgets', async ({
    coverLookupActions,
    coverLookupLocalReport,
    galleryActions,
    page,
    stepLogger,
    thirdPartyRequestEvidence,
    trackModalActions,
  }) => {
    await stepLogger.step('Open the fixture album through the production gallery and Album Details controls', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(TARGET.artist)}`);
      await galleryActions.waitForSelectedArtistGallery(TARGET.artist);
      expect(await galleryActions.selectAlbumDetailsByIdentity(TARGET)).toEqual(TARGET);
      await trackModalActions.waitForLoadedSummary();
    });

    await trackModalActions.prepareCoverLookup();
    const lookupStartedAt = performance.now();
    const modalVisible = await stepLogger.step('Measure the Cover Lookup modal becoming interactive', async () => (
      measureInteractionToPaint(
        page,
        () => trackModalActions.activateCoverLookup(),
        () => coverLookupActions.waitForModalReady(),
      )
    ));

    let selectedCandidate = null;
    await stepLogger.step('Wait for one decoded provider candidate through the production cover proxy', async () => {
      await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
      const candidates = await coverLookupActions.readRemoteCandidateSummaries();
      selectedCandidate = candidates.find(
        (candidate) => candidate.source.toLocaleLowerCase() === 'spotify',
      );
      expect(selectedCandidate?.id).toBeTruthy();
      const image = await coverLookupActions.readRemoteCandidateEvidence(selectedCandidate.id);
      expect(image.sha256).not.toBe('');
    });
    const candidateReadyMs = performance.now() - lookupStartedAt;

    const candidateSelection = await stepLogger.step('Measure candidate selection feedback', async () => (
      measureInteractionToPaint(
        page,
        () => coverLookupActions.selectRemoteCandidateById(selectedCandidate.id),
        () => Promise.all([
          coverLookupActions.waitForSelectedRemoteCandidateId(selectedCandidate.id),
          expect(coverLookupActions.coverLookup.saveRemoteButton).toBeEnabled(),
        ]),
      )
    ));

    let savePayload = null;
    const saveAccepted = await stepLogger.step('Measure Save acceptance and modal close', async () => (
      measureInteractionToPaint(
        page,
        async () => {
          savePayload = await coverLookupActions.saveSelectedRemoteCandidate();
        },
        () => coverLookupActions.coverLookup.waitForHidden(coverLookupActions.coverLookup.modal),
      )
    ));
    expect(savePayload?.optimistic_cover_path).toBe('');
    expect(savePayload?.optimistic_remote_source).toBe('spotify');
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);

    const reopened = await stepLogger.step(
      'Verify the saved Spotify link remains active after reopening Cover Lookup',
      async () => coverLookupActions.reopenUntilSavedRemoteCoverIsActive(
        () => trackModalActions.openCoverLookup(),
        'SPOTIFY',
        selectedCandidate.id,
      ),
    );
    expect(reopened.source).toBe('SPOTIFY');
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);

    await trackModalActions.close();

    const metrics = {
      modalVisibleMs: modalVisible.durationMs,
      candidateReadyMs,
      candidateSelectionMs: candidateSelection.durationMs,
      saveAcceptedMs: saveAccepted.durationMs,
      selectedCandidateId: selectedCandidate.id,
      selectedCandidateSource: selectedCandidate.source,
      targetArtist: TARGET.artist,
      targetAlbum: TARGET.album,
      targetYear: TARGET.year,
    };
    coverLookupLocalReport.setMetricsPayload(metrics);
    for (const [key, timingMs] of Object.entries(metrics)) {
      if (!TIMING_BUDGETS[key]) continue;
      await coverLookupLocalReport.recordTimingCheckpoint({
        key,
        label: key,
        timingMs,
        details: {
          candidateId: selectedCandidate.id,
          candidateSource: selectedCandidate.source,
          target: TARGET,
        },
      });
      coverLookupLocalReport.recordTerminalTimingOutcome(
        TIMING_BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, timingMs, TIMING_BUDGETS[key], key),
      );
    }
    for (const [label, measurement] of [
      ['modal open', modalVisible],
      ['candidate selection', candidateSelection],
      ['save acceptance', saveAccepted],
    ]) {
      expect.soft(
        measurement.maxLongTaskMs,
        `${label} produced a ${measurement.maxLongTaskMs} ms browser main-thread task.`,
      ).toBeLessThanOrEqual(MAX_INTERACTION_LONG_TASK_MS);
    }
    coverLookupLocalReport.recordContractCompletion();
  });
});
