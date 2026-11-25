// Reported 2026-11-19: after browsing artists and albums online, the network
// went off and the page was reloaded; only the gallery's first block came back. Everything seen
// online must stay usable offline after a reload: gallery pages scrolled through, artists opened
// from the tree or only scrolled past, and album details opened. Anything never seen still says
// Offline. Through the real UI, with the app's service worker allowed and the real server.
import { expect, test } from '../support/baseFixtures.js';
import {
  albumNeverRequested, keptDataKeys, primeCopy, requestedAlbumKeys, scrollToArtistHeading, visibleAlbumNames, LIBRARY_PATH,
} from '../helpers/instantReturnHelpers.js';

test.use({ serviceWorkers: 'allow' });


// Opens [album] under [artist], waits for its tracks, and returns their titles.
async function openDetails(galleryActions, trackModalActions, artist, album) {
  await galleryActions.clickAlbumDetailsByArtistAndAlbum(artist, album);
  await trackModalActions.waitForLoadedSummary();
  await expect(trackModalActions.trackModal.unreachableNotice).toHaveCount(0);
  // The details title names the album (with its artist and year).
  await expect(trackModalActions.trackModal.title).toContainText(album);
  const titles = await trackModalActions.readTrackTitles();
  expect(titles.length, `${album} lists its tracks`).toBeGreaterThan(0);
  await trackModalActions.close();
  return titles;
}

// The artist's own view, opened from the tree: named in the bar, with its albums and no Offline line.
async function expectArtistView(galleryActions, navigationPanelActions, artist) {
  const { galleryPage } = galleryActions;
  await navigationPanelActions.selectSidebarArtistByName(artist);
  await expect(galleryPage.galleryContextName).toHaveText(artist);
  await expect(galleryPage.unreachable).toHaveCount(0);
  await expect.poll(async () => (await galleryActions.readArtistHeadings()).map(heading => heading.trim())).toContain(artist);
  await expect.poll(async () => (await visibleAlbumNames(galleryPage)).length).toBeGreaterThan(0);
}

test('FTC-IAR-W20 after browsing online, an offline reload still opens every artist and album already seen, by the tree and by scrolling, and their details', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions, navigationPanelActions, trackModalActions }) => {
  test.setTimeout(240_000);
  const { galleryPage } = galleryActions;
  const requested = requestedAlbumKeys(page);
  await primeCopy(page, galleryActions);
  const artists = await navigationPanelActions.readSidebarArtistNames();
  expect(artists.length, 'the fixture has artists far apart in the gallery').toBeGreaterThan(6);
  // Three artists far apart: one opened from the tree, two only reached by scrolling the gallery.
  const opened = artists[1];
  const middle = artists[Math.floor(artists.length / 2)];
  const last = artists[artists.length - 1];

  // Online: open one artist from the tree, return to all artists, scroll down past the middle
  // artist to the last one, and open an album of each of those two.
  await expectArtistView(galleryActions, navigationPanelActions, opened);
  await navigationPanelActions.clickAllArtists();
  await galleryActions.waitForGalleryReady();
  await scrollToArtistHeading(galleryActions, middle);
  const [middleAlbum] = await galleryActions.readAlbumNamesByHeading(middle);
  const middleTracks = await openDetails(galleryActions, trackModalActions, middle, middleAlbum);
  await scrollToArtistHeading(galleryActions, last);
  const [lastAlbum] = await galleryActions.readAlbumNamesByHeading(last);
  const lastTracks = await openDetails(galleryActions, trackModalActions, last, lastAlbum);
  // What the page read is kept as it arrives; wait until the two albums are on the device.
  await expect.poll(async () => (await keptDataKeys(page)).filter(key => key.startsWith('/album-details')).length, {
    timeout: 15_000,
  }).toBeGreaterThanOrEqual(2);

  // Offline, the library is opened again, as the reported reload did (its address is a kept page).
  await context.setOffline(true);
  await page.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await expect(galleryPage.appCopyMarker).toHaveAttribute('content', 'cache');
  await expect(galleryPage.appCopyOfflineNotice).toBeVisible();

  // The tree opens the last artist, only ever scrolled to, and its album opens with its tracks.
  await expectArtistView(galleryActions, navigationPanelActions, last);
  expect(await openDetails(galleryActions, trackModalActions, last, lastAlbum)).toEqual(lastTracks);
  // The tree opens the artist opened online.
  await expectArtistView(galleryActions, navigationPanelActions, opened);

  // Back to all artists: the gallery scrolls past its first block to the middle artist, whose
  // album opens with the same tracks; the end of the kept gallery never shows on the way.
  await navigationPanelActions.clickAllArtists();
  await galleryActions.waitForGalleryReady();
  await scrollToArtistHeading(galleryActions, middle);
  await expect(galleryPage.galleryEndOffline).toBeHidden();
  expect(await openDetails(galleryActions, trackModalActions, middle, middleAlbum)).toEqual(middleTracks);

  // Never seen: an album in the window whose details were never asked for still says Offline.
  const unseen = await albumNeverRequested(galleryActions, requested);
  await galleryActions.clickAlbumDetailsByAlbumName(unseen);
  await expect(trackModalActions.trackModal.unreachableTitle).toHaveText('Offline');
  await expect(trackModalActions.trackModal.unreachableDetail).toHaveText("Can't load the details, check your network or try again later");
  await trackModalActions.close();

  // Back online the server answers again: data comes from it, not from the device.
  await context.setOffline(false);
  const served = page.waitForResponse(response => new URL(response.url()).pathname === '/album-details');
  await navigationPanelActions.selectSidebarArtistByName(last);
  await expect(galleryPage.galleryContextName).toHaveText(last);
  await galleryActions.clickAlbumDetailsByArtistAndAlbum(last, lastAlbum);
  const answer = await served;
  expect(answer.headers()['x-album-haven-app-copy'], 'the server answered, not the device').not.toBe('cache');
  await trackModalActions.waitForLoadedSummary();
  expect(await trackModalActions.readTrackTitles()).toEqual(lastTracks);
});
