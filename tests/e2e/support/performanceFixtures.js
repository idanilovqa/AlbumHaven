import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test as base } from './baseFixtures.js';
import { selectedPerformanceContractName } from '../helpers/timingBudget.js';
import { buildPerformanceAttemptTerminalEvidence } from '../helpers/performanceAttemptTerminalEvidence.js';

import {
  createPerformanceCheckpointRecorder,
  createScanStatusSampler,
  formatMegabytes,
  sampleMemoryPoint,
  samplePeakMemory,
  summarizePeakMemory,
} from '../helpers/index.js';

function buildIdleMemoryBudgetSummary({
  fixture,
  scrolledIdleSamples,
  detailRuns,
}) {
  const allSamples = [
    ...scrolledIdleSamples.map((sample) => ({ phase: 'scrolled-gallery-idle', ...sample })),
    ...detailRuns.flatMap((run, runIndex) => run.samples.map((sample) => ({
      phase: `after-album-detail-${runIndex + 1}`,
      visibleAlbumButtonIndex: run.visibleAlbumButtonIndex,
      ...sample,
    }))),
  ];

  const peakBytes = Math.max(...allSamples.map((sample) => Number(sample.bytes || 0)));
  const driftBytes = Number(allSamples.at(-1)?.bytes || 0) - Number(scrolledIdleSamples[0]?.bytes || 0);
  const sourceSet = [...new Set(allSamples.map((sample) => sample.source))].join(', ');
  const expectedPeakBytes = fixture.maxIdleMemoryMb * 1024 * 1024;
  const expectedDriftBytes = fixture.maxIdleDriftMb * 1024 * 1024;

  console.log(
    `[idle-memory] peak expected <= ${fixture.maxIdleMemoryMb} MB, actual ${formatMegabytes(peakBytes)} (${peakBytes} bytes), source=${sourceSet}`,
  );
  console.log(
    `[idle-memory] drift expected <= ${fixture.maxIdleDriftMb} MB, actual ${formatMegabytes(driftBytes)} (${driftBytes} bytes)`,
  );

  return {
    allSamples,
    peakBytes,
    driftBytes,
    sourceSet,
    expectedPeakBytes,
    expectedDriftBytes,
  };
}

function buildIdleMemoryObservedSummary({
  scrolledIdleSamples,
  detailRuns,
}) {
  const allSamples = [
    ...scrolledIdleSamples.map((sample) => ({ phase: 'scrolled-gallery-idle', ...sample })),
    ...detailRuns.flatMap((run, runIndex) => run.samples.map((sample) => ({
      phase: `after-album-detail-${runIndex + 1}`,
      visibleAlbumButtonIndex: run.visibleAlbumButtonIndex,
      ...sample,
    }))),
  ];

  return {
    allSamples,
    peakBytes: Math.max(0, ...allSamples.map((sample) => Number(sample.bytes || 0))),
    driftBytes: Number(allSamples.at(-1)?.bytes || 0) - Number(scrolledIdleSamples[0]?.bytes || 0),
    sourceSet: [...new Set(allSamples.map((sample) => sample.source))].join(', '),
    expectedPeakBytes: null,
    expectedDriftBytes: null,
  };
}

function createCheckpoint({
  key,
  label,
  timingMs = null,
  memoryBytes = null,
  memorySource = null,
  valueText = '',
  details = null,
  recordedAt = null,
}) {
  return {
    key,
    label,
    timingMs: timingMs === null ? null : Number(timingMs),
    memoryBytes: memoryBytes === null ? null : Number(memoryBytes),
    memorySource: memorySource || null,
    valueText: valueText || '',
    details: details || null,
    recordedAt: recordedAt || new Date().toISOString(),
  };
}

function buildIdleMemoryCheckpoints(scrolledIdleSamples, detailRuns) {
  const checkpoints = [];

  for (const [sampleIndex, sample] of scrolledIdleSamples.entries()) {
    checkpoints.push(createCheckpoint({
      key: `scrolled-gallery-idle-${sampleIndex + 1}`,
      label: `Scrolled gallery idle sample ${sampleIndex + 1}`,
      memoryBytes: sample.bytes,
      memorySource: sample.source,
      recordedAt: sample.recordedAt,
    }));
  }

  for (const [runIndex, detailRun] of detailRuns.entries()) {
    for (const [sampleIndex, sample] of detailRun.samples.entries()) {
      checkpoints.push(createCheckpoint({
        key: `detail-run-${runIndex + 1}-sample-${sampleIndex + 1}`,
        label: `Album detail ${runIndex + 1} idle sample ${sampleIndex + 1}`,
        memoryBytes: sample.bytes,
        memorySource: sample.source,
        recordedAt: sample.recordedAt,
        details: {
          visibleAlbumButtonIndex: detailRun.visibleAlbumButtonIndex,
        },
      }));
    }
  }

  return checkpoints;
}

function buildIdleMemorySummaryCards({ fixture, summary }) {
  const peakBudgetNote = fixture
    ? `Budget <= ${fixture.maxIdleMemoryMb.toFixed(1)} MB`
    : 'Budget unavailable';
  const driftBudgetNote = fixture
    ? `Budget <= ${fixture.maxIdleDriftMb.toFixed(1)} MB`
    : 'Budget unavailable';

  return [
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(summary.peakBytes),
      note: peakBudgetNote,
    },
    {
      label: 'Idle Drift',
      value: formatMegabytes(summary.driftBytes),
      note: driftBudgetNote,
    },
    {
      label: 'Memory Samples',
      value: String(summary.allSamples.length),
      note: summary.sourceSet || 'No source',
    },
  ];
}

function buildSyntheticPerformanceSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  const startupMs = Number(
    metricsPayload?.startupSidebarHydration?.coversMs
    ?? metricsPayload?.startupVisibleCoversMs
    ?? 0,
  );
  const returnMs = Number(
    metricsPayload?.allArtistsCoversMs
    ?? metricsPayload?.allArtistsReturn?.coversMs
    ?? 0,
  );
  const modalOpenMs = Number(
    metricsPayload?.albumDetailsOpenMs
    ?? metricsPayload?.albumDetails?.openMs
    ?? 0,
  );

  return [
    {
      label: 'Startup Covers Ready',
      value: `${Math.round(startupMs)} ms`,
      note: 'Initial All Artists visible covers',
    },
    {
      label: 'Return Covers Ready',
      value: `${Math.round(returnMs)} ms`,
      note: 'After the artist round-trip',
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
    {
      label: 'Album Details Open',
      value: `${Math.round(modalOpenMs)} ms`,
      note: 'Visible album modal open latency',
    },
  ];
}

function buildArtistFamilyLocalSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Search Gallery Ready',
      value: `${Math.round(Number(metricsPayload?.searchGalleryReadyMs || 0))} ms`,
      note: 'Neal Morse auto-selection family view',
    },
    {
      label: 'Cosmic Tree Ready',
      value: `${Math.round(Number(metricsPayload?.treeCosmicGalleryReadyMs || 0))} ms`,
      note: 'Filtered-tree switch to Cosmic Cathedral',
    },
    {
      label: 'Clear Search Ready',
      value: `${Math.round(Number(metricsPayload?.clearSearchReadyMs || 0))} ms`,
      note: 'Full tree restored with Neal Morse still selected',
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

function buildSearchAllArtistsLocalSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Search Auto-Select',
      value: `${Math.round(Number(metricsPayload?.searchAutoSelectionMs || 0))} ms`,
      note: 'Filtered tree selected Ария',
    },
    {
      label: 'All Artists Ready',
      value: `${Math.round(Number(metricsPayload?.allArtistsGalleryReadyMs || 0))} ms`,
      note: 'Search-scoped broad gallery ready',
    },
    {
      label: 'БИ-2 Gallery Ready',
      value: `${Math.round(Number(metricsPayload?.bi2GalleryReadyMs || 0))} ms`,
      note: 'Filtered tree follow-up selection',
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

function buildUtilityProblematicFilesLocalSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Problematic Files Ready',
      value: `${Math.round(Number(metricsPayload?.problematicReadyMs || 0))} ms`,
      note: Number(metricsPayload?.problematicReadyMs || 0) > 1000
        ? 'Grace used: above 1000 ms target; 1200 ms hard ceiling'
        : 'Target met: at or below 1000 ms; 1200 ms hard ceiling',
    },
    {
      label: 'Search Ready',
      value: `${Math.round(Number(metricsPayload?.searchReadyMs || 0))} ms`,
      note: `Representative token: ${metricsPayload?.searchToken || 'n/a'}`,
    },
    {
      label: 'Slowest Problem Filter',
      value: `${Math.round(Number(metricsPayload?.longestProblemFilterMs || 0))} ms`,
      note: `${Number(metricsPayload?.problemFilterCount || 0)} problem types checked`,
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

function buildUtilityRulesLocalSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  const secondaryTabTimings = [
    Number(metricsPayload?.loopsReadyMs || 0),
    Number(metricsPayload?.logHistoryReadyMs || 0),
    Number(metricsPayload?.integrationsReadyMs || 0),
    Number(metricsPayload?.appearanceReadyMs || 0),
  ].filter((value) => value > 0);
  return [
    {
      label: 'Rules Ready',
      value: `${Math.round(Number(metricsPayload?.rulesReadyMs || 0))} ms`,
      note: 'Settings open through Rules detail-ready state',
    },
    {
      label: 'Slowest Secondary Tab',
      value: `${Math.round(Math.max(0, ...secondaryTabTimings))} ms`,
      note: `${Number(metricsPayload?.validatedTabCount || 0)} utility tabs checked`,
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
    {
      label: 'Rules Count',
      value: String(Number(metricsPayload?.rulesCount || 0)),
      note: 'Rule rows visible in the sidebar',
    },
  ];
}

function buildSelectedArtistFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Artist UI Ready',
      value: `${Math.round(Number(metricsPayload?.selectedArtistApiMs || 0))} ms`,
      note: 'Visible sidebar selection into artist gallery',
    },
    {
      label: 'Selected Artist',
      value: String(metricsPayload?.selectedArtist || 'unknown'),
      note: 'library_browse rows',
    },
    {
      label: 'Albums',
      value: String(Number(metricsPayload?.albumCount || 0)),
      note: `${Number(metricsPayload?.trackPathCount || 0)} playable track paths`,
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildSearchBrowseFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Search UI Ready',
      value: `${Math.round(Number(metricsPayload?.searchBrowseApiMs || 0))} ms`,
      note: 'Visible search into filtered gallery',
    },
    {
      label: 'Query',
      value: String(metricsPayload?.query || 'unknown'),
      note: 'Chosen from the sidebar',
    },
    {
      label: 'Direct Matches',
      value: String(Number(metricsPayload?.directMatchCount || 0)),
      note: `${Number(metricsPayload?.albumCount || 0)} albums returned`,
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildRootAlbumBrowseFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Root Albums UI Ready',
      value: `${Math.round(Number(metricsPayload?.rootAlbumBrowseApiMs || 0))} ms`,
      note: 'Root open through All Artists sections and covers',
    },
    {
      label: 'Artist Groups',
      value: String(Number(metricsPayload?.artistGroupCount || 0)),
      note: `${Number(metricsPayload?.sidebarArtistCount || 0)} sidebar artists`,
    },
    {
      label: 'Albums',
      value: String(Number(metricsPayload?.albumCount || 0)),
      note: `${Number(metricsPayload?.flattenedAlbumCount || 0)} flattened albums`,
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildAppOpenAllArtistsFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Startup Root Hydration',
      value: String(Number(metricsPayload?.startupHydrationPayloadCount || 0)),
      note: 'Production empty-shell, fresh-preview, or full-view root payloads captured during app open',
    },
    {
      label: 'Visible UI Ready',
      value: `${Math.round(Number(metricsPayload?.visibleUiReadyMs || 0))} ms`,
      note: 'Sidebar, counts, sections, refresh, and covers',
    },
    {
      label: 'Artists',
      value: String(Number(metricsPayload?.artistCount || 0)),
      note: `${Number(metricsPayload?.sidebarArtistCount || 0)} sidebar artists`,
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildProblematicFilesFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Problematic Files UI Ready',
      value: `${Math.round(Number(metricsPayload?.problematicFilesApiMs || 0))} ms`,
      note: metricsPayload?.readinessGraceUsed
        ? 'GRACE USED — above 1000 ms target; within 1200 ms hard ceiling'
        : 'TARGET MET — at or below 1000 ms; 1200 ms hard ceiling',
    },
    {
      label: 'Problematic Items',
      value: String(Number(metricsPayload?.problematicItemCount || 0)),
      note: 'Utility projection rows',
    },
    {
      label: 'Detail Loaded Rows',
      value: String(Number(metricsPayload?.detailLoadedCount || 0)),
      note: 'List rows with detail state',
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildRulesFocusedLocalSummaryCards(_checkpoints, metricsPayload) {
  return [
    {
      label: 'Rules UI Ready',
      value: `${Math.round(Number(metricsPayload?.rulesApiMs || 0))} ms`,
      note: 'Visible Settings flow into Rules',
    },
    {
      label: 'Rule Groups',
      value: String(Number(metricsPayload?.ruleCount || 0)),
      note: 'Utility projection groups',
    },
    {
      label: 'Ignored Version Keys',
      value: String(Number(metricsPayload?.ignoredVersionKeyCount || 0)),
      note: 'Rules payload state',
    },
    {
      label: 'Source',
      value: String(metricsPayload?.viewDataSource || 'unknown'),
      note: String(metricsPayload?.persistenceBackend || 'unknown'),
    },
  ];
}

function buildScanColdSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Scan Start',
      value: `${Math.round(Number(metricsPayload?.sampleMetrics?.scanStartMs || 0))} ms`,
      note: 'First active scan state after cold open',
    },
    {
      label: '500 Folders',
      value: `${Math.round(Number(metricsPayload?.sampleMetrics?.folders500Ms || 0))} ms`,
      note: 'First server sample at or above 500 album folders',
    },
    {
      label: 'Scan Complete',
      value: `${Math.round(Number(metricsPayload?.sampleMetrics?.scanCompletedMs || 0))} ms`,
      note: 'Cold scan completion threshold',
    },
    {
      label: 'Browse Peak Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

function buildScanCachedSummaryCards(checkpoints, metricsPayload) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Startup Ready',
      value: `${Math.round(Number(metricsPayload?.startupReadyMs || 0))} ms`,
      note: 'Cached isolated startup to browse-ready state',
    },
    {
      label: 'Visible Scan',
      value: metricsPayload?.visibleScanTriggered ? 'Yes' : 'No',
      note: 'Unchanged cache should stay idle or near-idle',
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

function buildScanIncrementalSummaryCards(checkpoints, metricsPayload, label) {
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );
  return [
    {
      label: 'Scan Start',
      value: `${Math.round(Number(metricsPayload?.sampleMetrics?.scanStartMs || 0))} ms`,
      note: `${label} incremental scan start`,
    },
    {
      label: 'UI Updated',
      value: `${Math.round(Number(metricsPayload?.uiUpdatedMs || 0))} ms`,
      note: `${label} visible on the UI`,
    },
    {
      label: 'Scan Complete',
      value: `${Math.round(Number(metricsPayload?.sampleMetrics?.scanCompletedMs || 0))} ms`,
      note: `${label} incremental scan completion`,
    },
    {
      label: 'Peak Idle Memory',
      value: formatMegabytes(peakMemoryBytes),
      note: `${checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null).length} memory checkpoints`,
    },
  ];
}

async function useSyntheticPerformanceReportFixture({ page, performanceReport }, use, config) {
  const recorder = createPerformanceCheckpointRecorder(config.runLabel);
  let metricsPayload = null;
  const terminalTimingOutcomes = [];
  let contractComplete = false;

  await use({
    get checkpoints() {
      return recorder.checkpoints;
    },
    async recordTimingCheckpoint({ key, label, timingMs, details = null }) {
      const memorySample = await sampleMemoryPoint(page);
      return recorder.recordTimingCheckpoint({
        key,
        label,
        timingMs,
        memorySample,
        details,
      });
    },
    async recordPeakMemoryCheckpoint({
      key,
      label,
      details = null,
      sampleCount = 3,
      delayMs = 250,
    }) {
      const memorySummary = await samplePeakMemory(page, { sampleCount, delayMs });
      const peakSummary = summarizePeakMemory(memorySummary);
      recorder.recordMemoryCheckpoint({
        key,
        label,
        memoryBytes: peakSummary.bytes,
        memorySource: peakSummary.source,
        memorySamples: peakSummary.samples,
        details,
      });
      return memorySummary;
    },
    recordMemoryCheckpoint({ key, label, memorySummary, details = null }) {
      const peakSummary = summarizePeakMemory(memorySummary);
      return recorder.recordMemoryCheckpoint({
        key,
        label,
        memoryBytes: peakSummary.bytes,
        memorySource: peakSummary.source,
        memorySamples: peakSummary.samples,
        details,
      });
    },
    recordTextCheckpoint({ key, label, valueText, details = null }) {
      return recorder.recordTextCheckpoint({
        key,
        label,
        valueText,
        details,
      });
    },
    setMetricsPayload(payload) {
      metricsPayload = payload;
    },
    recordTerminalTimingOutcome(metricId, key, outcome) {
      terminalTimingOutcomes.push({ metricId, key, outcome });
    },
    recordContractCompletion() {
      contractComplete = true;
    },
  });

  if (contractComplete && terminalTimingOutcomes.length > 0) {
    const expectedMetricIds = config.expectedTimingMetricIds || [];
    if (expectedMetricIds.length !== terminalTimingOutcomes.length) {
      throw new Error(`${config.reportId} did not record every declared terminal timing metric.`);
    }
    metricsPayload = {
      ...(metricsPayload || {}),
      benchmarkValidation: {
        selectedContract: terminalTimingOutcomes[0].outcome.contractName,
        functionalChecksComplete: true,
        nonTimingChecksComplete: true,
        expectedMetricIds,
        results: terminalTimingOutcomes.map(({ metricId, key, outcome }) => ({
          key, metricId, contractName: outcome.contractName,
          units: 'ms', actual: outcome.actualMs, targetMaximum: outcome.targetMaximum,
          graceMs: outcome.graceMs, hardCeiling: outcome.hardCeiling,
          allowedMaximum: outcome.hardCeiling, performanceStatus: outcome.status,
          passed: outcome.passed,
        })),
      },
    };
  }

  performanceReport.publishRun({
    reportId: config.reportId,
    caseId: config.caseId,
    title: config.title,
    intro: config.intro,
    checkpoints: recorder.checkpoints,
    summaryCards: config.buildSummaryCards(recorder.checkpoints, metricsPayload),
    rawMetrics: {
      ...(metricsPayload || {}),
      checkpoints: recorder.checkpoints,
    },
  });
}

export const test = base.extend({
  startupRelationProjectionReadiness: [
    async ({}, use) => use(null),
    { scope: 'worker', auto: true },
  ],

  gaplessPlaybackFixture: async ({}, use) => {
    const tempRoot = String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
    if (!tempRoot) {
      throw new Error('ALBUM_HAVEN_E2E_TEMP_ROOT is required for gapless fixture metadata.');
    }
    const manifestPath = path.join(tempRoot, 'app-data', 'gapless-playback-fixture.json');
    const fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!fixture?.artist || !fixture?.album || !Array.isArray(fixture?.tracks)
        || fixture.tracks.length !== 10) {
      throw new Error(`Invalid gapless playback fixture manifest: ${manifestPath}`);
    }
    await use(Object.freeze({
      ...fixture,
      manifestPath,
      tracks: Object.freeze(fixture.tracks.map((track) => Object.freeze({ ...track }))),
    }));
  },

  scanStatusSampler: async ({}, use) => {
    const sampler = createScanStatusSampler();
    try {
      await use(sampler);
    } finally {
      await sampler.stop();
    }
  },

  performanceReport: async ({ stepLogger, testArtifacts }, use) => {
    let payload = null;

    await use({
      publishRun(nextPayload) {
        payload = nextPayload;
      },
    });

    if (!payload) {
      return;
    }

    const declaredValidation = payload.rawMetrics?.benchmarkValidation;
    const terminalValidation = declaredValidation
      ? buildPerformanceAttemptTerminalEvidence({
        ...declaredValidation,
        reporterFinalized: true,
        expectedMetricIds: declaredValidation.expectedMetricIds,
      })
      : null;
    if (declaredValidation) {
      payload = {
        ...payload,
        rawMetrics: { ...payload.rawMetrics, benchmarkValidation: terminalValidation },
      };
    }

    testArtifacts.queueJsonAttachment('performance-report-metrics', {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...payload,
      stepEvents: stepLogger.events,
      stepTranscript: stepLogger.transcript,
    });
  },

  playbackStartReport: async ({ performanceReport }, use) => {
    const attempts = [];
    let summary = null;
    let budget = null;
    let contractComplete = false;

    await use({
      recordAttempt(attempt) {
        attempts.push(attempt);
      },
      recordSummary(nextSummary) {
        summary = nextSummary;
      },
      recordBudget(nextBudget) {
        budget = nextBudget;
      },
      recordContractCompletion() {
        contractComplete = true;
      },
    });

    if (!attempts.length) return;
    const finalSummary = summary || {};
    const maximumBudget = budget?.maximumStart || {};
    const degradationBudget = budget?.degradation || {};
    performanceReport.publishRun({
      reportId: 'playbackStart',
      caseId: 'FTC-PLAYER-013',
      title: 'Album-Detail Playback Start Benchmark',
      intro: 'Generated-media playback-start timing through the production album popup, player, FastAPI media route, and isolated Postgres authority.',
      checkpoints: attempts.map((attempt, index) => ({
        key: `playback-start-${index + 1}`,
        label: attempt.label,
        timingMs: Number(attempt.elapsedMs || 0),
        memoryBytes: null,
        memorySource: null,
        valueText: `${Math.round(Number(attempt.elapsedMs || 0))} ms`,
        details: {
          rowIndex: attempt.rowIndex,
          track: attempt.track,
          diagnostics: attempt.diagnostics,
          trackTraffic: attempt.trackTraffic,
        },
        recordedAt: new Date().toISOString(),
      })),
      summaryCards: [
        {
          label: 'Maximum Start',
          value: `${Math.round(Number(finalSummary.maximumMs || 0))} ms`,
          note: `Target ${maximumBudget.targetMaximum} ms | hard ceiling ${maximumBudget.hardCeiling} ms | ${maximumBudget.status}`,
        },
        {
          label: 'Early / Late Median',
          value: `${Math.round(Number(finalSummary.earlyMedianMs || 0))} / ${Math.round(Number(finalSummary.lateMedianMs || 0))} ms`,
          note: `Delta ${Math.round(Number(finalSummary.degradationMs || 0))} ms | limit ${degradationBudget.maximumAllowedMs} ms | ${degradationBudget.status}`,
        },
        {
          label: 'Decoded Cache',
          value: String(Number(finalSummary.finalDecodedTrackCacheSize || 0)),
          note: 'Production decoded AudioBuffer entries after final start',
        },
      ],
      rawMetrics: {
        attempts,
        summary: finalSummary,
        budget,
        budgetStatus: budget?.overallStatus || 'hard-fail',
        benchmarkValidation: contractComplete ? {
          selectedContract: selectedPerformanceContractName(),
          functionalChecksComplete: true,
          nonTimingChecksComplete: true,
          expectedMetricIds: ['playback-start.maximumStartMs'],
          results: [{
            key: 'maximumStartMs',
            metricId: 'playback-start.maximumStartMs',
            contractName: selectedPerformanceContractName(),
            units: 'ms',
            actual: Number(finalSummary.maximumMs),
            targetMaximum: Number(maximumBudget.targetMaximum),
            graceMs: Number(maximumBudget.graceMs),
            hardCeiling: Number(maximumBudget.hardCeiling),
            allowedMaximum: Number(maximumBudget.hardCeiling),
            passed: maximumBudget.status !== 'hard-fail',
            performanceStatus: maximumBudget.status,
          }],
        } : null,
      },
    });
  },

  gaplessPlaybackReport: async ({ performanceReport }, use) => {
    let boundary = null;
    let timingOutcome = null;
    let contractComplete = false;
    await use({
      recordBoundary(value) {
        boundary = value;
      },
      recordTimingOutcome(value) {
        timingOutcome = value;
      },
      recordContractCompletion() {
        contractComplete = true;
      },
    });
    if (!boundary) return;
    performanceReport.publishRun({
      reportId: 'gaplessPlayback',
      caseId: 'FTC-PLAYER-016',
      title: 'Streaming Gapless Playback Boundary',
      intro: 'Generated lossless sample-boundary coverage through production PCM streaming and AudioWorklet diagnostics.',
      checkpoints: [{
        key: 'gapless-boundary',
        label: 'Sample-exact boundary',
        timingMs: null,
        memoryBytes: null,
        memorySource: null,
        valueText: `${Number(boundary.diagnostics?.boundaryCapture?.outgoing?.frames || 0)} frames`,
        details: boundary,
        recordedAt: new Date().toISOString(),
      }],
      summaryCards: [{
        label: 'Ordinary Underruns',
        value: String(Number(boundary.diagnostics?.underruns || 0)),
        note: 'Expected zero across the measured boundary.',
      }],
      rawMetrics: {
        ...boundary,
        benchmarkValidation: contractComplete && timingOutcome ? {
          selectedContract: timingOutcome.contractName,
          functionalChecksComplete: true,
          nonTimingChecksComplete: true,
          expectedMetricIds: ['gapless-playback.playbackBoundaryMs'],
          results: [{
            key: 'playbackBoundaryMs',
            metricId: 'gapless-playback.playbackBoundaryMs',
            contractName: timingOutcome.contractName,
            units: 'ms',
            actual: timingOutcome.actualMs,
            targetMaximum: timingOutcome.targetMaximum,
            graceMs: timingOutcome.graceMs,
            hardCeiling: timingOutcome.hardCeiling,
            allowedMaximum: timingOutcome.hardCeiling,
            performanceStatus: timingOutcome.status,
            passed: timingOutcome.passed,
          }],
        } : null,
      },
    });
  },

  idleMemoryReport: async ({ performanceReport }, use) => {
    const state = {
      scrolledIdleSamples: [],
      detailRuns: [],
      budgetSummary: null,
      fixture: null,
    };

    await use({
      recordScrolledGallerySamples(samples) {
        state.scrolledIdleSamples = samples;
      },
      recordDetailRuns(detailRuns) {
        state.detailRuns = detailRuns;
      },
      summarizeBudget(input) {
        state.fixture = input.fixture;
        state.budgetSummary = buildIdleMemoryBudgetSummary(input);
        return state.budgetSummary;
      },
    });

    if (!state.scrolledIdleSamples.length && !state.detailRuns.length) {
      return;
    }

    const summary = state.budgetSummary
      || (state.fixture
        ? buildIdleMemoryBudgetSummary({
          fixture: state.fixture,
          scrolledIdleSamples: state.scrolledIdleSamples,
          detailRuns: state.detailRuns,
        })
        : buildIdleMemoryObservedSummary({
          scrolledIdleSamples: state.scrolledIdleSamples,
          detailRuns: state.detailRuns,
        }));
    performanceReport.publishRun({
      reportId: 'idleMemory',
      caseId: 'FTC-GALLERY-STARTUP-005',
      title: 'Idle Gallery Memory Benchmark',
      intro: 'This performance report focuses on idle-memory retention after All Artists startup settles, with chart-first views for step timings and memory samples.',
      checkpoints: buildIdleMemoryCheckpoints(state.scrolledIdleSamples, state.detailRuns),
      summaryCards: buildIdleMemorySummaryCards({
        fixture: state.fixture,
        summary,
      }),
      rawMetrics: {
        fixture: state.fixture,
        scrolledIdleSamples: state.scrolledIdleSamples,
        detailRuns: state.detailRuns,
        budgetSummary: summary,
        benchmarkValidation: state.fixture ? {
          selectedContract: selectedPerformanceContractName(),
          functionalChecksComplete: true,
          nonTimingChecksComplete: true,
          expectedMetricIds: [],
          results: [
            {
              key: 'peakBytes', units: 'bytes', actual: summary.peakBytes,
              hardCeiling: summary.expectedPeakBytes, allowedMaximum: summary.expectedPeakBytes,
              passed: summary.peakBytes <= summary.expectedPeakBytes,
            },
            {
              key: 'driftBytes', units: 'bytes', actual: summary.driftBytes,
              hardCeiling: summary.expectedDriftBytes, allowedMaximum: summary.expectedDriftBytes,
              passed: summary.driftBytes <= summary.expectedDriftBytes,
            },
          ],
        } : null,
      },
    });
  },

  allArtistsLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'all-artists-local',
      reportId: 'allArtistsLocal',
      caseId: 'FTC-GALLERY-STARTUP-005A',
      title: 'All Artists Synthetic-Dataset Responsiveness Benchmark',
      intro: 'This synthetic performance report captures startup, sidebar, gallery, modal, and idle-memory checkpoints with historical trend charts across repeated runs.',
      buildSummaryCards: buildSyntheticPerformanceSummaryCards,
    });
  },

  artistFamilyLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'artist-family-local',
      reportId: 'artistFamilyLocal',
      caseId: 'FTC-SEARCH-NAV-005A',
      title: 'Neal Morse Artist Family Synthetic-Dataset Responsiveness Benchmark',
      intro: 'This synthetic performance report captures Neal Morse search, filtered-tree clicks, family-chip filtering, album-details modal timing, settings toggles, clear-search recovery, and idle-memory checkpoints with retained report history.',
      buildSummaryCards: buildArtistFamilyLocalSummaryCards,
    });
  },

  searchAllArtistsLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'search-all-artists-local',
      reportId: 'searchAllArtistsLocal',
      caseId: 'FTC-SEARCH-NAV-003A',
      title: 'Multi-Family Search All Artists Synthetic-Dataset Responsiveness Benchmark',
      intro: 'This synthetic performance report captures multi-family search auto-selection, search-scoped All artists browsing, deep-scroll cover recovery, follow-up tree selection, and idle-memory checkpoints with retained report history.',
      buildSummaryCards: buildSearchAllArtistsLocalSummaryCards,
    });
  },

  utilityProblematicFilesLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'utility-problematic-files-local',
      reportId: 'utilityProblematicFilesLocal',
      caseId: 'FTC-UTIL-PROBLEMS-009',
      title: 'Utilities Problematic Files Isolated-Data Responsiveness Benchmark',
      intro: 'This local-only performance report uses isolated Postgres and generated media to capture the immediate root-to-Settings Problematic Files open path, search responsiveness, per-problem filter review, and idle-memory checkpoints without reading the owner library.',
      buildSummaryCards: buildUtilityProblematicFilesLocalSummaryCards,
    });
  },

  utilityRulesLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'utility-rules-local',
      reportId: 'utilityRulesLocal',
      caseId: 'FTC-UTIL-RULES-002',
      title: 'Utilities Rules And Tab Readiness Real-Data Responsiveness Benchmark',
      intro: 'This local-only performance report captures the warmed Settings > Rules open path plus Loops, Log History, Integrations, and Appearance readiness timings and idle-memory checkpoints with retained report history.',
      buildSummaryCards: buildUtilityRulesLocalSummaryCards,
    });
  },

  selectedArtistFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'selected-artist-focused-local',
      reportId: 'selectedArtistFocusedLocal',
      caseId: 'FTC-GALLERY-STARTUP-005Q',
      title: 'Selected Artist Browse Benchmark',
      intro: 'This synthetic performance report captures the visible selected-artist UI flow through the selected library_browse repository after choosing a concrete artist from the root sidebar. It is a focused seam checkpoint inside the broader synthetic performance suite.',
      buildSummaryCards: buildSelectedArtistFocusedLocalSummaryCards,
      expectedTimingMetricIds: [
        'selected-artist.selectedArtistApiMs',
        'selected-artist.albumDetailsOpenMs',
      ],
    });
  },

  searchBrowseFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'search-browse-focused-local',
      reportId: 'searchBrowseFocusedLocal',
      caseId: 'FTC-GALLERY-STARTUP-005R',
      title: 'Visible Search Browse Benchmark',
      intro: 'This synthetic performance report captures the visible search UI flow through the selected library_browse repository after choosing a query from the root sidebar. It is a focused seam checkpoint inside the broader synthetic performance suite.',
      buildSummaryCards: buildSearchBrowseFocusedLocalSummaryCards,
      expectedTimingMetricIds: ['search-browse.searchBrowseReadyMs'],
    });
  },

  rootAlbumBrowseFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'root-album-browse-focused-local',
      reportId: 'rootAlbumBrowseFocusedLocal',
      caseId: 'FTC-GALLERY-STARTUP-005S',
      title: 'Root Album Browse UI Benchmark',
      intro: 'This synthetic performance report captures the visible root All Artists gallery flow through the selected library_browse repository. It is a focused seam checkpoint inside the broader synthetic performance suite.',
      buildSummaryCards: buildRootAlbumBrowseFocusedLocalSummaryCards,
      expectedTimingMetricIds: ['root-album-browse.rootAlbumBrowseApiMs'],
    });
  },

  appOpenAllArtistsFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'app-open-all-artists-focused-local',
      reportId: 'appOpenAllArtistsFocusedLocal',
      caseId: 'FTC-GALLERY-STARTUP-005T',
      title: 'App-Open All Artists UI Benchmark',
      intro: 'This local-only performance report captures app-open visible All Artists UI readiness through the normal root route, then separately records the explicit full root browse proof through the selected library_browse repository. The retained target name covers both phases without pretending they are the same checkpoint.',
      buildSummaryCards: buildAppOpenAllArtistsFocusedLocalSummaryCards,
    });
  },

  problematicFilesFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'problematic-files-focused-local',
      reportId: 'problematicFilesFocusedLocal',
      caseId: 'FTC-UTIL-PROBLEMS-010',
      title: 'Problematic Files UI Benchmark',
      intro: 'This local-only performance report captures the visible Settings > Problematic Files UI load path through isolated normal Postgres product tables so the benchmark stays non-empty and repeatable.',
      buildSummaryCards: buildProblematicFilesFocusedLocalSummaryCards,
    });
  },

  rulesFocusedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'rules-focused-local',
      reportId: 'rulesFocusedLocal',
      caseId: 'FTC-UTIL-RULES-002P',
      title: 'Utility Rules And Tab Readiness UI Benchmark',
      intro: 'This local-only performance report captures the visible Settings > Rules UI flow, then verifies Loops, Log History, Integrations, and Appearance readiness through the sibling utility tabs.',
      buildSummaryCards: buildRulesFocusedLocalSummaryCards,
      expectedTimingMetricIds: [
        'utility-rules-local-managed-chrome.rulesReadyMs',
        'utility-rules-local-managed-chrome.loopsReadyMs',
        'utility-rules-local-managed-chrome.logHistoryReadyMs',
        'utility-rules-local-managed-chrome.integrationsReadyMs',
        'utility-rules-local-managed-chrome.appearanceReadyMs',
      ],
    });
  },

  scanColdLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'scan-cold-local',
      reportId: 'scanColdLocal',
      caseId: 'FTC-OPS-014',
      title: 'Cold Scanner/Index/Cache Isolated Benchmark',
      intro: 'This isolated scanner/index/cache benchmark captures scanner startup, discovery, indexing, 100/300/500-folder thresholds, browse-during-scan responsiveness, and browse memory checkpoints against generated temporary media fixtures. Phase 6 requires this suite to use isolated Postgres-backed scan/cache/index state; it remains separate from real-app Postgres browse/load benchmarks because it measures scanner behavior.',
      buildSummaryCards: buildScanColdSummaryCards,
      expectedTimingMetricIds: [
        'scan-cold.activeBackStableMs', 'scan-cold.activeBackReadyMs',
        'scan-cold.resumeBrowseStableMs', 'scan-cold.resumeBrowseReadyMs',
      ],
    });
  },

  scanCachedLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'scan-cached-local',
      reportId: 'scanCachedLocal',
      caseId: 'FTC-OPS-015',
      title: 'Cached Scanner/Index/Cache Isolated Benchmark',
      intro: 'This isolated scanner/index/cache benchmark captures unchanged-cache cold-runtime startup to confirm the scan stays absent or trivially brief when the generated fixture library did not change. Phase 6 requires this suite to use isolated Postgres-backed scan/cache/index state; it remains separate from real-app Postgres browse/load benchmarks because it measures scanner cache reuse.',
      buildSummaryCards: buildScanCachedSummaryCards,
      expectedTimingMetricIds: ['scan-cached.startupReadyMs'],
    });
  },

  scanAddAlbumLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'scan-add-album-local',
      reportId: 'scanAddAlbumLocal',
      caseId: 'FTC-OPS-016',
      title: 'Incremental New Album Scanner/Index/Cache Isolated Benchmark',
      intro: 'This isolated scanner/index/cache benchmark captures incremental scan timing from one new temporary album addition through visible UI appearance and settled idle memory. Phase 6 requires this suite to use isolated Postgres-backed scan/cache/index state; it remains separate from real-app Postgres browse/load benchmarks because it measures incremental scanner behavior.',
      buildSummaryCards: (checkpoints, metricsPayload) => buildScanIncrementalSummaryCards(checkpoints, metricsPayload, 'New album'),
      expectedTimingMetricIds: ['scan-add-album.uiUpdatedMs'],
    });
  },

  scanMetadataLocalReport: async ({ page, performanceReport }, use) => {
    await useSyntheticPerformanceReportFixture({ page, performanceReport }, use, {
      runLabel: 'scan-metadata-local',
      reportId: 'scanMetadataLocal',
      caseId: 'FTC-OPS-017',
      title: 'Incremental Metadata Scanner/Index/Cache Isolated Benchmark',
      intro: 'This isolated scanner/index/cache benchmark captures incremental scan timing from one temporary metadata change through visible UI update and settled idle memory. Phase 6 requires this suite to use isolated Postgres-backed scan/cache/index state; it remains separate from real-app Postgres browse/load benchmarks because it measures incremental scanner behavior.',
      buildSummaryCards: (checkpoints, metricsPayload) => buildScanIncrementalSummaryCards(checkpoints, metricsPayload, 'Metadata change'),
      expectedTimingMetricIds: [
        'scan-metadata.cachedBrowseReadyMs', 'scan-metadata.cachedBrowseStableMs',
        'scan-metadata.searchReadyMs',
      ],
    });
  },
});

export { expect };
