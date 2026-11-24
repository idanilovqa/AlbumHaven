import { expect, test } from '../support/performanceFixtures.js';
import {
  expectTimingBudget,
  expectTimingBudgetOutcome,
  measureInteractionToPaint,
  performanceTimingBudget,
} from '../helpers/index.js';
import { COVER_LOOKUP_TEST_TARGETS } from '../helpers/coverLookupFixtureData.js';
import {
  PROJECTION_PENDING_WINDOW_METRIC_ID,
  PROJECTION_READ_PATH,
  STATUS_PATH,
  evaluateProjectionPendingTimeline,
  projectionReadScope,
} from './projectionPendingWindows.js';

const CASE_ID = 'FTC-COVERS-019P';
const TARGET = COVER_LOOKUP_TEST_TARGETS.performanceInteractions;
const TIMING_BUDGETS = Object.freeze(Object.fromEntries([
  'modalVisibleMs',
  'candidateReadyMs',
  'candidateSelectionMs',
  'saveAcceptedMs',
  'localCardsShownMs',
  'reopenAllCardsShownMs',
].map((key) => [key, Object.freeze(performanceTimingBudget(`cover-lookup.${key}`))])));
const MAX_INTERACTION_LONG_TASK_MS = 200;
const PROJECTION_PENDING_WINDOW_BUDGET = Object.freeze(performanceTimingBudget(PROJECTION_PENDING_WINDOW_METRIC_ID));

// 6.5 (FTC-COVERS-019P): passive. Reads the page's own /status polls until the first relation_projection.ready
// and the bodies of 503 gallery/search reads; every other response contributes only its URL and status.
function recordProjectionPendingTimeline(page) {
  const events = [];
  let readySeen = false;
  page.on('response', (response) => {
    const atMs = performance.now();
    const url = response.url();
    const { pathname } = new URL(url);
    const status = response.status();
    if (pathname === STATUS_PATH) {
      if (readySeen || !response.ok()) return;
      events.push(response.json().then(
        (body) => {
          if (body?.relation_projection?.ready !== true) return null;
          readySeen = true;
          return { atMs, kind: 'ready' };
        },
        () => null,
      ));
      return;
    }
    if (!PROJECTION_READ_PATH.test(pathname)) return;
    const scope = projectionReadScope(url);
    if (status >= 200 && status < 300) {
      events.push({ atMs, kind: 'success', scope });
    } else if (status === 503) {
      events.push(response.json().then(
        (body) => {
          const code = String(body?.code ?? '');
          return code.endsWith('_projection_pending') ? { atMs, kind: 'pending', scope, code } : null;
        },
        () => null,
      ));
    }
  });
  return async () => evaluateProjectionPendingTimeline(
    (await Promise.all(events)).filter(Boolean),
    PROJECTION_PENDING_WINDOW_BUDGET,
  );
}

// Owner (2026-11-18, see FTC-COVERS-048): the first painted state that already holds the settled cards; LOCAL
// counts its cards, or its empty state when the album has none, and REMOTE counts cards plus placeholders.
function allCardsShownAtMs(samples, { includeRemote }) {
  const settled = samples.at(-1);
  expect(settled, 'Cover Lookup never painted its gallery.').toBeTruthy();
  const shown = samples.find(sample => (
    (settled.local > 0 ? sample.local === settled.local : sample.emptyLocal)
    && (!includeRemote || sample.remote + sample.remotePlaceholders >= settled.remote)
  ));
  expect(shown, JSON.stringify(samples.slice(0, 6))).toBeTruthy();
  return shown.atMs;
}

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
    const projectionPendingTimeline = recordProjectionPendingTimeline(page);
    await stepLogger.step('Open the fixture album through the production gallery and Album Details controls', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(TARGET.artist)}`);
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForSelectedArtistGallery(TARGET.artist);
      expect(await galleryActions.selectAlbumDetailsByIdentity(TARGET)).toEqual(TARGET);
      await trackModalActions.waitForLoadedSummary();
    });

    await trackModalActions.prepareCoverLookup();
    const firstOpening = await coverLookupActions.coverLookup.startOpeningObservation();
    const lookupStartedAt = performance.now();
    const modalVisible = await stepLogger.step('Measure the Cover Lookup modal becoming interactive', async () => (
      measureInteractionToPaint(
        page,
        () => trackModalActions.activateCoverLookup(),
        () => coverLookupActions.waitForModalReady(),
      )
    ));

    let readyCandidate = null;
    let candidateReadyMs = null;
    await stepLogger.step('Wait for one decoded provider candidate through the production cover proxy', async () => {
      await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
      const candidates = await coverLookupActions.readRemoteCandidateSummaries();
      readyCandidate = candidates[0];
      expect(readyCandidate?.id).toBeTruthy();
      await coverLookupActions.waitForRemoteCandidateDecoded(readyCandidate.id);
      candidateReadyMs = performance.now() - lookupStartedAt;
      const image = await coverLookupActions.readRemoteCandidateEvidence(readyCandidate.id);
      expect(image.sha256).not.toBe('');
    });

    const localCardsShownMs = await stepLogger.step('Measure every LOCAL card of the first opening', async () => {
      await coverLookupActions.waitForModalResultsReady();
      const samples = await coverLookupActions.coverLookup.finishOpeningObservation(firstOpening);
      return allCardsShownAtMs(samples, { includeRemote: false });
    });

    let selectedCandidate = null;
    await stepLogger.step('Wait for the Spotify candidate used by the save contract', async () => {
      const candidates = await coverLookupActions.readRemoteCandidateSummaries();
      selectedCandidate = candidates.find(
        (candidate) => candidate.source.toLocaleLowerCase() === 'spotify',
      );
      expect(selectedCandidate?.id).toBeTruthy();
      const image = await coverLookupActions.readRemoteCandidateEvidence(selectedCandidate.id);
      expect(image.sha256).not.toBe('');
    });

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
          ({ payload: savePayload } = await coverLookupActions.saveSelectedRemoteCandidate());
        },
        () => coverLookupActions.coverLookup.waitForHidden(coverLookupActions.coverLookup.modal),
      )
    ));
    expect(savePayload?.optimistic_cover_ref).toBe('');
    expect(savePayload?.optimistic_remote_source).toBe('spotify');
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);

    const reopenAllCardsShownMs = await stepLogger.step('Measure every card of the reopening after Save', async () => {
      await trackModalActions.prepareCoverLookup();
      const reopening = await coverLookupActions.coverLookup.startOpeningObservation();
      let samples;
      try {
        await trackModalActions.activateCoverLookup();
        await coverLookupActions.waitForModalReady();
        await coverLookupActions.waitForModalResultsReady();
      } finally {
        samples = await coverLookupActions.coverLookup.finishOpeningObservation(reopening);
      }
      await coverLookupActions.closeModal();
      return allCardsShownAtMs(samples, { includeRemote: true });
    });

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

    await coverLookupActions.closeModal();
    await trackModalActions.close();
    const projectionPending = await projectionPendingTimeline();

    const metrics = {
      modalVisibleMs: modalVisible.durationMs,
      candidateReadyMs,
      candidateSelectionMs: candidateSelection.durationMs,
      saveAcceptedMs: saveAccepted.durationMs,
      localCardsShownMs,
      projectionPendingPreReadyCount: projectionPending.preReadyPendingCount,
      projectionPendingWindows: projectionPending.windows.map(({ scope, code, durationMs, outcome }) => ({
        scope, code, durationMs, status: outcome.status,
      })),
      reopenAllCardsShownMs,
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
    for (const [index, pendingWindow] of projectionPending.windows.entries()) {
      const key = `projectionPendingWindowMs.${index + 1}`;
      await coverLookupLocalReport.recordTimingCheckpoint({
        key,
        label: `projection pending window ${index + 1}`,
        timingMs: pendingWindow.durationMs,
        details: { scope: pendingWindow.scope, code: pendingWindow.code, budgetMetricId: PROJECTION_PENDING_WINDOW_METRIC_ID },
      });
      expectTimingBudgetOutcome(expect.soft, pendingWindow.outcome, `${key} (${pendingWindow.scope})`);
    }
    for (const [label, measurement] of [
      ['modal open', modalVisible],
      ['candidate selection', candidateSelection],
      ['save acceptance', saveAccepted],
    ]) {
      expect.soft(
        measurement.maxLongTaskMs,
        `${label} produced a ${measurement.maxLongTaskMs} ms browser main-thread task. `
          + `Longest frames: ${JSON.stringify(measurement.longFrames)}`,
      ).toBeLessThanOrEqual(MAX_INTERACTION_LONG_TASK_MS);
    }
    expect(
      projectionPending.violations,
      'A gallery or search read answered 503 projection pending outside its one post-ready window.',
    ).toEqual([]);
    coverLookupLocalReport.recordContractCompletion();
  });
});
