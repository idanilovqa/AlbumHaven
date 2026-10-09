const path = require('node:path');
const {buildSync} = require('esbuild');
function buildHomeFriendsBundle() {
  buildSync({absWorkingDir: path.join(__dirname, '..'), entryPoints: ['music_app/static/js/home-friends/index.jsx'],
    outfile: 'music_app/static/js/home-friends-bundle.js', bundle: true, minify: true,
    platform: 'browser', target: ['es2020'], format: 'iife', legalComments: 'linked',
    define: {'process.env.NODE_ENV': '"production"'},
  });
}
if (require.main === module) buildHomeFriendsBundle();
module.exports = {buildHomeFriendsBundle};
