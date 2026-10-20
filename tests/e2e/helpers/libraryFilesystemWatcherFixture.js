import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const WATCHER_FIXTURE_DIRECTORIES = new Set([
  'watcher-reconciliation',
  'watcher-punctuation-identity',
  'watcher-possessive-identity',
  'watcher-featured-ownership',
]);

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
if sys.argv[8] == "1":
    tags.delall("APIC")
tags.add(TPE1(encoding=3, text=[sys.argv[2]]))
tags.add(TPE2(encoding=3, text=[sys.argv[3]]))
tags.add(TALB(encoding=3, text=[sys.argv[4]]))
tags.add(TDRC(encoding=3, text=[sys.argv[5]]))
tags.add(TIT2(encoding=3, text=[sys.argv[6]]))
tags.add(TRCK(encoding=3, text=[sys.argv[7]]))
tags.add(TPOS(encoding=3, text=["1/1"]))
tags.save(track)
if sys.argv[8] == "1" and ID3(track).getall("APIC"):
    raise RuntimeError("Watcher cover fixture still contains embedded artwork")
`;

function assertOwnedPath(mediaRoot, candidate) {
  const resolved = path.resolve(candidate);
  const ownsCandidate = [...WATCHER_FIXTURE_DIRECTORIES].some((directory) => {
    const ownedRoot = path.resolve(mediaRoot, 'cases', directory);
    const relative = path.relative(ownedRoot, resolved);
    return relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  });
  if (!ownsCandidate) {
    throw new Error(`Watcher fixture path escaped its owned directory: ${resolved}`);
  }
  return resolved;
}

function watcherOwnedRoot(mediaRoot, fixtureDirectory = 'watcher-reconciliation') {
  if (!WATCHER_FIXTURE_DIRECTORIES.has(fixtureDirectory)) {
    throw new Error(`Unsupported watcher fixture directory: ${fixtureDirectory}`);
  }
  return path.resolve(mediaRoot, 'cases', fixtureDirectory);
}

export async function cleanupWatchedAlbumFixture({
  mediaRoot, ownedRoot, context, managedAppLifecycle, originalFailure,
}) {
  const expectedRoot = [...WATCHER_FIXTURE_DIRECTORIES]
    .map((directory) => watcherOwnedRoot(mediaRoot, directory))
    .find((candidate) => candidate === path.resolve(ownedRoot));
  if (!expectedRoot) throw new Error('Watcher cleanup requires an exact owned directory.');
  try {
    await context.close();
    if (fs.existsSync(expectedRoot)) fs.rmSync(expectedRoot, { recursive: true });
    // The runner drains the old watcher, removes exactly its owned inventory,
    // then starts a replacement that cannot hydrate the deleted fixture rows.
    await managedAppLifecycle.cleanupWatcherFixture();
  } catch (cleanupFailure) {
    const failures = [...(originalFailure ? [originalFailure] : []), cleanupFailure];
    try { await managedAppLifecycle.reportFailure(); } catch (reportFailure) { failures.push(reportFailure); }
    if (failures.length > 1) throw new AggregateError(failures, 'Watcher scenario and fixture cleanup failed.');
    throw cleanupFailure;
  }
  if (originalFailure) throw originalFailure;
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

async function retag(trackPath, {
  trackArtist, albumArtist, album, year, title, trackNumber, removeEmbeddedArtwork = false,
}) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', RETAG_SCRIPT, trackPath, trackArtist, albumArtist, album, String(year), title,
    String(trackNumber),
    removeEmbeddedArtwork ? '1' : '0',
  ], { encoding: 'utf8', windowsHide: true });
}

export async function createWatchedAlbumFixture(options = {}) {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env);
  const ownedRoot = watcherOwnedRoot(mediaRoot, options.fixtureDirectory);
  try {
    return await buildWatchedAlbumFixture(options);
  } catch (originalFailure) {
    await cleanupWatchedAlbumFixture({
      mediaRoot, ownedRoot, context: options.context,
      managedAppLifecycle: options.managedAppLifecycle, originalFailure,
    });
  }
}

async function buildWatchedAlbumFixture({
  artist = 'Watcher Reconciliation Artist',
  trackArtist = artist,
  albumArtist = artist,
  album = 'Watcher Reconciliation Album',
  albumFolderName = album,
  year = 2004,
  trackTitles = ['Watcher First Signal', 'Watcher Second Signal'],
  trackArtists = null,
  removeEmbeddedArtwork = false,
  fixtureDirectory = 'watcher-reconciliation',
} = {}) {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env);
  const ownedRoot = watcherOwnedRoot(mediaRoot, fixtureDirectory);
  if (fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true });
  const source = firstPlayableMp3(mediaRoot);
  const createAlbum = async ({
    album: albumName,
    folderName = albumName,
    year: albumYear,
    trackTitles: titles,
    trackArtist: defaultTrackArtist = trackArtist,
    trackArtists: albumTrackArtists = null,
    albumArtist: albumOwner = albumArtist,
  }) => {
    const directory = assertOwnedPath(mediaRoot, path.join(ownedRoot, artist, folderName));
    fs.mkdirSync(directory, { recursive: true });
    const createdTracks = [];
    for (const [index, title] of titles.entries()) {
      const filename = `${String(index + 1).padStart(2, '0')} - ${title}.mp3`;
      const destination = assertOwnedPath(mediaRoot, path.join(directory, filename));
      fs.copyFileSync(source, destination);
      await retag(destination, {
        trackArtist: albumTrackArtists?.[index] ?? defaultTrackArtist,
        albumArtist: albumOwner,
        album: albumName,
        year: albumYear,
        title,
        trackNumber: index + 1,
        removeEmbeddedArtwork,
      });
      createdTracks.push({ filename, title, path: destination });
    }
    return { album: albumName, year: albumYear, albumDirectory: directory, tracks: createdTracks };
  };
  const target = await createAlbum({
    album,
    folderName: albumFolderName,
    year,
    trackTitles,
    trackArtists,
  });
  const albumDirectory = target.albumDirectory;
  const tracks = target.tracks;
  return {
    artist,
    album,
    year,
    albumDirectory,
    tracks,
    async renameTrack(index, title) {
      const track = tracks[index];
      await retag(track.path, {
        trackArtist, albumArtist, album, year, title, trackNumber: index + 1,
        removeEmbeddedArtwork,
      });
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
    cleanup(options) {
      return cleanupWatchedAlbumFixture({ mediaRoot, ownedRoot, ...options });
    },
  };
}
