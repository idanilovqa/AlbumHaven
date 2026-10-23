import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '../support/baseFixtures.js';
import {
  createAlbumSourceOwnershipFixture, removeAlbumSourceOwnershipFixture,
  stageOwnedLegacyCoverContamination, stageOwnedLegacyInFolderCover, readOwnedLegacyCoverState,
} from '../helpers/albumSourceOwnershipFixture.js';
import { setOwnedLegacyCoverRepairProvider } from '../helpers/coverLookupProviderHelpers.js';

let ownedFixture;

async function expectCompleteSourceTracks(album, fixture, trackModalActions) {
  const sources = ['Real Album', 'Complete copy'].map(folder =>
    [1, 2].flatMap(disc => [1, 2].map(number => path.join(fixture.owner, folder, `CD${disc}`, `${number}.mp3`))),
  );
  const expectedPaths = sources.flat();
  expect(album.tracks).toHaveLength(4);
  const selectedPaths = album.tracks.map(track => track.path);
  expect(sources.some(source => source.every(expected => selectedPaths.includes(expected)))).toBe(true);
  for (const excluded of fixture.excludedPaths) expect(album.tracks.map(track => track.path)).not.toContain(excluded);
  expect(album.duplicate_sources).toHaveLength(2);
  expect(new Set(album.duplicate_sources.map(source => source.folder_path))).toEqual(
    new Set(['Real Album', 'Complete copy'].map(folder => path.join(fixture.owner, folder))),
  );
  const duplicatePaths = [];
  for (const source of album.duplicate_sources) {
    expect(source.tracks).toHaveLength(4);
    const paths = source.tracks.map(track => track.path);
    expect(sources.some(expected => expected.every(trackPath => paths.includes(trackPath)))).toBe(true);
    for (const excluded of fixture.excludedPaths) expect(paths).not.toContain(excluded);
    duplicatePaths.push(...paths);
  }
  expect(new Set(duplicatePaths)).toEqual(new Set(expectedPaths));
  await expect(trackModalActions.trackModal.duplicateSourceTabs).toHaveCount(2);
  const initialIndex = /\bis-active\b/u.test(await trackModalActions.trackModal.duplicateSourceTabs.nth(1).getAttribute('class') || '') ? 1 : 0;
  const displayedPaths = [];
  for (let index = 0; index < 2; index += 1) {
    await trackModalActions.trackModal.duplicateSourceTabs.nth(index).click();
    await expect(trackModalActions.trackModal.duplicateSourceTabs.nth(index)).toHaveClass(/\bis-active\b/u);
    await trackModalActions.waitForLoadedSummary();
    await expect(trackModalActions.trackModal.trackRows).toHaveCount(4);
    const tracks = await Promise.all([0, 1, 2, 3].map(row => trackModalActions.readTrackAt(row)));
    const paths = tracks.map(track => track.path);
    expect(sources.some(source => source.every(expected => paths.includes(expected)))).toBe(true);
    for (const excluded of fixture.excludedPaths) expect(paths).not.toContain(excluded);
    displayedPaths.push(...paths);
  }
  expect(new Set(displayedPaths)).toEqual(new Set(expectedPaths));
  await trackModalActions.trackModal.duplicateSourceTabs.nth(initialIndex).click();
  await expect(trackModalActions.trackModal.duplicateSourceTabs.nth(initialIndex)).toHaveClass(/\bis-active\b/u);
  await trackModalActions.waitForLoadedSummary();
}
test.beforeEach(async ({ managedAppLifecycle, galleryActions, appBarActions }) => {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createAlbumSourceOwnershipFixture(`E2E Album Source Ownership ${randomUUID().replaceAll('-', '')}`);
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.afterEach(async ({ managedAppLifecycle, galleryActions, appBarActions }) => {
  try {
    if (ownedFixture) await removeAlbumSourceOwnershipFixture(ownedFixture);
    ownedFixture = null;
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
  } finally {
    ownedFixture = null;
    await managedAppLifecycle.stop();
    await managedAppLifecycle.restart();
  }
});

test('FTC-COVERS-025 a persisted inherited cover from a rejected mixed folder is repaired by a production rescan', { tag: '@area:cover-providers' }, async ({
  managedAppLifecycle, galleryActions, trackModalActions, coverLookupActions,
  appBarActions, page, stepLogger,
}) => {
  test.setTimeout(240000);
  const fixture = ownedFixture;
  const target = { artist: fixture.artist, album: fixture.album, year: fixture.year };
  let inherited;
  await stepLogger.step('Stage uniquely owned legacy cover metadata before application startup', async () => {
    await managedAppLifecycle.stop();
    try {
      inherited = await stageOwnedLegacyCoverContamination(fixture);
      expect(inherited.origin).toBe('user');
      expect(inherited.provenance).toBeNull();
      expect(inherited.coverPath).toBe(inherited.wrongCoverPath);
      expect(inherited.repairPrevious).toBeNull();
    } finally {
      await managedAppLifecycle.restart();
    }
  });
  await stepLogger.step('Repair the inherited selection through the normal full scan control', async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(fixture.artist)}`);
    await galleryActions.waitForGalleryReady();
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
  });
  const inspectRepair = async () => {
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
    await trackModalActions.waitForLoadedSummary();
    await expectCompleteSourceTracks(opened.album, fixture, trackModalActions);
    expect(opened.album.cover_selection_origin).toBe('automatic');
    expect(opened.album.local_cover_width).toBe(1600);
    expect(opened.album.local_cover_height).toBe(1600);
    expect(opened.album.cover_path).not.toBe(inherited.wrongCoverPath);
    const visibleCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage, 'repaired physical album artwork',
      { expectedCoverPath: opened.album.cover_path },
    );
    expect(visibleCover.coverPath).toBe(opened.album.cover_path);
    const persisted = await readOwnedLegacyCoverState(fixture);
    expect(persisted.coverPath).toBe(opened.album.cover_path);
    expect(persisted.origin).toBe('automatic');
    expect(persisted.repairPrevious).toEqual({
      cover_path: inherited.wrongCoverPath,
      cover_selection_origin: 'user',
      cover_revision: inherited.wrongRevision,
    });
    await trackModalActions.close();
  };
  await stepLogger.step('Display eligible album artwork and retain the persisted repair audit', inspectRepair);
  await stepLogger.step('Retain the repaired artwork after browser reload', async () => {
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await inspectRepair();
  });
});

test('FTC-ALBUM-DETAILS-023 mixed and orphan copies stay outside album details while CD siblings and complete album sources survive reload and rescan', { tag: '@area:album-details' }, async ({
  galleryActions, trackModalActions, navigationPanelActions, artistPageSettingsActions,
  utilityTabBarActions, utilityProblematicFilesActions, settingsModalAppBarActions, page, appBarActions, stepLogger,
}) => {
  test.setTimeout(240000);
  const fixture = ownedFixture;
  const target = { artist: fixture.artist, album: fixture.album, year: fixture.year };
  const inspectAlbum = async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(fixture.artist)}`);
    await galleryActions.waitForGalleryReady();
    const { album } = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
    const tracks = album.tracks || [];
    expect(tracks).toHaveLength(4);
    expect(new Set(tracks.map(track => track.disc_number))).toEqual(new Set([1, 2]));
    for (const excluded of fixture.excludedPaths) expect(tracks.map(track => track.path)).not.toContain(excluded);
    expect(album.local_cover_width).toBe(1600);
    expect(album.local_cover_height).toBe(1600);
    expect(album.cover_path).not.toContain('Random songs');
    await trackModalActions.waitForLoadedSummary();
    await expectCompleteSourceTracks(album, fixture, trackModalActions);
    await trackModalActions.close();
    return album;
  };
  await stepLogger.step('Read only complete physical album sources with both discs and correct cover', inspectAlbum);
  await stepLogger.step('Keep the complete tagged Deluxe edition separate from the original sources', async () => {
    const deluxe = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload({ ...target, year: '2027' });
    expect(deluxe.album.edition).toBe('Deluxe');
    expect(deluxe.album.tracks).toHaveLength(4);
    expect(new Set(deluxe.album.tracks.map(track => track.disc_number))).toEqual(new Set([1, 2]));
    for (const track of deluxe.album.tracks) expect(track.path).toMatch(/[\\/]Deluxe[\\/]CD[12][\\/]/u);
    await trackModalActions.waitForLoadedSummary();
    await expect(trackModalActions.trackModal.trackRows).toHaveCount(4);
    await trackModalActions.close();
  });
  await stepLogger.step('Keep rejected files accessible in Loose Tracks', async () => {
    await navigationPanelActions.selectSidebarArtistByName(fixture.artist);
    await navigationPanelActions.waitForSidebarSelection(fixture.artist);
    await artistPageSettingsActions.openNonAlbumTracks(3);
    await artistPageSettingsActions.expectNonAlbumTrackPaths(fixture.excludedPaths);
    await artistPageSettingsActions.closeNonAlbumTracks();
  });
  await stepLogger.step('Retain the orphan duplicates as repairable Problematic Files', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady();
    await utilityProblematicFilesActions.search(fixture.artist);
    await utilityProblematicFilesActions.waitForSearchResults(fixture.artist);
    await utilityProblematicFilesActions.selectAlbumByTitle(fixture.album);
    const rows = await utilityProblematicFilesActions.readDetectedTrackRows();
    for (const excluded of fixture.excludedPaths.filter(value => value.endsWith('copied-song.mp3'))) {
      const row = rows.find(value => value.path === excluded);
      expect(row, `missing duplicate problem for ${excluded}`).toBeTruthy();
      expect(row.reasons.some(reason => /duplicate/iu.test(reason))).toBe(true);
    }
  });
  await stepLogger.step('Preserve membership after browser reload', async () => { await page.reload(); await inspectAlbum(); });
  await stepLogger.step('Reconstruct the same membership after a full physical rescan', async () => {
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
    await inspectAlbum();
  });
});

test('FTC-COVERS-026 an explicit adequate local cover remains user-owned and makes no automatic provider queries after reload and rescan', { tag: '@area:cover-providers' }, async ({
  galleryActions, trackModalActions, coverLookupActions, page, appBarActions, stepLogger, thirdPartyRequestEvidence,
}) => {
  test.setTimeout(240000);
  const fixture = ownedFixture;
  const target = { artist: fixture.artist, album: fixture.album, year: fixture.year };
  let saved;
  let displayedBaseline;
  await stepLogger.step('Select generated high resolution artwork through the real gallery Save flow', async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(fixture.artist)}`);
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity(target);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    saved = await coverLookupActions.selectLocalCoverByNameAndSave('manual-choice.png');
    expect(saved.updatedAlbum.cover_selection_origin).toBe('user');
    await trackModalActions.close();
    await page.reload();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
    expect(opened.album.cover_selection_origin).toBe('user');
    expect(opened.album.cover_path).toBe(saved.selectedCoverPath);
    expect(opened.album.cover_revision).toBe(saved.updatedAlbum.cover_revision);
    displayedBaseline = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage, 'settled explicit selection before rescan',
      { expectedCoverPath: opened.album.cover_path, expectedCoverRevision: opened.album.cover_revision },
    );
    const fullSize = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: opened.album.cover_path, coverRevision: opened.album.cover_revision,
      label: 'explicit selection source before rescan',
    });
    expect(fullSize.sha256).toBe(saved.candidateFullSize.sha256);
    expect((await readOwnedLegacyCoverState(fixture)).provenance).toBe('explicit');
    await trackModalActions.close();
  });
  await stepLogger.step('Skip provider work and preserve the saved bytes through two rescans and reload', async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      await coverLookupActions.resetProviderFixtureEvidence();
      await appBarActions.triggerFullRescanAndWait();
      await appBarActions.waitForScanAndCoverRefreshIdle();
      await page.reload();
      await galleryActions.waitForGalleryReady();
      const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
      expect(opened.album.cover_selection_origin).toBe('user');
      expect(opened.album.cover_path).toBe(saved.selectedCoverPath);
      expect(opened.album.cover_revision).toBe(saved.updatedAlbum.cover_revision);
      const image = await coverLookupActions.readDisplayedImageEvidence(trackModalActions.trackModal.detailedCoverImage,
        'explicit selection after physical rescan', { expectedCoverPath: opened.album.cover_path, expectedCoverRevision: opened.album.cover_revision });
      expect(image.sha256).toBe(displayedBaseline.sha256);
      const fullSize = await coverLookupActions.readFullSizeCoverEvidence({
        coverPath: opened.album.cover_path, coverRevision: opened.album.cover_revision,
        label: 'explicit selection source after rescan',
      });
      expect(fullSize.sha256).toBe(saved.candidateFullSize.sha256);
      expect((await readOwnedLegacyCoverState(fixture)).provenance).toBe('explicit');
      const evidence = await coverLookupActions.readProviderFixtureEvidence();
      expect((evidence.apple_search_terms || []).some(term => String(term).includes(fixture.artist))).toBe(false);
      await trackModalActions.waitForCoverLookupImprovementIndicator(false);
      await trackModalActions.close();
    }
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-027 poor legacy in-folder user cover upgrades to different adequate artwork on automatic search', { tag: '@area:cover-providers' }, async ({
  managedAppLifecycle, galleryActions, trackModalActions, coverLookupActions,
  appBarActions, page, stepLogger, thirdPartyRequestEvidence,
}, testInfo) => {
  test.setTimeout(240000);
  expect(process.env.ALBUM_HAVEN_COVER_REPAIR_MIN_EDGE,
    'Run this repair acceptance case with the isolated application minimum set to 2000').toBe('2000');
  const fixture = ownedFixture;
  const target = { artist: fixture.artist, album: fixture.album, year: fixture.year };
  let inherited;
  let baselineImage;
  await stepLogger.step('Stage legacy user ownership of correctly located undersized artwork while the application is stopped', async () => {
    await managedAppLifecycle.stop();
    try {
      inherited = await stageOwnedLegacyInFolderCover(fixture);
      expect(inherited.origin).toBe('user');
      expect(inherited.provenance).toBeNull();
    } finally {
      await managedAppLifecycle.restart();
    }
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(fixture.artist)}`);
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
    expect(opened.album.local_cover_width).toBe(1600);
    expect(opened.album.local_cover_height).toBe(1600);
    baselineImage = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage, 'undersized legacy artwork',
      { expectedCoverPath: inherited.coverPath, expectedCoverRevision: inherited.wrongRevision },
    );
    await trackModalActions.close();
  });
  try {
    await stepLogger.step('Search through the normal scan control using adequate different artwork from the owned provider fixture', async () => {
      await setOwnedLegacyCoverRepairProvider(testInfo, target);
      await coverLookupActions.resetProviderFixtureEvidence();
      await appBarActions.triggerIncrementalScanAndWait();
      await coverLookupActions.waitForAutomaticProviderSearch(target);
      await appBarActions.waitForScanAndCoverRefreshIdle();
    });
    const inspectReplacement = async () => {
      const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(target);
      expect(opened.album.cover_selection_origin).toBe('automatic');
      expect(opened.album.cover_revision).not.toBe(inherited.wrongRevision);
      expect(opened.album.local_cover_width).toBeGreaterThanOrEqual(2000);
      expect(opened.album.local_cover_height).toBeGreaterThanOrEqual(2000);
      const image = await coverLookupActions.readDisplayedImageEvidence(
        trackModalActions.trackModal.detailedCoverImage, 'automatic adequate legacy replacement',
        { expectedCoverPath: opened.album.cover_path, expectedCoverRevision: opened.album.cover_revision },
      );
      expect(image.sha256).not.toBe(baselineImage.sha256);
      const persisted = await readOwnedLegacyCoverState(fixture);
      expect(persisted.origin).toBe('automatic');
      expect(persisted.coverPath).toBe(opened.album.cover_path);
      await trackModalActions.waitForCoverLookupImprovementIndicator(false);
      await trackModalActions.close();
    };
    await stepLogger.step('Display and persist the replacement instead of leaving a suggestion', inspectReplacement);
    await stepLogger.step('Preserve the replacement after browser reload', async () => {
      await page.reload();
      await galleryActions.waitForGalleryReady();
      await inspectReplacement();
    });
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  } finally {
    await coverLookupActions.setProviderFixtureMode('normal');
  }
});
