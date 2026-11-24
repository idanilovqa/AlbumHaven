import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// MusicBrainz Delivery 2, S4, at the measured sandbox6 scale (about 10,800 albums and 64,000
// stored correction rows). Synthetic only: listed fixture albums and synthetic albums get certain release
// decisions whose release titles differ from their tags, then the application's own refresh
// stores each album's correction count. Idempotent for a reused prepared fixture.
const SEED = String.raw`
import json, sys, uuid
import psycopg
from psycopg.rows import dict_row
from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository

database_url, listed_count, synthetic_count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
namespace = uuid.UUID("5d1e4c0a-0000-4000-8000-00000000c0de")
group = str(uuid.uuid5(namespace, "group"))
with psycopg.connect(database_url, row_factory=dict_row) as connection:
    library_id = connection.execute(
        "select library.libraries.id from app.bootstrap_owners join library.libraries"
        " on library.libraries.owner_account_id = app.bootstrap_owners.account_id"
        " and library.libraries.name = 'Local Library' and library.libraries.library_kind = 'local'"
        " where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'").fetchone()["id"]
    connection.execute(
        "insert into library.local_artists (library_id, artist_key, name, metadata)"
        " select %s, 's4-correction-artist-' || n, 'Correction Fixture Artist ' || n, '{}'::jsonb"
        " from generate_series(1, 100) n on conflict (library_id, artist_key) do nothing", (library_id,))
    connection.execute(
        "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, metadata)"
        " select %(library)s, artists.id, 's4-correction::' || lpad(n::text, 5, '0'),"
        "        'Correction Fixture Album ' || lpad(n::text, 5, '0'), 1970 + n %% 50, '{}'::jsonb"
        " from generate_series(1, %(count)s) n"
        " join library.local_artists artists on artists.library_id = %(library)s"
        "  and artists.artist_key = 's4-correction-artist-' || (1 + n %% 100)"
        " on conflict (library_id, album_key) do nothing", {"library": library_id, "count": synthetic_count})
    albums = connection.execute(
        "(select album_key, title from library.local_albums where library_id = %(library)s"
        "  and album_key not like 's4-correction::%%' order by album_key limit %(listed)s)"
        " union all (select album_key, title from library.local_albums where library_id = %(library)s"
        "  and album_key like 's4-correction::%%' order by album_key limit %(count)s)",
        {"library": library_id, "listed": listed_count, "count": synthetic_count}).fetchall()
    connection.execute(
        "insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at) values (%s, 'Fixture', now())"
        " on conflict (mbid) do nothing", (group,))
    rows = [{"album_key": row["album_key"], "release": str(uuid.uuid5(namespace, row["album_key"])),
             "title": f"{row['title']} (Remastered)"} for row in albums]
    connection.execute(
        "insert into integration.musicbrainz_releases (mbid, release_group_mbid, title, refreshed_at)"
        " select rows.release, %s, rows.title, now()"
        " from jsonb_to_recordset(%s::jsonb) as rows(release uuid, title text) on conflict (mbid) do nothing",
        (group, json.dumps(rows)))
    connection.execute(
        "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, release_group_mbid,"
        " release_mbid, matcher_version, observed_at)"
        " select %s, rows.album_key, 'release', %s, rows.release, 2, now()"
        " from jsonb_to_recordset(%s::jsonb) as rows(album_key text, release uuid)"
        " on conflict (library_id, album_key) do nothing", (library_id, group, json.dumps(rows)))
MusicBrainzCorrectionsPostgresRepository(
    {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
    connect=lambda url: psycopg.connect(url, row_factory=dict_row)).refresh()
with psycopg.connect(database_url, row_factory=dict_row) as connection:
    # sandbox6 stores about 64,000 rows: give each synthetic album five automatic track-title
    # case changes beside its compared album-title row (idempotent; no tracks or files added).
    connection.execute(
        "insert into library.local_album_musicbrainz_correction_rows (library_id, album_key, field, disc_number,"
        " track_number, current_value, proposed_value, kind, mode)"
        " select stored.library_id, stored.album_key, 'title', 1, n, 'track ' || n, 'Track ' || n, 'case', 'auto'"
        " from library.local_album_musicbrainz_corrections stored cross join generate_series(1, 5) n"
        " where stored.album_key like 's4-correction::%%' and stored.auto_count = 0")
    connection.execute(
        "update library.local_album_musicbrainz_corrections set auto_count = 5, correction_count = correction_count + 5"
        " where album_key like 's4-correction::%%' and auto_count = 0")
    stored = connection.execute(
        "select count(*) filter (where correction_count > 0) as needing,"
        " count(*) filter (where correction_count > 0 and album_key not like 's4-correction::%%') as listed,"
        " (select count(*) from library.local_album_musicbrainz_correction_rows) as rows"
        " from library.local_album_musicbrainz_corrections").fetchone()
print(json.dumps({"albums": stored["needing"], "fixtureAlbums": stored["listed"], "rows": stored["rows"]}))
`;

/** Store about 10,800 data corrections in the isolated performance database. */
export async function seedMusicBrainzCorrections({ listedAlbums = 300, syntheticAlbums = 10500 } = {}) {
  const databaseUrl = String(process.env.DATABASE_MIGRATOR_URL || '').trim();
  resolveIsolatedE2ESetupConnection(databaseUrl);
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', SEED, databaseUrl, String(listedAlbums), String(syntheticAlbums)],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
