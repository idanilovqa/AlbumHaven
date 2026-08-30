import path from 'node:path';

const WINDOWS_PSQL_FALLBACK = 'C:\\PostgreSQL\\18\\bin\\psql.exe';

export function resolvePsqlCommands(environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return ['psql'];

  const configuredBin = String(environment.PGBIN || '').trim();
  const windowsPath = path.win32;
  const commands = [];
  if (configuredBin) {
    if (!windowsPath.isAbsolute(configuredBin)) {
      throw new Error('PGBIN must be an absolute path when selecting the PostgreSQL client.');
    }
    commands.push(windowsPath.join(configuredBin, 'psql.exe'));
  }
  commands.push('psql', WINDOWS_PSQL_FALLBACK);
  return [...new Set(commands)];
}

export function resolvePreferredPsqlCommand(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== 'win32') return 'psql';
  const configuredBin = String(environment.PGBIN || '').trim();
  if (!configuredBin) return WINDOWS_PSQL_FALLBACK;
  if (!path.win32.isAbsolute(configuredBin)) {
    throw new Error('PGBIN must be an absolute path when selecting the PostgreSQL client.');
  }
  return path.win32.join(configuredBin, 'psql.exe');
}

export const _private = { WINDOWS_PSQL_FALLBACK };
