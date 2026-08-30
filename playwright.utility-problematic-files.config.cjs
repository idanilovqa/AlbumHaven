const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const {
  resolveBrowserProjectUse,
  resolveRuntimeFlags,
} = require('./scripts/playwright-runtime-flags.cjs');
const { assertManagedSyntheticLargeFixtureEnv } = require('./scripts/playwright-real-data-safety.cjs');
const { PERFORMANCE_FAILURE_TRACE } = require('./scripts/playwright-trace-options.cjs');

const runtimeFlags = resolveRuntimeFlags(process.argv.slice(2), process.env);
const isHeadless = runtimeFlags.headlessOverride ?? true;
const appPort = Number(process.env.PLAYWRIGHT_REAL_APP_PORT || runtimeFlags.realAppPort || 5001);
const managedAppUrl = `http://127.0.0.1:${appPort}`;
const isInventoryDiscovery = process.env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY === '1'
  && process.argv.includes('--list');
const isManagedFixture = !isInventoryDiscovery && process.env.PLAYWRIGHT_MANAGED_APP === '1';
if (!isInventoryDiscovery && !isManagedFixture) {
  throw new Error('Utility Problematic Files Playwright requires runner-managed mode or explicit list-only inventory discovery.');
}
if (process.env.PLAYWRIGHT_SERVE_REAL_APP === '1') {
  throw new Error('Utility Problematic Files Playwright rejects the legacy real-app webServer mode.');
}
assertManagedSyntheticLargeFixtureEnv(process.env, {
  managedSyntheticLarge: isManagedFixture,
  expectedFixtureProfile: 'utility-problematic-files',
});

const performanceReporterPath = path.join(__dirname, 'scripts', 'playwright-performance-reporter.cjs');
const finalResultReporterPath = path.join(__dirname, 'scripts', 'playwright-final-result-reporter.cjs');
const { FINAL_RESULT_NONCE_ENV } = require(finalResultReporterPath);
const finalResultReporterOptions = { nonce: String(process.env[FINAL_RESULT_NONCE_ENV] || '') };
delete process.env[FINAL_RESULT_NONCE_ENV];
const selectedBrowser = runtimeFlags.browser;
const browserProjectUse = resolveBrowserProjectUse(selectedBrowser);

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e', 'utilityProblematicFiles'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'utility-problematic-files'),
  snapshotPathTemplate: `{testDir}/{testFileDir}/{testFileName}-snapshots/${selectedBrowser}/{arg}-{platform}{ext}`,
  timeout: 240000,
  workers: 1,
  expect: {
    timeout: 15000,
  },
  fullyParallel: false,
  reporter: [
    ['list'],
    [performanceReporterPath],
    [finalResultReporterPath, finalResultReporterOptions],
  ],
  use: {
    baseURL: managedAppUrl,
    headless: isHeadless,
    viewport: { width: 1440, height: 960 },
    trace: PERFORMANCE_FAILURE_TRACE,
    screenshot: 'off',
  },
  projects: [
    {
      name: 'utility-problematic-files',
      use: {
        ...browserProjectUse,
        launchOptions: {
          ...(browserProjectUse.launchOptions || {}),
          args: [
            ...(browserProjectUse.launchOptions?.args || []),
            '--enable-features=PerformanceMeasureMemory',
          ],
        },
      },
    },
  ],
  webServer: undefined,
});
