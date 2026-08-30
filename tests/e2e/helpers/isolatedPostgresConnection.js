const FAKE_E2E_DATABASE_NAME = 'album_haven_fake_e2e';
const CI_DATABASE_PATTERN = /^album_haven_ci_([a-z0-9]+(?:_[a-z0-9]+)*)$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function identityError() {
  return new Error(
    `This operation requires ${FAKE_E2E_DATABASE_NAME}/album_haven_migrator `
    + 'or an exact isolated Postgres setup identity using '
    + 'album_haven_ci_<suffix>/album_haven_migrator_<suffix> on loopback.',
  );
}

export function resolveIsolatedE2ESetupConnection(databaseUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(databaseUrl || '').trim());
  } catch {
    throw identityError();
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  const roleName = decodeURIComponent(parsedUrl.username);
  const ciDatabaseMatch = CI_DATABASE_PATTERN.exec(databaseName);
  const legacyIdentity = databaseName === FAKE_E2E_DATABASE_NAME
    && roleName === 'album_haven_migrator';
  const ciIdentity = ciDatabaseMatch !== null
    && roleName === `album_haven_migrator_${ciDatabaseMatch[1]}`;
  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol)
    || !LOOPBACK_HOSTS.has(parsedUrl.hostname)
    || parsedUrl.search
    || parsedUrl.hash
    || (!legacyIdentity && !ciIdentity)
  ) {
    throw identityError();
  }

  const password = parsedUrl.password
    ? decodeURIComponent(parsedUrl.password)
    : '';
  parsedUrl.password = '';
  const runtimeRoleName = ciDatabaseMatch
    ? `album_haven_app_${ciDatabaseMatch[1]}`
    : 'album_haven_app';
  return {
    databaseName,
    databaseTarget: parsedUrl.toString(),
    password,
    roleName,
    privilegeRoleName: runtimeRoleName,
    runtimeRoleName,
  };
}
