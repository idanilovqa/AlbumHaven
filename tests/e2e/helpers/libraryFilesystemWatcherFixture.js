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
  'watcher-artist-collation',
  'watcher-joint-credit',
  'watcher-possessive-identity',
  'watcher-featured-ownership',
  'watcher-local-cover-ranking',
  'watcher-numeric-discs',
  'watcher-year-distinct-releases',
  'watcher-offline-deletion',
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
tags.add(TPOS(encoding=3, text=[sys.argv[9]]))
tags.save(track)
if sys.argv[8] == "1" and ID3(track).getall("APIC"):
    raise RuntimeError("Watcher cover fixture still contains embedded artwork")
`;

const CREATE_LOCAL_ART_SCRIPT = `
import sys
from pathlib import Path
from PIL import Image

album = Path(sys.argv[1])
Image.new("RGB", (1200, 1200), "navy").save(album / "front-scan.jpg", format="JPEG")
Image.new("RGB", (2400, 2400), "red").save(album / "booklet-page.jpg", format="JPEG")
`;

const REMOVE_SCAN_SOURCE_SCRIPT = `
import os
import sys

import psycopg

with psycopg.connect(os.environ["ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL"]) as connection:
    row = connection.execute(
        """
        update library.local_track_files
        set metadata = metadata #- '{scan_cache,source}'
        where private_path = %s
          and scan_cache_stale is false
        returning id
        """,
        (sys.argv[1],),
    ).fetchall()
    if len(row) != 1:
        raise RuntimeError("Expected exactly one active watcher-owned track file")
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
  trackArtist, albumArtist, album, year, title, trackNumber, discTag = '1/1',
  removeEmbeddedArtwork = false,
}) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', RETAG_SCRIPT, trackPath, trackArtist, albumArtist, album, String(year), title,
    String(trackNumber),
    removeEmbeddedArtwork ? '1' : '0',
    discTag,
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

// Call only while the managed application is stopped.
export async function stageLegacyTrackFileWithoutScanSource(trackPath) {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env);
  const ownedPath = assertOwnedPath(mediaRoot, trackPath);
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c',
    REMOVE_SCAN_SOURCE_SCRIPT,
    ownedPath,
  ], { encoding: 'utf8', windowsHide: true });
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
  discNumbers = null,
  localArtworkCandidates = false,
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
    discNumbers: albumDiscNumbers = discNumbers,
  }) => {
    const directory = assertOwnedPath(mediaRoot, path.join(ownedRoot, artist, folderName));
    fs.mkdirSync(directory, { recursive: true });
    if (localArtworkCandidates) {
      await execFileAsync(resolvePlaywrightPython(process.env), ['-c', CREATE_LOCAL_ART_SCRIPT, directory], {
        encoding: 'utf8',
        windowsHide: true,
      });
    }
    const createdTracks = [];
    const discTotal = albumDiscNumbers ? Math.max(...albumDiscNumbers) : 1;
    for (const [index, title] of titles.entries()) {
      const filename = `${String(index + 1).padStart(2, '0')} - ${title}.mp3`;
      const discNumber = albumDiscNumbers?.[index] ?? 1;
      const trackDirectory = albumDiscNumbers
        ? assertOwnedPath(mediaRoot, path.join(directory, String(discNumber)))
        : directory;
      fs.mkdirSync(trackDirectory, { recursive: true });
      const destination = assertOwnedPath(mediaRoot, path.join(trackDirectory, filename));
      fs.copyFileSync(source, destination);
      await retag(destination, {
        trackArtist: albumTrackArtists?.[index] ?? defaultTrackArtist,
        albumArtist: albumOwner,
        album: albumName,
        year: albumYear,
        title,
        trackNumber: index + 1,
        discTag: `${discNumber}/${discTotal}`,
        removeEmbeddedArtwork,
      });
      createdTracks.push({ filename, title, path: destination, discNumber, discTotal });
    }
    return { album: albumName, year: albumYear, albumDirectory: directory, tracks: createdTracks };
  };
  const target = await createAlbum({
    album,
    folderName: albumFolderName,
    year,
    trackTitles,
    trackArtists,
    discNumbers,
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
        discTag: `${track.discNumber}/${track.discTotal}`,
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
