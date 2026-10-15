const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');

test('native delivery retains the runtime build command without the obsolete React build command', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.scripts['build:runtime'], 'node scripts/build-runtime-bundle.cjs');
  assert.equal(Object.hasOwn(manifest.scripts, 'build:home-friends'), false);
  for (const [name, command] of Object.entries(manifest.scripts)) {
    assert.doesNotMatch(command, /build-home-friends(?:\.cjs)?|build:home-friends/, name);
  }
});

test('runtime concatenator main writes the native runtime without generating a React bundle', () => {
  const source = read('scripts/build-runtime-bundle.cjs');
  const main = source.match(/if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(main, 'Retain the explicit executable-main boundary');
  assert.match(main[1], /^\s*writeRuntimeBundle\(\);/m);
  assert.doesNotMatch(source, /build-home-friends|buildHomeFriendsBundle|home-friends-bundle/);
  assert.doesNotMatch(source, /require\s*\(\s*['"](?:react(?:-dom)?|esbuild)(?:\/[^'"]*)?['"]\s*\)/);
});

test('plain runtime concatenator keeps its existing output and public build interfaces', () => {
  const source = read('scripts/build-runtime-bundle.cjs');
  assert.match(source, /const\s+outputPath\s*=\s*path\.join\(repoRoot,\s*'music_app',\s*'static',\s*'js',\s*'runtime-bundle\.js'\)/);
  assert.match(source, /function\s+buildRuntimeBundle\s*\(\s*\)/);
  assert.match(source, /function\s+writeRuntimeBundle\s*\(\s*\)/);
  const exports = source.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  assert.ok(exports, 'Retain the concatenator exports');
  for (const name of ['RUNTIME_SCRIPT_PATHS', 'buildRuntimeBundle', 'outputPath']) {
    assert.match(exports[1], new RegExp('(?:^|,)\\s*' + name + '\\s*(?:,|$)'));
  }
});
