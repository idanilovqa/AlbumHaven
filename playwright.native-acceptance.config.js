const home = require('./playwright.home-feedback.config.js');

// Reuse the serialized parent manifest and the managed Home app lifecycle.
module.exports = {
  ...home,
  testDir: './tests/e2e/nativeAcceptance',
  outputDir: './test-results/playwright-artifacts/native-acceptance',
  use: { ...home.use, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'native-acceptance-chrome' }],
};
