const { defineConfig } = require('@playwright/test');
const baseline = require('./playwright.mobile-layout.config.js');
module.exports = defineConfig({
  ...baseline,
  testDir: './tests/e2e/mobile-feedback',
  outputDir: './test-results/mobile-feedback',
  reporter: [['list'], ['json', { outputFile: 'test-results/mobile-feedback-results.json' }]],
  webServer: { ...baseline.webServer, command: baseline.webServer.command + ' --extended-mobile-media' },
});
