import { expect } from '@playwright/test';

import { readRuntimeView } from './realAppBenchmarkHelpers.js';

export function normalizeAlbum(album) {
  const hydratedTrackCount = Array.isArray(album?.tracks) ? album.tracks.length : 0;
  const declaredTrackCount = [album?.track_count_preview, album?.track_count]
    .map(Number)
    .find(Number.isFinite) ?? 0;
  const trackCount = album?.preview_only === true
    ? Math.max(hydratedTrackCount, declaredTrackCount)
    : hydratedTrackCount || declaredTrackCount;
  return {
    name: String(album?.name || '').trim(),
    trackCount,
    year: String(album?.year || '').trim(),
  };
}

export async function readArtistRendererInventory(page, galleryActions, artist) {
  const view = await readRuntimeView(page);
  const artistGroups = Array.isArray(view.artist_groups) ? view.artist_groups : [];
  const effectiveGroups = artistGroups.length
    ? artistGroups
    : [
      ...(Array.isArray(view.primary_artist_groups) ? view.primary_artist_groups : []),
      ...(Array.isArray(view.family_artist_groups) ? view.family_artist_groups : []),
    ];
  const logical = effectiveGroups.flatMap((group) => (
    (group?.albums || []).map((album) => ({
      ...normalizeAlbum(album),
      groupArtist: String(group?.artist || '').trim(),
    }))
  ));
  const mounted = await galleryActions.galleryPage.readMountedAlbumInventory();
  const scroll = await galleryActions.readGalleryScrollState();
  return {
    albumCount: Number(view.album_count || logical.length),
    logical,
    logicalReady: logical.length > 0,
    mounted,
    visualNonblank: mounted.length > 0,
    loaderHidden: await galleryActions.galleryPage.libraryLoader.isHidden(),
    recordedAt: new Date().toISOString(),
    scroll,
  };
}

export async function captureRendererCheckpoint({
  artist,
  galleryActions,
  page,
  screenshotPath,
}) {
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return readArtistRendererInventory(page, galleryActions, artist);
}

export function findLogicalAlbum(inventory, albumName) {
  return inventory.logical.find((album) => album.name === albumName) || null;
}

export function findLogicalAlbumByIdentity(inventory, expected) {
  const artist = String(expected?.artist || '').trim();
  const album = String(expected?.album || '').trim();
  const year = String(expected?.year || '').trim();
  return inventory.logical.find((candidate) => (
    candidate.groupArtist === artist
    && candidate.name === album
    && candidate.year === year
  )) || null;
}

export async function waitForPositiveLogicalAlbumTrackCounts({
  artist,
  expectedAlbum,
  expectedLogicalCount,
  galleryActions,
  page,
  timeout = 10000,
}) {
  let lastInventory = null;
  await expect.poll(async () => {
    lastInventory = await readArtistRendererInventory(page, galleryActions, artist);
    const target = findLogicalAlbumByIdentity(lastInventory, expectedAlbum);
    const mountedTrackCounts = lastInventory.mounted.map((album) => {
      const match = String(album.trackCount || '').trim().match(/^(\d+)\s+tracks?$/i);
      return match ? Number(match[1]) : -1;
    });
    return {
      allPositive: lastInventory.logical.length > 0
        && lastInventory.logical.every((album) => album.trackCount > 0),
      logicalCount: lastInventory.logical.length,
      mountedAllPositive: mountedTrackCounts.length > 0
        && mountedTrackCounts.every((trackCount) => trackCount > 0),
      targetCount: Number(target?.trackCount ?? -1),
      targetMatches: lastInventory.logical.filter((album) => (
        album.groupArtist === String(expectedAlbum?.artist || '').trim()
        && album.name === String(expectedAlbum?.album || '').trim()
        && album.year === String(expectedAlbum?.year || '').trim()
      )).length,
    };
  }, {
    message: `Expected every logical ${artist} gallery album to keep a positive track count `
      + `and ${expectedAlbum.album} (${expectedAlbum.year}) to appear exactly once with `
      + `${expectedAlbum.trackCount} tracks. Last inventory: ${JSON.stringify(lastInventory)}`,
    timeout: Number(timeout),
    intervals: [50, 100, 250],
  }).toEqual({
    allPositive: true,
    logicalCount: Number(expectedLogicalCount),
    mountedAllPositive: true,
    targetCount: Number(expectedAlbum.trackCount),
    targetMatches: 1,
  });
  return lastInventory;
}

export function logicalAlbumNames(inventory) {
  return inventory.logical.map((album) => album.name);
}

export function recordRendererViolation(violations, condition, message, evidence = null) {
  if (condition) return;
  violations.push({ evidence, message });
}
