const test = require('node:test');
const assert = require('node:assert/strict');

test('every shared millisecond benchmark declares a 200-400 ms grace without replacing its target', async () => {
  const benchmarks = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');
  const catalog = [
    benchmarks.ALL_ARTISTS_LOCAL_BENCHMARK,
    benchmarks.ARTIST_FAMILY_LOCAL_BENCHMARK,
    benchmarks.SEARCH_ALL_ARTISTS_LOCAL_BENCHMARK,
    benchmarks.APP_OPEN_ALL_ARTISTS_LOCAL_BENCHMARK,
    benchmarks.UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK,
    benchmarks.UTILITY_RULES_LOCAL_BENCHMARK,
  ];
  const timingExpectations = catalog.flatMap((benchmark) => (
    benchmark.expectations.filter((expectation) => expectation.units === 'ms')
  ));

  assert.equal(timingExpectations.length, 52);
  for (const expectation of timingExpectations) {
    assert.ok(Number.isFinite(expectation.targetMaximum), `${expectation.key} target`);
    assert.ok(expectation.graceMs >= 200 && expectation.graceMs <= 400, `${expectation.key} grace`);
    assert.equal(expectation.maxAllowed, expectation.targetMaximum + expectation.graceMs, `${expectation.key} ceiling`);
    assert.equal(expectation.hardCeiling, expectation.maxAllowed, `${expectation.key} hard ceiling alias`);
  }

  const selectedArtistSelection = benchmarks.ALL_ARTISTS_LOCAL_BENCHMARK.expectations
    .find((expectation) => expectation.key === 'selectedArtistSelectionMs');
  assert.equal(selectedArtistSelection.targetMaximum, 350);
  assert.equal(selectedArtistSelection.graceMs, 200);
  assert.equal(selectedArtistSelection.maxAllowed, 550);
});

test('local real-data benchmark evaluation passes when metrics stay within the documented ceilings', async () => {
  const { evaluateAllArtistsLocalBenchmark } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateAllArtistsLocalBenchmark({
    startupSidebarHydration: {
      previewSidebarMs: 154,
      fullSidebarMs: 5808,
      fullCountSynchronizedMs: 5090,
      firstAlbumsMs: 147,
      coversMs: 128,
    },
    initialMemory: { peakBytes: 17267052 },
    selectedArtistSelectionMs: 208,
    selectedArtistGalleryMs: 3200,
    allArtistsSelectionMs: 1177,
    allArtistsFirstAlbumsMs: 3500,
    allArtistsCoversMs: 2500,
    allArtistsReturnMemory: {
      peakBytes: 17545328,
      idleSamples: [
        { bytes: 17379204 },
        { bytes: 17422208 },
        { bytes: 17545328 },
      ],
    },
    jumpScroll: { jumpSettledMs: 2255 },
    jumpScrollMemory: { peakBytes: 18458576 },
    jumpScrollCoversReadyMs: 2432,
    albumDetailsOpenMs: 1800,
    albumDetailsCloseMs: 2000,
    finalMemory: { peakBytes: 35502996 },
  });

  assert.deepEqual(evaluation.failures, []);
  assert.equal(evaluation.results.every((result) => result.passed), true);
  assert.equal(
    evaluation.results.find((result) => result.key === 'startupPreviewSidebarMs')?.checkpointKey,
    'startup-preview-sidebar',
  );
});

test('local real-data benchmark evaluation reports a clear failure when one metric regresses past its ceiling', async () => {
  const { evaluateAllArtistsLocalBenchmark } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateAllArtistsLocalBenchmark({
    startupSidebarHydration: {
      previewSidebarMs: 1082,
      fullSidebarMs: 5808,
      fullCountSynchronizedMs: 5090,
      firstAlbumsMs: 147,
      coversMs: 128,
    },
    initialMemory: { peakBytes: 17267052 },
    selectedArtistSelectionMs: 208,
    selectedArtistGalleryMs: 3200,
    allArtistsSelectionMs: 1177,
    allArtistsFirstAlbumsMs: 3500,
    allArtistsCoversMs: 2500,
    allArtistsReturnMemory: {
      peakBytes: 17545328,
      idleSamples: [
        { bytes: 17379204 },
        { bytes: 17422208 },
        { bytes: 17545328 },
      ],
    },
    jumpScroll: { jumpSettledMs: 2255 },
    jumpScrollMemory: { peakBytes: 18458576 },
    jumpScrollCoversReadyMs: 2432,
    albumDetailsOpenMs: 1800,
    albumDetailsCloseMs: 2000,
    finalMemory: { peakBytes: 35502996 },
  });

  assert.equal(evaluation.failures.length, 1);
  assert.match(evaluation.failures[0], /startupPreviewSidebarMs hard-fail: exceeded 1081 ms/);
});

test('shared benchmark terminal lines report target, grace, hard ceiling, and classification for all timing contracts', async () => {
  const benchmarks = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');
  const evaluations = [
    benchmarks.evaluateAllArtistsLocalBenchmark({}),
    benchmarks.evaluateArtistFamilyLocalBenchmark({}),
    benchmarks.evaluateSearchAllArtistsLocalBenchmark({}),
    benchmarks.evaluateAppOpenAllArtistsLocalBenchmark({}),
    benchmarks.evaluateUtilityProblematicFilesLocalBenchmark({}),
    benchmarks.evaluateUtilityRulesLocalBenchmark({}),
  ];
  const lines = evaluations.flatMap(benchmarks.formatBenchmarkTimingResults);

  assert.equal(lines.length, 52);
  for (const line of lines) {
    assert.match(line, /^\[performance-budget\] \S+: (TARGET MET|GRACE USED|HARD FAIL):/);
    assert.match(line, /target/);
    assert.match(line, /grace/);
    assert.match(line, /hard ceiling/);
  }
});

test('local real-data benchmark ignores a one-sample return-memory spike when later samples settle back down', async () => {
  const { evaluateAllArtistsLocalBenchmark } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateAllArtistsLocalBenchmark({
    startupSidebarHydration: {
      previewSidebarMs: 154,
      fullSidebarMs: 5808,
      fullCountSynchronizedMs: 5090,
      firstAlbumsMs: 147,
      coversMs: 128,
    },
    initialMemory: { peakBytes: 17267052 },
    selectedArtistSelectionMs: 208,
    selectedArtistGalleryMs: 3200,
    allArtistsSelectionMs: 1177,
    allArtistsFirstAlbumsMs: 3500,
    allArtistsCoversMs: 2500,
    allArtistsReturnMemory: {
      peakBytes: 28431392,
      idleSamples: [
        { bytes: 28431392 },
        { bytes: 16901892 },
        { bytes: 17462816 },
      ],
    },
    jumpScroll: { jumpSettledMs: 2255 },
    jumpScrollMemory: { peakBytes: 18458576 },
    jumpScrollCoversReadyMs: 2432,
    albumDetailsOpenMs: 1800,
    albumDetailsCloseMs: 2000,
    finalMemory: { peakBytes: 35502996 },
  });

  assert.deepEqual(evaluation.failures, []);
  const returnMemoryResult = evaluation.results.find((result) => result.key === 'allArtistsReturnMemoryBytes');
  assert.equal(returnMemoryResult?.passed, true);
  assert.match(returnMemoryResult?.actualText || '', /1\/3 samples over ceiling/);
});

test('local real-data benchmark fails when return-memory stays above the ceiling for most idle samples', async () => {
  const { evaluateAllArtistsLocalBenchmark } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateAllArtistsLocalBenchmark({
    startupSidebarHydration: {
      previewSidebarMs: 154,
      fullSidebarMs: 5808,
      fullCountSynchronizedMs: 5090,
      firstAlbumsMs: 147,
      coversMs: 128,
    },
    initialMemory: { peakBytes: 17267052 },
    selectedArtistSelectionMs: 208,
    selectedArtistGalleryMs: 3200,
    allArtistsSelectionMs: 1177,
    allArtistsFirstAlbumsMs: 3500,
    allArtistsCoversMs: 2500,
    allArtistsReturnMemory: {
      peakBytes: 28431392,
      idleSamples: [
        { bytes: 28431392 },
        { bytes: 21495808 },
        { bytes: 17462816 },
      ],
    },
    jumpScroll: { jumpSettledMs: 2255 },
    jumpScrollMemory: { peakBytes: 18458576 },
    jumpScrollCoversReadyMs: 2432,
    albumDetailsOpenMs: 1800,
    albumDetailsCloseMs: 2000,
    finalMemory: { peakBytes: 35502996 },
  });

  assert.equal(evaluation.failures.length, 1);
  assert.match(evaluation.failures[0], /allArtistsReturnMemoryBytes exceeded 18.0 MB .* persistently/);
});

test('benchmark validation payload keeps retained threshold overlay fields for all-artists evaluations', async () => {
  const {
    buildBenchmarkValidationPayload,
    evaluateAllArtistsLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateAllArtistsLocalBenchmark({
    startupSidebarHydration: {
      previewSidebarMs: 154,
      fullSidebarMs: 5808,
      fullCountSynchronizedMs: 5090,
      firstAlbumsMs: 147,
      coversMs: 128,
    },
    initialMemory: { peakBytes: 17267052 },
    selectedArtistSelectionMs: 208,
    selectedArtistGalleryMs: 3200,
    allArtistsSelectionMs: 1177,
    allArtistsFirstAlbumsMs: 3500,
    allArtistsCoversMs: 2500,
    allArtistsReturnMemory: {
      peakBytes: 17545328,
      idleSamples: [
        { bytes: 17379204 },
        { bytes: 17422208 },
        { bytes: 17545328 },
      ],
    },
    jumpScroll: { jumpSettledMs: 2255 },
    jumpScrollMemory: { peakBytes: 18458576 },
    jumpScrollCoversReadyMs: 2432,
    albumDetailsOpenMs: 1800,
    albumDetailsCloseMs: 2000,
    finalMemory: { peakBytes: 35502996 },
  });

  const payload = buildBenchmarkValidationPayload(evaluation);
  const startupPreview = payload.results.find((result) => result.checkpointKey === 'startup-preview-sidebar');

  assert.equal(payload.benchmarkId, 'all-artists-local-managed-chrome');
  assert.equal(payload.benchmarkVersion, '2026-06-30-asgi-managed-chrome-all-artists-badge-sync');
  assert.ok(startupPreview);
  assert.equal(startupPreview.targetMaximum, 881);
  assert.equal(startupPreview.graceMs, 200);
  assert.equal(startupPreview.allowedMaximum, 1081);
  assert.equal(startupPreview.allowedText, '1081 ms');
  assert.equal(startupPreview.performanceStatus, 'target-met');
});

test('benchmark validation payload keeps retained threshold overlay fields for artist-family evaluations', async () => {
  const {
    buildBenchmarkValidationPayload,
    evaluateArtistFamilyLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateArtistFamilyLocalBenchmark({
    searchAutoSelectionMs: 15000,
    searchGalleryReadyMs: 2200,
    resonanceChipReadyMs: 650,
    cosmicChipAddReadyMs: 700,
    nealMorseBandChipAddReadyMs: 700,
    resonanceChipRemoveReadyMs: 700,
    treeCosmicSelectionMs: 255,
    treeCosmicGalleryReadyMs: 6500,
    cosmicPrimaryOnlyChipMs: 650,
    cosmicAlbumDetailsOpenMs: 500,
    cosmicAlbumDetailsCloseMs: 500,
    treeNealSelectionMs: 150,
    treeNealGalleryReadyMs: 2200,
    nealFirstAlbumOpenMs: 500,
    nealFirstAlbumCloseMs: 500,
    nealSecondAlbumOpenMs: 500,
    nealSecondAlbumCloseMs: 500,
    combineSimilarOnMs: 900,
    combineSimilarOffMs: 900,
    clearSearchReadyMs: 2500,
    peakIdleMemoryBytes: 35651584,
    finalIdleMemory: { peakBytes: 35651584 },
  });

  const payload = buildBenchmarkValidationPayload(evaluation);
  const clearSearch = payload.results.find((result) => result.checkpointKey === 'clear-search-ready');

  assert.equal(payload.benchmarkId, 'artist-family-local-managed-chrome');
  assert.equal(payload.benchmarkVersion, '2026-06-05-managed-chrome-neal-morse-clear-search-root-restore');
  assert.ok(clearSearch);
  assert.equal(clearSearch.targetMaximum, 6000);
  assert.equal(clearSearch.graceMs, 400);
  assert.equal(clearSearch.allowedMaximum, 6400);
  assert.equal(clearSearch.allowedText, '6400 ms');
});

test('benchmark validation payload keeps retained threshold overlay fields for search-all-artists evaluations', async () => {
  const {
    buildBenchmarkValidationPayload,
    evaluateSearchAllArtistsLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const evaluation = evaluateSearchAllArtistsLocalBenchmark({
    searchAutoSelectionMs: 20601,
    searchGalleryReadyMs: 351,
    searchIdleMemory: { peakBytes: 12788068 },
    allArtistsSelectionMs: 293,
    allArtistsGalleryReadyMs: 954,
    jumpScroll: { jumpSettledMs: 1136 },
    jumpScrollMemory: { peakBytes: 12490124 },
    jumpScrollCoversReadyMs: 1249,
    bi2SelectionMs: 261,
    bi2GalleryReadyMs: 93,
    finalMemory: { peakBytes: 12709924 },
  });

  const payload = buildBenchmarkValidationPayload(evaluation);
  const searchAutoSelection = payload.results.find((result) => result.checkpointKey === 'search-auto-selection');

  assert.equal(payload.benchmarkId, 'search-all-artists-local-managed-chrome');
  assert.equal(payload.benchmarkVersion, '2026-07-07-managed-chrome-search-follow-up-selection-calibration-1');
  assert.ok(searchAutoSelection);
  assert.equal(searchAutoSelection.targetMaximum, 24000);
  assert.equal(searchAutoSelection.graceMs, 400);
  assert.equal(searchAutoSelection.allowedMaximum, 24400);
  assert.equal(searchAutoSelection.allowedText, '24400 ms');
});

test('app-open all-artists benchmark keeps the approved 2100 ms target separate from its 400 ms grace', async () => {
  const {
    buildBenchmarkValidationPayload,
    evaluateAppOpenAllArtistsLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const passingEvaluation = evaluateAppOpenAllArtistsLocalBenchmark({
    visibleUiReadyMs: 2100,
  });
  const failingEvaluation = evaluateAppOpenAllArtistsLocalBenchmark({
    visibleUiReadyMs: 2501,
  });
  const graceEvaluation = evaluateAppOpenAllArtistsLocalBenchmark({
    visibleUiReadyMs: 2401,
  });
  const payload = buildBenchmarkValidationPayload(passingEvaluation);
  const visibleUiReady = payload.results.find((result) => result.checkpointKey === 'app-open-visible-ui-ready');

  assert.deepEqual(passingEvaluation.failures, []);
  assert.equal(payload.benchmarkId, 'app-open-all-artists-local-managed-chrome');
  assert.equal(payload.benchmarkVersion, '2026-08-26-shared-local-ci-app-open-visible-preview-ready-2100');
  assert.ok(visibleUiReady);
  assert.equal(visibleUiReady.targetMaximum, 2100);
  assert.equal(visibleUiReady.graceMs, 400);
  assert.equal(visibleUiReady.allowedMaximum, 2500);
  assert.equal(visibleUiReady.allowedText, '2500 ms');
  assert.equal(graceEvaluation.results[0].performanceStatus, 'grace-used');
  assert.equal(graceEvaluation.results[0].passed, true);
  assert.equal(failingEvaluation.failures.length, 1);
  assert.match(failingEvaluation.failures[0], /visibleUiReadyMs hard-fail: exceeded 2500 ms/);
});

test('isolated problematic-files dataset validation requires exact identities, reasons, and compact summaries', async () => {
  const {
    evaluateProblematicFilesDatasetContract,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');
  const contract = {
    problematicItemCount: 2,
    expectedProblemTypes: ['Encoding problem', 'Incomplete track order'],
    expectedProblemReasons: [
      'Encoding problem',
      'Incomplete track order: Disc 1 missing 1',
    ],
    expectedProblematicAlbums: [
      {
        artist: 'Fixture Artist A',
        album: 'Fixture Album A',
        problemReasons: ['Incomplete track order: Disc 1 missing 1'],
      },
      {
        artist: 'Fixture Artist B',
        album: 'Fixture Album B',
        problemReasons: ['Encoding problem'],
      },
    ],
  };
  const payload = {
    count: 2,
    items: [
      {
        key: 'a',
        album_artist: 'Fixture Artist A',
        name: 'Fixture Album A',
        problem_reasons: ['Incomplete track order: Disc 1 missing 1'],
        detail_loaded: false,
      },
      {
        key: 'b',
        album_artist: 'Fixture Artist B',
        name: 'Fixture Album B',
        problem_reasons: ['Encoding problem'],
        detail_loaded: false,
      },
    ],
    initial_detail: {
      key: 'a',
      detail_loaded: true,
    },
  };

  assert.deepEqual(evaluateProblematicFilesDatasetContract(payload, contract), []);
  const failures = evaluateProblematicFilesDatasetContract({
    ...payload,
    items: [
      {
        ...payload.items[0],
        detail_loaded: true,
        track_problem_rows: [],
      },
      {
        ...payload.items[1],
        problem_reasons: [],
      },
    ],
  }, contract);
  assert.ok(failures.some((failure) => /must remain compact/.test(failure)));
  assert.ok(failures.some((failure) => /Encoding problem/.test(failure)));

  const extraReasonFailures = evaluateProblematicFilesDatasetContract({
    ...payload,
    items: [
      {
        ...payload.items[0],
        problem_reasons: ['Missing year', 'Unexpected problem'],
      },
      payload.items[1],
    ],
  }, contract);
  assert.ok(extraReasonFailures.some((failure) => /report exactly/.test(failure)));
  assert.ok(extraReasonFailures.some((failure) => /Unexpected problem/.test(failure)));
  assert.ok(extraReasonFailures.some((failure) => /reason set/.test(failure)));
});

test('utility problematic-files benchmark guards the cold API, payload size, visible readiness, and filters', async () => {
  const {
    buildBenchmarkValidationPayload,
    evaluateUtilityProblematicFilesLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');

  const passingEvaluation = evaluateUtilityProblematicFilesLocalBenchmark({
    coldProblematicApiMs: 1200,
    problematicResponseBytes: 409600,
    problematicReadyMs: 1200,
    searchReadyMs: 350,
    longestProblemFilterMs: 3300,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  });
  const filterFailure = evaluateUtilityProblematicFilesLocalBenchmark({
    coldProblematicApiMs: 1000,
    problematicResponseBytes: 409600,
    problematicReadyMs: 1000,
    searchReadyMs: 350,
    longestProblemFilterMs: 3701,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  });
  const readinessFailure = evaluateUtilityProblematicFilesLocalBenchmark({
    coldProblematicApiMs: 1000,
    problematicResponseBytes: 409600,
    problematicReadyMs: 1201,
    searchReadyMs: 350,
    longestProblemFilterMs: 3300,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  });
  const coldApiFailure = evaluateUtilityProblematicFilesLocalBenchmark({
    coldProblematicApiMs: 1201,
    problematicResponseBytes: 409600,
    problematicReadyMs: 1000,
    searchReadyMs: 350,
    longestProblemFilterMs: 3300,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  });
  const responseSizeFailure = evaluateUtilityProblematicFilesLocalBenchmark({
    coldProblematicApiMs: 1000,
    problematicResponseBytes: 409601,
    problematicReadyMs: 1000,
    searchReadyMs: 350,
    longestProblemFilterMs: 3300,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  });

  const coldApiExpectation = passingEvaluation.benchmark.expectations.find((expectation) => expectation.key === 'coldProblematicApiMs');
  const responseSizeExpectation = passingEvaluation.benchmark.expectations.find((expectation) => expectation.key === 'problematicResponseBytes');
  const readinessExpectation = passingEvaluation.benchmark.expectations.find((expectation) => expectation.key === 'problematicReadyMs');
  const longestFilterExpectation = passingEvaluation.benchmark.expectations.find((expectation) => expectation.key === 'longestProblemFilterMs');
  const validationPayload = buildBenchmarkValidationPayload(passingEvaluation);

  assert.deepEqual(passingEvaluation.failures, []);
  assert.notEqual(passingEvaluation.benchmark.datasetContract.problematicItemCount, 177);
  assert.equal(
    passingEvaluation.benchmark.version,
    '2026-08-08-isolated-postgres-problematic-files-v5',
  );
  assert.equal(
    passingEvaluation.benchmark.datasetContract.mode,
    'isolated-postgres-generated-media',
  );
  assert.ok(
    Number.isInteger(passingEvaluation.benchmark.datasetContract.problematicItemCount)
      && passingEvaluation.benchmark.datasetContract.problematicItemCount > 0,
  );
  assert.equal(passingEvaluation.benchmark.datasetContract.problematicItemCount, 18);
  assert.deepEqual(
    passingEvaluation.benchmark.datasetContract.expectedProblemTypes,
    [
      'Encoding problem',
      'Incomplete track order',
      'Missing cover art',
      'Missing track number',
      'Missing year',
      'Year mismatch',
    ],
  );
  assert.deepEqual(
    passingEvaluation.benchmark.datasetContract.expectedProblemReasons,
    [
      'Encoding problem',
      'Incomplete track order: Disc 1 missing 2',
      'Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9',
      'Incomplete track order: Disc 2 missing 1, 2, 3',
      'Missing cover art',
      'Missing track number',
      'Missing year',
      'Year mismatch',
    ],
  );
  assert.deepEqual(
    passingEvaluation.benchmark.datasetContract.expectedProblematicAlbums?.map(
      ({ artist, album }) => ({ artist, album }),
    ),
    [
      { artist: 'Neal Morse', album: 'Neal Morse Plays Pink Floyd' },
      { artist: 'E2E Rarity Artist', album: 'Two Track Rarity Fixture' },
      { artist: 'E2E Rarity Artist', album: 'Natural Filename Order Fixture' },
      { artist: 'E2E Rarity Artist', album: 'Sparse Album Edit Fixture' },
      { artist: 'Generated Problem Fixture', album: 'Encoding And Missing Metadata' },
      { artist: 'Mastodon', album: 'Crack The Skye Fixture 07' },
      { artist: 'Mastodon', album: 'Crack The Skye Fixture 08' },
      { artist: 'Various Artists', album: 'Explicit Disc Label Control' },
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      passingEvaluation.benchmark.datasetContract.expectedProblematicAlbums.map(
        ({ artist, album, problemReasons }) => [`${artist} / ${album}`, problemReasons],
      ),
    ),
    {
      'Neal Morse / Neal Morse Plays Pink Floyd': [
        'Missing cover art',
        'Missing track number',
        'Missing year',
      ],
      'E2E Rarity Artist / Two Track Rarity Fixture': [
        'Incomplete track order: Disc 1 missing 2',
      ],
      'E2E Rarity Artist / Natural Filename Order Fixture': [
        'Missing track number',
        'Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9',
      ],
      'E2E Rarity Artist / Sparse Album Edit Fixture': ['Year mismatch'],
      'Generated Problem Fixture / Encoding And Missing Metadata': [
        'Missing year',
        'Missing cover art',
        'Missing track number',
        'Encoding problem',
      ],
      'Mastodon / Crack The Skye Fixture 07': ['Missing cover art'],
      'Mastodon / Crack The Skye Fixture 08': ['Missing cover art'],
      'Various Artists / Explicit Disc Label Control': [
        'Incomplete track order: Disc 2 missing 1, 2, 3',
      ],
    },
  );
  for (const expectedAlbum of passingEvaluation.benchmark.datasetContract.expectedProblematicAlbums) {
    assert.ok(Array.isArray(expectedAlbum.problemReasons) && expectedAlbum.problemReasons.length > 0);
  }
  assert.equal(
    validationPayload.datasetContract.problematicItemCount,
    passingEvaluation.benchmark.datasetContract.problematicItemCount,
  );
  assert.equal(validationPayload.sampleWindow.collectedOn, '2026-07-31');
  assert.equal(validationPayload.sampleWindow.datasetItemCount, 15);
  assert.notEqual(
    validationPayload.sampleWindow.datasetItemCount,
    passingEvaluation.benchmark.datasetContract.problematicItemCount,
    'The July 31 sample describes the historical 15-item dataset, not the current 18-item contract.',
  );
  assert.match(validationPayload.sampleWindow.label, /five sequential final-source fresh-app runs/);
  assert.equal(validationPayload.sampleWindow.browser, 'chromium');
  assert.match(validationPayload.sampleWindow.mode, /isolated Postgres/i);
  assert.match(passingEvaluation.benchmark.description, /cold Problematic Files API payload/);
  assert.deepEqual(
    Object.fromEntries(passingEvaluation.benchmark.expectations.map((expectation) => [
      expectation.key,
      {
        observedBaseline: expectation.observedBaseline,
        observedRange: expectation.observedRange,
      },
    ])),
    {
      coldProblematicApiMs: {
        observedBaseline: 239,
        observedRange: { min: 176, max: 305 },
      },
      problematicResponseBytes: {
        observedBaseline: 80037,
        observedRange: { min: 80037, max: 80037 },
      },
      problematicReadyMs: {
        observedBaseline: 384,
        observedRange: { min: 346, max: 440 },
      },
      searchReadyMs: {
        observedBaseline: 62,
        observedRange: { min: 50, max: 67 },
      },
      longestProblemFilterMs: {
        observedBaseline: 222,
        observedRange: { min: 170, max: 238 },
      },
      problematicIdleMemoryBytes: {
        observedBaseline: 4308888,
        observedRange: { min: 4270864, max: 4323852 },
      },
      finalIdleMemoryBytes: {
        observedBaseline: 4793204,
        observedRange: { min: 4640200, max: 5551780 },
      },
    },
  );
  assert.equal(coldApiExpectation?.targetMaximum, 1000);
  assert.equal(coldApiExpectation?.graceMs, 200);
  assert.equal(coldApiExpectation?.maxAllowed, 1200);
  assert.equal(passingEvaluation.results.find((result) => result.key === 'coldProblematicApiMs')?.graceUsed, true);
  assert.equal(responseSizeExpectation?.maxAllowed, 409600);
  assert.equal(responseSizeExpectation?.units, 'bytes');
  assert.equal(readinessExpectation?.targetMaximum, 1000);
  assert.equal(readinessExpectation?.graceMs, 200);
  assert.equal(readinessExpectation?.maxAllowed, 1200);
  assert.equal(passingEvaluation.results.find((result) => result.key === 'problematicReadyMs')?.graceUsed, true);
  assert.equal(longestFilterExpectation?.targetMaximum, 3300);
  assert.equal(longestFilterExpectation?.graceMs, 400);
  assert.equal(longestFilterExpectation?.maxAllowed, 3700);
  assert.equal(filterFailure.failures.length, 1);
  assert.match(filterFailure.failures[0], /longestProblemFilterMs hard-fail: exceeded 3700 ms/);
  assert.equal(readinessFailure.failures.length, 1);
  assert.match(readinessFailure.failures[0], /problematicReadyMs hard-fail: exceeded 1200 ms/);
  assert.equal(coldApiFailure.failures.length, 1);
  assert.match(coldApiFailure.failures[0], /coldProblematicApiMs hard-fail: exceeded 1200 ms/);
  assert.equal(responseSizeFailure.failures.length, 1);
  assert.match(responseSizeFailure.failures[0], /problematicResponseBytes failed: exceeded 0.4 MB \(409600 bytes\)/);
});

test('utility benchmark fails closed when a required metric is absent or non-finite', async () => {
  const {
    evaluateUtilityProblematicFilesLocalBenchmark,
  } = await import('../../tests/e2e/helpers/syntheticPerformanceBenchmark.js');
  const invalidValues = [undefined, null, '', Number.NaN, Number.POSITIVE_INFINITY];
  const validMetrics = {
    coldProblematicApiMs: 1000,
    problematicResponseBytes: 409600,
    problematicReadyMs: 1000,
    searchReadyMs: 350,
    longestProblemFilterMs: 500,
    problematicIdleMemory: { peakBytes: 50331648 },
    finalMemory: { peakBytes: 50331648 },
  };

  for (const metricKey of ['coldProblematicApiMs', 'problematicResponseBytes', 'problematicReadyMs']) {
    for (const invalidValue of invalidValues) {
      const evaluation = evaluateUtilityProblematicFilesLocalBenchmark({
        ...validMetrics,
        [metricKey]: invalidValue,
      });
      const result = evaluation.results.find((entry) => entry.key === metricKey);
      assert.equal(result?.passed, false, `${metricKey} should reject ${String(invalidValue)}`);
      assert.equal(result?.actualText, 'unavailable');
      assert.equal(evaluation.failures.length, 1);
    }
  }
});
