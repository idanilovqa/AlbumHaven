const baseConfig = require('./playwright.config.js');

module.exports = {
  ...baseConfig,
  outputDir: baseConfig.outputDir.replace(/default$/, 'lastfm-auto-timezone'),
  projects: [
    {
      name: 'lastfm-auto-timezone',
      testMatch: /lastfmAutoTimezone\.spec\.js$/,
      use: baseConfig.projects[0].use,
    },
  ],
};
