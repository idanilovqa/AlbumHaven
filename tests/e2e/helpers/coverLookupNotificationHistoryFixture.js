import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsync = promisify(execFile);
const TASK_PREFIX = 'notification-history-performance-';
export const NOTIFICATION_HISTORY_SIZE = 528;

async function executeFixtureSql(sql, environment = process.env) {
  const connection = resolveIsolatedE2ESetupConnection(
    environment.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
  );
  const childEnvironment = { ...environment, PGCLIENTENCODING: 'UTF8' };
  delete childEnvironment.PGDATABASE;
  if (connection.password) childEnvironment.PGPASSWORD = connection.password;

  const commands = resolvePsqlCommands(environment, process.platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      const result = await execFileAsync(commands[index], [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        `--dbname=${connection.databaseTarget}`,
        '--set=ON_ERROR_STOP=1',
        '--command',
        sql,
      ], {
        encoding: 'utf8',
        env: childEnvironment,
        windowsHide: true,
      });
      return String(result.stdout || '').trim();
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

export async function seedCoverLookupNotificationHistory() {
  const inserted = Number(await executeFixtureSql(`
    with fixture_library as (
      select libraries.id
      from app.bootstrap_owners owners
      join library.libraries libraries on libraries.owner_account_id = owners.account_id
      where owners.owner_key = 'local-bootstrap-owner'
        and libraries.name = 'Local Library'
        and libraries.library_kind = 'local'
      limit 1
    ), actionable_album as (
      select
        albums.id,
        albums.album_key,
        albums.title,
        albums.release_year,
        artists.name as artist_name
      from fixture_library
      join library.local_albums albums on albums.library_id = fixture_library.id
      join library.local_artists artists on artists.id = albums.artist_id
      where encode(convert_to(albums.title, 'UTF8'), 'hex')
              = 'd0a0d0b5d0bcd0b8d0bad181d18b'
        and encode(convert_to(artists.name, 'UTF8'), 'hex') = 'd094d094d0a2'
      limit 1
    ), removed as (
      delete from ops.cover_lookup_tasks
      where task_key like '${TASK_PREFIX}%'
    ), inserted as (
      insert into ops.cover_lookup_tasks (
        library_id, task_key, status, requested_at, completed_at,
        provider_payload, metadata
      )
      select
        fixture_library.id,
        '${TASK_PREFIX}' || lpad(series.value::text, 4, '0'),
        'completed',
        now() - make_interval(secs => series.value),
        now() - make_interval(secs => series.value),
        '{}'::jsonb,
        jsonb_build_object(
          'source_family', 'cover_lookup_notifications',
          'notification_action_taken', false,
          'notification_completed_at', (now() - make_interval(secs => series.value))::text,
          'source_payload', jsonb_build_object(
            'type', 'cover_lookup',
            'artist', case
              when series.value = 1 then actionable_album.artist_name
              else 'Notification Artist ' || lpad(series.value::text, 4, '0')
            end,
            'album', case
              when series.value = 1 then actionable_album.title
              else 'Notification Album ' || lpad(series.value::text, 4, '0')
            end,
            'year', case
              when series.value = 1 then actionable_album.release_year
              else 2000 + (series.value % 25)
            end,
            'album_payload', case
              when series.value = 1 then jsonb_build_object(
                'id', actionable_album.id,
                'key', actionable_album.album_key,
                'album_key', actionable_album.album_key,
                'name', actionable_album.title,
                'album', actionable_album.title,
                'album_artist', actionable_album.artist_name,
                'artist', actionable_album.artist_name,
                'year', actionable_album.release_year
              )
              else null
            end,
            'progress', 100,
            'progress_label', 'Complete',
            'message', 'No better cover art was found.',
            'result_kind', 'no_results',
            'started_at', (now() - make_interval(secs => series.value + 1))::text,
            'updated_at', (now() - make_interval(secs => series.value))::text
          )
        )
      from fixture_library
      cross join actionable_album
      cross join generate_series(1, ${NOTIFICATION_HISTORY_SIZE}) as series(value)
      returning 1
    )
    select count(*) from inserted;
  `));
  if (inserted !== NOTIFICATION_HISTORY_SIZE) {
    throw new Error(`Expected ${NOTIFICATION_HISTORY_SIZE} notification rows; inserted ${inserted}.`);
  }
}

export async function clearCoverLookupNotificationHistory() {
  await executeFixtureSql(`
    delete from ops.cover_lookup_tasks
    where task_key like '${TASK_PREFIX}%';
  `);
}
