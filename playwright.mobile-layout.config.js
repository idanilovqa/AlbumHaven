const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const { resolvePlaywrightPython } = require('./scripts/playwright-python.cjs');
const { resolveBrowserProjectUse } = require('./scripts/playwright-runtime-flags.cjs');
const python = resolvePlaywrightPython(process.env);
const port = Number(process.env.MOBILE_LAYOUT_PORT || 6190);
const smtpPort = Number(process.env.MOBILE_LAYOUT_SMTP_PORT || 6191);
const controlPort = Number(process.env.MOBILE_LAYOUT_CONTROL_PORT || 6192);
process.env.MOBILE_LAYOUT_CONTROL_URL = `http://127.0.0.1:${controlPort}`;
module.exports = defineConfig({
  testDir: './tests/e2e/mobile-layout',
  outputDir: './test-results/mobile-layout',
  workers: 1, fullyParallel: false, retries: 0, forbidOnly: Boolean(process.env.CI),
  timeout: 90000, expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/mobile-layout-results.json' }]],
  use: {
    ...devices['Pixel 7'], ...resolveBrowserProjectUse(process.env.PLAYWRIGHT_BROWSER || 'chromium'),
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: `"${python}" "${path.join(__dirname, 'tests/e2e/support/phase7AuthApp.py')}" --port ${port} --smtp-port ${smtpPort} --control-port ${controlPort} --mobile-layout-media`,
    url: `http://127.0.0.1:${port}/health`, timeout: 180000,
    reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  },
});
