import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

// Marks every track of one fixture album as a Non-album rarity through the stored exception overrides, so the
// case owns Loose Tracks rows (the overrides' triggers queue them for the store); unmarking removes those keys.
const SCRIPT = `
import json
import sys

import psycopg
from psycopg.types.json import Jsonb

database_url, artist, album, action, keys = sys.argv[1:]
with psycopg.connect(database_url) as connection:
    if action == "unmark":
        # By the keys it marked: a rescan may have re-indexed the album's tracks since.
        for key in json.loads(keys):
            connection.execute(
                "delete from library.exception_overrides where track_key = %s and override_payload ->> 'exception_type' = 'Non-album rarity'",
                (key,),
            )
        print(json.dumps({"tracks": len(json.loads(keys)), "keys": json.loads(keys)}))
        raise SystemExit(0)
    tracks = connection.execute(
        """
        select tracks.library_id, tracks.id, files.private_path
        from library.local_tracks tracks
        join library.local_albums albums on albums.id = tracks.album_id
        join library.local_artists artists on artists.id = albums.artist_id
        join library.local_track_files files on files.track_id = tracks.id
        where artists.name = %s and albums.title = %s
        """,
        (artist, album),
    ).fetchall()
    if not tracks:
        raise RuntimeError("The fixture album has no tracks to mark.")
    for library_id, track_id, private_path in tracks:
        connection.execute(
            """
            insert into library.exception_overrides (library_id, track_id, track_key, override_payload)
            values (%s, %s, %s, %s)
            on conflict (library_id, track_key) do update set override_payload = excluded.override_payload
            """,
            (library_id, track_id, private_path, Jsonb({"exception_type": "Non-album rarity"})),
        )
print(json.dumps({"tracks": len(tracks), "keys": [row[2] for row in tracks]}))
`;

async function run(artist, album, action, environment, keys = []) {
  const databaseUrl = String(environment.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim();
  resolveIsolatedE2ESetupConnection(databaseUrl);
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(environment),
    ['-c', SCRIPT, databaseUrl, artist, album, action, JSON.stringify(keys)],
    { encoding: 'utf8', env: environment, windowsHide: true },
  );
  return JSON.parse(stdout);
}

export const markAlbumTracksAsRarities = ({ artist, album, environment = process.env }) => (
  run(artist, album, 'mark', environment)
);

// Takes the result of markAlbumTracksAsRarities.
export const unmarkAlbumTracksAsRarities = (marked, environment = process.env) => (
  run('', '', 'unmark', environment, marked?.keys || [])
);
