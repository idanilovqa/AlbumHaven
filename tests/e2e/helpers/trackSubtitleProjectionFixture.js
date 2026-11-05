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

const GENERATE_FIXTURE = String.raw`
import json
import shutil
import sys
from pathlib import Path

from mutagen.id3 import ID3, TALB, TDRC, TIT2, TIT3, TPE1, TPE2, TPOS, TRCK, TXXX

media_root = Path(sys.argv[1]).resolve()
owner_name = sys.argv[2]
owner = (media_root / owner_name).resolve()
if owner.parent != media_root or owner.exists():
    raise RuntimeError("Track subtitle projection fixture ownership is invalid")

source = next(
    (
        candidate
        for candidate in media_root.rglob("*.mp3")
        if owner_name not in candidate.parts
    ),
    None,
)
if source is None:
    raise RuntimeError("Track subtitle projection fixture requires one generated MP3 source")

albums = [
    {
        "artist": "Art Zoyd",
        "album": "Génération sans futur",
        "year": "1976",
        "tracks": [
            {"title": "La Ville", "subtitle": "La Ville", "part": "La Ville"},
            {"title": "Speedy Gonzalez", "subtitle": "Speedy Gonzalez", "part": "Speedy Gonzalez"},
        ],
    },
    {
        "artist": "I Monster",
        "album": "Neveroddoreven",
        "year": "2003",
        "tracks": [
            {"title": "Daydream in Blue", "subtitle": "Glamour Puss Mix"},
            {"title": "Heaven", "subtitle": "Sticky Black Vinyl Mix"},
        ],
    },
    {
        "artist": "Annot Rhül",
        "album": "Leviathan",
        "year": "2014",
        "tracks": [
            {"title": "Leviathan I"},
            {"title": "Leviathan II"},
        ],
    },
    {
        "artist": "Accented Album Regression",
        "album": "Belle Âme",
        "year": "2012",
        "tracks": [
            {"title": "First Movement"},
            {"title": "Second Movement"},
        ],
    },
]

for album in albums:
    album_dir = owner / album["artist"] / album["album"]
    album_dir.mkdir(parents=True, exist_ok=True)
    track_total = len(album["tracks"])
    for track_number, track in enumerate(album["tracks"], start=1):
        destination = album_dir / f"{track_number:02d}.mp3"
        shutil.copyfile(source, destination)
        tags = ID3(destination)
        tags.clear()
        for frame in (
            TPE1(encoding=3, text=[album["artist"]]),
            TPE2(encoding=3, text=[album["artist"]]),
            TALB(encoding=3, text=[album["album"]]),
            TIT2(encoding=3, text=[track["title"]]),
            TRCK(encoding=3, text=[f"{track_number}/{track_total}"]),
            TPOS(encoding=3, text=["1/1"]),
            TDRC(encoding=3, text=[album["year"]]),
        ):
            tags.add(frame)
        if track.get("subtitle"):
            tags.add(TIT3(encoding=3, text=[track["subtitle"]]))
        if track.get("part"):
            tags.add(TXXX(encoding=3, desc="part", text=[track["part"]]))
        track["edition"] = f"Track Frame {track_number}"
        tags.add(TXXX(encoding=3, desc="Album Edition", text=[track["edition"]]))
        tags.save(destination)

print(json.dumps({"owner": str(owner), "albums": albums}))
`;

export async function createTrackSubtitleProjectionFixture() {
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const ownerName = `E2E Track Subtitle Projection ${randomUUID().replaceAll('-', '')}`;
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', GENERATE_FIXTURE, mediaRoot, ownerName],
    { encoding: 'utf8', windowsHide: true },
  );
  return { ...JSON.parse(stdout), mediaRoot };
}

const CLEAR_EXPLICIT_EDITIONS = String.raw`
import sys
from pathlib import Path

from mutagen.id3 import ID3

media_root = Path(sys.argv[1]).resolve()
owner = Path(sys.argv[2]).resolve()
if owner.parent != media_root or not owner.name.startswith("E2E Track Subtitle Projection "):
    raise RuntimeError("Track subtitle projection fixture ownership is invalid")

for track_path in owner.rglob("*.mp3"):
    tags = ID3(track_path)
    tags.delall("TXXX:Album Edition")
    tags.save(track_path)
`;

export async function clearTrackSubtitleProjectionEditions(fixture) {
  await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', CLEAR_EXPLICIT_EDITIONS, fixture.mediaRoot, fixture.owner],
    { encoding: 'utf8', windowsHide: true },
  );
}

export async function removeTrackSubtitleProjectionFixture(fixture) {
  const mediaRoot = path.resolve(fixture.mediaRoot);
  const owner = path.resolve(fixture.owner);
  if (
    path.dirname(owner) !== mediaRoot
    || !path.basename(owner).startsWith('E2E Track Subtitle Projection ')
  ) {
    throw new Error('Unsafe track subtitle projection fixture removal');
  }
  await fs.rm(owner, { recursive: true });
}
