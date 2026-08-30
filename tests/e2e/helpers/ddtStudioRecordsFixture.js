import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsyncDefault = promisify(execFile);
const ARTIST = 'ДДТ';
const ALBUM = 'Студийные записи';
const TRACK_COUNT = 16;
const TOUCHED_TRACKS = new Set([1, 2, 3, 4]);
const YEARLESS_TRACKS = new Set([9, 10, 11, 16]);
const RESET_SQL_PATH = fileURLToPath(
  new URL('./ddtStudioRecordsFixtureReset.sql', import.meta.url),
);

const RESTORE_PHYSICAL_TAGS_SCRIPT = `
import json
import sys
from pathlib import Path

from mutagen.id3 import ID3, TDRC, TRCK

album_dir = Path(sys.argv[1]).resolve(strict=True)
fixture = json.loads(sys.argv[2])
expected = {
    row["filename"]: row
    for row in fixture
}
actual = {
    track_path.name: track_path
    for track_path in album_dir.glob("*.mp3")
}
if set(actual) != set(expected):
    raise RuntimeError(
        "Studio Records reset requires exactly the 16 expected generated MP3 files."
    )

records = []
for filename in sorted(expected):
    row = expected[filename]
    track_path = actual[filename]
    tags = ID3(track_path)
    if tags.getall("TXXX:Album Edition"):
        raise RuntimeError(
            f"Studio Records fixture must not contain an Album Edition tag: {filename}"
        )
    tags.delall("TDRC")
    tags.delall("TRCK")
    if row["year"] is not None:
        tags.add(TDRC(encoding=3, text=[str(row["year"])]))
    tags.add(TRCK(encoding=3, text=[str(row["track_number"])]))
    tags.save(track_path)
    track_stat = track_path.stat()
    records.append({
        **row,
        "private_path": str(track_path),
        "file_size_bytes": track_stat.st_size,
        "modified_at_epoch": track_stat.st_mtime,
    })

print(json.dumps(records, ensure_ascii=True))
`;

function expectedFixtureRows() {
  return Array.from({ length: TRACK_COUNT }, (_, index) => {
    const trackNumber = index + 1;
    const year = TOUCHED_TRACKS.has(trackNumber)
      ? 1990
      : YEARLESS_TRACKS.has(trackNumber)
        ? null
        : 1999;
    return {
      filename: `${String(trackNumber).padStart(2, '0')}. Студийная запись ${trackNumber}.mp3`,
      track_number: trackNumber,
      year,
      release_date: year === null ? null : `${year}-01-01`,
    };
  });
}

function resolveFixtureAlbumDirectory(environment) {
  const mediaRoot = resolveWritableFixtureMediaRoot(environment);
  const albumDirectory = path.resolve(mediaRoot, ARTIST, ALBUM);
  const relativePath = path.relative(mediaRoot, albumDirectory);
  if (
    !relativePath
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('The Studio Records fixture directory must be inside fixture media.');
  }
  return albumDirectory;
}

function resolvePsqlConnection(environment) {
  const databaseUrl = String(
    environment.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '',
  ).trim();
  if (!databaseUrl) {
    throw new Error(
      'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required to restore isolated Postgres.',
    );
  }
  return resolveIsolatedE2ESetupConnection(databaseUrl);
}

async function executePsql({ args, env, execFileAsync, platform }) {
  const commands = resolvePsqlCommands(env, platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      return await execFileAsync(commands[index], args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

export async function restoreDdtStudioRecordsFixture(
  {
    env = process.env,
    execFileAsync = execFileAsyncDefault,
    platform = process.platform,
    pythonCommand = resolvePlaywrightPython(env),
  } = {},
) {
  const albumDirectory = resolveFixtureAlbumDirectory(env);
  const { databaseTarget, password } = resolvePsqlConnection(env);
  const { stdout: physicalStdout } = await execFileAsync(
    pythonCommand,
    ['-c', RESTORE_PHYSICAL_TAGS_SCRIPT, albumDirectory, JSON.stringify(expectedFixtureRows())],
    { encoding: 'utf8', windowsHide: true },
  );
  const physicalRows = JSON.parse(String(physicalStdout || '').trim() || '[]');
  if (!Array.isArray(physicalRows) || physicalRows.length !== TRACK_COUNT) {
    throw new Error('Physical Studio Records reset did not return exactly 16 tracks.');
  }

  const args = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    `--dbname=${databaseTarget}`,
    '--set=ON_ERROR_STOP=1',
    `--variable=fixture_b64=${Buffer.from(
      JSON.stringify(physicalRows),
      'utf8',
    ).toString('base64')}`,
    `--file=${RESET_SQL_PATH}`,
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
  const result = JSON.parse(String(stdout || '').trim() || '{}');
  if (
    result.album_rows !== 1
    || result.track_rows !== TRACK_COUNT
    || result.track_file_rows !== TRACK_COUNT
    || result.album_edition_rows !== 0
    || result.file_edition_rows !== 0
  ) {
    throw new Error(`Studio Records Postgres reset was incomplete: ${JSON.stringify(result)}`);
  }
  return result;
}
