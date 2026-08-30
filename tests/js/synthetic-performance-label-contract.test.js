const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');

function repositoryPath(...segments) {
  return path.join(repositoryRoot, ...segments);
}

function readRepositoryFile(...segments) {
  return fs.readFileSync(repositoryPath(...segments), 'utf8');
}

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
