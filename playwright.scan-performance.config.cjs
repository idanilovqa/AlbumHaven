const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const {
  resolveBrowserProjectUse,
  resolveRuntimeFlags,
} = require('./scripts/playwright-runtime-flags.cjs');
const { buildAndAssertProviderWriteSafeEnv } = require('./scripts/playwright-provider-safety.cjs');
const { PERFORMANCE_FAILURE_TRACE } = require('./scripts/playwright-trace-options.cjs');
const { resolvePlaywrightPython } = require('./scripts/playwright-python.cjs');

const runtimeFlags = resolveRuntimeFlags(process.argv.slice(2), process.env);
const isHeadless = runtimeFlags.headlessOverride ?? true;
const scanAppPort = Number(process.env.PLAYWRIGHT_PORT || runtimeFlags.fakeAppPort || 4174);
const scanAppUrl = `http://127.0.0.1:${scanAppPort}`;
const statusSamplesPath = path.resolve(
  process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH
    || path.join(__dirname, '.tmp', 'playwright-scan-status', `direct-port-${scanAppPort}.jsonl`),
);
process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH = statusSamplesPath;
const pythonExe = resolvePlaywrightPython(process.env);
const supportAppPath = path.join(__dirname, 'tests', 'e2e', 'support', 'scanPerformanceApp.py');
const performanceReporterPath = path.join(__dirname, 'scripts', 'playwright-performance-reporter.cjs');
const finalResultReporterPath = path.join(__dirname, 'scripts', 'playwright-final-result-reporter.cjs');
const { FINAL_RESULT_NONCE_ENV } = require(finalResultReporterPath);
const finalResultReporterOptions = { nonce: String(process.env[FINAL_RESULT_NONCE_ENV] || '') };
delete process.env[FINAL_RESULT_NONCE_ENV];
const selectedBrowser = runtimeFlags.browser;
const browserProjectUse = resolveBrowserProjectUse(selectedBrowser);
const managedScanApp = process.env.PLAYWRIGHT_MANAGED_SCAN_APP === '1';
const jsonOutputFile = String(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE || '').trim();

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e', 'scanPerformance'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'scan-performance'),
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
    ...(jsonOutputFile ? [['json', { outputFile: jsonOutputFile }]] : []),
  ],
  use: {
    baseURL: scanAppUrl,
    headless: isHeadless,
    viewport: { width: 1440, height: 960 },
    trace: PERFORMANCE_FAILURE_TRACE,
    screenshot: 'off',
  },
  projects: [
    {
      name: 'scan-performance',
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
  webServer: managedScanApp ? undefined : {
    command: `"${pythonExe}" "${supportAppPath}" --port ${scanAppPort}`,
    url: `${scanAppUrl}/status`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120000,
    env: buildAndAssertProviderWriteSafeEnv({
      ...process.env,
      ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH: statusSamplesPath,
    }),
  },
});
