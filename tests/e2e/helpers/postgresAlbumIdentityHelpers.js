import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);
const IDENTITY_SQL_PATH = fileURLToPath(
  new URL('./postgresAlbumIdentityQuery.sql', import.meta.url),
);
const TRACK_METADATA_SQL_PATH = fileURLToPath(
  new URL('./postgresAlbumTrackMetadataQuery.sql', import.meta.url),
);

async function executePsql({
  args,
  env,
  execFileAsync,
  platform,
}) {
  const commands = resolvePsqlCommands(env, platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      return await execFileAsync(commands[index], args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
      });
    } catch (error) {
      const canTryFallback = error?.code === 'ENOENT' && index < commands.length - 1;
      if (!canTryFallback) {
        throw error;
      }
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

export async function queryPersistedAlbumIdentity(
  {
    artist,
    album,
    year,
    edition = '',
  },
  {
    env = process.env,
    execFileAsync = execFileAsyncDefault,
    platform = process.platform,
  } = {},
) {
  const databaseUrl = String(
    env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '',
  ).trim();
  if (!databaseUrl) {
    throw new Error(
      'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required to inspect isolated Postgres.',
    );
  }
  if (!Number.isInteger(Number(year))) {
    throw new Error(`A whole release year is required, received ${year}.`);
  }

  const { databaseTarget, password } = resolveIsolatedE2ESetupConnection(databaseUrl);
  const encodeSqlVariable = (value) => (
    Buffer.from(String(value), 'utf8').toString('base64')
  );
  const args = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    `--dbname=${databaseTarget}`,
    '--set=ON_ERROR_STOP=1',
    `--variable=artist_b64=${encodeSqlVariable(artist)}`,
    `--variable=album_b64=${encodeSqlVariable(album)}`,
    `--variable=year=${Number(year)}`,
    `--variable=edition_b64=${encodeSqlVariable(edition)}`,
    `--file=${IDENTITY_SQL_PATH}`,
  ];
  const childEnv = {
    ...env,
    PGCLIENTENCODING: 'UTF8',
  };
  delete childEnv.PGDATABASE;
  if (password) childEnv.PGPASSWORD = password;
  const { stdout } = await executePsql({
    args,
    env: childEnv,
    execFileAsync,
    platform,
  });
  const rows = JSON.parse(String(stdout || '').trim() || '[]');
  if (!Array.isArray(rows)) {
    throw new Error('The isolated Postgres identity query returned a non-array payload.');
  }
  return {
    album_ids: rows.map((row) => Number(row.album_id)),
    album_keys: rows.map((row) => String(row.album_key)),
    track_counts: rows.map((row) => Number(row.track_count)),
  };
}

export async function queryPersistedAlbumTrackMetadata(
  { artist, album },
  {
    env = process.env,
    execFileAsync = execFileAsyncDefault,
    platform = process.platform,
  } = {},
) {
  const databaseUrl = String(env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required to inspect isolated Postgres.');
  }
  const { databaseTarget, password } = resolveIsolatedE2ESetupConnection(databaseUrl);
  const encodeSqlVariable = (value) => Buffer.from(String(value), 'utf8').toString('base64');
  const childEnv = { ...env, PGCLIENTENCODING: 'UTF8' };
  delete childEnv.PGDATABASE;
  if (password) childEnv.PGPASSWORD = password;
  const { stdout } = await executePsql({
    args: [
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      `--dbname=${databaseTarget}`,
      '--set=ON_ERROR_STOP=1',
      `--variable=artist_b64=${encodeSqlVariable(artist)}`,
      `--variable=album_b64=${encodeSqlVariable(album)}`,
      `--file=${TRACK_METADATA_SQL_PATH}`,
    ],
    env: childEnv,
    execFileAsync,
    platform,
  });
  const rows = JSON.parse(String(stdout || '').trim() || '[]');
  if (!Array.isArray(rows)) throw new Error('The isolated Postgres track query returned a non-array payload.');
  return rows;
}
