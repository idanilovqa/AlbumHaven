const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const fixtureSafety = require('../../scripts/playwright-real-data-safety.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const performanceTargetsPath = path.join(repoRoot, 'tests', 'ci', 'performance-targets.json');
const isolatedLibraryAppPath = path.join(repoRoot, 'tests', 'e2e', 'support', 'isolatedLibraryApp.py');
const managedFixtureRoot = path.join(repoRoot, 'test-results', 'fixtures', 'job-1234');

const formerLocalRealTargetNames = new Set([
  'all-artists',
  'artist-family',
  'search-all-artists',
  'utility-problematic-files',
  'utility-rules',
  'selected-artist',
  'search-browse',
  'root-album-browse',
  'app-open-all-artists',
  'problematic-files-focused',
  'rules-focused',
]);
const dedicatedProblematicTargetNames = new Set([
  'utility-problematic-files',
  'problematic-files-focused',
]);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readPerformanceTargets() {
  return JSON.parse(fs.readFileSync(performanceTargetsPath, 'utf8')).targets;
}

function extractPythonFunction(source, functionName) {
  const start = source.search(new RegExp(`^def ${functionName}\\(`, 'm'));
  assert.notEqual(start, -1, `isolatedLibraryApp.py must define ${functionName}`);
  const remainder = source.slice(start);
  const nextDefinition = remainder.slice(1).search(/^def |^class /m);
  return nextDefinition === -1 ? remainder : remainder.slice(0, nextDefinition + 1);
}

test('all 11 former local-real targets reference their selected discoverable cloud fixture specs', () => {
  const targets = readPerformanceTargets().filter((target) => formerLocalRealTargetNames.has(target.name));

  assert.equal(targets.length, 11);
  for (const target of targets) {
    const usesDedicatedProblematicProfile = dedicatedProblematicTargetNames.has(target.name);
    assert.equal(
      target.fixtureProfile,
      usesDedicatedProblematicProfile ? 'utility-problematic-files' : 'synthetic-large-library',
      target.name,
    );
    assert.doesNotMatch(target.runnerClass, /real/i, target.name);

    for (const ownedCase of target.cases) {
      const identity = `${target.name}: ${ownedCase.config} :: ${ownedCase.project} :: ${ownedCase.test}`;
      assert.doesNotMatch(identity, /localRealData|\.local\.|real[- ]data/i);
      assert.equal(fs.existsSync(path.join(repoRoot, ownedCase.config)), true, identity);
      assert.equal(fs.existsSync(path.join(repoRoot, ownedCase.test)), true, identity);

      if (usesDedicatedProblematicProfile) {
        assert.equal(ownedCase.config, 'playwright.utility-problematic-files.config.cjs', identity);
        assert.equal(ownedCase.project, 'utility-problematic-files', identity);
        assert.match(ownedCase.test, /^tests\/e2e\/utilityProblematicFiles\//, identity);
      } else if (target.name === 'utility-rules' || target.name === 'rules-focused') {
        assert.equal(ownedCase.config, 'playwright.synthetic-large-library.config.cjs', identity);
        assert.equal(ownedCase.project, 'synthetic-large-library', identity);
        assert.match(ownedCase.test, /^tests\/e2e\/syntheticLargeLibrary\//, identity);
      }

      const source = read(ownedCase.test);
      assert.doesNotMatch(source, /PLAYWRIGHT_REAL_APP/iu, identity);
      assert.doesNotMatch(source, /local[- ]only|local real-build|real[- ]data/iu, identity);
    }
  }
});

test('managed fixture safety accepts only the selected dedicated profile and rejects owner state', () => {
  const validate = fixtureSafety.assertManagedSyntheticLargeFixtureEnv;
  const safeManagedEnv = {
    ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app_1234@localhost/album_haven_ci_1234',
    ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: 'postgresql://album_haven_app_1234@localhost/album_haven_ci_1234',
    ALBUM_HAVEN_FIXTURE_PROFILE: 'utility-problematic-files',
    ALBUM_HAVEN_FIXTURE_ROOT: managedFixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(managedFixtureRoot, 'media'),
  };
  const options = {
    managedSyntheticLarge: true,
    expectedFixtureProfile: 'utility-problematic-files',
  };

  assert.doesNotThrow(() => validate(safeManagedEnv, options));
  assert.throws(
    () => validate({ ...safeManagedEnv, ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library' }, options),
    /ALBUM_HAVEN_FIXTURE_PROFILE|utility-problematic-files/,
  );
  assert.throws(
    () => validate({ ...safeManagedEnv, MUSIC_DIR: 'C:\\Users\\owner\\Music' }, options),
    /MUSIC_DIR|owner|runtime path/i,
  );
  assert.throws(
    () => validate({ ...safeManagedEnv, PLAYWRIGHT_REAL_APP_URL: 'https://owner.example.test' }, options),
    /PLAYWRIGHT_REAL_APP_URL|owner|loopback/i,
  );
});

test('managed converted runs reject owner mode and require the synthetic-large fixture contract', () => {
  const validate = fixtureSafety.assertManagedSyntheticLargeFixtureEnv;
  const safeManagedEnv = {
    ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app_1234@localhost/album_haven_ci_1234',
    ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: 'postgresql://album_haven_app_1234@localhost/album_haven_ci_1234',
    ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
    ALBUM_HAVEN_FIXTURE_ROOT: managedFixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(managedFixtureRoot, 'media'),
  };

  assert.equal(typeof validate, 'function');
  assert.throws(
    () => validate({
      ...safeManagedEnv,
      PLAYWRIGHT_REAL_APP: '1',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app@localhost/album_haven_core',
    }, { managedSyntheticLarge: true }),
    /owner|generic|PLAYWRIGHT_REAL_APP|album_haven_core/i,
  );
  assert.throws(
    () => validate({ ...safeManagedEnv, ALBUM_HAVEN_FIXTURE_PROFILE: '' }, { managedSyntheticLarge: true }),
    /ALBUM_HAVEN_FIXTURE_PROFILE|synthetic-large-library/,
  );
  assert.throws(
    () => validate({ ...safeManagedEnv, ALBUM_HAVEN_FIXTURE_ROOT: '' }, { managedSyntheticLarge: true }),
    /ALBUM_HAVEN_FIXTURE_ROOT/,
  );
  assert.throws(
    () => validate({
      ...safeManagedEnv,
      ALBUM_HAVEN_FIXTURE_ROOT: managedFixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(managedFixtureRoot, 'owner', 'Music'),
    }, { managedSyntheticLarge: true }),
    /exact|media/i,
  );
  assert.throws(
    () => validate({
      ...safeManagedEnv,
      PLAYWRIGHT_REAL_APP_URL: 'https://owner-library.example.test',
    }, { managedSyntheticLarge: true }),
    /PLAYWRIGHT_REAL_APP_URL|managed.*loopback/i,
  );
  assert.doesNotThrow(() => validate(safeManagedEnv, { managedSyntheticLarge: true }));
});

test('synthetic config is list-only for explicit inventory discovery and otherwise requires managed mode', () => {
  const configPath = './playwright.synthetic-large-library.config.cjs';
  const plain = childProcess.spawnSync(process.execPath, ['-e', `require('${configPath}')`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /managed|discovery/i);

  const discovery = childProcess.spawnSync(process.execPath, ['-e', [
    "process.argv.push('--list');",
    `const config = require('${configPath}');`,
    'process.stdout.write(JSON.stringify(Boolean(config.webServer)));',
  ].join(' ')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY: '1' },
  });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(JSON.parse(discovery.stdout), false);
});

test('isolatedLibraryApp exposes the shared preloaded fixture seam', () => {
  const source = fs.readFileSync(isolatedLibraryAppPath, 'utf8');
  const seam = extractPythonFunction(source, 'configure_preloaded_fixture');

  assert.match(seam, /ALBUM_HAVEN_FIXTURE_ROOT/);
  assert.match(seam, /ALBUM_HAVEN_FIXTURE_PROFILE/);
  assert.match(seam, /PRELOADED_FIXTURE_PROFILES/);
  assert.match(seam, /media/);
  assert.doesNotMatch(
    seam,
    /build_file_cache|persist_fixture_inventory|prepare_isolated_database/,
    'the preloaded seam must consume fixture media and already-loaded normal Postgres rows',
  );
  assert.match(
    source,
    /fixture_profile_mode\s*=\s*classify_fixture_profile_mode\(fixture_profile\)[\s\S]*?is_preloaded_fixture\s*=\s*fixture_profile_mode\s*==\s*["']preloaded-release["'][\s\S]*?if\s+is_preloaded_fixture:[\s\S]*?configure_preloaded_fixture\([\s\S]*?else:[\s\S]*?build_file_cache\(/,
    'managed fixture profiles must bypass the legacy generated-inventory path',
  );
  assert.match(source, /build_preloaded_synthetic_provider_cover_specs/);
  assert.doesNotMatch(
    source,
    /if\s+is_preloaded_fixture:[\s\S]{0,350}?cover_specs\s*=\s*\[\]/,
  );
});
