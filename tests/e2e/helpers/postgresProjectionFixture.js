import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);
const STALE_PROJECTION_SQL = `
with target as (
  select libraries.id
  from library.libraries libraries
  join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
  where libraries.library_kind = 'local'
  order by libraries.id
  limit 1
), updated as (
  update library.libraries libraries
  set metadata = jsonb_set(
    coalesce(libraries.metadata, '{}'::jsonb),
    '{scan_cache}',
    coalesce(libraries.metadata -> 'scan_cache', '{}'::jsonb)
      - 'relation_projection' - 'relation_views' - 'relations_last_built',
    true
  )
  from target
  where libraries.id = target.id
  returning libraries.id
)
select count(*) from updated;
`;

export async function markRelationProjectionStale(options = {}) {
  const env = options.env || process.env;
  const connection = resolveIsolatedE2ESetupConnection(
    env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
  );
  const childEnv = { ...env, PGCLIENTENCODING: 'UTF8' };
  delete childEnv.PGDATABASE;
  if (connection.password) childEnv.PGPASSWORD = connection.password;
  const commands = resolvePsqlCommands(env, options.platform || process.platform);
  const execute = options.execFileAsync || execFileAsyncDefault;

  for (let index = 0; index < commands.length; index += 1) {
    try {
      const result = await execute(commands[index], [
        '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
        `--dbname=${connection.databaseTarget}`,
        '--set=ON_ERROR_STOP=1', '--command', STALE_PROJECTION_SQL,
      ], { encoding: 'utf8', env: childEnv, windowsHide: true });
      const affected = Number.parseInt(String(result.stdout || '').trim(), 10);
      if (affected !== 1) throw new Error(`Expected one isolated library; updated ${affected || 0}.`);
      return affected;
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}
