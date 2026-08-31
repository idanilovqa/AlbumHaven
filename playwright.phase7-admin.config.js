const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { resolvePlaywrightPython } = require('./scripts/playwright-python.cjs');
const { resolveBrowserProjectUse } = require('./scripts/playwright-runtime-flags.cjs');

const port = Number(process.env.PHASE7_ADMIN_PORT || 6190);
const smtpPort = Number(process.env.PHASE7_ADMIN_SMTP_PORT || 6191);
const controlPort = Number(process.env.PHASE7_ADMIN_CONTROL_PORT || 6192);
const pythonExe = resolvePlaywrightPython(process.env);
const launcher = path.join(__dirname, 'tests', 'e2e', 'support', 'phase7AuthApp.py');
const browserUse = resolveBrowserProjectUse('chromium');
const setupDatabaseURL = process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL
  || 'postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e';
const runtimeDatabaseURL = process.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL
  || 'postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e';

process.env.PHASE7_AUTH_CONTROL_URL = `http://127.0.0.1:${controlPort}`;

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e', 'phase7', 'admin-management'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'phase7-admin'),
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    ...browserUse,
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'phase7-admin-management' }],
  webServer: {
    command: `"${pythonExe}" "${launcher}" --port ${port} --smtp-port ${smtpPort} --control-port ${controlPort}`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120000,
    env: {
      ...process.env,
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: setupDatabaseURL,
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: runtimeDatabaseURL,
    },
  },
});
