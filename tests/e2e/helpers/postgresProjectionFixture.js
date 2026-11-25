import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);
// The way a scoped relation index really goes stale: an older writer changes relation source rows (here it moves one
// album to another artist), so the triggers journal the album in library.local_relation_dirty_albums and the
// source fingerprint changes. The next start replays the journal per album ('pending_source_changes').
function oldWriterRelationChangeSql(keepArtist) {
  const keep = String(keepArtist).replaceAll("'", "''");
  return `
with target as (
  select libraries.id as library_id
  from library.libraries libraries
  join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
  where libraries.library_kind = 'local'
  order by libraries.id
  limit 1
), album as (
  select albums.id, albums.artist_id
  from library.local_albums albums
  join target on target.library_id = albums.library_id
  join library.local_artists artists on artists.id = albums.artist_id
  where artists.name <> '${keep}'
  order by albums.id desc
  limit 1
), owner as (
  select artists.id
  from library.local_artists artists
  join target on target.library_id = artists.library_id
  cross join album
  where artists.id <> album.artist_id and artists.name <> '${keep}'
    and exists (select 1 from library.local_albums owned where owned.artist_id = artists.id)
  order by artists.id desc
  limit 1
), moved as (
  update library.local_albums albums
  set artist_id = owner.id
  from album, owner
  where albums.id = album.id
  returning albums.id
)
select count(*) from moved;
`;
}

export async function journalOldWriterRelationChange(options = {}) {
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
        '--set=ON_ERROR_STOP=1', '--command', oldWriterRelationChangeSql(options.keepArtist ?? ''),
      ], { encoding: 'utf8', env: childEnv, windowsHide: true });
      const affected = Number.parseInt(String(result.stdout || '').trim(), 10);
      if (affected !== 1) throw new Error(`Expected one album moved by an old writer; moved ${affected || 0}.`);
      return affected;
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

// The stored relation rows' family for one artist: what the selected startup view may show before the replay
// finishes (the selected family projection reads the same links).
function storedFamilySql(artist) {
  const name = String(artist).replaceAll("'", "''");
  return `
with target as (
  select artists.id
  from library.local_artists artists
  join library.libraries libraries on libraries.id = artists.library_id and libraries.library_kind = 'local'
  where artists.name = '${name}'
  order by artists.id
  limit 1
)
select distinct family.name
from (
  select artist_id, related_artist_id, source_family from library.local_artist_family_links_current
  union all
  select artist_id, related_artist_id, source_family from library.local_artist_family_links
) links
join target on links.artist_id = target.id
join library.local_artists family on family.id = links.related_artist_id
where links.source_family <> 'folder_derived_runtime' and family.name <> '${name}'
order by family.name;
`;
}

export async function readStoredRelationFamily(artist, options = {}) {
  const env = options.env || process.env;
  const connection = resolveIsolatedE2ESetupConnection(env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
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
        '--set=ON_ERROR_STOP=1', '--command', storedFamilySql(artist),
      ], { encoding: 'utf8', env: childEnv, windowsHide: true });
      return String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

// An older writer's library: the scoped index has no compatibility evidence, so edits commit and their relation
// publication waits in the journal until the reconciliation owner proves the evidence (FTC-GALLERY-STARTUP-005Q).
const REMOVE_COMPATIBILITY_EVIDENCE_SQL = `
with removed as (
  delete from library.local_relation_compatibility_state state
  using library.libraries libraries
  join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
  where state.library_id = libraries.id and libraries.library_kind = 'local'
  returning state.library_id
)
select count(*) from removed;
`;

export async function removeRelationCompatibilityEvidence(options = {}) {
  const env = options.env || process.env;
  const connection = resolveIsolatedE2ESetupConnection(env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
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
        '--set=ON_ERROR_STOP=1', '--command', REMOVE_COMPATIBILITY_EVIDENCE_SQL,
      ], { encoding: 'utf8', env: childEnv, windowsHide: true });
      const removed = Number.parseInt(String(result.stdout || '').trim(), 10);
      if (removed !== 1) throw new Error(`Expected one library's compatibility evidence; removed ${removed || 0}.`);
      return removed;
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}
