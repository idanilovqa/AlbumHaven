const baseConfig = require('./playwright.config.js');

module.exports = {
  ...baseConfig,
  outputDir: baseConfig.outputDir.replace(/default$/, 'non-album-rescan'),
  projects: [
    {
      name: 'non-album-rescan',
      testMatch: /nonAlbumRarity\.spec\.js$/,
      grep: /FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details$/,
      use: baseConfig.projects[0].use,
    },
  ],
};
