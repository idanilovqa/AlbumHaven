const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const chromeExecutable = String(process.env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim();

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'components'),
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'components'),
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
