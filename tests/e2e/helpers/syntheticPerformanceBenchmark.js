import thresholdClassification from '../../../scripts/performance-threshold-classification.cjs';
import {
  evaluateTimingBudget,
  formatTimingBudgetOutcome,
  performanceTimingBudget,
  selectedPerformanceContractName,
} from './timingBudget.js';

const { classifyPerformanceThreshold } = thresholdClassification;

const MEGABYTE = 1024 * 1024;
const TIMING_CONTRACT_OVERRIDES = Object.freeze({
  'all-artists-local-managed-chrome.startupPreviewSidebarMs': 'all-artists.startupPreviewSidebarMs',
  'artist-family-local-managed-chrome.treeNealSelectionMs': 'artist-family.treeNealSelectionMs',
  'search-all-artists-local-managed-chrome.allArtistsSelectionMs': 'search-all-artists.allArtistsSelectionMs',
  'app-open-all-artists-local-managed-chrome.visibleUiReadyMs': 'app-open-all-artists.visibleUiReadyMs',
});

function defineBenchmark(benchmark) {
  return {
    ...benchmark,
    expectations: benchmark.expectations.map((expectation) => {
      if (expectation.units !== 'ms') {
        return expectation;
      }
      const defaultMetricId = `${benchmark.id}.${expectation.key}`;
      const metricId = TIMING_CONTRACT_OVERRIDES[defaultMetricId] || defaultMetricId;
      const timingBudget = performanceTimingBudget(metricId);
      return {
        ...expectation,
        ...timingBudget,
        maxAllowed: timingBudget.hardCeiling,
      };
    }),
  };
}

function formatMilliseconds(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : 'unavailable';
}

function formatBytes(value) {
  return Number.isFinite(Number(value))
    ? `${(Number(value) / MEGABYTE).toFixed(1)} MB (${Math.round(Number(value))} bytes)`
    : 'unavailable';
}

function readMetricValue(metrics, metricPath) {
  return String(metricPath || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => current?.[key], metrics);
}

function formatMetricValue(units, value) {
  if (units === 'bytes') {
    return formatBytes(value);
  }
  return formatMilliseconds(value);
}

function readIdleSampleBytes(metrics, metricPath) {
  const idleSamples = readMetricValue(metrics, metricPath);
  if (!Array.isArray(idleSamples)) {
    return [];
  }
  return idleSamples.map((sample) => Number(sample?.bytes || 0));
}

function evaluateExpectation(expectation, metrics) {
  const rawActual = readMetricValue(metrics, expectation.metricPath);
  const actual = (
    rawActual !== null
    && rawActual !== undefined
    && !(typeof rawActual === 'string' && rawActual.trim() === '')
  ) ? Number(rawActual) : Number.NaN;
  const timingOutcome = expectation.units === 'ms'
    ? evaluateTimingBudget(actual, expectation)
    : null;
  const thresholdOutcome = timingOutcome || classifyPerformanceThreshold({
    units: expectation.units,
    actual,
    hardCeiling: expectation.maxAllowed,
  });
  const result = {
    ...expectation,
    actual,
    actualText: formatMetricValue(expectation.units, actual),
    baselineText: formatMetricValue(expectation.units, expectation.observedBaseline),
    allowedText: formatMetricValue(expectation.units, expectation.maxAllowed),
    rangeText: `${formatMetricValue(expectation.units, expectation.observedRange.min)} .. ${formatMetricValue(expectation.units, expectation.observedRange.max)}`,
    passed: thresholdOutcome.passed,
    graceMs: timingOutcome?.graceMs ?? null,
    hardCeiling: timingOutcome?.hardCeiling ?? Number(expectation.maxAllowed),
    performanceStatus: timingOutcome?.status ?? thresholdOutcome.performanceStatus,
    thresholdPassed: thresholdOutcome.thresholdPassed ?? thresholdOutcome.passed,
    policyPassed: thresholdOutcome.policyPassed ?? thresholdOutcome.passed,
    targetMet: timingOutcome?.targetMet ?? null,
    graceUsed: timingOutcome?.graceUsed ?? false,
  };

  if (expectation.key === 'allArtistsReturnMemoryBytes') {
    const sampleBytes = readIdleSampleBytes(metrics, 'allArtistsReturnMemory.idleSamples');
    const overThresholdCount = sampleBytes.filter((value) => value > Number(expectation.maxAllowed)).length;
    const policyEvidence = {
      classificationPolicy: 'all-artists-return-memory-sample-window',
      sampleCount: sampleBytes.length,
      overThresholdCount,
      failingSampleCount: 2,
    };
    const policyOutcome = classifyPerformanceThreshold({
      units: expectation.units,
      actual,
      hardCeiling: expectation.maxAllowed,
      ...policyEvidence,
    });
    Object.assign(result, policyEvidence, {
      performanceStatus: policyOutcome.performanceStatus,
      thresholdPassed: policyOutcome.thresholdPassed,
      policyPassed: policyOutcome.policyPassed,
      passed: policyOutcome.passed,
    });
    if (sampleBytes.length > 0) {
      result.actualText = `${formatMetricValue(expectation.units, actual)} peak; ${overThresholdCount}/${sampleBytes.length} samples over ceiling`;
    }
  }

  return result;
}

function formatBenchmarkFailure(result, rangeLabel = 'Observed range') {
  const classification = result.units === 'ms' ? 'hard-fail' : 'failed';
  return `${result.key} ${classification}: exceeded ${result.allowedText}; actual ${result.actualText}. `
    + `${rangeLabel} ${result.rangeText}. ${result.description}`;
}

export function buildBenchmarkValidationPayload(benchmarkEvaluation) {
  const benchmark = benchmarkEvaluation?.benchmark;
  const results = Array.isArray(benchmarkEvaluation?.results)
    ? benchmarkEvaluation.results
    : [];

  return {
    benchmarkId: benchmark?.id || '',
    benchmarkVersion: benchmark?.version || '',
    selectedContract: selectedPerformanceContractName(),
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    expectedMetricIds: (benchmark?.expectations || [])
      .filter((expectation) => expectation.units === 'ms')
      .map((expectation) => expectation.metricId),
    datasetContract: benchmark?.datasetContract || null,
    sampleWindow: benchmark?.sampleWindow || null,
    results: results.map((result) => ({
      key: result.key,
      metricId: result.metricId || null,
      contractName: result.contractName || selectedPerformanceContractName(),
      checkpointKey: result.checkpointKey,
      description: result.description,
      units: result.units,
      actual: result.actual,
      actualText: result.actualText,
      observedBaseline: result.observedBaseline,
      observedRange: result.observedRange,
      allowedMaximum: result.maxAllowed,
      allowedText: result.allowedText,
      targetMaximum: result.targetMaximum,
      graceMs: result.graceMs,
      hardCeiling: result.hardCeiling,
      performanceStatus: result.performanceStatus,
      targetMet: result.targetMet,
      graceUsed: Boolean(result.graceUsed),
      classificationPolicy: result.classificationPolicy,
      sampleCount: result.sampleCount,
      overThresholdCount: result.overThresholdCount,
      failingSampleCount: result.failingSampleCount,
      thresholdPassed: result.thresholdPassed,
      policyPassed: result.policyPassed,
      passed: result.passed,
    })),
  };
}

export function evaluateProblematicFilesDatasetContract(payload, datasetContract) {
  const failures = [];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const expectedCount = Number(datasetContract?.problematicItemCount);
  const expectedAlbums = Array.isArray(datasetContract?.expectedProblematicAlbums)
    ? datasetContract.expectedProblematicAlbums
    : [];
  const normalizeStringSet = (values) => (
    [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value).trim())
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
  );
  const expectedProblemReasons = normalizeStringSet(datasetContract?.expectedProblemReasons);

  if (!Array.isArray(payload?.items)) {
    failures.push('Problematic Files payload must expose an items array.');
  }
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    failures.push('The isolated Problematic Files contract must declare a positive exact item count.');
  } else if (Number(payload?.count) !== expectedCount || items.length !== expectedCount) {
    const observedRows = items.map((item) => {
      const observedReasons = Array.isArray(item?.problem_reasons)
        ? item.problem_reasons.map((reason) => String(reason))
        : [];
      return `${String(item?.album_artist || '')} / ${String(item?.name || '')}`
        + ` [${observedReasons.join(', ')}]`;
    });
    failures.push(
      `Expected exactly ${expectedCount} isolated Problematic Files rows; `
      + `received count=${String(payload?.count)} and items.length=${items.length}. `
      + `Observed rows: ${observedRows.join(' | ')}.`,
    );
  }
  for (const item of items) {
    const leakedDetailFields = [
      'track_problem_rows',
      'repair_preview_rows',
      'problematic_track_paths',
    ].filter((field) => item?.[field] !== undefined);
    if (item?.detail_loaded !== false || leakedDetailFields.length > 0) {
      failures.push(
        `Summary row "${String(item?.key || '')}" must remain compact; `
        + `detail_loaded=${String(item?.detail_loaded)} leaked=${leakedDetailFields.join(',') || 'none'}.`,
      );
    }
  }
  for (const expectedAlbum of expectedAlbums) {
    const artist = String(expectedAlbum?.artist || '');
    const album = String(expectedAlbum?.album || '');
    const matches = items.filter((item) => (
      String(item?.album_artist || '') === artist
      && String(item?.name || '') === album
    ));
    if (matches.length !== 1) {
      failures.push(
        `Expected isolated fixture "${artist} / ${album}" exactly once; received ${matches.length}.`,
      );
      continue;
    }
    const actualReasons = normalizeStringSet(matches[0]?.problem_reasons);
    const expectedReasons = normalizeStringSet(expectedAlbum?.problemReasons);
    if (JSON.stringify(actualReasons) !== JSON.stringify(expectedReasons)) {
      failures.push(
        `Expected isolated fixture "${artist} / ${album}" to report exactly `
        + `[${expectedReasons.join(', ')}]; received [${actualReasons.join(', ')}].`,
      );
    }
  }
  const actualProblemReasons = normalizeStringSet(
    items.flatMap((item) => (Array.isArray(item?.problem_reasons) ? item.problem_reasons : [])),
  );
  if (JSON.stringify(actualProblemReasons) !== JSON.stringify(expectedProblemReasons)) {
    failures.push(
      `Expected isolated Problematic Files reason set [${expectedProblemReasons.join(', ')}]; `
      + `received [${actualProblemReasons.join(', ')}].`,
    );
  }
  const firstItem = items[0];
  const initialDetail = payload?.initial_detail;
  if (!firstItem || !initialDetail) {
    failures.push('The isolated Problematic Files payload must include a first summary and initial detail.');
  } else {
    if (String(initialDetail.key || '') !== String(firstItem.key || '')) {
      failures.push('The isolated initial detail must match the first sorted summary row.');
    }
    if (initialDetail.detail_loaded !== true) {
      failures.push('The isolated initial detail must be fully loaded.');
    }
  }

  return failures;
}

export function formatBenchmarkTimingResults(benchmarkEvaluation) {
  const results = Array.isArray(benchmarkEvaluation?.results)
    ? benchmarkEvaluation.results
    : [];
  return results
    .filter((result) => result.units === 'ms')
    .map((result) => `[performance-budget] ${result.key}: ${formatTimingBudgetOutcome(
      result.description || result.key,
      {
        actualMs: result.actual,
        targetMaximum: result.targetMaximum,
        graceMs: result.graceMs,
        hardCeiling: result.hardCeiling,
        status: result.performanceStatus,
      },
    )}`);
}

export function logBenchmarkTimingResults(benchmarkEvaluation, log = console.log) {
  const lines = formatBenchmarkTimingResults(benchmarkEvaluation);
  lines.forEach((line) => log(line));
  return lines;
}

export const ALL_ARTISTS_LOCAL_BENCHMARK = defineBenchmark({
  id: 'all-artists-local-managed-chrome',
  version: '2026-06-30-asgi-managed-chrome-all-artists-badge-sync',
  caseId: 'FTC-GALLERY-STARTUP-005A',
  description: 'Managed local real-data Chrome benchmark ceilings for the All Artists round-trip responsiveness and memory guard.',
  sampleWindow: {
    collectedOn: '2026-06-30',
    browser: 'chrome',
    mode: 'managed local real-data app',
    sampleSize: 5,
  },
  expectations: [
    {
      key: 'startupPreviewSidebarMs',
      checkpointKey: 'startup-preview-sidebar',
      metricPath: 'startupSidebarHydration.previewSidebarMs',
      units: 'ms',
      description: 'Startup preview sidebar should appear quickly from the cached preview.',
      observedBaseline: 400,
      observedRange: { min: 122, max: 154 },
      maxAllowed: 881,
    },
    {
      key: 'startupFullSidebarMs',
      checkpointKey: 'startup-full-sidebar',
      metricPath: 'startupSidebarHydration.fullSidebarMs',
      units: 'ms',
      description: 'The cached full sidebar expansion should finish well before a multi-second stall becomes obvious.',
      observedBaseline: 4254,
      observedRange: { min: 3675, max: 5808 },
      maxAllowed: 6000,
    },
    {
      key: 'startupFullAllArtistsCountMs',
      checkpointKey: 'startup-full-all-artists-count',
      metricPath: 'startupSidebarHydration.fullCountSynchronizedMs',
      units: 'ms',
      description: 'The All artists badge should reach the real hydrated sidebar total within the full-sidebar hydration window.',
      observedBaseline: 4850,
      observedRange: { min: 4349, max: 5090 },
      maxAllowed: 6000,
    },
    {
      key: 'startupFirstAlbumsMs',
      checkpointKey: 'startup-first-albums',
      metricPath: 'startupSidebarHydration.firstAlbumsMs',
      units: 'ms',
      description: 'The first album groups for initial All Artists startup should render promptly.',
      observedBaseline: 113,
      observedRange: { min: 76, max: 147 },
      maxAllowed: 300,
    },
    {
      key: 'startupVisibleCoversMs',
      checkpointKey: 'startup-visible-covers',
      metricPath: 'startupSidebarHydration.coversMs',
      units: 'ms',
      description: 'Initial visible covers should finish loading quickly once the startup gallery is present.',
      observedBaseline: 93,
      observedRange: { min: 67, max: 128 },
      maxAllowed: 320,
    },
    {
      key: 'initialIdleMemoryBytes',
      checkpointKey: 'startup-idle-memory',
      metricPath: 'initialMemory.peakBytes',
      units: 'bytes',
      description: 'Settled All Artists startup memory should stay near the warm idle baseline before deeper browsing.',
      observedBaseline: 17254619,
      observedRange: { min: 17237312, max: 17267052 },
      maxAllowed: 18 * MEGABYTE,
    },
    {
      key: 'selectedArtistSelectionMs',
      checkpointKey: 'selected-artist-selection-visible',
      metricPath: 'selectedArtistSelectionMs',
      units: 'ms',
      description: 'Selecting one visible artist from the All Artists tree should visibly apply without a laggy pause.',
      observedBaseline: 121,
      observedRange: { min: 75, max: 208 },
      maxAllowed: 350,
    },
    {
      key: 'selectedArtistGalleryMs',
      checkpointKey: 'selected-artist-gallery-ready',
      metricPath: 'selectedArtistGalleryMs',
      units: 'ms',
      description: 'The selected artist gallery should become ready within the observed warm real-data envelope.',
      observedBaseline: 2196,
      observedRange: { min: 1573, max: 3636 },
      maxAllowed: 3200,
    },
    {
      key: 'allArtistsSelectionMs',
      checkpointKey: 'all-artists-selection-visible',
      metricPath: 'allArtistsSelectionMs',
      units: 'ms',
      description: 'Returning to All Artists should show the selection change promptly.',
      observedBaseline: 802,
      observedRange: { min: 649, max: 1177 },
      maxAllowed: 1800,
    },
    {
      key: 'allArtistsFirstAlbumsMs',
      checkpointKey: 'all-artists-first-albums-visible',
      metricPath: 'allArtistsFirstAlbumsMs',
      units: 'ms',
      description: 'The first All Artists albums should reappear quickly after the round-trip back from a selected artist.',
      observedBaseline: 2784,
      observedRange: { min: 1894, max: 3544 },
      maxAllowed: 3500,
    },
    {
      key: 'allArtistsVisibleCoversMs',
      checkpointKey: 'all-artists-visible-covers',
      metricPath: 'allArtistsCoversMs',
      units: 'ms',
      description: 'Visible All Artists covers should return without a prolonged blank-card delay after the round-trip.',
      observedBaseline: 1286,
      observedRange: { min: 968, max: 2452 },
      maxAllowed: 2500,
    },
    {
      key: 'allArtistsReturnMemoryBytes',
      checkpointKey: 'all-artists-return-memory',
      metricPath: 'allArtistsReturnMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after returning to All Artists should stay near the startup idle budget.',
      observedBaseline: 17447807,
      observedRange: { min: 17379204, max: 17545328 },
      maxAllowed: 18 * MEGABYTE,
    },
    {
      key: 'jumpScrollSettledMs',
      checkpointKey: 'jump-scroll-settled',
      metricPath: 'jumpScroll.jumpSettledMs',
      units: 'ms',
      description: 'The deep jump-scroll should settle within the observed large-gallery browsing envelope.',
      observedBaseline: 1724,
      observedRange: { min: 1438, max: 2255 },
      maxAllowed: 2500,
    },
    {
      key: 'jumpScrollMemoryBytes',
      checkpointKey: 'jump-scroll-memory',
      metricPath: 'jumpScrollMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory right after the deep jump-scroll should remain under the scrolled browsing budget.',
      observedBaseline: 18288625,
      observedRange: { min: 17914244, max: 18458576 },
      maxAllowed: 19 * MEGABYTE,
    },
    {
      key: 'jumpScrollVisibleCoversMs',
      checkpointKey: 'jump-scroll-visible-covers',
      metricPath: 'jumpScrollCoversReadyMs',
      units: 'ms',
      description: 'Visible covers should reload promptly after the deep jump-scroll lands.',
      observedBaseline: 1817,
      observedRange: { min: 1503, max: 2432 },
      maxAllowed: 4200,
    },
    {
      key: 'albumDetailsOpenMs',
      checkpointKey: 'album-details-open',
      metricPath: 'albumDetailsOpenMs',
      units: 'ms',
      description: 'Opening one visible album details modal should stay inside the current warm real-data latency envelope.',
      observedBaseline: 400,
      observedRange: { min: 427, max: 1609 },
      maxAllowed: 2300,
    },
    {
      key: 'albumDetailsCloseMs',
      checkpointKey: 'album-details-close',
      metricPath: 'albumDetailsCloseMs',
      units: 'ms',
      description: 'Closing the album details modal should settle without an outsized post-modal pause.',
      observedBaseline: 1913,
      observedRange: { min: 1581, max: 2640 },
      maxAllowed: 2588,
    },
    {
      key: 'finalIdleMemoryBytes',
      checkpointKey: 'final-idle-memory',
      metricPath: 'finalMemory.peakBytes',
      units: 'bytes',
      description: 'Peak idle memory after the modal round-trip should stay within the observed final retained-memory budget.',
      observedBaseline: 34801790,
      observedRange: { min: 34358604, max: 35502996 },
      maxAllowed: 36 * MEGABYTE,
    },
  ],
});

export const ARTIST_FAMILY_LOCAL_BENCHMARK = defineBenchmark({
  id: 'artist-family-local-managed-chrome',
  version: '2026-06-05-managed-chrome-neal-morse-clear-search-root-restore',
  caseId: 'FTC-SEARCH-NAV-005A',
  description: 'Managed local real-data Chrome benchmark ceilings for the Neal Morse artist-family responsiveness and memory guard.',
  sampleWindow: {
    collectedOn: '2026-06-05',
    browser: 'chrome',
    mode: 'managed local real-data app',
    sampleSize: 1,
  },
  expectations: [
    {
      key: 'searchAutoSelectionMs',
      checkpointKey: 'search-auto-selection',
      metricPath: 'searchAutoSelectionMs',
      units: 'ms',
      description: 'Searching for Neal Morse should auto-select the canonical artist quickly.',
      observedBaseline: 13000,
      observedRange: { min: 0, max: 16000 },
      maxAllowed: 20000,
    },
    {
      key: 'searchGalleryReadyMs',
      checkpointKey: 'search-gallery-ready',
      metricPath: 'searchGalleryReadyMs',
      units: 'ms',
      description: 'The Neal Morse family gallery should become ready without a long pause after search.',
      observedBaseline: 2200,
      observedRange: { min: 0, max: 2200 },
      maxAllowed: 3500,
    },
    {
      key: 'resonanceChipReadyMs',
      checkpointKey: 'resonance-chip-ready',
      metricPath: 'resonanceChipReadyMs',
      units: 'ms',
      description: 'Filtering to Neal Morse & The Resonance should settle quickly.',
      observedBaseline: 650,
      observedRange: { min: 0, max: 650 },
      maxAllowed: 1800,
    },
    {
      key: 'cosmicChipAddReadyMs',
      checkpointKey: 'cosmic-chip-add-ready',
      metricPath: 'cosmicChipAddReadyMs',
      units: 'ms',
      description: 'Adding Cosmic Cathedral to the active family chips should update the gallery promptly.',
      observedBaseline: 700,
      observedRange: { min: 0, max: 700 },
      maxAllowed: 1800,
    },
    {
      key: 'nealMorseBandChipAddReadyMs',
      checkpointKey: 'neal-morse-band-chip-add-ready',
      metricPath: 'nealMorseBandChipAddReadyMs',
      units: 'ms',
      description: 'Adding The Neal Morse Band to the active family chips should update the gallery promptly.',
      observedBaseline: 700,
      observedRange: { min: 0, max: 700 },
      maxAllowed: 1800,
    },
    {
      key: 'resonanceChipRemoveReadyMs',
      checkpointKey: 'resonance-chip-remove-ready',
      metricPath: 'resonanceChipRemoveReadyMs',
      units: 'ms',
      description: 'Removing Neal Morse & The Resonance from the active family chips should settle quickly.',
      observedBaseline: 700,
      observedRange: { min: 0, max: 700 },
      maxAllowed: 1800,
    },
    {
      key: 'treeCosmicSelectionMs',
      checkpointKey: 'tree-cosmic-selection',
      metricPath: 'treeCosmicSelectionMs',
      units: 'ms',
      description: 'Clicking Cosmic Cathedral in the filtered tree should highlight the new primary artist immediately.',
      observedBaseline: 255,
      observedRange: { min: 128, max: 519 },
      maxAllowed: 700,
    },
    {
      key: 'treeCosmicGalleryReadyMs',
      checkpointKey: 'tree-cosmic-gallery-ready',
      metricPath: 'treeCosmicGalleryReadyMs',
      units: 'ms',
      description: 'The Cosmic Cathedral family gallery should become ready within an interactive-feeling warm-cache window.',
      observedBaseline: 6500,
      observedRange: { min: 0, max: 7000 },
      maxAllowed: 9000,
    },
    {
      key: 'cosmicPrimaryOnlyChipMs',
      checkpointKey: 'cosmic-primary-only-chip-ready',
      metricPath: 'cosmicPrimaryOnlyChipMs',
      units: 'ms',
      description: 'Switching the Cosmic Cathedral family view down to primary-only should settle quickly.',
      observedBaseline: 650,
      observedRange: { min: 0, max: 650 },
      maxAllowed: 1800,
    },
    {
      key: 'cosmicAlbumDetailsOpenMs',
      checkpointKey: 'cosmic-album-details-open',
      metricPath: 'cosmicAlbumDetailsOpenMs',
      units: 'ms',
      description: 'Opening the Cosmic Cathedral album details should stay responsive and show the tracklist quickly.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'cosmicAlbumDetailsCloseMs',
      checkpointKey: 'cosmic-album-details-close',
      metricPath: 'cosmicAlbumDetailsCloseMs',
      units: 'ms',
      description: 'Closing the Cosmic Cathedral album details should settle quickly.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'treeNealSelectionMs',
      checkpointKey: 'tree-neal-selection',
      metricPath: 'treeNealSelectionMs',
      units: 'ms',
      description: 'Clicking Neal Morse in the filtered tree again should visibly reselect the primary artist quickly.',
      observedBaseline: 150,
      observedRange: { min: 0, max: 150 },
      maxAllowed: 450,
    },
    {
      key: 'treeNealGalleryReadyMs',
      checkpointKey: 'tree-neal-gallery-ready',
      metricPath: 'treeNealGalleryReadyMs',
      units: 'ms',
      description: 'The Neal Morse family gallery should reload quickly after returning from Cosmic Cathedral.',
      observedBaseline: 2200,
      observedRange: { min: 0, max: 2200 },
      maxAllowed: 3500,
    },
    {
      key: 'nealFirstAlbumOpenMs',
      checkpointKey: 'neal-first-album-open',
      metricPath: 'nealFirstAlbumOpenMs',
      units: 'ms',
      description: 'Opening the first Neal Morse album details should make the interactive tracklist available quickly; cover loading is asserted separately.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'nealFirstAlbumCloseMs',
      checkpointKey: 'neal-first-album-close',
      metricPath: 'nealFirstAlbumCloseMs',
      units: 'ms',
      description: 'Closing the first Neal Morse album details should settle quickly.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'nealSecondAlbumOpenMs',
      checkpointKey: 'neal-second-album-open',
      metricPath: 'nealSecondAlbumOpenMs',
      units: 'ms',
      description: 'Opening a second Neal Morse album details view should make the interactive tracklist available within the same responsive envelope; cover loading is asserted separately.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'nealSecondAlbumCloseMs',
      checkpointKey: 'neal-second-album-close',
      metricPath: 'nealSecondAlbumCloseMs',
      units: 'ms',
      description: 'Closing the second Neal Morse album details should settle quickly.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 500 },
      maxAllowed: 1200,
    },
    {
      key: 'combineSimilarOnMs',
      checkpointKey: 'combine-similar-on-ready',
      metricPath: 'combineSimilarOnMs',
      units: 'ms',
      description: 'Turning on Combine similar artists should rebuild the gallery promptly.',
      observedBaseline: 900,
      observedRange: { min: 0, max: 900 },
      maxAllowed: 2000,
    },
    {
      key: 'combineSimilarOffMs',
      checkpointKey: 'combine-similar-off-ready',
      metricPath: 'combineSimilarOffMs',
      units: 'ms',
      description: 'Turning off Combine similar artists should restore the default grouped view promptly.',
      observedBaseline: 900,
      observedRange: { min: 0, max: 900 },
      maxAllowed: 2000,
    },
    {
      key: 'clearSearchReadyMs',
      checkpointKey: 'clear-search-ready',
      metricPath: 'clearSearchReadyMs',
      units: 'ms',
      description: 'Clearing the search should restore the full tree while keeping Neal Morse selected and visible.',
      observedBaseline: 2500,
      observedRange: { min: 0, max: 2500 },
      maxAllowed: 6000,
    },
    {
      key: 'peakIdleMemoryBytes',
      checkpointKey: 'peak-idle-memory',
      metricPath: 'peakIdleMemoryBytes',
      units: 'bytes',
      description: 'Peak idle memory across the artist-family browsing cycle should stay within the current real-data budget.',
      observedBaseline: 35651584,
      observedRange: { min: 0, max: 35651584 },
      maxAllowed: 40 * MEGABYTE,
    },
    {
      key: 'finalIdleMemoryBytes',
      checkpointKey: 'clear-search-idle-memory',
      metricPath: 'finalIdleMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after clearing search and returning to the full tree should stay near the warmed artist-family browsing budget.',
      observedBaseline: 35651584,
      observedRange: { min: 0, max: 35651584 },
      maxAllowed: 40 * MEGABYTE,
    },
  ],
});

export const SEARCH_ALL_ARTISTS_LOCAL_BENCHMARK = defineBenchmark({
  id: 'search-all-artists-local-managed-chrome',
  version: '2026-07-07-managed-chrome-search-follow-up-selection-calibration-1',
  caseId: 'FTC-SEARCH-NAV-003A',
  description: 'Managed local real-data Chrome benchmark ceilings for the multi-family search-loaded All artists responsiveness and memory guard.',
  sampleWindow: {
    collectedOn: '2026-06-05',
    browser: 'chrome',
    mode: 'managed local real-data app',
    sampleSize: 1,
  },
  expectations: [
    {
      key: 'searchAutoSelectionMs',
      checkpointKey: 'search-auto-selection',
      metricPath: 'searchAutoSelectionMs',
      units: 'ms',
      description: 'Searching for Ария should auto-select the intended artist in the filtered tree without an excessive stall.',
      observedBaseline: 20601,
      observedRange: { min: 0, max: 20601 },
      maxAllowed: 24000,
    },
    {
      key: 'searchGalleryReadyMs',
      checkpointKey: 'search-gallery-ready',
      metricPath: 'searchGalleryReadyMs',
      units: 'ms',
      description: 'The search-loaded Ария gallery should become usable within an interactive-feeling warm real-data window.',
      observedBaseline: 2500,
      observedRange: { min: 0, max: 2500 },
      maxAllowed: 6000,
    },
    {
      key: 'searchIdleMemoryBytes',
      checkpointKey: 'search-idle-memory',
      metricPath: 'searchIdleMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after the search-loaded Ария family view settles should stay within the current broad real-data budget.',
      observedBaseline: 22020096,
      observedRange: { min: 0, max: 22020096 },
      maxAllowed: 32 * MEGABYTE,
    },
    {
      key: 'allArtistsSelectionMs',
      checkpointKey: 'search-all-artists-selection-visible',
      metricPath: 'allArtistsSelectionMs',
      units: 'ms',
      description: 'The search-scoped All artists selection should visibly apply without a laggy pause.',
      observedBaseline: 900,
      observedRange: { min: 0, max: 900 },
      maxAllowed: 2500,
    },
    {
      key: 'allArtistsGalleryReadyMs',
      checkpointKey: 'search-all-artists-gallery-ready',
      metricPath: 'allArtistsGalleryReadyMs',
      units: 'ms',
      description: 'The search-scoped All artists gallery should reload promptly after the broad multi-family click.',
      observedBaseline: 1800,
      observedRange: { min: 0, max: 1800 },
      maxAllowed: 5000,
    },
    {
      key: 'jumpScrollSettledMs',
      checkpointKey: 'search-all-artists-jump-scroll-settled',
      metricPath: 'jumpScroll.jumpSettledMs',
      units: 'ms',
      description: 'Jump-scrolling the broad search-loaded All artists gallery should settle within the same large-gallery envelope as other real-data guards.',
      observedBaseline: 1900,
      observedRange: { min: 0, max: 1900 },
      maxAllowed: 3500,
    },
    {
      key: 'jumpScrollVisibleCoversMs',
      checkpointKey: 'search-all-artists-jump-scroll-visible-covers',
      metricPath: 'jumpScrollCoversReadyMs',
      units: 'ms',
      description: 'Visible covers should continue loading after the deeper search-scoped All artists jump scroll.',
      observedBaseline: 2100,
      observedRange: { min: 0, max: 2100 },
      maxAllowed: 5000,
    },
    {
      key: 'jumpScrollMemoryBytes',
      checkpointKey: 'search-all-artists-jump-scroll-memory',
      metricPath: 'jumpScrollMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after the broad search-loaded jump scroll should stay inside the current large-gallery browsing budget.',
      observedBaseline: 25165824,
      observedRange: { min: 0, max: 25165824 },
      maxAllowed: 36 * MEGABYTE,
    },
    {
      key: 'bi2SelectionMs',
      checkpointKey: 'tree-bi2-selection',
      metricPath: 'bi2SelectionMs',
      units: 'ms',
      description: 'Clicking БИ-2 in the filtered tree should update the active selection quickly.',
      observedBaseline: 350,
      observedRange: { min: 0, max: 350 },
      maxAllowed: 1200,
    },
    {
      key: 'bi2GalleryReadyMs',
      checkpointKey: 'tree-bi2-gallery-ready',
      metricPath: 'bi2GalleryReadyMs',
      units: 'ms',
      description: 'The БИ-2 gallery should become ready within the current warm search-navigation budget.',
      observedBaseline: 10376,
      observedRange: { min: 10079, max: 10673 },
      maxAllowed: 12000,
    },
    {
      key: 'finalIdleMemoryBytes',
      checkpointKey: 'final-idle-memory',
      metricPath: 'finalMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after the БИ-2 follow-up selection should stay within the same broad real-data browsing budget.',
      observedBaseline: 26214400,
      observedRange: { min: 0, max: 26214400 },
      maxAllowed: 40 * MEGABYTE,
    },
  ],
});

export const APP_OPEN_ALL_ARTISTS_LOCAL_BENCHMARK = defineBenchmark({
  id: 'app-open-all-artists-local-managed-chrome',
  version: '2026-08-26-shared-local-ci-app-open-visible-preview-ready-2100',
  caseId: 'FTC-GALLERY-STARTUP-005T',
  description: 'Shared local-and-CI synthetic-data Chrome benchmark ceiling for default-route app-open visible All Artists readiness through the Postgres browse path.',
  sampleWindow: {
    collectedOn: '2026-07-25',
    browser: 'chrome',
    mode: 'managed local real-data app',
    sampleSize: 5,
  },
  expectations: [
    {
      key: 'visibleUiReadyMs',
      checkpointKey: 'app-open-visible-ui-ready',
      metricPath: 'visibleUiReadyMs',
      units: 'ms',
      description: 'Opening the app on the default route should reach the rendered Postgres sidebar preview, first gallery paint, and decoded same-origin covers within the 2100 ms target plus the owner-approved 400 ms grace.',
      observedBaseline: 1500,
      observedRange: { min: 1505, max: 2038 },
      maxAllowed: 2100,
      graceMs: 400,
    },
  ],
});

export const UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK = defineBenchmark({
  id: 'utility-problematic-files-isolated-postgres',
  version: '2026-08-08-isolated-postgres-problematic-files-v5',
  caseId: 'FTC-UTIL-PROBLEMS-009',
  description: 'Managed isolated-Postgres benchmark ceilings for the cold Problematic Files API payload and the warmed visible Settings flow over generated media.',
  datasetContract: {
    mode: 'isolated-postgres-generated-media',
    problematicItemCount: 18,
    expectedProblemTypes: [
      'Encoding problem',
      'Incomplete track order',
      'Missing cover art',
      'Missing track number',
      'Missing year',
      'Year mismatch',
    ],
    expectedProblemReasons: [
      'Encoding problem',
      'Incomplete track order: Disc 1 missing 2',
      'Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9',
      'Incomplete track order: Disc 2 missing 1, 2, 3',
      'Missing cover art',
      'Missing track number',
      'Missing year',
      'Year mismatch',
    ],
    expectedProblematicAlbums: [
      {
        artist: 'Neal Morse',
        album: 'Neal Morse Plays Pink Floyd',
        problemReasons: [
          'Missing cover art',
          'Missing track number',
          'Missing year',
        ],
      },
      {
        artist: 'E2E Rarity Artist',
        album: 'Two Track Rarity Fixture',
        problemReasons: ['Incomplete track order: Disc 1 missing 2'],
      },
      {
        artist: 'E2E Rarity Artist',
        album: 'Natural Filename Order Fixture',
        problemReasons: [
          'Missing track number',
          'Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9',
        ],
      },
      {
        artist: 'E2E Rarity Artist',
        album: 'Sparse Album Edit Fixture',
        problemReasons: ['Year mismatch'],
      },
      {
        artist: 'Generated Problem Fixture',
        album: 'Encoding And Missing Metadata',
        problemReasons: [
          'Missing year',
          'Missing cover art',
          'Missing track number',
          'Encoding problem',
        ],
      },
      {
        artist: 'Mastodon',
        album: 'Crack The Skye Fixture 07',
        problemReasons: ['Missing cover art'],
      },
      {
        artist: 'Mastodon',
        album: 'Crack The Skye Fixture 08',
        problemReasons: ['Missing cover art'],
      },
      {
        artist: 'Various Artists',
        album: 'Explicit Disc Label Control',
        problemReasons: ['Incomplete track order: Disc 2 missing 1, 2, 3'],
      },
    ],
  },
  sampleWindow: {
    collectedOn: '2026-07-31',
    browser: 'chromium',
    datasetItemCount: 15,
    mode: 'isolated Postgres with generated media',
    label: 'five sequential final-source fresh-app runs with utility prewarm disabled and rebuild telemetry asserted',
    sampleSize: 5,
  },
  expectations: [
    {
      key: 'coldProblematicApiMs',
      checkpointKey: 'problematic-files-cold-api',
      metricPath: 'coldProblematicApiMs',
      units: 'ms',
      description: 'The cold Problematic Files API request should complete end to end within the 1000 ms target plus the owner-approved 200 ms grace.',
      observedBaseline: 239,
      observedRange: { min: 176, max: 305 },
      targetMaximum: 1000,
      graceMs: 200,
      maxAllowed: 1200,
    },
    {
      key: 'problematicResponseBytes',
      checkpointKey: 'problematic-files-response-bytes',
      metricPath: 'problematicResponseBytes',
      units: 'bytes',
      description: 'The Problematic Files response body should remain at or below 400 KiB.',
      observedBaseline: 80037,
      observedRange: { min: 80037, max: 80037 },
      maxAllowed: 409600,
    },
    {
      key: 'problematicReadyMs',
      checkpointKey: 'problematic-files-ready',
      metricPath: 'problematicReadyMs',
      units: 'ms',
      description: 'Opening Settings immediately after normal root navigation targets one second and must remain within the owner-approved 1200 ms hard ceiling; 1001-1200 ms is reported as grace usage.',
      observedBaseline: 384,
      observedRange: { min: 346, max: 440 },
      targetMaximum: 1000,
      maxAllowed: 1200,
    },
    {
      key: 'searchReadyMs',
      checkpointKey: 'problematic-search-ready',
      metricPath: 'searchReadyMs',
      units: 'ms',
      description: 'Filtering Problematic Files by a representative search term should update within an interactive-feeling local envelope.',
      observedBaseline: 62,
      observedRange: { min: 50, max: 67 },
      maxAllowed: 1000,
    },
    {
      key: 'longestProblemFilterMs',
      checkpointKey: 'problem-filter-1',
      metricPath: 'longestProblemFilterMs',
      units: 'ms',
      description: 'Applying one visible problem-type filter should stay within the current local-only review budget.',
      observedBaseline: 222,
      observedRange: { min: 170, max: 238 },
      maxAllowed: 3300,
    },
    {
      key: 'problematicIdleMemoryBytes',
      checkpointKey: 'problematic-files-idle-memory',
      metricPath: 'problematicIdleMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after Problematic Files loads should remain bounded for a warmed utility session.',
      observedBaseline: 4308888,
      observedRange: { min: 4270864, max: 4323852 },
      maxAllowed: 64 * MEGABYTE,
    },
    {
      key: 'finalIdleMemoryBytes',
      checkpointKey: 'problematic-files-final-memory',
      metricPath: 'finalMemory.peakBytes',
      units: 'bytes',
      description: 'Idle memory after the search and per-problem review pass should stay inside the same bounded utility budget.',
      observedBaseline: 4793204,
      observedRange: { min: 4640200, max: 5551780 },
      maxAllowed: 64 * MEGABYTE,
    },
  ],
});

export const UTILITY_RULES_LOCAL_BENCHMARK = defineBenchmark({
  id: 'utility-rules-local-managed-chrome',
  version: '2026-06-07-managed-chrome-rules-cache-fast-path',
  caseId: 'FTC-UTIL-RULES-002',
  description: 'Managed local real-data Chrome benchmark ceilings for Utilities > Rules and the follow-up utility-tab readiness pass.',
  sampleWindow: {
    collectedOn: '2026-06-07',
    browser: 'chrome',
    mode: 'managed local real-data app',
    sampleSize: 5,
  },
  expectations: [
    {
      key: 'rulesReadyMs',
      checkpointKey: 'rules-ready',
      metricPath: 'rulesReadyMs',
      units: 'ms',
      description: 'Opening Utilities directly into Rules should stay below the owner-approved 5-second ceiling and within the warmed cache fast path.',
      observedBaseline: 900,
      observedRange: { min: 800, max: 1100 },
      maxAllowed: 5000,
    },
    {
      key: 'loopsReadyMs',
      checkpointKey: 'loops-ready',
      metricPath: 'loopsReadyMs',
      units: 'ms',
      description: 'Switching from Rules to Loops should settle without a long delay.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 2000 },
      maxAllowed: 2500,
    },
    {
      key: 'logHistoryReadyMs',
      checkpointKey: 'log-history-ready',
      metricPath: 'logHistoryReadyMs',
      units: 'ms',
      description: 'Switching from Rules to Log History should settle without a long delay.',
      observedBaseline: 500,
      observedRange: { min: 0, max: 2000 },
      maxAllowed: 2500,
    },
    {
      key: 'integrationsReadyMs',
      checkpointKey: 'integrations-ready',
      metricPath: 'integrationsReadyMs',
      units: 'ms',
      description: 'Switching from Rules to Integrations should settle without a long delay.',
      observedBaseline: 900,
      observedRange: { min: 0, max: 3000 },
      maxAllowed: 3500,
    },
    {
      key: 'appearanceReadyMs',
      checkpointKey: 'appearance-ready',
      metricPath: 'appearanceReadyMs',
      units: 'ms',
      description: 'Switching from Rules to Appearance should settle quickly.',
      observedBaseline: 350,
      observedRange: { min: 0, max: 1200 },
      maxAllowed: 1800,
    },
    {
      key: 'peakTabMemoryBytes',
      checkpointKey: 'appearance-memory',
      metricPath: 'peakTabMemoryBytes',
      units: 'bytes',
      description: 'Peak idle memory across the Rules-driven utility-tab review should remain bounded.',
      observedBaseline: 50331648,
      observedRange: { min: 0, max: 50331648 },
      maxAllowed: 64 * MEGABYTE,
    },
  ],
});

export function evaluateAllArtistsLocalBenchmark(rawMetrics) {
  const startupMode = String(rawMetrics?.startupSidebarHydration?.startupMode || '').trim();
  const skipPreviewSidebarExpectation = startupMode === 'loader-first'
    || startupMode === 'direct-full-sidebar';
  const expectations = ALL_ARTISTS_LOCAL_BENCHMARK.expectations.filter((expectation) => {
    if (skipPreviewSidebarExpectation && expectation.key === 'startupPreviewSidebarMs') {
      return false;
    }
    return true;
  });
  const results = expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: ALL_ARTISTS_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => {
        if (result.key === 'allArtistsReturnMemoryBytes' && Number(result.sampleCount || 0) > 0) {
          return `${result.key} exceeded ${result.allowedText} persistently; actual ${result.actualText}. `
            + `Observed five-run range ${result.rangeText}. ${result.description}`;
        }
        return formatBenchmarkFailure(result, 'Observed five-run range');
      }),
  };
}

export function evaluateArtistFamilyLocalBenchmark(rawMetrics) {
  const results = ARTIST_FAMILY_LOCAL_BENCHMARK.expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: ARTIST_FAMILY_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => formatBenchmarkFailure(result)),
  };
}

export function evaluateSearchAllArtistsLocalBenchmark(rawMetrics) {
  const results = SEARCH_ALL_ARTISTS_LOCAL_BENCHMARK.expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: SEARCH_ALL_ARTISTS_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => formatBenchmarkFailure(result)),
  };
}

export function evaluateAppOpenAllArtistsLocalBenchmark(rawMetrics) {
  const results = APP_OPEN_ALL_ARTISTS_LOCAL_BENCHMARK.expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: APP_OPEN_ALL_ARTISTS_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => formatBenchmarkFailure(result)),
  };
}

export function evaluateUtilityProblematicFilesLocalBenchmark(rawMetrics) {
  const results = UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK.expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => formatBenchmarkFailure(result)),
  };
}

export function evaluateUtilityRulesLocalBenchmark(rawMetrics) {
  const results = UTILITY_RULES_LOCAL_BENCHMARK.expectations.map((expectation) => (
    evaluateExpectation(expectation, rawMetrics)
  ));

  return {
    benchmark: UTILITY_RULES_LOCAL_BENCHMARK,
    results,
    failures: results
      .filter((result) => !result.passed)
      .map((result) => formatBenchmarkFailure(result)),
  };
}
