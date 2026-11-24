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

const OWNER_PREFIX = '天門 E2E ';

// An album whose track-artist frames were written by a Latin-1 tagger: every
// Japanese character became "?". The album-artist frame kept the real name.
const GENERATE_FIXTURE = String.raw`
import json
import shutil
import sys
from pathlib import Path

from mutagen.id3 import ID3, TALB, TDRC, TIT2, TPE1, TPE2, TRCK

media_root = Path(sys.argv[1]).resolve()
owner_name = sys.argv[2]
album = sys.argv[3]
owner = (media_root / owner_name).resolve()
if owner.parent != media_root or owner.exists():
    raise RuntimeError("Unreadable credit fixture ownership is invalid")
source = next((candidate for candidate in media_root.rglob("*.mp3") if owner_name not in candidate.parts), None)
if source is None:
    raise RuntimeError("Unreadable credit fixture requires one generated MP3 source")

album_dir = owner / album
album_dir.mkdir(parents=True)
files = []
for track_number, title in enumerate(("Main Theme", "Ending Theme"), start=1):
    destination = album_dir / f"{track_number:02d} - {title}.mp3"
    shutil.copyfile(source, destination)
    tags = ID3(destination)
    tags.clear()
    for frame in (
        TPE1(encoding=0, text=["??"]),
        TPE2(encoding=3, text=[owner_name]),
        TALB(encoding=3, text=[album]),
        TIT2(encoding=3, text=[title]),
        TRCK(encoding=3, text=[f"{track_number}/2"]),
        TDRC(encoding=3, text=["2011"]),
    ):
        tags.add(frame)
    tags.save(destination)
    files.append({"path": str(destination), "filename": destination.name, "title": title})

print(json.dumps({"owner": str(owner), "ownerName": owner_name, "album": album, "files": files}))
`;

const READ_TRACK_ARTISTS = String.raw`
import json
import sys

from mutagen.id3 import ID3

print(json.dumps([[str(text) for text in ID3(path).get("TPE1").text] for path in sys.argv[1:]]))
`;

async function runPython(script, args) {
  const { stdout } = await execFileAsync(resolvePlaywrightPython(process.env), ['-c', script, ...args],
    { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout);
}

export async function createUnreadableCreditFixture() {
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const token = randomUUID().replaceAll('-', '').slice(0, 10);
  const ownerName = `${OWNER_PREFIX}${token}`;
  const album = `She and Her Cat ${token.split('').reverse().join('')}`;
  return { ...(await runPython(GENERATE_FIXTURE, [mediaRoot, ownerName, album])), mediaRoot };
}

/** The track-artist (TPE1) text each fixture file holds on disk. */
export async function readFixtureTrackArtists(fixture) {
  return runPython(READ_TRACK_ARTISTS, fixture.files.map((file) => file.path));
}

export async function removeUnreadableCreditFixture(fixture) {
  const mediaRoot = path.resolve(fixture.mediaRoot);
  const owner = path.resolve(fixture.owner);
  if (path.dirname(owner) !== mediaRoot || !path.basename(owner).startsWith(OWNER_PREFIX)) {
    throw new Error('Unsafe unreadable credit fixture removal');
  }
  await fs.rm(owner, { recursive: true });
}
