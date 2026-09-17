import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveIsolatedE2ESetupConnection } from '../tests/e2e/helpers/isolatedPostgresConnection.js';

export async function captureIdentityDiagnostic({ album, accepted, testInfo, explainOnly = false }) {
  const { databaseTarget, password } = resolveIsolatedE2ESetupConnection(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
  const encoded = Buffer.from(album).toString('base64');
  const sql = `select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (
    select a.id as album_id, a.library_id, a.artist_id, ar.name as artist, a.album_key, a.title,
      a.release_year, a.metadata->>'edition' as edition,
      count(t.id) as track_count, array_agg(distinct f.metadata#>>'{scan_cache,file_entry,year}') as file_years,
      array_agg(distinct f.metadata#>>'{scan_cache,file_entry,album_artist}') as file_album_artists,
      array_agg(distinct f.metadata#>>'{scan_cache,file_entry,album}') as file_albums,
      (select jsonb_agg(s.release_key) from library.separate_releases s where s.library_id=a.library_id) as separate_release_keys
    from library.local_albums a
    left join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
    left join library.local_tracks t on t.album_id=a.id and t.library_id=a.library_id
    left join library.local_track_files f on f.track_id=t.id
    where a.title like convert_from(decode('${encoded}','base64'),'UTF8') || '%'
    group by a.id, ar.name order by a.id
  ) r;`;
  const env = { ...process.env, PGCLIENTENCODING: 'UTF8' };
  if (password) env.PGPASSWORD = password;
  delete env.PGDATABASE;
  const queryStartedAt = new Date().toISOString();
  const { stdout } = await promisify(execFile)('C:/PostgreSQL/18/bin/psql.exe', [
    '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', `--dbname=${databaseTarget}`,
    '--set=ON_ERROR_STOP=1', '--command', explainOnly ? `BEGIN READ ONLY; EXPLAIN ${sql} ROLLBACK;` : sql,
  ], { env, encoding: 'utf8', windowsHide: true });
  if (explainOnly) return { explained: stdout.includes('Aggregate') };
  await testInfo.attach('immediate-postgres-identity', {
    body: Buffer.from(JSON.stringify({ queryStartedAt, queryFinishedAt: new Date().toISOString(), rows: JSON.parse(stdout), accepted: accepted.payload ?? null }, null, 2)),
    contentType: 'application/json',
  });
}
