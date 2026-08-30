const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const providerSafety = require('../../scripts/playwright-provider-safety.cjs');
const { _private: playwrightRunner } = require('../../scripts/run-playwright.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const inheritedOwnerEnv = Object.freeze({
  LASTFM_API_ENABLED: '1',
  LASTFM_API_KEY: 'owner-api-key',
  LASTFM_API_SECRET: 'owner-api-secret',
  LASTFM_API_ROOT: 'https://owner-lastfm.example/2.0/',
  LASTFM_SESSION: 'owner-session',
  LASTFM_SESSION_KEY: 'owner-session-key',
  LASTFM_USERNAME: 'owner-user',
});

function assertLastfmWritesDisabled(env) {
  for (const key of providerSafety.LASTFM_WRITE_ENV_KEYS) assert.equal(env[key], '');
  assert.doesNotThrow(() => providerSafety.assertProviderWriteSafeEnv(env));
}

test('provider safety blanks inherited Last.fm write configuration and rejects unsafe child env', () => {
  assertLastfmWritesDisabled(providerSafety.buildAndAssertProviderWriteSafeEnv({
    ...inheritedOwnerEnv,
    KEEP_ME: 'preserved',
  }));
  assert.throws(
    () => providerSafety.assertProviderWriteSafeEnv(inheritedOwnerEnv),
    /must blank LASTFM_API_ENABLED/,
  );
});

test('run-playwright sanitizes Last.fm values after loading repo-style dotenv values', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-lastfm-env-'));
  const dotenvPath = path.join(tempRoot, '.env');
  fs.writeFileSync(
    dotenvPath,
    Object.entries(inheritedOwnerEnv).map(([key, value]) => `${key}=${value}`).join('\n'),
    'utf8',
  );
  try {
    const loaded = playwrightRunner.loadDotEnvFile({}, dotenvPath);
    assert.deepEqual(loaded, inheritedOwnerEnv);
    assertLastfmWritesDisabled(playwrightRunner.buildAndAssertProviderWriteSafeEnv(loaded));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-playwright refuses to spawn when an unsafe Last.fm child environment bypasses sanitizing', async () => {
  await assert.rejects(
    playwrightRunner.runPlaywrightProcess(['test'], inheritedOwnerEnv, 1000, {
      spawnFn() {
        throw new Error('unsafe environment reached spawn');
      },
    }),
    /must blank LASTFM_API_ENABLED/,
  );
});

test('run-playwright rejects a synthetic run without the effective isolated database selector', async () => {
  const safeEnv = playwrightRunner.buildAndAssertProviderWriteSafeEnv({
    ...inheritedOwnerEnv,
    ALBUM_HAVEN_APP_DATABASE_URL: '',
  });
  assertLastfmWritesDisabled(safeEnv);

  await assert.rejects(
    playwrightRunner.runPlaywrightProcess(
      ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
      safeEnv,
      1000,
      {
        spawnFn() {
          throw new Error('empty database selector reached spawn');
        },
      },
    ),
    /ALBUM_HAVEN_FAKE_E2E_DATABASE_URL/,
  );
});

test('managed real-data database preflight accepts configured generic and internally isolated modes', () => {
  assert.doesNotThrow(() => playwrightRunner.assertManagedRealDataDatabaseEnv(
    { ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app@localhost/album_haven' },
    { managedGenericRealData: true },
  ));
  assert.doesNotThrow(() => playwrightRunner.assertManagedRealDataDatabaseEnv(
    { ALBUM_HAVEN_APP_DATABASE_URL: '' },
    { managedGenericRealData: false },
  ));
});

for (const [configPath, extraEnv] of [
  ['playwright.config.js', {}],
  ['playwright.performance.config.cjs', {}],
  ['playwright.scan-performance.config.cjs', {}],
]) {
  test(`${configPath} never forwards inherited Last.fm write settings to webServer`, () => {
    const script = `const config = require('./${configPath}'); process.stdout.write(JSON.stringify(config.webServer.env));`;
    const result = childProcess.spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...inheritedOwnerEnv,
        ...extraEnv,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assertLastfmWritesDisabled(JSON.parse(result.stdout));
  });
}

test('synthetic-large config accepts only a fully validated runner-managed environment', () => {
  const script = "const config = require('./playwright.synthetic-large-library.config.cjs'); process.stdout.write(JSON.stringify(Boolean(config.webServer)));";
  const fixtureRoot = path.join(repoRoot, 'test-results', 'fixture-contract');
  const unsafeResult = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...inheritedOwnerEnv,
    },
  });
  assert.notEqual(unsafeResult.status, 0);
  assert.match(unsafeResult.stderr, /runner-managed mode|inventory discovery/);

  const managedResult = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...inheritedOwnerEnv,
      PLAYWRIGHT_MANAGED_APP: '1',
      PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
      ALBUM_HAVEN_APP_DATABASE_URL:
        'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
        'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    },
  });
  assert.equal(managedResult.status, 0, managedResult.stderr);
  assert.equal(JSON.parse(managedResult.stdout), false);
});
