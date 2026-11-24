import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const OWNER_PATTERN = /^E2E Save Cards [a-z0-9]+$/u;

// Every album is a folder of two same-named, same-length songs by one album artist in one year,
// so only album names decide which albums a save merges or folds.
const GENERATE = `
import json, shutil, sys
from pathlib import Path
from mutagen.id3 import ID3, TALB, TPE1, TPE2, TIT2, TRCK, TDRC
root = Path(sys.argv[1]).resolve(strict=True)
owner = root / sys.argv[2]
if owner.exists():
    raise RuntimeError("Owned save cards fixture already exists")
source = next(root.rglob("*.mp3"), None)
if source is None:
    raise RuntimeError("Save cards fixture requires one generated MP3 source")
owner.mkdir()
for index, album in enumerate(json.loads(sys.argv[3])):
    for number in [1, 2]:
        destination = owner / f"Folder {index:02d}" / f"{index:02d}-{number:02d}.mp3"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        tags = ID3(destination)
        tags.clear()
        for frame in [TALB(encoding=3, text=[album]), TPE1(encoding=3, text=[sys.argv[2]]),
                      TPE2(encoding=3, text=[sys.argv[2]]), TIT2(encoding=3, text=[f"Save Song {number}"]),
                      TRCK(encoding=3, text=[str(number)]), TDRC(encoding=3, text=["2026"])]:
            tags.add(frame)
        tags.save(destination)
print(json.dumps({"owner": str(owner)}))
`;

export async function createSaveCardsFixture(artist, albums) {
  if (!OWNER_PATTERN.test(artist)) throw new Error('Invalid fixture ownership name');
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', GENERATE, mediaRoot, artist, JSON.stringify(albums)],
    { encoding: 'utf8', windowsHide: true },
  );
  return { ...JSON.parse(stdout), artist, mediaRoot };
}

function ownedRoot(fixture) {
  const resolved = path.resolve(fixture.owner);
  if (path.dirname(resolved) !== path.resolve(fixture.mediaRoot) || !OWNER_PATTERN.test(path.basename(resolved))) {
    throw new Error('Unsafe fixture path');
  }
  return resolved;
}

export function albumFilenames(albumIndex) {
  return [1, 2].map(number => `${String(albumIndex).padStart(2, '0')}-${String(number).padStart(2, '0')}.mp3`);
}

async function setFileMode(fixture, mode) {
  const root = ownedRoot(fixture);
  const files = (await fs.readdir(root, { recursive: true })).filter(name => name.endsWith('.mp3'));
  await Promise.all(files.map(name => fs.chmod(path.join(root, name), mode)));
}

// A real media-write failure: the files refuse the save.
export async function makeFixtureFilesReadOnly(fixture) {
  await setFileMode(fixture, 0o444);
}

export async function makeFixtureFilesWritable(fixture) {
  await setFileMode(fixture, 0o644);
}

export async function removeSaveCardsFixture(fixture) {
  await makeFixtureFilesWritable(fixture);
  // The running app may still be closing a file it has just written.
  await fs.rm(ownedRoot(fixture), { recursive: true, maxRetries: 10, retryDelay: 200 });
}
