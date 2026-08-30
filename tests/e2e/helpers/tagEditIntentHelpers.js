import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

const STAGE_VERIFIED_INTENT_SCRIPT = `
import json
import sys
from pathlib import Path

import psycopg
from config import PERSISTENCE_BACKEND_POSTGRES
from mutagen.id3 import ID3, TALB
from music_app.services.library_roots import library_root_cache_identity
from psycopg.types.json import Jsonb

database_url, intent_id, track_path_text, media_root_text, old_album, requested_album = sys.argv[1:]
track_path = Path(track_path_text)
media_root = Path(media_root_text)
setup_config = {
    "ALBUM_HAVEN_APP_DATABASE_URL": database_url,
    "MUSIC_DIR": media_root,
    "CACHE_PATH": media_root.parent / "app-data" / "inert-library-cache.json",
    "LIBRARY_ROOTS_PATH": media_root.parent / "app-data" / "inert-library-roots.json",
    "PERSISTENCE_BACKENDS": {"library_roots": PERSISTENCE_BACKEND_POSTGRES},
}
root_identity = library_root_cache_identity(setup_config)

with psycopg.connect(database_url) as connection:
    exception_row = connection.execute(
        """
        select coalesce(
                 library.exception_overrides.override_payload ->> 'exception_type',
                 ''
               )
        from library.local_track_files
        join library.local_tracks
          on library.local_tracks.id = library.local_track_files.track_id
        left join library.exception_overrides
          on library.exception_overrides.library_id = library.local_tracks.library_id
         and library.exception_overrides.track_key = library.local_tracks.track_key
        where library.local_track_files.private_path = %s
          and library.local_track_files.scan_cache_stale is false
        """,
        (str(track_path),),
    ).fetchone()
    if exception_row is None:
        raise RuntimeError("The staged track is missing from Postgres inventory.")
    old_exception = exception_row[0] or ""
    changes = [{
        "path": str(track_path),
        "old_values": {"album": old_album, "exception_type": old_exception},
        "requested_values": {
            "album": requested_album,
            "exception_type": "Non-album rarity",
        },
    }]
    connection.execute(
        """
        insert into library.tag_edit_intents (
          id, library_root_identity, status, changes
        ) values (%s::uuid, %s, 'prepared', %s::jsonb)
        """,
        (intent_id, root_identity, Jsonb(changes)),
    )

tags = ID3(track_path)
album_frame = tags.get("TALB")
album_values = [str(value) for value in album_frame.text] if album_frame else []
if album_values != [old_album]:
    raise RuntimeError(
        f"Expected physical Album {old_album!r} before intent staging; received {album_values!r}."
    )
tags.delall("TALB")
if requested_album:
    tags.add(TALB(encoding=3, text=[requested_album]))
tags.save(track_path)

verified_tags = ID3(track_path)
verified_frame = verified_tags.get("TALB")
verified_values = (
    [str(value) for value in verified_frame.text]
    if verified_frame
    else []
)
expected_values = [requested_album] if requested_album else []
if verified_values != expected_values:
    raise RuntimeError(
        f"Physical Album verification failed: expected {expected_values!r}, received {verified_values!r}."
    )

with psycopg.connect(database_url) as connection:
    cursor = connection.execute(
        """
        update library.tag_edit_intents
        set status = 'files_verified', updated_at = now()
        where id = %s::uuid and status = 'prepared'
        returning id
        """,
        (intent_id,),
    )
    if cursor.fetchone() is None:
        raise RuntimeError("The staged tag-edit intent could not reach files_verified.")

print(json.dumps({"intentId": intent_id, "trackPath": str(track_path)}))
`;

const READ_INTENT_STATUS_SCRIPT = `
import json
import sys

import psycopg

database_url, intent_id = sys.argv[1:]
with psycopg.connect(database_url) as connection:
    row = connection.execute(
        """
        select status, last_error
        from library.tag_edit_intents
        where id = %s::uuid
        """,
        (intent_id,),
    ).fetchone()
if row is None:
    raise RuntimeError("The staged tag-edit intent is missing.")
print(json.dumps({"status": row[0], "lastError": row[1]}))
`;

const READ_TRACK_POSTGRES_STATE_SCRIPT = `
import json
import sys

import psycopg

database_url, track_path = sys.argv[1:]
with psycopg.connect(database_url) as connection:
    row = connection.execute(
        """
        select library.local_albums.title,
               coalesce(
                 library.exception_overrides.override_payload ->> 'exception_type',
                 ''
               )
        from library.local_track_files
        join library.local_tracks
          on library.local_tracks.id = library.local_track_files.track_id
        left join library.local_albums
          on library.local_albums.id = library.local_tracks.album_id
        left join library.exception_overrides
          on library.exception_overrides.library_id = library.local_tracks.library_id
         and library.exception_overrides.track_key = library.local_tracks.track_key
        where library.local_track_files.private_path = %s
          and library.local_track_files.scan_cache_stale is false
        """,
        (track_path,),
    ).fetchone()
if row is None:
    raise RuntimeError("The generated track is missing from Postgres inventory.")
print(json.dumps({"album": row[0] or "", "exceptionType": row[1] or ""}))
`;

function fakeDatabaseUrl(environment) {
  const databaseUrl = String(
    environment.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '',
  ).trim();
  resolveIsolatedE2ESetupConnection(databaseUrl);
  return databaseUrl;
}

function generatedTrackPath({ artist, album, filename, environment }) {
  const mediaRoot = resolveWritableFixtureMediaRoot(environment);
  const trackPath = fs.realpathSync(path.join(mediaRoot, artist, album, filename));
  const relativePath = path.relative(mediaRoot, trackPath);
  if (
    !relativePath
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
    || path.extname(trackPath).toLowerCase() !== '.mp3'
  ) {
    throw new Error('Intent staging rejects media outside the generated fixture root.');
  }
  return trackPath;
}

async function runPython(script, args, environment) {
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(environment),
    ['-c', script, ...args],
    {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

export async function stageFilesVerifiedAlbumAndExceptionIntent({
  artist,
  album,
  filename,
  requestedAlbum,
  environment = process.env,
}) {
  const intentId = randomUUID();
  const trackPath = generatedTrackPath({ artist, album, filename, environment });
  const mediaRoot = resolveWritableFixtureMediaRoot(environment);
  return runPython(
    STAGE_VERIFIED_INTENT_SCRIPT,
    [
      fakeDatabaseUrl(environment),
      intentId,
      trackPath,
      mediaRoot,
      String(album),
      String(requestedAlbum),
    ],
    environment,
  );
}

export async function readTagEditIntentStatus(
  intentId,
  environment = process.env,
) {
  return runPython(
    READ_INTENT_STATUS_SCRIPT,
    [fakeDatabaseUrl(environment), String(intentId)],
    environment,
  );
}

export async function readGeneratedTrackPostgresState(
  trackPath,
  environment = process.env,
) {
  return runPython(
    READ_TRACK_POSTGRES_STATE_SCRIPT,
    [fakeDatabaseUrl(environment), String(trackPath)],
    environment,
  );
}
