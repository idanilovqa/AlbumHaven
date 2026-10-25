import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
tags.add(TPE1(encoding=3, text=[sys.argv[2]]))
tags.add(TPE2(encoding=3, text=[sys.argv[2]]))
tags.add(TALB(encoding=3, text=[sys.argv[3]]))
tags.add(TDRC(encoding=3, text=[sys.argv[4]]))
tags.add(TIT2(encoding=3, text=[sys.argv[5]]))
tags.add(TRCK(encoding=3, text=[sys.argv[6]]))
tags.add(TPOS(encoding=3, text=["1/1"]))
tags.save(track)
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

function isNestedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveThroughExistingParent(candidate) {
  let existing = path.resolve(candidate);
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Watcher recovery path has no existing owner.');
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...missingSegments);
}

function assertRecoveryOwnedPath(tempRoot, candidate, label, expectedName) {
  const configured = path.resolve(String(candidate || ''));
  const casesRoot = resolveThroughExistingParent(path.resolve(tempRoot, 'cases'));
  if (!isNestedPath(path.resolve(tempRoot, 'cases'), configured)) {
    throw new Error(`Watcher recovery ${label} escaped the owned boundary.`);
  }
  const resolved = resolveThroughExistingParent(configured);
  if (!isNestedPath(casesRoot, resolved)) {
    throw new Error(`Watcher recovery ${label} escaped the canonical owned boundary.`);
  }
  const relative = path.relative(casesRoot, resolved);
  const segments = relative.split(path.sep);
  const [fixtureBoundary] = segments;
  if (
    !fixtureBoundary?.startsWith('watcher-recovery-')
    || segments.length !== 2
    || segments[1] !== expectedName
  ) {
    throw new Error(`Watcher recovery ${label} must remain in its watcher-recovery owned boundary.`);
  }
  return { resolved, fixtureBoundary };
}

function validateLifecycleAcknowledgment(acknowledgment, status) {
  if (
    !acknowledgment
    || String(acknowledgment.nonce || '').trim() === ''
    || acknowledgment.status !== status
  ) {
    throw new Error(`Managed app ${status === 'stopped' ? 'stop' : 'restart'} acknowledgment was invalid.`);
  }
  return acknowledgment;
}

export function readWatcherRecoveryManifest({ manifestPath, environment = process.env } = {}) {
  const tempRootValue = String(environment.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
  if (!tempRootValue || !fs.existsSync(tempRootValue) || !fs.statSync(tempRootValue).isDirectory()) {
    throw new Error('Watcher recovery requires the runner-owned temp root.');
  }
  const tempRoot = fs.realpathSync(tempRootValue);
  const expectedManifestPath = path.resolve(
    tempRoot,
    'app-data',
    'watcher-recovery-fixture.json',
  );
  const configuredManifestPath = path.resolve(manifestPath || expectedManifestPath);
  if (configuredManifestPath !== expectedManifestPath) {
    throw new Error('Watcher recovery manifest must be the exact runner-owned temp root manifest.');
  }
  if (!fs.existsSync(configuredManifestPath)) {
    throw new Error('Watcher recovery manifest is unavailable.');
  }
  const resolvedManifestPath = fs.realpathSync(configuredManifestPath);
  if (!isNestedPath(tempRoot, resolvedManifestPath)) {
    throw new Error('Watcher recovery manifest escaped the canonical runner-owned temp root.');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Watcher recovery manifest is unavailable or invalid: ${error?.message || error}`);
  }

  const requiredText = (field) => {
    const value = String(manifest?.[field] || '').trim();
    if (!value) throw new Error(`Watcher recovery manifest requires ${field}.`);
    return value;
  };
  const failureRootId = requiredText('failure_root_id');
  const healthyRootId = requiredText('healthy_root_id');
  if (failureRootId === healthyRootId) {
    throw new Error('Watcher recovery manifest requires distinct root IDs.');
  }
  const ownedPaths = [
    ['failure root', requiredText('failure_root_path'), 'failure-root'],
    ['failure root staging path', requiredText('failure_root_staging_path'), 'failure-root-staging'],
    ['healthy root', requiredText('healthy_root_path'), 'healthy-root'],
  ].map(([label, candidate, expectedName]) => (
    assertRecoveryOwnedPath(tempRoot, candidate, label, expectedName)
  ));
  if (new Set(ownedPaths.map(({ fixtureBoundary }) => fixtureBoundary)).size !== 1) {
    throw new Error('Watcher recovery roots must share one owned boundary.');
  }
  for (let index = 0; index < ownedPaths.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < ownedPaths.length; otherIndex += 1) {
      const left = ownedPaths[index].resolved;
      const right = ownedPaths[otherIndex].resolved;
      if (left === right || isNestedPath(left, right) || isNestedPath(right, left)) {
        throw new Error('Watcher recovery root paths must be distinct and non-overlapping.');
      }
    }
  }

  return Object.freeze({
    manifestPath: resolvedManifestPath,
    tempRoot,
    failureRootId,
    failureRootPath: ownedPaths[0].resolved,
    failureRootStagingPath: ownedPaths[1].resolved,
    healthyRootId,
    healthyRootPath: ownedPaths[2].resolved,
    viewerUsername: requiredText('viewer_username'),
    viewerPassword: requiredText('viewer_password'),
  });
}

export function watcherRecoveryTextContainsPrivateIdentity(text, manifest) {
  const privateValues = [
    manifest.failureRootId,
    manifest.healthyRootId,
    manifest.failureRootPath,
    manifest.failureRootStagingPath,
    manifest.healthyRootPath,
    path.basename(manifest.failureRootPath),
    path.basename(manifest.failureRootStagingPath),
    path.basename(manifest.healthyRootPath),
  ];
  return privateValues.some((value) => String(text || '').includes(String(value)));
}

function firstOwnedFile(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) return candidate;
    }
  }
  throw new Error('Watcher recovery owned root contains no fixture file.');
}

export async function createWatcherRecoveryFixture({
  manifestPath,
  managedAppLifecycle,
  environment = process.env,
} = {}) {
  if (!managedAppLifecycle) {
    throw new Error('Watcher recovery requires the managed app lifecycle.');
  }
  const manifest = readWatcherRecoveryManifest({ manifestPath, environment });
  let failureRootUnavailable = !fs.existsSync(manifest.failureRootPath)
    && fs.existsSync(manifest.failureRootStagingPath);
  let cleanupStarted = false;

  async function stopForRename() {
    return validateLifecycleAcknowledgment(await managedAppLifecycle.stop(), 'stopped');
  }

  async function restartAfterRename() {
    return validateLifecycleAcknowledgment(await managedAppLifecycle.restart(), 'ready');
  }

  async function renameBetween(source, destination, resultingUnavailable) {
    await stopForRename();
    if (!fs.existsSync(source) || fs.existsSync(destination)) {
      throw new Error('Watcher recovery root rename precondition failed after writer shutdown.');
    }
    fs.renameSync(source, destination);
    failureRootUnavailable = resultingUnavailable;
    await restartAfterRename();
  }

  return {
    manifest,
    get failureRootUnavailable() { return failureRootUnavailable; },
    async makeFailureRootUnavailable() {
      if (failureRootUnavailable) return;
      await renameBetween(
        manifest.failureRootPath,
        manifest.failureRootStagingPath,
        true,
      );
    },
    async restoreFailureRoot() {
      if (!failureRootUnavailable) return;
      await renameBetween(
        manifest.failureRootStagingPath,
        manifest.failureRootPath,
        false,
      );
    },
    removeOneUnavailableFile() {
      if (!failureRootUnavailable) {
        throw new Error('Watcher recovery destructive mutation requires the root to be unavailable.');
      }
      const candidate = firstOwnedFile(manifest.failureRootStagingPath);
      fs.rmSync(candidate);
      return path.basename(candidate);
    },
    createHealthyFile(label = 'healthy-event') {
      const source = firstOwnedFile(manifest.healthyRootPath);
      const extension = path.extname(source) || '.mp3';
      const destination = path.join(
        manifest.healthyRootPath,
        `${label}-${randomUUID()}${extension}`,
      );
      fs.copyFileSync(source, destination);
      return destination;
    },
    async cleanup({ viewerContext } = {}) {
      if (cleanupStarted) return;
      cleanupStarted = true;
      const failures = [];
      try { await viewerContext?.close(); } catch (error) { failures.push(error); }
      if (failureRootUnavailable) {
        try { await this.restoreFailureRoot(); } catch (error) { failures.push(error); }
      }
      try {
        const cleanup = managedAppLifecycle.cleanupWatcherRecoveryFixture
          || managedAppLifecycle.cleanupWatcherFixture;
        await cleanup.call(managedAppLifecycle);
      } catch (error) {
        failures.push(error);
        try { await managedAppLifecycle.reportFailure(); } catch (reportError) {
          failures.push(reportError);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Watcher recovery cleanup failed.');
      }
    },
  };
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

async function retag(trackPath, { artist, album, year, title, trackNumber }) {
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', RETAG_SCRIPT, trackPath, artist, album, String(year), title, String(trackNumber),
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

async function buildWatchedAlbumFixture({
  artist = 'Watcher Reconciliation Artist',
  album = 'Watcher Reconciliation Album',
  year = 2004,
  ownedDirectoryName = 'watcher-reconciliation',
} = {}) {
  const mediaRoot = resolveWatcherFixtureMediaRoot();
  const normalizedOwnedDirectoryName = normalizeOwnedDirectoryName(ownedDirectoryName);
  const ownedRoot = assertOwnedPath(
    mediaRoot,
    path.join(mediaRoot, 'cases', normalizedOwnedDirectoryName),
    normalizedOwnedDirectoryName,
  );
  const albumDirectory = assertOwnedPath(
    mediaRoot,
    path.join(ownedRoot, artist, album),
    normalizedOwnedDirectoryName,
  );
  if (fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true });
  const createAlbum = async ({ album: albumName, year: albumYear, trackTitles }) => {
    const directory = assertOwnedPath(
      mediaRoot,
      path.join(ownedRoot, artist, albumName),
      normalizedOwnedDirectoryName,
    );
    const createdTracks = [];
    const sourceRoot = fs.mkdtempSync(path.join(path.dirname(mediaRoot), '.watcher-source-'));
    try {
      const source = path.join(sourceRoot, 'source.mp3');
      await generatePlayableMp3Source(source);
      await materializeTaggedAlbum({
        stagingParent: path.dirname(mediaRoot),
        destination: directory,
        async buildAlbum(stagedAlbum) {
          for (const [index, title] of trackTitles.entries()) {
            const filename = `${String(index + 1).padStart(2, '0')} - ${title}.mp3`;
            const destination = assertOwnedPath(
              mediaRoot,
              path.join(directory, filename),
              normalizedOwnedDirectoryName,
            );
            await materializeTaggedTrack({
              source,
              destination: path.join(stagedAlbum, filename),
              metadata: {
                artist,
                album: albumName,
                year: albumYear,
                title,
                trackNumber: index + 1,
              },
            });
            createdTracks.push({ filename, title, path: destination });
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
    year,
    trackTitles: ['Watcher First Signal', 'Watcher Second Signal'],
  });
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
      await retag(track.path, { artist, album, year, title, trackNumber: index + 1 });
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
