'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const readJson = filename => JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
const retired = name => ['react', 'react-dom', 'scheduler', 'esbuild'].includes(name) || name.startsWith('@esbuild/');
const aliasTarget = value => typeof value === 'string' && value.startsWith('npm:')
  ? value.slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@|$)/)?.[1] : null;
function checkEdges(record, location) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, value] of Object.entries(record[field] || {})) {
      assert.equal(retired(name), false, `${location}.${field}: ${name}`);
      const target = aliasTarget(value);
      if (target) assert.equal(retired(target), false, `${location}.${field}: alias ${name} -> ${target}`);
    }
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (Array.isArray(record[field])) for (const name of record[field]) {
      assert.equal(retired(name), false, `${location}.${field}: ${name}`);
    }
  }
}
function checkPackages(manifest, lock) {
  checkEdges(manifest, 'package.json');
  assert.equal(lock.lockfileVersion, 3, 'Inspect the delivered package-lock v3 node graph');
  assert.ok(lock.packages && Object.hasOwn(lock.packages, ''), 'Lock contains its root package');
  for (const [location, record] of Object.entries(lock.packages)) {
    const name = location.split('node_modules/').at(-1);
    assert.equal(retired(name), false, `Retired lock node: ${location}`);
    if (record.name) assert.equal(retired(record.name), false, `Retired aliased lock node: ${location}`);
    checkEdges(record, `package-lock.json:${location}`);
  }
  // A v3 lock should not carry a second legacy dependency graph unnoticed.
  assert.equal(Object.hasOwn(lock, 'dependencies'), false);
}

test('package and lock retire React, ReactDOM, scheduler and esbuild nodes and edges', () => {
  const manifest = readJson('package.json'), lock = readJson('package-lock.json');
  checkPackages(manifest, lock);
  assert.equal(typeof manifest.devDependencies?.['@playwright/test'], 'string');
  assert.equal(lock.packages[''].devDependencies['@playwright/test'], manifest.devDependencies['@playwright/test']);
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    assert.ok(lock.packages[`node_modules/${name}`], `Preserve browser runner ${name}`);
  }
});

test('dependency checks reject nested nodes, peer edges and npm aliases without banning bridge names', () => {
  const clean = () => ({lockfileVersion: 3, packages: {'': {}}});
  for (const name of ['react', 'react-dom', 'scheduler', 'esbuild', '@esbuild/linux-x64']) {
    assert.throws(() => checkPackages({dependencies: {[name]: '*'}}, clean()));
    const nested = clean(); nested.packages[`node_modules/other/node_modules/${name}`] = {};
    assert.throws(() => checkPackages({}, nested));
    const peer = clean(); peer.packages['node_modules/other'] = {peerDependencies: {[name]: '*'}};
    assert.throws(() => checkPackages({}, peer));
    assert.throws(() => checkPackages({optionalDependencies: {alias: `npm:${name}@1.0.0`}}, clean()));
  }
  assert.doesNotThrow(() => checkPackages({dependencies: {'album-tops-react-bridge': '*'}}, clean()));
});

// Functional/performance entry points are already covered by package-scripts.test.js.
test('cleanup preserves the remaining component and browser suite entry points', () => {
  const {scripts} = readJson('package.json');
  const expected = {
    'test:component': 'playwright test --config=playwright.component.config.js',
    'test:e2e:home-feedback': 'node scripts/run-playwright.cjs test --config=playwright.home-feedback.config.js',
    'test:e2e:phase7:auth': 'playwright test --config=playwright.phase7-auth.config.js',
    'test:e2e:phase7:admin': 'playwright test --config=playwright.phase7-admin.config.js',
    'test:e2e:performance:production-search': 'playwright test --config=playwright.production-search-benchmark.config.cjs',
    'test:e2e:performance:paired-search-calibration': 'node scripts/run-paired-search-calibration.cjs',
    'test:e2e:functional:local': 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1',
    'test:e2e:functional:local:list': 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1 -List',
  };
  for (const [name, command] of Object.entries(expected)) assert.equal(scripts[name], command, name);
});

// The native-entry-delivery.test.js closure walk already rejects JSX targets,
// bare dependencies and escapes without evaluating an application module.
// These exact obsolete production paths are deliberately narrower than a JSX
// or React substring ban: plain browser fixture entries and bridge names remain valid.
test('exact retired production JSX owners, builder and generated bundle assets remain absent', () => {
  const removed = [
    "music_app/static/js/album-tops/app.jsx",
    "music_app/static/js/album-tops/builder.jsx",
    "music_app/static/js/album-tops/index.jsx",
    "music_app/static/js/album-tops/mutation-notice.jsx",
    "music_app/static/js/album-tops/sharing.jsx",
    "music_app/static/js/home-friends/activity-missing.jsx",
    "music_app/static/js/home-friends/activity-tracks.jsx",
    "music_app/static/js/home-friends/activity.jsx",
    "music_app/static/js/home-friends/app.jsx",
    "music_app/static/js/home-friends/artist-selection.jsx",
    "music_app/static/js/home-friends/comparison.jsx",
    "music_app/static/js/home-friends/components.jsx",
    "music_app/static/js/home-friends/detail-projection.jsx",
    "music_app/static/js/home-friends/friend-notifications.jsx",
    "music_app/static/js/home-friends/friend-request.jsx",
    "music_app/static/js/home-friends/friends-directory.jsx",
    "music_app/static/js/home-friends/history-navigation.jsx",
    "music_app/static/js/home-friends/index.jsx",
    "music_app/static/js/home-friends/library-navigation.jsx",
    "music_app/static/js/home-friends/member-profile.jsx",
    "music_app/static/js/home-friends/native-choice.jsx",
    "music_app/static/js/home-friends/native-dialog.jsx",
    "music_app/static/js/home-friends/now-playing.jsx",
    "music_app/static/js/home-friends/profile.jsx",
    "music_app/static/js/home-friends/queue.jsx",
    "music_app/static/js/home-friends/resource-detail.jsx",
    "music_app/static/js/home-friends/resource-sharing.jsx",
    "music_app/static/js/home-friends/shared-header.jsx",
    "music_app/static/js/home-friends/track-preference.jsx",
    "music_app/static/js/home-friends/view-control.jsx",
    "music_app/static/js/playlists/app.jsx",
    "music_app/static/js/playlists/creation-session.jsx",
    "music_app/static/js/playlists/creation.jsx",
    "music_app/static/js/playlists/directory-filters.jsx",
    "music_app/static/js/playlists/draft-local-match.jsx",
    "music_app/static/js/playlists/draft.jsx",
    "music_app/static/js/playlists/filter-session.jsx",
    "music_app/static/js/playlists/filter-surface.jsx",
    "music_app/static/js/playlists/index.jsx",
    "music_app/static/js/playlists/integrations.jsx",
    "music_app/static/js/playlists/library-mix.jsx",
    "music_app/static/js/playlists/mutation-status.jsx",
    "music_app/static/js/playlists/selection-actions.jsx",
    "music_app/static/js/playlists/selection.jsx",
    "music_app/static/js/playlists/settings.jsx",
    "music_app/static/js/playlists/sharing.jsx",
    "music_app/static/js/playlists/track-table.jsx",
    "music_app/static/js/playtables/editor-selection.jsx",
    "music_app/static/js/playtables/selection.jsx",
    "music_app/static/js/playtables/track-table-presentation.jsx",
    "scripts/build-home-friends.cjs",
    "music_app/static/js/home-friends-bundle.js",
    "music_app/static/js/home-friends-bundle.js.LEGAL.txt"
];
  for (const filename of removed) {
    assert.throws(() => fs.lstatSync(path.join(root, filename)), {code: 'ENOENT'}, filename);
  }
});
