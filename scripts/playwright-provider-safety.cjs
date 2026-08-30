const LASTFM_WRITE_ENV_KEYS = Object.freeze([
  'LASTFM_API_ENABLED',
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_API_ROOT',
  'LASTFM_SESSION',
  'LASTFM_SESSION_KEY',
  'LASTFM_USERNAME',
]);

function buildProviderWriteSafeEnv(env = {}) {
  const safeEnv = { ...env };
  for (const key of LASTFM_WRITE_ENV_KEYS) safeEnv[key] = '';
  return safeEnv;
}

function assertProviderWriteSafeEnv(env = {}) {
  for (const key of LASTFM_WRITE_ENV_KEYS) {
    if (String(env[key] || '').trim()) {
      throw new Error(`Playwright child environment must blank ${key} before launching the app.`);
    }
  }
  return env;
}

function buildAndAssertProviderWriteSafeEnv(env = {}) {
  return assertProviderWriteSafeEnv(buildProviderWriteSafeEnv(env));
}

module.exports = {
  LASTFM_WRITE_ENV_KEYS,
  assertProviderWriteSafeEnv,
  buildAndAssertProviderWriteSafeEnv,
  buildProviderWriteSafeEnv,
};
