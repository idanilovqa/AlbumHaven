import { expect, test } from '../support/baseFixtures.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';
import {
  queryPersistedAlbumIdentity,
  queryPersistedAlbumTrackMetadata,
} from '../helpers/postgresAlbumIdentityHelpers.js';

const ARTIST = 'Watcher Reconciliation Artist';
const TARGET_ALBUM = 'Watcher Reconciliation Album';
const TARGET_YEAR = 2004;
const EARLIER_ALBUM = 'Watcher Earlier Album';
const LATER_ALBUM = 'Watcher Later Album';

async function viewResponseHasAlbumTrackCount(response, albumName, expectedCount) {
  if (!response.ok() || new URL(response.url()).pathname !== '/view-data') return false;
  const payload = await response.json();
  const pending = payload && typeof payload === 'object' ? [payload] : [];
  let album = null;
  while (pending.length && !album) {
    const value = pending.pop();
    if (value?.name === albumName && ('track_count_preview' in value || 'track_count' in value)) {
      album = value;
      break;
    }
    Object.values(value || {}).forEach((child) => {
      if (child && typeof child === 'object') pending.push(child);
    });
  }
  if (!album) return false;
  const count = Number(album.track_count_preview ?? album.track_count ?? album.tracks?.length ?? -1);
  return count === expectedCount;
}

test('FTC-LIBROOTS-016 / 017 / 018 reconciles filesystem changes and confirms missing-album removal', { tag: '@area:album-details' }, async ({
  appBarActions,
  galleryActions,
  libraryFilesystemWatcherActions,
  context,
  managedAppLifecycle,
  page,
  searchToolbarActions,
  stepLogger,
  testArtifacts,
  trackModalActions,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);
  const latencySamples = [];
  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Open the production gallery and record the current inventory revision', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
    });
    let status = await libraryFilesystemWatcherActions.readStatus();
    expect(status.scan_in_progress).toBe(false);

    await stepLogger.step('Copy a three-album burst into the watched root without starting a scan', async () => {
      const startedAt = Date.now();
      fixture = await createWatchedAlbumFixture({ artist: ARTIST, album: TARGET_ALBUM, year: TARGET_YEAR, context, managedAppLifecycle });
      await fixture.createSiblingAlbum({
        album: EARLIER_ALBUM,
        year: 2001,
        trackTitles: ['Earlier Signal'],
      });
      await fixture.createSiblingAlbum({
        album: LATER_ALBUM,
        year: 2009,
        trackTitles: ['Later Signal'],
      });
      status = await libraryFilesystemWatcherActions.waitForRevisionAfter(status.inventory_mutation_revision);
      latencySamples.push({ mutation: 'create-burst', visibleRevisionMs: Date.now() - startedAt });
      expect(status.scan_in_progress).toBe(false);
    });

    await stepLogger.step('Verify Postgres and the year-sorted gallery publish all created albums', async () => {
      await expect.poll(async () => {
        const identity = await queryPersistedAlbumIdentity({ artist: ARTIST, album: TARGET_ALBUM, year: TARGET_YEAR });
        return identity.track_counts;
      }, { timeout: 60000, intervals: [250, 500, 1000] }).toEqual([2]);
      await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(ARTIST);
      for (const album of [EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM]) {
        await galleryActions.waitForAlbumVisible(album, { timeout: 60000 });
      }
      const titles = (await galleryActions.galleryPage.albumCard.visibleTitles.allTextContents())
        .map((value) => value.trim())
        .filter((value) => [EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM].includes(value));
      expect(titles).toEqual([EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM]);
    });

    await stepLogger.step('Retag one file externally and load the changed title through Album Details', async () => {
      const startedAt = Date.now();
      const previousRevision = (await libraryFilesystemWatcherActions.readStatus()).inventory_mutation_revision;
      await fixture.renameTrack(1, 'Watcher Retagged Signal');
      status = await libraryFilesystemWatcherActions.waitForRevisionAfter(previousRevision);
      await expect.poll(async () => {
        const tracks = await queryPersistedAlbumTrackMetadata({ artist: ARTIST, album: TARGET_ALBUM });
        return tracks.map((track) => track.title);
      }, { timeout: 60000, intervals: [250, 500, 1000] }).toContain('Watcher Retagged Signal');
      latencySamples.push({ mutation: 'retag', visibleRevisionMs: Date.now() - startedAt });
      await galleryActions.clickAlbumDetailsByAlbumName(TARGET_ALBUM);
      await trackModalActions.waitForReady();
      await expect(trackModalActions.trackModal.trackRowByTitle('Watcher Retagged Signal'))
        .toHaveCount(1, { timeout: 15000 });
      await expect(trackModalActions.trackModal.trackRows).toHaveCount(2);
      await trackModalActions.close();
    });

    await stepLogger.step('Delete one track and reconcile only that file', async () => {
      const startedAt = Date.now();
      const previousRevision = (await libraryFilesystemWatcherActions.readStatus()).inventory_mutation_revision;
      const refreshedView = page.waitForResponse(
        (response) => viewResponseHasAlbumTrackCount(response, TARGET_ALBUM, 1),
        { timeout: 60000 },
      );
      fixture.deleteTrack(0);
      status = await libraryFilesystemWatcherActions.waitForRevisionAfter(previousRevision);
      await refreshedView;
      await expect(galleryActions.galleryPage.albumCard.trackCountByAlbumName(TARGET_ALBUM))
        .toHaveText('1 track', { timeout: 15000 });
      await expect.poll(async () => {
        const tracks = await queryPersistedAlbumTrackMetadata({ artist: ARTIST, album: TARGET_ALBUM });
        return tracks.filter((track) => track.scan_cache_stale !== true).length;
      }, {
        timeout: 60000,
        intervals: [250, 500, 1000],
        message: 'Expected targeted reconciliation to stale the deleted PostgreSQL track file',
      }).toBe(1);
      latencySamples.push({ mutation: 'delete-track', visibleRevisionMs: Date.now() - startedAt });
      await galleryActions.clickAlbumDetailsByAlbumName(TARGET_ALBUM);
      await expect(trackModalActions.trackModal.trackRows).toHaveCount(1, { timeout: 15000 });
      await trackModalActions.close();
    });

    await stepLogger.step('Delete the album and keep its missing card in the same year-sorted position', async () => {
      const startedAt = Date.now();
      const previousRevision = (await libraryFilesystemWatcherActions.readStatus()).inventory_mutation_revision;
      fixture.deleteAlbum();
      status = await libraryFilesystemWatcherActions.waitForRevisionAfter(previousRevision);
      await expect(galleryActions.galleryPage.albumCard.artboxByAlbumName(TARGET_ALBUM))
        .toHaveAttribute('data-album-artbox-state', 'missing', { timeout: 60000 });
      latencySamples.push({ mutation: 'delete-album', visibleUiMs: Date.now() - startedAt });
      const titles = (await galleryActions.galleryPage.albumCard.visibleTitles.allTextContents())
        .map((value) => value.trim())
        .filter((value) => [EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM].includes(value));
      expect(titles).toEqual([EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM]);

      const artbox = galleryActions.galleryPage.albumCard.artboxByAlbumName(TARGET_ALBUM);
      const bounds = await artbox.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
      const alert = galleryActions.galleryPage.albumCard.missingAlertByAlbumName(TARGET_ALBUM);
      const compactBounds = await alert.root.boundingBox();
      expect(compactBounds).not.toBeNull();
      expect(compactBounds.width).toBeLessThanOrEqual(32);
      await alert.root.hover();
      await expect.poll(async () => (await alert.root.boundingBox())?.width ?? 0).toBeGreaterThan(100);
      await expect(alert.text).toHaveText('Album not found');
    });

    await stepLogger.step('Show the full missing alert, disable unsafe actions, and render no track table', async () => {
      await galleryActions.clickAlbumDetailsByAlbumName(TARGET_ALBUM);
      await expect(trackModalActions.trackModal.missingAlert).toBeVisible({ timeout: 60000 });
      await expect(trackModalActions.trackModal.missingAlert).toContainText('Album details unavailable');
      await expect(trackModalActions.trackModal.albumTrackTable.root).toHaveCount(0);
      await expect(trackModalActions.trackModal.missingEditButton).toBeDisabled();
      await expect(trackModalActions.trackModal.missingFolderButton).toBeDisabled();
    });

    await stepLogger.step('Confirm owner removal and remove the card immediately and durably', async () => {
      const earlierCard = galleryActions.galleryPage.albumCard.cardByAlbumName(EARLIER_ALBUM);
      const targetCard = galleryActions.galleryPage.albumCard.cardByAlbumName(TARGET_ALBUM);
      const laterCard = galleryActions.galleryPage.albumCard.cardByAlbumName(LATER_ALBUM);
      const [earlierBoundsBefore, targetBoundsBefore] = await Promise.all([
        earlierCard.boundingBox(),
        targetCard.boundingBox(),
      ]);
      expect(earlierBoundsBefore).not.toBeNull();
      expect(targetBoundsBefore).not.toBeNull();
      const galleryScrollTopBefore = await galleryActions.galleryPage.readScrollTop();
      const urlBefore = page.url();
      const mainFrameNavigations = [];
      const recordMainFrameNavigation = (frame) => {
        if (frame === page.mainFrame()) mainFrameNavigations.push(frame.url());
      };
      page.on('framenavigated', recordMainFrameNavigation);

      await trackModalActions.trackModal.removeMissingAlbumButton.click();
      await expect(trackModalActions.trackModal.appConfirmDialog.overlay).toBeVisible();
      const removalResponsePromise = page.waitForResponse((response) => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === 'POST'
          && path.startsWith('/api/library/albums/')
          && path.endsWith('/confirm-removal');
      });
      await trackModalActions.trackModal.appConfirmDialog.acceptButton.click();
      const removalResponse = await removalResponsePromise;
      expect(removalResponse.status()).toBe(200);
      await expect(trackModalActions.trackModal.appConfirmDialog.overlay).toBeHidden();
      await expect(trackModalActions.trackModal.dialog).toBeHidden({ timeout: 60000 });
      await expect(galleryActions.galleryPage.albumCard.cardByAlbumName(TARGET_ALBUM)).toHaveCount(0);
      await expect(appBarActions.appBar.errorToasts).toHaveCount(0);

      const remainingTitles = (await galleryActions.galleryPage.albumCard.visibleTitles.allTextContents())
        .map((value) => value.trim())
        .filter((value) => [EARLIER_ALBUM, TARGET_ALBUM, LATER_ALBUM].includes(value));
      expect(remainingTitles).toEqual([EARLIER_ALBUM, LATER_ALBUM]);
      const [earlierBoundsAfter, laterBoundsAfter] = await Promise.all([
        earlierCard.boundingBox(),
        laterCard.boundingBox(),
      ]);
      expect(earlierBoundsAfter).not.toBeNull();
      expect(laterBoundsAfter).not.toBeNull();
      expect(Math.abs(earlierBoundsAfter.x - earlierBoundsBefore.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(earlierBoundsAfter.y - earlierBoundsBefore.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(laterBoundsAfter.x - targetBoundsBefore.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(laterBoundsAfter.y - targetBoundsBefore.y)).toBeLessThanOrEqual(1);
      await expect.poll(() => galleryActions.galleryPage.readScrollTop()).toBe(galleryScrollTopBefore);
      expect(page.url()).toBe(urlBefore);
      expect(mainFrameNavigations).toEqual([]);
      page.off('framenavigated', recordMainFrameNavigation);
      await expect.poll(async () => {
        const identity = await queryPersistedAlbumIdentity({ artist: ARTIST, album: TARGET_ALBUM, year: TARGET_YEAR });
        return identity.album_ids.length;
      }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe(0);
      await page.reload();
      await galleryActions.waitForGalleryReady();
      await expect(galleryActions.galleryPage.albumCard.cardByAlbumName(TARGET_ALBUM)).toHaveCount(0);
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    testArtifacts.queueJsonAttachment('watcher-latency-samples.json', latencySamples);
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});
