const baseConfig = require('./playwright.config.js');

module.exports = {
  ...baseConfig,
  outputDir: baseConfig.outputDir.replace(/default$/, 'cover-rescan'),
  projects: [
    {
      name: 'cover-rescan',
      testMatch: /coverLookup\.spec\.js$/,
      grep: /FTC-COVERS-011|FTC-COVERS-035/,
      use: baseConfig.projects[0].use,
    },
  ],
};
