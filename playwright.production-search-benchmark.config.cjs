const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const {
  assertProductionSearchBenchmarkInvocation,
  PRODUCTION_SEARCH_BENCHMARK_URL,
} = require('./tests/e2e/support/productionSearchBenchmarkGuard.cjs');
const pairedSearchReporterPath = path.join(__dirname, 'scripts', 'paired-search-calibration-reporter.cjs');

assertProductionSearchBenchmarkInvocation();

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e', 'productionRealData'),
  testMatch: 'searchFirstVisible.spec.js',
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'production-search-benchmark'),
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  preserveOutput: 'always',
  reporter: [
    ['list'],
    ['html', {
      open: 'never',
      outputFolder: path.join(__dirname, 'test-results', 'production-search-benchmark-report'),
    }],
    [pairedSearchReporterPath],
  ],
  use: {
    baseURL: PRODUCTION_SEARCH_BENCHMARK_URL,
    headless: true,
    viewport: { width: 1440, height: 960 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'production-search-read-only' }],
});
