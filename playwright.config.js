const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const {
  resolveBrowserProjectUse,
  resolveRuntimeFlags,
} = require('./scripts/playwright-runtime-flags.cjs');
const { buildAndAssertProviderWriteSafeEnv } = require('./scripts/playwright-provider-safety.cjs');
const { resolvePlaywrightPython } = require('./scripts/playwright-python.cjs');

const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const providerPort = Number(process.env.PLAYWRIGHT_PROVIDER_PORT || port + 2);
const providerBaseURL = `http://127.0.0.1:${providerPort}`;
const setupDatabaseURL = process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL
  || 'postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e';
const runtimeDatabaseURL = process.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL
  || 'postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e';
process.env.ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL = providerBaseURL;
const pythonExe = resolvePlaywrightPython(process.env);
const isolatedAppScript = path.join(__dirname, 'tests', 'e2e', 'support', 'isolatedLibraryApp.py');
const performanceReporterPath = path.join(__dirname, 'scripts', 'playwright-performance-reporter.cjs');
const finalResultReporterPath = path.join(__dirname, 'scripts', 'playwright-final-result-reporter.cjs');
const { FINAL_RESULT_NONCE_ENV } = require(finalResultReporterPath);
const finalResultReporterOptions = { nonce: String(process.env[FINAL_RESULT_NONCE_ENV] || '') };
const blobOutputFile = String(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE || '').trim();
delete process.env[FINAL_RESULT_NONCE_ENV];
const runtimeFlags = resolveRuntimeFlags(process.argv.slice(2), process.env);
const isHeadless = runtimeFlags.headlessOverride ?? true;
const selectedBrowser = runtimeFlags.browser;
const browserProjectUse = resolveBrowserProjectUse(selectedBrowser);
const isolatedFunctionalTitles = /FTC-COVERS-011|FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details$/;
const managedBrowserProjectUse = {
  ...browserProjectUse,
  launchOptions: {
    ...(browserProjectUse.launchOptions || {}),
    args: [
      '--disable-gpu',
      '--enable-features=PerformanceMeasureMemory',
    ],
  },
};

module.exports = defineConfig({
  metadata: {
    providerBaseURL,
  },
  testDir: path.join(__dirname, 'tests', 'e2e', 'specs'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'default'),
  snapshotPathTemplate: `{testDir}/{testFileDir}/{testFileName}-snapshots/${selectedBrowser}/{arg}-{platform}{ext}`,
  timeout: 240000,
  // The default suite shares one production FastAPI/ASGI process plus isolated Postgres fixtures.
  // Keep the main e2e run single-worker so media and cover-task flows do not race.
  workers: 1,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  reporter: [
    ['list'],
    [performanceReporterPath],
    [finalResultReporterPath, finalResultReporterOptions],
    ...(blobOutputFile ? [['blob', { outputFile: blobOutputFile }]] : []),
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: isHeadless,
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'functional',
      grepInvert: isolatedFunctionalTitles,
      testIgnore: /lastfmAutoTimezone\.spec\.js$|playerReloadAutoplayAllowed\.spec\.js$/,
      use: managedBrowserProjectUse,
    },
  ],
  webServer: process.env.PLAYWRIGHT_MANAGED_APP === '1'
    ? undefined
    : {
      command: `"${pythonExe}" "${isolatedAppScript}" --port ${port} --provider-port ${providerPort}`,
      env: buildAndAssertProviderWriteSafeEnv({
        ...process.env,
        ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: setupDatabaseURL,
        ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: runtimeDatabaseURL,
        ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL: providerBaseURL,
        PLAYWRIGHT_PROVIDER_PORT: String(providerPort),
      }),
      url: `http://127.0.0.1:${port}/status`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120000,
    },
});
