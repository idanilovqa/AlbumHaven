import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const OWNER_PATTERN = /^E2E Duplicate Twin [a-z0-9]+$/u;

// Two folders holding the same two songs by one album artist in one year; only the
// album names differ, so renaming one album makes the two a duplicate pair.
const GENERATE = `
import json, shutil, sys
from pathlib import Path
from mutagen.id3 import ID3, TALB, TPE1, TPE2, TIT2, TRCK, TDRC
root = Path(sys.argv[1]).resolve(strict=True)
owner = root / sys.argv[2]
if owner.exists():
    raise RuntimeError("Owned duplicate twin fixture already exists")
source = next(root.rglob("*.mp3"), None)
if source is None:
    raise RuntimeError("Duplicate twin fixture requires one generated MP3 source")
owner.mkdir()
for folder, album in [("Twin Copy", "Twin Release"), ("Other Copy", "Other Release")]:
    for number in [1, 2]:
        destination = owner / folder / f"{number:02d}.mp3"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        tags = ID3(destination)
        tags.clear()
        for frame in [TALB(encoding=3, text=[album]), TPE1(encoding=3, text=[sys.argv[2]]),
                      TPE2(encoding=3, text=[sys.argv[2]]), TIT2(encoding=3, text=[f"Twin Song {number}"]),
                      TRCK(encoding=3, text=[str(number)]), TDRC(encoding=3, text=["2026"])]:
            tags.add(frame)
        tags.save(destination)
print(json.dumps({"owner": str(owner)}))
`;

export async function createDuplicateTwinFixture(artist) {
  if (!OWNER_PATTERN.test(artist)) throw new Error('Invalid fixture ownership name');
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const { stdout } = await execFileAsync(resolvePlaywrightPython(process.env), ['-c', GENERATE, mediaRoot, artist], {
    encoding: 'utf8', windowsHide: true,
  });
  return { ...JSON.parse(stdout), artist, mediaRoot };
}

export async function removeDuplicateTwinFixture(fixture) {
  const resolved = path.resolve(fixture.owner);
  if (path.dirname(resolved) !== path.resolve(fixture.mediaRoot) || !OWNER_PATTERN.test(path.basename(resolved))) {
    throw new Error('Unsafe fixture removal');
  }
  await fs.rm(resolved, { recursive: true });
}
