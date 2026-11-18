import fs from 'node:fs/promises';
import path from 'node:path';

import { authenticatedPageGet, authenticatedPagePost } from './authenticatedPageRequest.js';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';
import { readGeneratedMp3TagSnapshots } from './physicalTagHelpers.js';
import { flattenAlbums } from './realAppBenchmarkHelpers.js';

// The fake ten-track ДДТ «Ремиксы» album of the synthetic-large-library profile
// (media/writable/ДДТ/Ремиксы). Timing tests split half of it away and merge it back.
export const DDT_ARTIST = 'ДДТ';
export const REMIXES_ALBUM = 'Ремиксы';
export const REMIXES_SPLIT_ALBUM = 'Ремиксы2';
export const REMIXES_YEAR = '2000';
export const REMIXES_FILENAMES = Object.freeze([
  '01. Фонограммщик.mp3',
  '02. Террорист.mp3',
  '03. Конвейер.mp3',
  '04. Храм.mp3',
  '05. Российское танго.mp3',
  '06. В последнюю осень.mp3',
  '07. Милиционер в рок-клубе.mp3',
  '08. Революция.mp3',
  '09. Мальчик слепой.mp3',
  '10. Это все.mp3',
]);
export const REMIXES_SPLIT_FILENAMES = Object.freeze(REMIXES_FILENAMES.slice(0, 5));
const ALLOWED_PROFILES = ['synthetic-large-library'];
const REQUEST_TIMEOUT_MS = 120000;

export function trackFilename(track) {
  return String(track?.filename || String(track?.path || '').split(/[\\/]/u).pop() || '').trim();
}

function remixesDirectory() {
  const mediaRoot = resolveWritableFixtureMediaRoot(process.env, { allowedProfiles: ALLOWED_PROFILES });
  const preparedRoot = String(process.env.ALBUM_HAVEN_E2E_WRITABLE_MEDIA_ROOT || '').trim()
    ? mediaRoot
    : path.join(mediaRoot, 'writable');
  return path.join(preparedRoot, DDT_ARTIST, REMIXES_ALBUM);
}

// Byte-exact copy of the ten MP3s (with timestamps) so `finally` can return the shared
// prepared media to its released state even when the app-level restore did not finish.
export async function snapshotRemixesMedia() {
  const directory = remixesDirectory();
  const filenames = (await fs.readdir(directory)).filter((name) => name.endsWith('.mp3')).sort();
  if (JSON.stringify(filenames) !== JSON.stringify([...REMIXES_FILENAMES].sort())) {
    throw new Error(`«${REMIXES_ALBUM}» must start as the released ten-track fixture: ${filenames.join(', ')}`);
  }
  return Promise.all(filenames.map(async (filename) => {
    const filePath = path.join(directory, filename);
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { filePath, bytes, atime: stat.atime, mtime: stat.mtime };
  }));
}

export async function restoreRemixesMedia(snapshot) {
  for (const { filePath, bytes, atime, mtime } of snapshot) {
    await fs.writeFile(filePath, bytes);
    await fs.utimes(filePath, atime, mtime);
  }
}

// Physical ID3 tags of every file: TALB is «Ремиксы2» exactly for `splitFilenames`,
// and TIT2 matches `titles[filename]` where given.
export async function readRemixesPhysicalState() {
  const snapshots = await readGeneratedMp3TagSnapshots({
    artist: DDT_ARTIST,
    album: REMIXES_ALBUM,
    allowedProfiles: ALLOWED_PROFILES,
  });
  return Object.fromEntries(snapshots.map(({ filename, frames }) => [filename, {
    album: frames.TALB || [],
    title: frames.TIT2 || [],
  }]));
}

export async function expectRemixesPhysicalState(expect, { splitFilenames = [], titles = {} } = {}) {
  const physical = await readRemixesPhysicalState();
  expect(Object.keys(physical).sort()).toEqual([...REMIXES_FILENAMES].sort());
  for (const filename of REMIXES_FILENAMES) {
    const expectedAlbum = splitFilenames.includes(filename) ? REMIXES_SPLIT_ALBUM : REMIXES_ALBUM;
    expect(physical[filename].album, `${filename} album tag`).toEqual([expectedAlbum]);
    if (titles[filename] !== undefined) {
      expect(physical[filename].title, `${filename} title tag`).toEqual([titles[filename]]);
    }
  }
  return physical;
}

// `observe(label, response)` lets a caller audit every response, including polled reads.
async function readJson(response, label, { observe } = {}) {
  observe?.(label, response);
  const body = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  if (!response.ok() || payload?.ok === false) {
    throw new Error(`${label} returned HTTP ${response.status()}: ${body.slice(0, 2000)}`);
  }
  return payload;
}

// The DDT albums named `albumName` that the Postgres browse projection serves now.
export async function findDdtAlbums(page, albumName, options = {}) {
  const response = await authenticatedPageGet(
    page,
    `/view-data?surface=albums&artist=${encodeURIComponent(DDT_ARTIST)}`,
    { timeout: REQUEST_TIMEOUT_MS },
  );
  const payload = await readJson(response, 'DDT view-data', options);
  return flattenAlbums(payload.artist_groups || [])
    .filter((album) => String(album?.name || '').trim() === albumName);
}

export function albumRequestKey(album) {
  return String(album?.request_key || album?.identity_key || album?.key || '').trim();
}

export async function readAlbumDetails(page, album, options = {}) {
  const response = await authenticatedPageGet(
    page,
    `/album-details?album_key=${encodeURIComponent(albumRequestKey(album))}`,
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return (await readJson(response, 'album-details', options)).album;
}

// The full album payload Edit Tags sends, read the way the editor reads it, or null
// while the browse projection has no single album of that name.
export async function readDdtAlbumPayload(page, albumName, options = {}) {
  const albums = await findDdtAlbums(page, albumName, options);
  if (albums.length !== 1) return null;
  return readAlbumDetails(page, albums[0], options);
}

export async function postEditTags(page, album, updates) {
  return authenticatedPagePost(page, '/utilities/edit-tags', {
    data: { confirmed: true, album, updates },
    timeout: REQUEST_TIMEOUT_MS,
  });
}

export function albumUpdatesFor(album, filenames, fields) {
  const wanted = new Set(filenames);
  const updates = {};
  for (const track of album?.tracks || []) {
    if (wanted.has(trackFilename(track))) updates[track.path] = { ...fields };
  }
  if (Object.keys(updates).length !== wanted.size) {
    throw new Error(`Album payload is missing tracks: wanted ${[...wanted].join(', ')}.`);
  }
  return updates;
}

// App-level restore used from `finally`: every track back in «Ремиксы» with its released
// title, through the real Edit Tags route so Postgres and files stay consistent.
export async function restoreRemixesThroughApp(page, { titles = {} } = {}) {
  const split = await readDdtAlbumPayload(page, REMIXES_SPLIT_ALBUM);
  if (split) {
    const response = await postEditTags(
      page,
      split,
      albumUpdatesFor(split, split.tracks.map(trackFilename), { album: REMIXES_ALBUM }),
    );
    await readJson(response, 'restore merge');
  }
  const source = await readDdtAlbumPayload(page, REMIXES_ALBUM);
  if (!source) throw new Error(`«${REMIXES_ALBUM}» is not a single album after restore.`);
  const titleUpdates = {};
  for (const track of source.tracks || []) {
    const expected = titles[trackFilename(track)];
    if (expected !== undefined && String(track.title || '') !== expected) {
      titleUpdates[track.path] = { title: expected };
    }
  }
  if (Object.keys(titleUpdates).length) {
    await readJson(await postEditTags(page, source, titleUpdates), 'restore titles');
  }
}
