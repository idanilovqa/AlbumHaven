const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { resolveBrowserProjectUse, resolveRuntimeFlags } = require('./scripts/playwright-runtime-flags.cjs');
const finalReporter = path.join(__dirname, 'scripts/playwright-final-result-reporter.cjs');
const { FINAL_RESULT_NONCE_ENV } = require(finalReporter);
const finalReporterOptions = { nonce: String(process.env[FINAL_RESULT_NONCE_ENV] || '') };
delete process.env[FINAL_RESULT_NONCE_ENV];
const flags = resolveRuntimeFlags(process.argv.slice(2), process.env);
const port = Number(process.env.PLAYWRIGHT_PORT || process.env.PLAYWRIGHT_REAL_APP_PORT || 6270);
const manifest = String(process.env.ALBUM_HAVEN_HOME_FEEDBACK_MANIFEST || '').trim();
const blobOutputFile = String(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE || '').trim();

module.exports = defineConfig({
  testDir: './tests/e2e/homeFeedback',
  // Full config metadata is serialized by Playwright before workers reload this file.
  metadata: { homeFeedbackManifest: manifest },
  outputDir: './test-results/playwright-artifacts/home-feedback',
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 10000 },
  reporter: [['list'], [finalReporter, finalReporterOptions],
    ...(blobOutputFile ? [['blob', { outputFile: blobOutputFile }]] : [])],
  use: {
    ...resolveBrowserProjectUse(flags.browser),
    baseURL: `http://127.0.0.1:${port}`,
    headless: flags.headlessOverride ?? true,
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'home-feedback-chromium' }],
});
