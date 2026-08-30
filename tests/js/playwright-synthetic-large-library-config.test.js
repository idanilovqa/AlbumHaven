const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

test('synthetic-large Playwright config delegates startup only to the validated managed runner', () => {
  const script = "const config=require('./playwright.synthetic-large-library.config.cjs');process.stdout.write(JSON.stringify(Boolean(config.webServer)));";
  const fixtureRoot = path.join(repoRoot, '.tmp', 'synthetic-fixture-contract');
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_MANAGED_APP: '1',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: 'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
      MUSIC_DIR: '',
      MUSIC_APP_DATA_DIR: '',
      MUSIC_CACHE_PATH: '',
      MUSIC_COVER_CACHE_PATH: '',
      MUSIC_LIBRARY_ROOTS_PATH: '',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), false);
});

test('synthetic-large Playwright config uses the exact managed loopback app URL', () => {
  const script = "const config=require('./playwright.synthetic-large-library.config.cjs');process.stdout.write(config.use.baseURL);";
  const fixtureRoot = path.join(repoRoot, '.tmp', 'synthetic-fixture-contract');
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_MANAGED_APP: '1',
      PLAYWRIGHT_REAL_APP_PORT: '5123',
      PLAYWRIGHT_REAL_APP_URL: '',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL: 'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
      MUSIC_DIR: '',
      MUSIC_APP_DATA_DIR: '',
      MUSIC_CACHE_PATH: '',
      MUSIC_COVER_CACHE_PATH: '',
      MUSIC_LIBRARY_ROOTS_PATH: '',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'http://127.0.0.1:5123');
});
