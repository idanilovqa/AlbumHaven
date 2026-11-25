import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const OWNER_PATTERN = /^E2E Artist Tree [a-z0-9]+$/u;

// Each file is a tagged copy of a generated MP3 at its own relative path under the owned folder.
const GENERATE = `
import json, shutil, sys
from pathlib import Path
from mutagen.id3 import ID3, TALB, TPE1, TPE2, TIT2, TRCK, TDRC
root = Path(sys.argv[1]).resolve(strict=True)
owner = root / sys.argv[2]
if owner.exists():
    raise RuntimeError("Owned artist tree fixture already exists")
source = next(root.rglob("*.mp3"), None)
if source is None:
    raise RuntimeError("Artist tree fixture requires one generated MP3 source")
for track in json.loads(sys.argv[3]):
    destination = owner / track["path"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    tags = ID3(destination)
    tags.clear()
    for frame in [TALB(encoding=3, text=[track["album"]]), TPE1(encoding=3, text=[track["artist"]]),
                  TPE2(encoding=3, text=[track["albumArtist"]]), TIT2(encoding=3, text=[track["title"]]),
                  TRCK(encoding=3, text=[str(track["number"])]), TDRC(encoding=3, text=["2026"])]:
        tags.add(frame)
    tags.save(destination)
print(json.dumps({"owner": str(owner)}))
`;

export async function createArtistTreeFixture(name, tracks) {
  if (!OWNER_PATTERN.test(name)) throw new Error('Invalid fixture ownership name');
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', GENERATE, mediaRoot, name, JSON.stringify(tracks)],
    { encoding: 'utf8', windowsHide: true },
  );
  return { ...JSON.parse(stdout), mediaRoot };
}

export async function removeArtistTreeFixture(fixture) {
  const resolved = path.resolve(fixture.owner);
  if (path.dirname(resolved) !== path.resolve(fixture.mediaRoot) || !OWNER_PATTERN.test(path.basename(resolved))) {
    throw new Error('Unsafe fixture path');
  }
  // The running app may still be closing a file it has just written.
  await fs.rm(resolved, { recursive: true, maxRetries: 10, retryDelay: 200 });
}
