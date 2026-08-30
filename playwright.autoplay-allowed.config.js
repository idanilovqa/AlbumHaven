const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const baseConfig = require('./playwright.config.js');

const autoplayFlag = '--autoplay-policy=no-user-gesture-required';
const baseProject = baseConfig.projects[0];
const baseArgs = baseProject.use?.launchOptions?.args || [];

module.exports = defineConfig({
  ...baseConfig,
  outputDir: path.join(__dirname, 'test-results', 'playwright-artifacts', 'autoplay-allowed'),
  workers: 1,
  projects: [{
    ...baseProject,
    name: 'reload-autoplay-allowed',
    testMatch: /playerReloadAutoplayAllowed\.spec\.js$/,
    testIgnore: undefined,
    use: {
      ...baseProject.use,
      browserName: 'chromium',
      channel: baseProject.use.launchOptions?.executablePath ? undefined : 'chrome',
      launchOptions: {
        ...baseProject.use.launchOptions,
        args: [...baseArgs, autoplayFlag],
      },
    },
  }],
});
