import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

const OWNER_PREFIX = 'E2E Compilation Owner ';

// Three Various Artists compilations owned by one artist folder. The same two
// track artists appear on every part and sort before the owner, so a title
// search that auto-selected the alphabetical first group would hide the set.
const GENERATE_FIXTURE = String.raw`
import json
import shutil
import sys
from pathlib import Path

from mutagen.id3 import ID3, TALB, TCMP, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK

media_root = Path(sys.argv[1]).resolve()
owner_name = sys.argv[2]
saga = sys.argv[3]
owner = (media_root / owner_name).resolve()
if owner.parent != media_root or owner.exists():
    raise RuntimeError("Compilation title search fixture ownership is invalid")

source = next(
    (candidate for candidate in media_root.rglob("*.mp3") if owner_name not in candidate.parts),
    None,
)
if source is None:
    raise RuntimeError("Compilation title search fixture requires one generated MP3 source")

track_artists = ["Aa Credit One", "Aa Credit Two"]
albums = []
for part in ("I", "II", "III"):
    album = f"{saga}, Part {part}"
    album_dir = owner / album
    album_dir.mkdir(parents=True, exist_ok=True)
    for track_number, artist in enumerate(track_artists, start=1):
        destination = album_dir / f"{track_number:02d} - {artist}.mp3"
        shutil.copyfile(source, destination)
        tags = ID3(destination)
        tags.clear()
        for frame in (
            TPE1(encoding=3, text=[artist]),
            TPE2(encoding=3, text=["Various Artists"]),
            TALB(encoding=3, text=[album]),
            TIT2(encoding=3, text=[f"{artist} {part}"]),
            TRCK(encoding=3, text=[f"{track_number}/{len(track_artists)}"]),
            TPOS(encoding=3, text=["1/1"]),
            TDRC(encoding=3, text=["2014"]),
            TCMP(encoding=3, text=["1"]),
        ):
            tags.add(frame)
        tags.save(destination)
    albums.append(album)

print(json.dumps({"owner": str(owner), "ownerName": owner_name, "saga": saga, "albums": albums, "trackArtists": track_artists}))
`;

export async function createCompilationTitleSearchFixture() {
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const token = randomUUID().replaceAll('-', '').slice(0, 10);
  const ownerName = `${OWNER_PREFIX}${token}`;
  // The title shares no word with any artist name, so the search names nobody.
  const saga = `Odyssey Saga ${token.split('').reverse().join('')}`;
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', GENERATE_FIXTURE, mediaRoot, ownerName, saga],
    { encoding: 'utf8', windowsHide: true },
  );
  return { ...JSON.parse(stdout), mediaRoot };
}

export async function removeCompilationTitleSearchFixture(fixture) {
  const mediaRoot = path.resolve(fixture.mediaRoot);
  const owner = path.resolve(fixture.owner);
  if (path.dirname(owner) !== mediaRoot || !path.basename(owner).startsWith(OWNER_PREFIX)) {
    throw new Error('Unsafe compilation title search fixture removal');
  }
  await fs.rm(owner, { recursive: true });
}
