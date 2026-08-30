import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import {
  changedId3Frames,
  readGeneratedMp3AlbumTags,
  readGeneratedMp3TagSnapshots,
  temporarilyMakeGeneratedMp3Unavailable,
} from '../e2e/helpers/physicalTagHelpers.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const originalTempRoot = process.env.ALBUM_HAVEN_E2E_TEMP_ROOT;
const originalFixtureProfile = process.env.ALBUM_HAVEN_FIXTURE_PROFILE;
const originalFixtureRoot = process.env.ALBUM_HAVEN_FIXTURE_ROOT;
const originalMediaRoot = process.env.ALBUM_HAVEN_MEDIA_ROOT;
const tempRoots = [];

const WRITE_TAG_FIXTURES_SCRIPT = `
import sys
from pathlib import Path

from mutagen.id3 import ID3, TALB

album_dir = Path(sys.argv[1])
fixtures = (
    ("01 - Rename Track 1.mp3", ["Durable Album Rename Fixture", "Alternate Album Value"]),
    ("02 - Rename Track 2.mp3", ["Durable Album Rename Fixture"]),
)
for filename, values in fixtures:
    tags = ID3()
    tags.add(TALB(encoding=3, text=values))
    tags.save(album_dir / filename)
`;

beforeEach(() => {
  delete process.env.ALBUM_HAVEN_FIXTURE_PROFILE;
  delete process.env.ALBUM_HAVEN_FIXTURE_ROOT;
  delete process.env.ALBUM_HAVEN_MEDIA_ROOT;
});

afterEach(async () => {
  if (originalTempRoot === undefined) {
    delete process.env.ALBUM_HAVEN_E2E_TEMP_ROOT;
  } else {
    process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = originalTempRoot;
  }
  for (const [name, value] of [
    ['ALBUM_HAVEN_FIXTURE_PROFILE', originalFixtureProfile],
    ['ALBUM_HAVEN_FIXTURE_ROOT', originalFixtureRoot],
    ['ALBUM_HAVEN_MEDIA_ROOT', originalMediaRoot],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('returns each MP3 basename with every TALB text value', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-physical-tags-'));
  tempRoots.push(tempRoot);
  const albumDirectory = path.join(tempRoot, 'media', 'Fixture Artist', 'Fixture Album');
  await mkdir(albumDirectory, { recursive: true });
  await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', WRITE_TAG_FIXTURES_SCRIPT, albumDirectory],
    { encoding: 'utf8', windowsHide: true },
  );
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = tempRoot;

  const records = await readGeneratedMp3AlbumTags({
    artist: 'Fixture Artist',
    album: 'Fixture Album',
  });

  assert.deepEqual(records, [
    {
      filename: '01 - Rename Track 1.mp3',
      albumValues: ['Durable Album Rename Fixture', 'Alternate Album Value'],
    },
    {
      filename: '02 - Rename Track 2.mp3',
      albumValues: ['Durable Album Rename Fixture'],
    },
  ]);
});

test('normalizes complete ID3 snapshots and reports only frames whose values changed', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-physical-tags-'));
  tempRoots.push(tempRoot);
  const albumDirectory = path.join(tempRoot, 'media', 'Fixture Artist', 'Fixture Album');
  await mkdir(albumDirectory, { recursive: true });
  await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', `
import sys
from pathlib import Path
from mutagen.id3 import ID3, TALB, TIT2

track_path = Path(sys.argv[1]) / "01 - Snapshot Track.mp3"
tags = ID3()
tags.add(TALB(encoding=3, text=["Before Album"]))
tags.add(TIT2(encoding=3, text=["Untouched Title"]))
tags.save(track_path)
`, albumDirectory],
    { encoding: 'utf8', windowsHide: true },
  );
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = tempRoot;

  const before = await readGeneratedMp3TagSnapshots({
    artist: 'Fixture Artist',
    album: 'Fixture Album',
  });
  const after = structuredClone(before);
  after[0].frames.TALB = ['After Album'];

  assert.deepEqual(before, [{
    filename: '01 - Snapshot Track.mp3',
    frames: {
      TALB: ['Before Album'],
      TIT2: ['Untouched Title'],
    },
  }]);
  assert.deepEqual(changedId3Frames(before, after), [{
    filename: '01 - Snapshot Track.mp3',
    changedFrames: ['TALB'],
  }]);
});

test('temporarily replaces only a generated MP3 with an unwritable directory and restores it', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-physical-tags-'));
  tempRoots.push(tempRoot);
  const albumDirectory = path.join(tempRoot, 'media', 'Fixture Artist', 'Fixture Album');
  const trackPath = path.join(albumDirectory, '01 - Failure Probe.mp3');
  await mkdir(albumDirectory, { recursive: true });
  await writeFile(trackPath, 'original fixture bytes');
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = tempRoot;

  const unavailable = temporarilyMakeGeneratedMp3Unavailable({
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    filename: '01 - Failure Probe.mp3',
  });

  assert.equal(unavailable.sourcePath, trackPath);
  assert.equal((await stat(trackPath)).isDirectory(), true);
  unavailable.restore();
  assert.equal((await stat(trackPath)).isFile(), true);
  assert.equal(await readFile(trackPath, 'utf8'), 'original fixture bytes');
});

test('preloaded functional helpers mutate only the exact invocation-owned fixture media root', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-launcher-root-'));
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-preloaded-fixture-'));
  tempRoots.push(tempRoot, fixtureRoot);
  const mediaRoot = path.join(fixtureRoot, 'media');
  const albumDirectory = path.join(mediaRoot, 'Fixture Artist', 'Fixture Album');
  const trackPath = path.join(albumDirectory, '01 - Failure Probe.mp3');
  await mkdir(path.join(tempRoot, 'media'), { recursive: true });
  await mkdir(albumDirectory, { recursive: true });
  await writeFile(trackPath, 'invocation-owned fixture bytes');
  process.env.ALBUM_HAVEN_E2E_TEMP_ROOT = tempRoot;
  process.env.ALBUM_HAVEN_FIXTURE_PROFILE = 'functional-core';
  process.env.ALBUM_HAVEN_FIXTURE_ROOT = fixtureRoot;
  process.env.ALBUM_HAVEN_MEDIA_ROOT = mediaRoot;

  const unavailable = temporarilyMakeGeneratedMp3Unavailable({
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    filename: '01 - Failure Probe.mp3',
  });

  assert.equal(unavailable.sourcePath, trackPath);
  unavailable.restore();
  assert.equal(await readFile(trackPath, 'utf8'), 'invocation-owned fixture bytes');
});

test('preloaded functional helpers reject media outside the exact fixture media directory', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-preloaded-fixture-'));
  const unrelatedRoot = await mkdtemp(path.join(tmpdir(), 'album-haven-owner-media-'));
  tempRoots.push(fixtureRoot, unrelatedRoot);
  await mkdir(path.join(fixtureRoot, 'media'), { recursive: true });
  process.env.ALBUM_HAVEN_FIXTURE_PROFILE = 'functional-core';
  process.env.ALBUM_HAVEN_FIXTURE_ROOT = fixtureRoot;
  process.env.ALBUM_HAVEN_MEDIA_ROOT = unrelatedRoot;

  assert.throws(
    () => temporarilyMakeGeneratedMp3Unavailable({
      artist: 'Fixture Artist',
      album: 'Fixture Album',
      filename: '01 - Failure Probe.mp3',
    }),
    /exact functional fixture media directory/u,
  );
});
