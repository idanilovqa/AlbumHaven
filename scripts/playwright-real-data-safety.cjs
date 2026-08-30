function assertManagedRealDataDatabaseEnv(env = {}, options = {}) {
  if (!options.managedGenericRealData) return env;
  if (!String(env.ALBUM_HAVEN_APP_DATABASE_URL || '').trim()) {
    throw new Error(
      'Managed generic real-data Playwright requires a non-empty '
      + 'ALBUM_HAVEN_APP_DATABASE_URL after dotenv loading. '
      + 'Unset an accidental empty override so the repository selector can load.',
    );
  }
  return env;
}

function assertManagedSyntheticLargeFixtureEnv(env = {}, options = {}) {
  if (!options.managedSyntheticLarge) return env;

  const expectedFixtureProfile = String(
    options.expectedFixtureProfile || 'synthetic-large-library',
  ).trim();
  if (!expectedFixtureProfile) {
    throw new Error('Managed fixture validation requires an exact expected fixture profile.');
  }

  if (String(env.PLAYWRIGHT_REAL_APP || '').trim() === '1') {
    throw new Error('Synthetic-large managed runs reject PLAYWRIGHT_REAL_APP owner mode.');
  }
  const rawDatabaseUrl = String(env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL || '').trim();
  const selectedDatabaseUrl = String(env.ALBUM_HAVEN_APP_DATABASE_URL || '').trim();
  if (!rawDatabaseUrl) {
    throw new Error('ALBUM_HAVEN_FAKE_E2E_DATABASE_URL is required for synthetic-large runs.');
  }
  if (!selectedDatabaseUrl || selectedDatabaseUrl !== rawDatabaseUrl) {
    throw new Error('ALBUM_HAVEN_APP_DATABASE_URL must match ALBUM_HAVEN_FAKE_E2E_DATABASE_URL exactly.');
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    throw new Error('ALBUM_HAVEN_FAKE_E2E_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || databaseUrl.password
    || databaseUrl.search
    || databaseUrl.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
    throw new Error('Synthetic-large database URL must be passwordless PostgreSQL on loopback without connection overrides.');
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, ''));
  const roleName = decodeURIComponent(databaseUrl.username);
  const suffixMatch = /^album_haven_ci_([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(databaseName);
  if (!suffixMatch || roleName !== `album_haven_app_${suffixMatch[1]}`) {
    throw new Error('Synthetic-large runs require a matching album_haven_ci_<suffix>/album_haven_app_<suffix> identity, never album_haven_core or a generic database.');
  }
  if (String(env.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim() !== expectedFixtureProfile) {
    throw new Error(`ALBUM_HAVEN_FIXTURE_PROFILE must be ${expectedFixtureProfile}.`);
  }
  const fixtureRoot = String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim();
  const mediaRoot = String(env.ALBUM_HAVEN_MEDIA_ROOT || '').trim();
  if (!fixtureRoot || !mediaRoot || !require('node:path').isAbsolute(fixtureRoot) || !require('node:path').isAbsolute(mediaRoot)) {
    throw new Error('ALBUM_HAVEN_FIXTURE_ROOT and ALBUM_HAVEN_MEDIA_ROOT must be absolute.');
  }
  const path = require('node:path');
  const resolvedFixture = path.resolve(fixtureRoot);
  const resolvedMedia = path.resolve(mediaRoot);
  const expectedMedia = path.resolve(resolvedFixture, 'media');
  if (resolvedMedia !== expectedMedia) {
    throw new Error('ALBUM_HAVEN_MEDIA_ROOT must be the exact media directory under ALBUM_HAVEN_FIXTURE_ROOT.');
  }
  for (const name of [
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL',
  ]) {
    const value = String(env[name] || '').trim();
    if (value) throw new Error(`${name} must not inherit an owner or generic runtime path.`);
  }
  return env;
}

module.exports = { assertManagedRealDataDatabaseEnv, assertManagedSyntheticLargeFixtureEnv };
