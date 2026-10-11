const { defineConfig } = require('@playwright/test');
const { validateEnvironment } = require('./tests/e2e/support/sandbox3ReadOnlyGuard.cjs');
const { baseURL } = validateEnvironment();
module.exports = defineConfig({
  testDir: './tests/e2e/productionRealData',
  testMatch: 'sandbox3ReadOnlyBenchmark.spec.js',
  outputDir: './test-results/sandbox3-read-only',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
});
