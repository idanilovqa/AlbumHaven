'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {nativeModuleSpecifiers} = require('./native-module-specifiers.cjs');
const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Sample native controller/view are reachable through the actual native mount without React or second boot', () => {
  const visited = new Set();
  function visit(relative) {
    if (visited.has(relative)) return; visited.add(relative);
    assert.ok(relative.startsWith('music_app/static/js/') && relative.endsWith('.mjs'));
    const source = read(relative);
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:react(?:-dom)?(?:\/|['"])|esbuild(?:\/|['"]))/);
    for (const specifier of nativeModuleSpecifiers(source)) {
      assert.ok(specifier.startsWith('.'), 'Native dependency must stay local');
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
  visit('music_app/static/js/home-friends/index-native.mjs');
  for (const relative of ['playlists/native.mjs', 'playlists/native-app.mjs', 'playlists/sample-playlist.mjs',
    'playlists/native-sample-playlist.mjs', 'playlists/native-track-table.mjs', 'playlists/model.mjs'])
    assert.ok(visited.has(`music_app/static/js/${relative}`), `Actual native delivery includes ${relative}`);
});

test('existing generated runtime input inventory contains actual Sample runtime owners exactly once', () => {
  const build = read('scripts/build-runtime-bundle.cjs');
  for (const name of ['js/runtime/playlist-queue.js', 'js/runtime/explicit-queue-sources.js', 'js/runtime/playlists-react-bridge.js'])
    assert.equal(build.split(`'${name}'`).length - 1, 1, name);
  // Source presence is not generated-byte freshness or release acceptance.
  assert.match(read('music_app/static/js/runtime/playlists-react-bridge.js'), /createSamplePlaylistRuntime/);
});
