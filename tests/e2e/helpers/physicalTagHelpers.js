import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

const READ_ALBUM_TAGS_SCRIPT = `
import json
import sys
from pathlib import Path

from mutagen.id3 import ID3

album_dir = Path(sys.argv[1])
records = []
for track_path in sorted(album_dir.glob("*.mp3")):
    album_frame = ID3(track_path).get("TALB")
    records.append({
        "filename": track_path.name,
        "albumValues": [str(value) for value in album_frame.text] if album_frame else [],
    })
print(json.dumps(records))
`;

const READ_COMPLETE_TAG_SNAPSHOTS_SCRIPT = `
import json
import sys
from pathlib import Path

from mutagen.id3 import ID3

album_dir = Path(sys.argv[1])
records = []
for track_path in sorted(album_dir.glob("*.mp3")):
    tags = ID3(track_path)
    frames = {}
    for frame_key in sorted(tags.keys()):
        frame = tags[frame_key]
        text = getattr(frame, "text", None)
        frames[frame_key] = (
            [str(value) for value in text]
            if text is not None
            else [str(frame)]
        )
    records.append({
        "filename": track_path.name,
        "frames": frames,
    })
print(json.dumps(records, sort_keys=True))
`;

async function runGeneratedMp3TagScript({ artist, album, script }) {
  const albumDirectory = path.join(
    resolveWritableFixtureMediaRoot(process.env),
    artist,
    album,
  );
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', script, albumDirectory],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(stdout);
}

export async function readGeneratedMp3AlbumTags({ artist, album }) {
  return runGeneratedMp3TagScript({
    artist,
    album,
    script: READ_ALBUM_TAGS_SCRIPT,
  });
}

export async function readGeneratedMp3TagSnapshots({ artist, album }) {
  return runGeneratedMp3TagScript({
    artist,
    album,
    script: READ_COMPLETE_TAG_SNAPSHOTS_SCRIPT,
  });
}

export function changedId3Frames(beforeSnapshots, afterSnapshots) {
  const beforeByFilename = new Map(
    beforeSnapshots.map((snapshot) => [snapshot.filename, snapshot.frames]),
  );
  const afterByFilename = new Map(
    afterSnapshots.map((snapshot) => [snapshot.filename, snapshot.frames]),
  );
  const filenames = [...new Set([
    ...beforeByFilename.keys(),
    ...afterByFilename.keys(),
  ])].sort((left, right) => left.localeCompare(right));
  return filenames.map((filename) => {
    const beforeFrames = beforeByFilename.get(filename) || {};
    const afterFrames = afterByFilename.get(filename) || {};
    const frameKeys = [...new Set([
      ...Object.keys(beforeFrames),
      ...Object.keys(afterFrames),
    ])].sort((left, right) => left.localeCompare(right));
    return {
      filename,
      changedFrames: frameKeys.filter((frameKey) => (
        JSON.stringify(beforeFrames[frameKey] ?? null)
        !== JSON.stringify(afterFrames[frameKey] ?? null)
      )),
    };
  });
}

export function temporarilyMakeGeneratedMp3Unavailable({ artist, album, filename }) {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env);
  const sourcePath = path.resolve(mediaRoot, String(artist), String(album), String(filename));
  const relativePath = path.relative(mediaRoot, sourcePath);
  const isContained = relativePath !== ''
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
  if (
    !isContained
    || path.extname(sourcePath).toLowerCase() !== '.mp3'
    || path.basename(sourcePath) !== String(filename)
    || !fs.statSync(sourcePath).isFile()
  ) {
    throw new Error('Refusing to alter a path that is not a test-owned generated MP3 fixture.');
  }
  const unavailablePath = `${sourcePath}.temporarily-unavailable-${process.pid}`;
  if (fs.existsSync(unavailablePath)) {
    throw new Error(`Temporary generated MP3 path already exists: ${unavailablePath}`);
  }
  fs.renameSync(sourcePath, unavailablePath);
  fs.mkdirSync(sourcePath);
  let restored = false;
  return {
    sourcePath,
    restore() {
      if (restored) return;
      if (!fs.statSync(sourcePath).isDirectory()) {
        throw new Error('Generated MP3 write blocker was unexpectedly replaced.');
      }
      fs.rmdirSync(sourcePath);
      fs.renameSync(unavailablePath, sourcePath);
      restored = true;
    },
  };
}
