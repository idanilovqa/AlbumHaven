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
const TYPO_TRACKS = new Set([5, 6, 7, 8, 12]);
const TYPO_ARTIST = 'Ovderhead';
const TYPO_ALBUM = 'Telepathic Minds';
const RESET_SQL_PATH = fileURLToPath(
  new URL('./ddtStudioRecordsFixtureReset.sql', import.meta.url),
);

const RESTORE_PHYSICAL_TAGS_SCRIPT = `
import json
import sys
from pathlib import Path

from mutagen.id3 import ID3, TALB, TDRC, TRCK, TPE1, TPE2

album_dir = Path(sys.argv[1]).resolve(strict=True)
media_root = album_dir.parent.parent
fixture = json.loads(sys.argv[2])
expected = {
    row["filename"]: row
    for row in fixture
}
typo_dir = media_root / "Ovderhead" / "Telepathic Minds"
owned_dirs = (album_dir, typo_dir)
actual = {}
for filename in expected:
    matches = [directory / filename for directory in owned_dirs if (directory / filename).is_file()]
    if len(matches) != 1:
        raise RuntimeError(
            f"Studio Records reset requires exactly one owned copy of {filename}."
        )
    actual[filename] = matches[0]
if sum(1 for directory in owned_dirs for _ in directory.glob("*.mp3")) != len(expected):
    raise RuntimeError(
        "Studio Records reset requires exactly the 16 expected generated MP3 files."
    )

records = []
for filename in sorted(expected):
    row = expected[filename]
    track_path = actual[filename]
    destination = media_root / row["artist"] / row["album"] / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    if track_path != destination:
        track_path = track_path.replace(destination)
    tags = ID3(track_path)
    if tags.getall("TXXX:Album Edition"):
        raise RuntimeError(
            f"Studio Records fixture must not contain an Album Edition tag: {filename}"
        )
    tags.delall("TALB")
    tags.add(TALB(encoding=3, text=[row["album"]]))
    tags.delall("TPE1")
    tags.add(TPE1(encoding=3, text=[row["artist"]]))
    tags.delall("TPE2")
    tags.add(TPE2(encoding=3, text=[row["album_artist"]]))
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

function expectedFixtureRows({ typoArtistAlbum = false } = {}) {
  return Array.from({ length: TRACK_COUNT }, (_, index) => {
    const trackNumber = index + 1;
    const year = TOUCHED_TRACKS.has(trackNumber)
      ? 1990
      : YEARLESS_TRACKS.has(trackNumber)
        ? null
        : 1999;
    const isTypoAlbum = typoArtistAlbum && TYPO_TRACKS.has(trackNumber);
    return {
      filename: `${String(trackNumber).padStart(2, '0')}. Студийная запись ${trackNumber}.mp3`,
      artist: isTypoAlbum ? TYPO_ARTIST : ARTIST,
      album_artist: isTypoAlbum ? TYPO_ARTIST : ARTIST,
      album: isTypoAlbum ? TYPO_ALBUM : ALBUM,
      track_number: trackNumber,
      year,
      release_date: year === null ? null : `${year}-01-01`,
    };
  });
}

function resolveFixtureAlbumDirectory(environment) {
  const resolvedMediaRoot = resolveWritableFixtureMediaRoot(environment, {
    allowedProfiles: ['functional-core', 'synthetic-large-library'],
  });
  const mediaRoot = environment.ALBUM_HAVEN_FIXTURE_PROFILE === 'synthetic-large-library'
    && !String(environment.ALBUM_HAVEN_E2E_WRITABLE_MEDIA_ROOT || '').trim()
    ? path.resolve(resolvedMediaRoot, 'writable')
    : resolvedMediaRoot;
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
    typoArtistAlbum = false,
  } = {},
) {
  const albumDirectory = resolveFixtureAlbumDirectory(env);
  const { databaseTarget, password } = resolvePsqlConnection(env);
  const { stdout: physicalStdout } = await execFileAsync(
    pythonCommand,
    [
      '-c',
      RESTORE_PHYSICAL_TAGS_SCRIPT,
      albumDirectory,
      JSON.stringify(expectedFixtureRows({ typoArtistAlbum })),
    ],
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
    || Number(result.typo_album_rows || 0) !== (typoArtistAlbum ? 1 : 0)
    || Number(result.typo_membership_rows || 0) !== (typoArtistAlbum ? 1 : 0)
  ) {
    throw new Error(`Studio Records Postgres reset was incomplete: ${JSON.stringify(result)}`);
  }
  return result;
}
