const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repositoryRoot = path.resolve(__dirname, '..', '..');

function repositoryPath(...segments) {
  return path.join(repositoryRoot, ...segments);
}

function readRepositoryFile(...segments) {
  return fs.readFileSync(repositoryPath(...segments), 'utf8');
}

test('search report displays the measured readiness timing and identifies missing evidence', () => {
  const source = readRepositoryFile('tests', 'e2e', 'support', 'performanceFixtures.js');
  const start = source.indexOf('function buildSearchBrowseFocusedLocalSummaryCards(');
  const end = source.indexOf('function buildRootAlbumBrowseFocusedLocalSummaryCards(', start);
  assert.ok(start >= 0 && end > start, 'Search summary builder must exist');
  const buildSummary = vm.runInNewContext(
    `${source.slice(start, end)}\nbuildSearchBrowseFocusedLocalSummaryCards`,
  );

  for (const [metrics, expected] of [
    [{ searchReadyMs: 462 }, '462 ms'],
    [{ searchReadyMs: 462.6 }, '463 ms'],
    [{ searchReadyMs: 0 }, '0 ms'],
    [{}, 'Not recorded'],
    [{ searchReadyMs: null }, 'Not recorded'],
    [{ searchReadyMs: NaN }, 'Not recorded'],
  ]) {
    const card = buildSummary([], metrics).find(item => item.label === 'Search UI Ready');
    assert.equal(card?.value, expected);
  }
});

test('synthetic performance helpers and benchmark tests use dataset-accurate filenames', () => {
  const expectedAbsent = [
    ['tests', 'e2e', 'helpers', 'localRealDataBenchmark.js'],
    ['tests', 'e2e', 'helpers', 'localRealDataReporting.js'],
    ['tests', 'js', 'local-real-data-benchmark.test.js'],
  ];
  const expectedPresent = [
    ['tests', 'e2e', 'helpers', 'syntheticPerformanceBenchmark.js'],
    ['tests', 'e2e', 'helpers', 'performanceCheckpointReporting.js'],
    ['tests', 'js', 'synthetic-performance-benchmark.test.js'],
  ];

  for (const segments of expectedAbsent) {
    assert.equal(
      fs.existsSync(repositoryPath(...segments)),
      false,
      `${segments.join('/')} should be removed after the synthetic-data rename`,
    );
  }
  for (const segments of expectedPresent) {
    assert.equal(
      fs.existsSync(repositoryPath(...segments)),
      true,
      `${segments.join('/')} should exist after the synthetic-data rename`,
    );
  }
});

test('performance helper surfaces no longer expose local-real-data identifiers or copy', () => {
  const helperIndex = readRepositoryFile('tests', 'e2e', 'helpers', 'index.js');
  const performanceFixtures = readRepositoryFile('tests', 'e2e', 'support', 'performanceFixtures.js');
  const performanceReporter = readRepositoryFile('scripts', 'playwright-performance-reporter.cjs');

  for (const [label, source] of [
    ['helpers index', helperIndex],
    ['performance fixtures', performanceFixtures],
    ['performance reporter', performanceReporter],
  ]) {
    assert.doesNotMatch(source, /LocalRealData|localRealData/, `${label} retains a local-real-data identifier`);
  }
  assert.doesNotMatch(
    performanceFixtures,
    /local-real-data/,
    'performance fixture report copy should describe the synthetic dataset accurately',
  );
  assert.match(
    helperIndex,
    /\bcreatePerformanceCheckpointRecorder\b/,
    'the helpers index should export createPerformanceCheckpointRecorder',
  );

  for (const reportId of [
    'allArtistsLocal',
    'artistFamilyLocal',
    'searchAllArtistsLocal',
  ]) {
    const reportCopy = performanceFixtures.match(
      new RegExp(`reportId: '${reportId}',[\\s\\S]*?buildSummaryCards:`),
    );
    assert.ok(reportCopy, `${reportId} should keep its stable report fixture`);
    assert.doesNotMatch(
      reportCopy[0],
      /real-data/i,
      `${reportId} title and intro should describe the synthetic dataset`,
    );
    assert.match(
      reportCopy[0],
      /synthetic/i,
      `${reportId} title or intro should name the synthetic dataset`,
    );
  }
});

test('Problematic Files report copy matches the approved readiness ceiling', () => {
  const performanceFixtures = readRepositoryFile(
    'tests',
    'e2e',
    'support',
    'performanceFixtures.js',
  );
  const summaryBuilder = performanceFixtures.match(
    /function buildUtilityProblematicFilesLocalSummaryCards[\s\S]*?function buildUtilityRulesLocalSummaryCards/u,
  );

  assert.ok(summaryBuilder, 'Problematic Files summary builder should remain present');
  assert.match(summaryBuilder[0], /1200 ms hard ceiling/u);
  assert.doesNotMatch(summaryBuilder[0], /1400 ms hard ceiling/u);
});


test('search report distinguishes populated readiness from query commitment without fallback evidence', () => {
  const source = readRepositoryFile('tests', 'e2e', 'support', 'performanceFixtures.js');
  const start = source.indexOf('function buildSearchBrowseFocusedLocalSummaryCards(');
  const end = source.indexOf('function buildRootAlbumBrowseFocusedLocalSummaryCards(', start);
  assert.ok(start >= 0 && end > start);
  const buildSummary = vm.runInNewContext(
    `${source.slice(start, end)}\nbuildSearchBrowseFocusedLocalSummaryCards`,
  );
  for (const [metrics, expected] of [
    [{ searchReadyMs: 80, searchPopulatedReadyMs: 950 }, '950 ms'],
    [{ searchReadyMs: 80, searchPopulatedReadyMs: 0 }, '0 ms'],
    [{ searchReadyMs: 80 }, 'Not recorded'],
    [{ searchReadyMs: 80, searchPopulatedReadyMs: null }, 'Not recorded'],
    [{ searchReadyMs: 80, searchPopulatedReadyMs: NaN }, 'Not recorded'],
  ]) {
    const cards = buildSummary([], metrics);
    assert.equal(cards.find(card => card.label === 'Populated Search Ready')?.value, expected);
    assert.equal(cards.find(card => card.label === 'Search UI Ready')?.value, '80 ms');
  }
});

test('populated search readiness is required by the report and uses the unchanged search ceiling', () => {
  const fixtures = readRepositoryFile('tests', 'e2e', 'support', 'performanceFixtures.js');
  const report = fixtures.slice(fixtures.indexOf('searchBrowseFocusedLocalReport:'), fixtures.indexOf('rootAlbumBrowseFocusedLocalReport:'));
  assert.ok(report.includes("'search-browse.searchPopulatedReadyMs'"));
  const times = JSON.parse(readRepositoryFile('tests', 'ci', 'performance-times.json'));
  assert.deepEqual(times['search-browse.searchPopulatedReadyMs'], times['search-browse.searchBrowseReadyMs']);
});
