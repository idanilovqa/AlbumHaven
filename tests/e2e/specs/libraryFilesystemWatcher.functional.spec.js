import fs from 'node:fs';
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
const WATCHER_COVER_TARGET = Object.freeze({
  artist: 'Watcher Automatic Cover Artist',
  album: 'Watcher Automatic Cover Album',
  year: '2006',
});
const WATCHER_LOCAL_COVER_TARGET = Object.freeze({
  artist: 'Watcher Local Cover Artist',
  album: 'Watcher Local Cover Album',
  year: '2007',
});

test('FTC-COVERS-034 watcher prefers front-named local art over a larger booklet image', {
  tag: '@area:cover-providers',
}, async ({
  context,
  coverLookupActions,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  stepLogger,
  trackModalActions,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(180000);
  let fixture;
  let originalFailure;

  try {
    await stepLogger.step('Add watched album with front and booklet images', async () => {
      await coverLookupActions.setProviderFixtureMode('automatic-coverless');
      await coverLookupActions.resetProviderFixtureEvidence();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        ...WATCHER_LOCAL_COVER_TARGET,
        year: Number(WATCHER_LOCAL_COVER_TARGET.year),
        fixtureDirectory: 'watcher-local-cover-ranking',
        createLocalArt: true,
        removeEmbeddedArtwork: true,
        context,
        managedAppLifecycle,
      });

      await libraryFilesystemWatcherActions.waitForRevisionAfter(status.inventory_mutation_revision);
    });

    await stepLogger.step('Show the front-named image without remote lookup', async () => {
      let opened;
      await expect(async () => {
        await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(WATCHER_LOCAL_COVER_TARGET.artist)}`);
        await galleryActions.waitForGalleryReady();
        opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
          WATCHER_LOCAL_COVER_TARGET,
          60000,
        );
        expect(opened.album.cover_path).toMatch(/[\\/]front-scan\.jpg$/i);
      }).toPass({ timeout: 60000, intervals: [250, 500, 1000] });

      await trackModalActions.waitForLoadedSummary();
      await expect(trackModalActions.trackModal.detailedCoverImage).toBeVisible();
      await trackModalActions.close();

      const evidence = await coverLookupActions.readProviderFixtureEvidence();
      expect(evidence.apple_search_requests).toBe(0);
      expect(evidence.apple_artwork_requests).toBe(0);
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});
const PUNCTUATION_BAND_TARGET = Object.freeze({
  artist: 'Fire',
  trackArtist: 'Fire & Ash',
  album: 'Watcher Punctuation Identity',
  year: 2007,
});
const POSSESSIVE_PROJECT_TARGET = Object.freeze({
  artist: "Luca Turilli's Rhapsody",
  baseArtist: 'Rhapsody',
  album: 'Watcher Possessive Project Identity',
  year: 2008,
});
const ARTIST_COLLATION_TARGETS = Object.freeze([
  Object.freeze({ artist: '!Air', album: 'Watcher Collation Air', year: 2009 }),
  Object.freeze({ artist: "I'm with Her", album: 'Watcher Collation Apostrophe', year: 2010 }),
  Object.freeze({ artist: 'IZZ', album: 'Watcher Collation IZZ', year: 2011 }),
  Object.freeze({ artist: "'Til Tuesday", album: 'Watcher Collation Til', year: 2012 }),
]);
const JOINT_CREDIT_TARGET = Object.freeze({
  album: 'Watcher Joint Credit Release',
  displayArtist: 'Jordsjø / Breidablik',
  members: Object.freeze(['Jordsjø', 'Breidablik']),
  year: 2013,
});
const GROUPED_FEATURE_TARGET = Object.freeze({
  artist: 'Feature Credit Owner',
  album: 'Watcher Grouped Feature Credit',
  year: 2014,
  trackTitle: 'Grouped Feature Signal',
  trackArtist: 'Feature Credit Owner / Guest One / Guest Two / Guest One',
});
const FEATURED_OWNERSHIP_TARGETS = Object.freeze([
  Object.freeze({
    artist: 'Belle Stars',
    album: 'Rain Man',
    albumArtist: 'Various Artists',
    trackArtists: ['Belle Stars', 'Watcher Compilation Performer'],
    year: 1988,
  }),
  Object.freeze({
    artist: 'Ben Del Maestro',
    album: 'The Lord Of The Rings: The Return Of The King',
    albumArtist: 'Various Artists',
    trackArtists: ['Ben Del Maestro', 'Watcher Compilation Performer'],
    year: 2003,
  }),
  Object.freeze({
    artist: 'Beny Moré',
    album: 'Dexter: Music From The Showtime Original Series',
    albumArtist: 'Various Artists',
    trackArtists: ['Beny Moré', 'Watcher Compilation Performer'],
    year: 2007,
  }),
  Object.freeze({
    artist: 'Bella Ramsey',
    album: 'Hilda: Season 2 (Original Series Soundtrack)',
    albumArtist: 'Ryan Carlson',
    trackArtists: ['Bella Ramsey', 'RYAN CARLSON.'],
    year: 2020,
  }),
]);

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

async function expectFeaturedAlbumOccurrence({
  page,
  galleryActions,
  navigationPanelActions,
  artist,
  album,
}) {
  await expect.poll(
    () => navigationPanelActions.readSidebarArtistLabelCount(artist),
    { timeout: 60000, intervals: [250, 500, 1000] },
  ).toBe(1);
  await navigationPanelActions.selectSidebarArtistByName(artist);
  await navigationPanelActions.waitForSidebarSelection(artist);
  await galleryActions.waitForArtistHeadings([artist]);
  await galleryActions.waitForAlbumVisible(album, 60000);

  const subsectionTitle = await galleryActions.readAlbumSubsectionTitle(artist, album);
  expect(subsectionTitle).toBe('Featured On');
}

async function expectOwnedAlbumOccurrence({
  artist,
  album,
  equivalentArtist,
  galleryActions,
  navigationPanelActions,
  page,
}) {
  await expect.poll(
    () => navigationPanelActions.readSidebarArtistLabelCount(artist),
    { timeout: 60000, intervals: [250, 500, 1000] },
  ).toBe(1);
  await expect.poll(
    () => navigationPanelActions.readSidebarArtistLabelCount(equivalentArtist),
    { timeout: 60000, intervals: [250, 500, 1000] },
  ).toBe(0);
  await navigationPanelActions.selectSidebarArtistByName(artist);
  await navigationPanelActions.waitForSidebarSelection(artist);
  await galleryActions.waitForArtistHeadings([artist]);
  await galleryActions.waitForAlbumVisible(album, 60000);

  expect((await galleryActions.readAlbumNamesByHeading(artist))
    .filter((albumName) => albumName === album)).toHaveLength(1);
  const subsectionTitle = await galleryActions.readAlbumSubsectionTitle(artist, album);
  expect(subsectionTitle).toBeNull();
}

test('FTC-LIBROOTS-016 / 017 / 018 reconciles filesystem changes and confirms missing-album removal', { tag: '@area:album-details' }, async ({
  appBarActions,
  coverLookupActions,
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
      await galleryActions.clickAlbumDetailsByAlbumName(TARGET_ALBUM);
      await expect(trackModalActions.trackModal.trackRows).toHaveCount(2);
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
      const galleryResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/utilities/cover-lookup/gallery'
      ));
      await trackModalActions.openCoverLookup();
      const response = await galleryResponse;
      expect(response.status()).toBe(200);
      await coverLookupActions.waitForModalResultsReady();
      expect(await coverLookupActions.readModalSubtitle()).toContain(TARGET_ALBUM);
      await coverLookupActions.closeModal();
      await trackModalActions.close();
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

test('FTC-SEARCH-NAV-029 watcher preserves punctuation-only band identity', {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add album whose track artist is one punctuation-bearing band', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        artist: PUNCTUATION_BAND_TARGET.artist,
        trackArtist: PUNCTUATION_BAND_TARGET.trackArtist,
        albumArtist: PUNCTUATION_BAND_TARGET.artist,
        album: PUNCTUATION_BAND_TARGET.album,
        year: PUNCTUATION_BAND_TARGET.year,
        fixtureDirectory: 'watcher-punctuation-identity',
        context,
        managedAppLifecycle,
      });
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
    });

    await stepLogger.step('Expose one intact band identity and no punctuation fragment', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(
        () => navigationPanelActions.readSidebarArtistLabelCount(
          PUNCTUATION_BAND_TARGET.trackArtist,
        ),
        { timeout: 60000, intervals: [250, 500, 1000] },
      ).toBe(1);
      expect(await navigationPanelActions.readSidebarArtistLabelCount('Ash')).toBe(0);

      await searchToolbarActions.search(PUNCTUATION_BAND_TARGET.trackArtist, {
        submitWithEnter: true,
      });
      await searchToolbarActions.waitForQuery(PUNCTUATION_BAND_TARGET.trackArtist);
      await galleryActions.waitForAlbumVisible(PUNCTUATION_BAND_TARGET.album, 60000);
    });

    await stepLogger.step('Keep the identity stable after application restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(
        () => navigationPanelActions.readSidebarArtistLabelCount(
          PUNCTUATION_BAND_TARGET.trackArtist,
        ),
        { timeout: 60000, intervals: [250, 500, 1000] },
      ).toBe(1);
      expect(await navigationPanelActions.readSidebarArtistLabelCount('Ash')).toBe(0);
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-SEARCH-NAV-030 watcher keeps possessive project identity separate from base artist', {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add one release containing distinct project and base artist credits', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        artist: POSSESSIVE_PROJECT_TARGET.artist,
        albumArtist: POSSESSIVE_PROJECT_TARGET.artist,
        album: POSSESSIVE_PROJECT_TARGET.album,
        year: POSSESSIVE_PROJECT_TARGET.year,
        trackTitles: ['Project Signal', 'Base Signal', 'Guest Signal'],
        trackArtists: [
          POSSESSIVE_PROJECT_TARGET.artist,
          POSSESSIVE_PROJECT_TARGET.baseArtist,
          'Watcher Guest Artist',
        ],
        fixtureDirectory: 'watcher-possessive-identity',
        context,
        managedAppLifecycle,
      });
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
    });

    await stepLogger.step('Expose separate project and base artist identities', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(
        () => navigationPanelActions.readSidebarArtistLabelCount(
          POSSESSIVE_PROJECT_TARGET.artist,
        ),
        { timeout: 60000, intervals: [250, 500, 1000] },
      ).toBe(1);
      expect(await navigationPanelActions.readSidebarArtistLabelCount(
        POSSESSIVE_PROJECT_TARGET.baseArtist,
      )).toBe(1);

      await searchToolbarActions.search(POSSESSIVE_PROJECT_TARGET.artist, {
        submitWithEnter: true,
      });
      await searchToolbarActions.waitForQuery(POSSESSIVE_PROJECT_TARGET.artist);
      await galleryActions.waitForAlbumVisible(POSSESSIVE_PROJECT_TARGET.album, 60000);
    });

    await stepLogger.step('Keep both identities separate after application restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(
        () => navigationPanelActions.readSidebarArtistLabelCount(
          POSSESSIVE_PROJECT_TARGET.artist,
        ),
        { timeout: 60000, intervals: [250, 500, 1000] },
      ).toBe(1);
      expect(await navigationPanelActions.readSidebarArtistLabelCount(
        POSSESSIVE_PROJECT_TARGET.baseArtist,
      )).toBe(1);
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test("FTC-SEARCH-NAV-032 watcher sorts I'm with Her before IZZ without changing display names", {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  stepLogger,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  const expectedArtists = ARTIST_COLLATION_TARGETS.map(({ artist }) => artist);
  const targetArtists = new Set(expectedArtists);
  const readTargetOrder = async () => (await navigationPanelActions.readSidebarArtistNames())
    .filter((artist) => targetArtists.has(artist));
  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add four watched albums spanning leading and internal punctuation', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      const [initial, ...siblings] = ARTIST_COLLATION_TARGETS;
      fixture = await createWatchedAlbumFixture({
        artist: initial.artist,
        trackArtist: initial.artist,
        albumArtist: initial.artist,
        album: initial.album,
        year: initial.year,
        trackTitles: ['Collation Signal'],
        fixtureDirectory: 'watcher-artist-collation',
        context,
        managedAppLifecycle,
      });
      for (const target of siblings) {
        await fixture.createSiblingAlbum({
          album: target.album,
          year: target.year,
          trackTitles: ['Collation Signal'],
          trackArtist: target.artist,
          albumArtist: target.artist,
        });
      }
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
    });

    await stepLogger.step('Ignore leading punctuation for ordering but preserve every display name', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(readTargetOrder, {
        timeout: 60000,
        intervals: [250, 500, 1000],
      }).toEqual(expectedArtists);
    });

    await stepLogger.step('Keep the same collation and display names after restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await expect.poll(readTargetOrder, {
        timeout: 60000,
        intervals: [250, 500, 1000],
      }).toEqual(expectedArtists);
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-SEARCH-NAV-033 watcher projects one joint-credit release under both constituent artists', {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  const verifyJointCredit = async () => {
    const sidebarArtists = await navigationPanelActions.readHydratedSidebarArtistNames();
    expect(sidebarArtists).not.toContain(JOINT_CREDIT_TARGET.displayArtist);
    for (const member of JOINT_CREDIT_TARGET.members) expect(sidebarArtists).toContain(member);

    await searchToolbarActions.search(JOINT_CREDIT_TARGET.album, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(JOINT_CREDIT_TARGET.album);
    expect(await navigationPanelActions.readSidebarArtistNameCount(
      JOINT_CREDIT_TARGET.displayArtist,
    )).toBe(0);
    for (const member of JOINT_CREDIT_TARGET.members) {
      expect(await navigationPanelActions.readSidebarArtistNameCount(member)).toBe(1);
      await navigationPanelActions.selectSidebarArtistByName(member);
      await navigationPanelActions.waitForSidebarSelection(member);
      await galleryActions.waitForAlbumVisible(JOINT_CREDIT_TARGET.album);
      expect(await galleryActions.readAlbumCreditByName(JOINT_CREDIT_TARGET.album)).toBe(
        JOINT_CREDIT_TARGET.displayArtist,
      );
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: member,
        album: JOINT_CREDIT_TARGET.album,
        year: String(JOINT_CREDIT_TARGET.year),
      })).toBe(1);
    }
  };
  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add one two-track release with two explicit constituent artists', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        artist: 'Watcher Joint Credits',
        trackArtist: JOINT_CREDIT_TARGET.members[0],
        albumArtist: 'Various Artists',
        album: JOINT_CREDIT_TARGET.album,
        year: JOINT_CREDIT_TARGET.year,
        trackTitles: ['Northern Signal', 'Wasteland Signal'],
        trackArtists: JOINT_CREDIT_TARGET.members,
        fixtureDirectory: 'watcher-joint-credit',
        context,
        managedAppLifecycle,
      });
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
    });

    await stepLogger.step('Show one joint-credit album under each member without a synthetic artist', async () => {
      await verifyJointCredit();
      await galleryActions.clickAlbumDetailsByAlbumName(JOINT_CREDIT_TARGET.album);
      await trackModalActions.waitForLoadedSummary();
      await expect(trackModalActions.trackModal.trackRows).toHaveCount(2);
      await trackModalActions.close();
    });

    await stepLogger.step('Keep constituent membership and one release after restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await verifyJointCredit();
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-ALBUM-TRACK-CREDITS-003 groups repeated featured artists under one marker', {
  tag: '@area:album-details',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add one ordinary release with repeated structured guests', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        artist: GROUPED_FEATURE_TARGET.artist,
        albumArtist: GROUPED_FEATURE_TARGET.artist,
        album: GROUPED_FEATURE_TARGET.album,
        year: GROUPED_FEATURE_TARGET.year,
        trackTitles: [GROUPED_FEATURE_TARGET.trackTitle],
        trackArtists: [GROUPED_FEATURE_TARGET.trackArtist],
        ownedDirectoryName: 'watcher-grouped-feature-credit',
        context,
        managedAppLifecycle,
      });
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      await appBarActions.waitForScanAndCoverRefreshIdle();
    });

    await stepLogger.step('Render one feat. marker and each guest once', async () => {
      await searchToolbarActions.search(GROUPED_FEATURE_TARGET.album, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(GROUPED_FEATURE_TARGET.album);
      await galleryActions.waitForAlbumVisible(GROUPED_FEATURE_TARGET.album);
      await galleryActions.clickAlbumDetailsByAlbumName(GROUPED_FEATURE_TARGET.album);
      const summary = await trackModalActions.waitForLoadedSummary();
      expect(summary.trackRows).toBe(1);
      expect(await trackModalActions.readTrackCredits(1)).toEqual([{
        rawTitle: GROUPED_FEATURE_TARGET.trackTitle,
        rawArtist: GROUPED_FEATURE_TARGET.trackArtist,
        title: GROUPED_FEATURE_TARGET.trackTitle,
        secondaryArtist: 'feat. Guest One, Guest Two',
      }]);
      await trackModalActions.close();
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-SEARCH-NAV-034 keeps empty artist-scoped Non-album tracks disabled after hydration', {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  artistPageSettingsActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);

  const artist = 'Watcher Empty Non-album Artist';
  const album = 'Watcher Empty Non-album Release';
  const verifyDisabledState = async () => {
    await searchToolbarActions.search(album, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(album);
    await navigationPanelActions.selectSidebarArtistByName(artist);
    await navigationPanelActions.waitForSidebarSelection(artist);
    await galleryActions.waitForAlbumVisible(album);
    await artistPageSettingsActions.expectNoNonAlbumTracks();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksButton).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksButton).toHaveCSS(
      'cursor',
      'not-allowed',
    );
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksButton).toHaveCSS(
      'opacity',
      '0.55',
    );
  };
  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add an ordinary album with no loose tracks', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        artist,
        album,
        year: 2014,
        trackTitles: ['Owned Album Track'],
        fixtureDirectory: 'watcher-empty-non-album',
        context,
        managedAppLifecycle,
      });
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      await appBarActions.waitForScanAndCoverRefreshIdle();
    });

    await stepLogger.step('Keep the empty Non-album tracks action disabled and visibly inactive', async () => {
      await verifyDisabledState();
    });

    await stepLogger.step('Keep the disabled state after restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await verifyDisabledState();
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-SEARCH-NAV-031 watcher keeps soundtrack track artists under Featured On', {
  tag: '@area:gallery-search',
}, async ({
  appBarActions,
  context,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  navigationPanelActions,
  page,
  stepLogger,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(300000);

  let fixture;
  let originalFailure;
  try {
    await stepLogger.step('Add soundtrack releases with distinct album and track artist credits', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      const [initial, ...siblings] = FEATURED_OWNERSHIP_TARGETS;
      fixture = await createWatchedAlbumFixture({
        artist: 'Watcher Soundtracks',
        trackArtist: initial.artist,
        albumArtist: initial.albumArtist,
        album: initial.album,
        year: initial.year,
        trackTitles: ['Featured Signal', 'Owner Signal'],
        trackArtists: initial.trackArtists,
        fixtureDirectory: 'watcher-featured-ownership',
        context,
        managedAppLifecycle,
      });
      for (const target of siblings) {
        await fixture.createSiblingAlbum({
          album: target.album,
          folderName: target.album.replaceAll(':', ' -'),
          year: target.year,
          trackTitles: ['Featured Signal', 'Owner Signal'],
          trackArtists: target.trackArtists,
          albumArtist: target.albumArtist,
        });
      }
      await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      await appBarActions.waitForScanAndCoverRefreshIdle();
      for (const target of FEATURED_OWNERSHIP_TARGETS) {
        await expect.poll(async () => {
          const identity = await queryPersistedAlbumIdentity({
            artist: target.albumArtist,
            album: target.album,
            year: target.year,
          });
          return identity.track_counts;
        }, { timeout: 60000, intervals: [250, 500, 1000] }).toEqual([2]);
      }
    });

    await stepLogger.step('Show every track performer only under Featured On with owner credit intact', async () => {
      for (const target of FEATURED_OWNERSHIP_TARGETS) {
        await expectFeaturedAlbumOccurrence({
          page,
          galleryActions,
          navigationPanelActions,
          ...target,
        });
      }
      const ownedTarget = FEATURED_OWNERSHIP_TARGETS.at(-1);
      await expectOwnedAlbumOccurrence({
        artist: ownedTarget.albumArtist,
        album: ownedTarget.album,
        equivalentArtist: ownedTarget.trackArtists.at(-1),
        page,
        galleryActions,
        navigationPanelActions,
      });
    });

    await stepLogger.step('Keep an album-title search under its selected track performer', async () => {
      const target = FEATURED_OWNERSHIP_TARGETS.at(-1);
      await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(target.album)}`);
      await galleryActions.waitForGalleryReady();
      await expectFeaturedAlbumOccurrence({
        page,
        galleryActions,
        navigationPanelActions,
        ...target,
      });
      const observation = await galleryActions.readProductionVisibleAlbumObservation(
        target.artist,
        [target.album],
      );
      expect(observation.albumCount).toBe(1);
      expect(observation.renderedIdentities).toEqual([
        { album: target.album, year: String(target.year) },
      ]);
    });

    await stepLogger.step('Keep soundtrack ownership stable after application restart', async () => {
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      for (const target of FEATURED_OWNERSHIP_TARGETS) {
        await expectFeaturedAlbumOccurrence({
          page,
          galleryActions,
          navigationPanelActions,
          ...target,
        });
      }
      const ownedTarget = FEATURED_OWNERSHIP_TARGETS.at(-1);
      await expectOwnedAlbumOccurrence({
        artist: ownedTarget.albumArtist,
        album: ownedTarget.album,
        equivalentArtist: ownedTarget.trackArtists.at(-1),
        page,
        galleryActions,
        navigationPanelActions,
      });
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});

test('FTC-COVERS-033 watcher indexes a new album and applies one automatic cover without Full Scan', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  context,
  coverLookupActions,
  galleryActions,
  libraryFilesystemWatcherActions,
  managedAppLifecycle,
  page,
  stepLogger,
  trackModalActions,
}) => {
  test.skip(process.platform === 'linux', 'Native library watching is deferred on Linux; use manual Full Rescan.');
  test.setTimeout(240000);
  let fixture;
  let originalFailure;

  try {
    await stepLogger.step('Add a coverless album to the watched library', async () => {
      await coverLookupActions.setProviderFixtureMode('automatic-coverless');
      await coverLookupActions.resetProviderFixtureEvidence();
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const status = await libraryFilesystemWatcherActions.readStatus();
      expect(status.scan_in_progress).toBe(false);

      fixture = await createWatchedAlbumFixture({
        ...WATCHER_COVER_TARGET,
        year: Number(WATCHER_COVER_TARGET.year),
        removeEmbeddedArtwork: true,
        context,
        managedAppLifecycle,
      });
      const committed = await libraryFilesystemWatcherActions.waitForRevisionAfter(
        status.inventory_mutation_revision,
      );
      expect(committed.scan_in_progress).toBe(false);
      await expect.poll(async () => {
        const identity = await queryPersistedAlbumIdentity({
          ...WATCHER_COVER_TARGET,
          year: Number(WATCHER_COVER_TARGET.year),
        });
        return { albumCount: identity.album_ids.length, trackCounts: identity.track_counts };
      }, { timeout: 60000, intervals: [250, 500, 1000] }).toEqual({
        albumCount: 1,
        trackCounts: [2],
      });
    });

    await stepLogger.step('Apply the automatic cover through the watcher follow-up', async () => {
      await coverLookupActions.waitForAutomaticProviderSearch(
        WATCHER_COVER_TARGET,
      );
      await expect.poll(async () => {
        const evidence = await coverLookupActions.readProviderFixtureEvidence();
        return {
          appleSearchRequests: evidence.apple_search_requests,
          appleArtworkRequests: evidence.apple_artwork_requests,
        };
      }, { timeout: 60000, intervals: [250, 500, 1000] }).toEqual({
        appleSearchRequests: 1,
        appleArtworkRequests: 1,
      });

      let opened;
      await expect(async () => {
        await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(WATCHER_COVER_TARGET.artist)}`);
        await galleryActions.waitForGalleryReady();
        opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
          WATCHER_COVER_TARGET,
          { timeout: 60000 },
        );
        expect(opened.album.cover_selection_origin).toBe('automatic');
        expect(opened.album.cover_path).toMatch(/[\\/]cover\.jpg$/i);
      }).toPass({ timeout: 60000, intervals: [250, 500, 1000] });

      await trackModalActions.waitForLoadedSummary();
      await expect(trackModalActions.trackModal.detailedCoverImage).toBeVisible();
      const coverFiles = fs.readdirSync(fixture.albumDirectory)
        .filter((name) => /^cover\.(?:jpe?g|png|webp)$/i.test(name));
      expect(coverFiles).toEqual(['cover.jpg']);
      fixture.coverPath = opened.album.cover_path;
      fixture.coverRevision = opened.album.cover_revision;
      await trackModalActions.close();
    });

    await stepLogger.step('Restart without duplicating the projection, lookup, or cover file', async () => {
      await coverLookupActions.resetProviderFixtureEvidence();
      await managedAppLifecycle.restart();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(WATCHER_COVER_TARGET.artist)}`);
      await galleryActions.waitForGalleryReady();
      const reopened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
        WATCHER_COVER_TARGET,
        { timeout: 60000 },
      );
      expect(reopened.album.cover_selection_origin).toBe('automatic');
      expect(reopened.album.cover_path).toBe(fixture.coverPath);
      expect(reopened.album.cover_revision).toBe(fixture.coverRevision);
      await trackModalActions.waitForLoadedSummary();
      await expect(trackModalActions.trackModal.detailedCoverImage).toBeVisible();
      await trackModalActions.close();

      const identity = await queryPersistedAlbumIdentity({
        ...WATCHER_COVER_TARGET,
        year: Number(WATCHER_COVER_TARGET.year),
      });
      expect(identity.album_ids).toHaveLength(1);
      expect(identity.track_counts).toEqual([2]);
      expect(fs.readdirSync(fixture.albumDirectory)
        .filter((name) => /^cover\.(?:jpe?g|png|webp)$/i.test(name))).toEqual(['cover.jpg']);
      const evidence = await coverLookupActions.readProviderFixtureEvidence();
      expect(evidence).toMatchObject({
        apple_search_requests: 0,
        apple_artwork_requests: 0,
        apple_search_terms: [],
        manual_page_requests: 0,
        manual_image_requests: 0,
        later_provider_started: 0,
        later_provider_completed: 0,
        musicbrainz_started: 0,
        musicbrainz_queries: [],
        musicbrainz_completed: 0,
        cover_art_archive_requests: 0,
        cover_art_archive_release_ids: [],
        discogs_search_requests: 0,
        discogs_detail_requests: 0,
        candidate_image_requests: 0,
      });
    });
  } catch (error) {
    originalFailure = error;
  } finally {
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    else if (originalFailure) throw originalFailure;
  }
});
