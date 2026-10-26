import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const WATCHER_FIXTURE_PROFILES = ['functional-core', 'synthetic-large-library'];
const WATCHER_FIXTURE_DIRECTORIES = [
  'watcher-reconciliation',
  'watcher-grouped-feature-credit',
  'gallery-native-response-overlap',
  'generated-preview-storage',
];

function resolveWatcherFixtureMediaRoot(environment = process.env) {
  return resolveWritableFixtureMediaRoot(environment, { allowedProfiles: WATCHER_FIXTURE_PROFILES });
}

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

const GENERATE_PLAYABLE_MP3_SCRIPT = `
import sys
from pathlib import Path
from tests.e2e.support.isolatedLibraryApp import ensure_playable_loop_source

ensure_playable_loop_source(Path(sys.argv[1]))
`;

function normalizeOwnedDirectoryName(value) {
  const name = String(value || 'watcher-reconciliation').trim();
  if (!WATCHER_FIXTURE_DIRECTORIES.includes(name)) {
    throw new Error('Watcher fixture requires a runner-owned directory identity.');
  }
  return name;
}

function assertOwnedPath(mediaRoot, candidate, ownedDirectoryName = 'watcher-reconciliation') {
  const resolved = path.resolve(candidate);
  const ownedRoot = path.resolve(
    mediaRoot,
    'cases',
    normalizeOwnedDirectoryName(ownedDirectoryName),
  );
  const relative = path.relative(ownedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
  mediaRoot, ownedRoot, ownedDirectoryName = 'watcher-reconciliation',
  context, managedAppLifecycle, originalFailure,
}) {
  const expectedRoot = path.resolve(
    mediaRoot,
    'cases',
    normalizeOwnedDirectoryName(ownedDirectoryName),
  );
  if (path.resolve(ownedRoot) !== expectedRoot) throw new Error('Watcher cleanup requires its exact owned directory.');
  const cleanupFailures = [];
  try { await context.close(); } catch (error) { cleanupFailures.push(error); }
  try {
    if (fs.existsSync(expectedRoot)) fs.rmSync(expectedRoot, { recursive: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    // The runner drains the old watcher, removes exactly its owned inventory,
    // then starts a replacement that cannot hydrate the deleted fixture rows.
    await managedAppLifecycle.cleanupWatcherFixture(ownedDirectoryName);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length) {
    const failures = [...(originalFailure ? [originalFailure] : []), ...cleanupFailures];
    try { await managedAppLifecycle.reportFailure(); } catch (reportFailure) { failures.push(reportFailure); }
    if (failures.length > 1) throw new AggregateError(failures, 'Watcher scenario and fixture cleanup failed.');
    throw cleanupFailures[0];
  }
  if (originalFailure) throw originalFailure;
}

async function retag(trackPath, {
  trackArtist, albumArtist, album, year, title, trackNumber,
  discTag = '1/1', removeEmbeddedArtwork = false,
}) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', RETAG_SCRIPT, trackPath, trackArtist, albumArtist, album, String(year), title,
    String(trackNumber),
    removeEmbeddedArtwork ? '1' : '0',
    discTag,
  ], { encoding: 'utf8', windowsHide: true });
}

export async function generatePlayableMp3Source(destination) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', GENERATE_PLAYABLE_MP3_SCRIPT, destination,
  ], { encoding: 'utf8', windowsHide: true });
}

export async function materializeTaggedTrack({
  source,
  destination,
  metadata,
  retagTrack = retag,
}) {
  const stagedPath = `${destination}.pending`;
  if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath);
  try {
    fs.copyFileSync(source, stagedPath);
    await retagTrack(stagedPath, metadata);
    fs.renameSync(stagedPath, destination);
  } catch (error) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath);
    throw error;
  }
}

export async function materializeTaggedAlbum({ stagingParent, destination, buildAlbum }) {
  const stagingRoot = fs.mkdtempSync(path.join(stagingParent, '.watcher-album-'));
  const stagedAlbum = path.join(stagingRoot, 'album');
  try {
    fs.mkdirSync(stagedAlbum);
    await buildAlbum(stagedAlbum);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(stagedAlbum, destination);
  } finally {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true });
  }
}

export async function createWatchedAlbumFixture(options = {}) {
  const mediaRoot = resolveWatcherFixtureMediaRoot();
  const ownedDirectoryName = normalizeOwnedDirectoryName(options.ownedDirectoryName);
  const ownedRoot = assertOwnedPath(
    mediaRoot,
    path.join(mediaRoot, 'cases', ownedDirectoryName),
    ownedDirectoryName,
  );
  try {
    return await buildWatchedAlbumFixture(options);
  } catch (originalFailure) {
    await cleanupWatchedAlbumFixture({
      mediaRoot, ownedRoot, ownedDirectoryName, context: options.context,
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
  removeEmbeddedArtwork = false,
  ownedDirectoryName = 'watcher-reconciliation',
} = {}) {
  const mediaRoot = resolveWatcherFixtureMediaRoot();
  const normalizedOwnedDirectoryName = normalizeOwnedDirectoryName(ownedDirectoryName);
  const ownedRoot = assertOwnedPath(
    mediaRoot,
    path.join(mediaRoot, 'cases', normalizedOwnedDirectoryName),
    normalizedOwnedDirectoryName,
  );
  if (fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true });
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
    const directory = assertOwnedPath(
      mediaRoot,
      path.join(ownedRoot, artist, folderName),
      normalizedOwnedDirectoryName,
    );
    const createdTracks = [];
    const normalizedDiscNumbers = titles.map((_, index) => Number(albumDiscNumbers?.[index]) || 1);
    const discTotal = Math.max(...normalizedDiscNumbers);
    const sourceRoot = fs.mkdtempSync(path.join(path.dirname(mediaRoot), '.watcher-source-'));
    try {
      const source = path.join(sourceRoot, 'source.mp3');
      await generatePlayableMp3Source(source);
      await materializeTaggedAlbum({
        stagingParent: path.dirname(mediaRoot),
        destination: directory,
        async buildAlbum(stagedAlbum) {
          for (const [index, title] of titles.entries()) {
            const discNumber = normalizedDiscNumbers[index];
            const filename = `${String(index + 1).padStart(2, '0')} - ${title}.mp3`;
            const relativePath = discTotal > 1
              ? path.join(`CD${discNumber}`, filename)
              : filename;
            const destination = assertOwnedPath(
              mediaRoot,
              path.join(directory, relativePath),
              normalizedOwnedDirectoryName,
            );
            const stagedDestination = path.join(stagedAlbum, relativePath);
            fs.mkdirSync(path.dirname(stagedDestination), { recursive: true });
            await materializeTaggedTrack({
              source,
              destination: stagedDestination,
              metadata: {
                trackArtist: albumTrackArtists?.[index] || defaultTrackArtist,
                albumArtist: albumOwner,
                album: albumName,
                year: albumYear,
                title,
                trackNumber: index + 1,
                discTag: `${discNumber}/${discTotal}`,
                removeEmbeddedArtwork,
              },
            });
            createdTracks.push({ filename, title, path: destination, discNumber, discTotal });
          }
        },
      });
    } finally {
      if (fs.existsSync(sourceRoot)) fs.rmSync(sourceRoot, { recursive: true });
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
    mediaRoot,
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
      fs.rmSync(assertOwnedPath(mediaRoot, tracks[index].path, normalizedOwnedDirectoryName));
    },
    deleteAlbum() {
      fs.rmSync(albumDirectory, { recursive: true });
    },
    cleanup(options) {
      return cleanupWatchedAlbumFixture({
        mediaRoot,
        ownedRoot,
        ownedDirectoryName: normalizedOwnedDirectoryName,
        ...options,
      });
    },
  };
}
