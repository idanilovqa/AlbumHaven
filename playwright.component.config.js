const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const chromeExecutable = String(process.env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim();
const componentRunId = String(process.env.PLAYWRIGHT_COMPONENT_RUN_ID || `pid-${process.pid}`)
  .replace(/[^a-zA-Z0-9_.-]+/g, '-');

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'components'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'components', componentRunId),
  snapshotPathTemplate: '{testDir}/{testFileDir}/{testFileName}-snapshots/{projectName}/{arg}-{platform}{ext}',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    ...(chromeExecutable ? { launchOptions: { executablePath: chromeExecutable } } : { channel: 'chrome' }),
    headless: true,
    viewport: { width: 480, height: 640 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
