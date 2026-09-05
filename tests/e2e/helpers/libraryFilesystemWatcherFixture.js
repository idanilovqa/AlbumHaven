import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

const RETAG_SCRIPT = `
import sys
from pathlib import Path
from mutagen.id3 import ID3, ID3NoHeaderError, TALB, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK

track = Path(sys.argv[1])
try:
    tags = ID3(track)
except ID3NoHeaderError:
    tags = ID3()
for frame in ("TALB", "TDRC", "TIT2", "TPE1", "TPE2", "TPOS", "TRCK"):
    tags.delall(frame)
tags.add(TPE1(encoding=3, text=[sys.argv[2]]))
tags.add(TPE2(encoding=3, text=[sys.argv[2]]))
tags.add(TALB(encoding=3, text=[sys.argv[3]]))
tags.add(TDRC(encoding=3, text=[sys.argv[4]]))
tags.add(TIT2(encoding=3, text=[sys.argv[5]]))
tags.add(TRCK(encoding=3, text=[sys.argv[6]]))
tags.add(TPOS(encoding=3, text=["1/1"]))
tags.save(track)
`;

function assertOwnedPath(mediaRoot, candidate) {
  const resolved = path.resolve(candidate);
  const ownedRoot = path.resolve(mediaRoot, 'cases', 'watcher-reconciliation');
  const relative = path.relative(ownedRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Watcher fixture path escaped its owned directory: ${resolved}`);
  }
  return resolved;
}

function firstPlayableMp3(mediaRoot) {
  const pending = [mediaRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp3' && fs.statSync(candidate).size > 0) return candidate;
    }
  }
  throw new Error('The functional fixture contains no playable MP3 source.');
}

async function retag(trackPath, { artist, album, year, title, trackNumber }) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', RETAG_SCRIPT, trackPath, artist, album, String(year), title, String(trackNumber),
  ], { encoding: 'utf8', windowsHide: true });
}

export async function createWatchedAlbumFixture({
  artist = 'Watcher Reconciliation Artist',
  album = 'Watcher Reconciliation Album',
  year = 2004,
} = {}) {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env);
  const ownedRoot = assertOwnedPath(mediaRoot, path.join(mediaRoot, 'cases', 'watcher-reconciliation'));
  const albumDirectory = assertOwnedPath(mediaRoot, path.join(ownedRoot, artist, album));
  if (fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true });
  fs.mkdirSync(albumDirectory, { recursive: true });
  const source = firstPlayableMp3(mediaRoot);
  const createAlbum = async ({ album: albumName, year: albumYear, trackTitles }) => {
    const directory = assertOwnedPath(mediaRoot, path.join(ownedRoot, artist, albumName));
    fs.mkdirSync(directory, { recursive: true });
    const createdTracks = [];
    for (const [index, title] of trackTitles.entries()) {
      const filename = `${String(index + 1).padStart(2, '0')} - ${title}.mp3`;
      const destination = assertOwnedPath(mediaRoot, path.join(directory, filename));
      fs.copyFileSync(source, destination);
      await retag(destination, {
        artist,
        album: albumName,
        year: albumYear,
        title,
        trackNumber: index + 1,
      });
      createdTracks.push({ filename, title, path: destination });
    }
    return { album: albumName, year: albumYear, albumDirectory: directory, tracks: createdTracks };
  };
  const target = await createAlbum({
    album,
    year,
    trackTitles: ['Watcher First Signal', 'Watcher Second Signal'],
  });
  const tracks = target.tracks;
  return {
    artist,
    album,
    year,
    albumDirectory,
    tracks,
    async renameTrack(index, title) {
      const track = tracks[index];
      await retag(track.path, { artist, album, year, title, trackNumber: index + 1 });
      track.title = title;
    },
    createSiblingAlbum(options) {
      return createAlbum(options);
    },
    deleteTrack(index) {
      fs.rmSync(assertOwnedPath(mediaRoot, tracks[index].path));
    },
    deleteAlbum() {
      fs.rmSync(albumDirectory, { recursive: true });
    },
    cleanup() {
      if (fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true });
    },
  };
}
