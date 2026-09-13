import { expect, test } from '../support/baseFixtures.js';
import {
  expectPostgresBrowse,
  expectStartupProjectionRebuilt,
} from '../helpers/artistAliasParityHelpers.js';

const COMPILATION_LEAD = 'Compilation Signal Lead';
const COMPILATION_GUEST = 'Compilation Signal Guest';
const COMPILATION_OWNER = 'Compilation Signal Lead / Compilation Signal Guest';
const COMPILATION_LEAD_SOLO = 'Compilation Lead Solo';
const COMPILATION_GUEST_SOLO = 'Compilation Guest Solo';
const CONTROL_LEAD = 'Control Signal Lead';
const CONTROL_PARTNER = 'Control Signal Partner';
const CONTROL_OWNER = 'Control Signal Lead / Control Signal Partner';
const CONTROL_LEAD_SOLO = 'Control Lead Solo';
const CONTROL_PARTNER_SOLO = 'Control Partner Solo';
const CONTROL_SHARED_ALBUM = 'Non-Compilation Cross-Credits';
const SOUNDTRACK_LEAD = 'Sia';
const SOUNDTRACK_GUEST = 'Soundtrack Signal Guest';
const SOUNDTRACK_OWNER = 'Sia / Soundtrack Signal Guest';
const SOUNDTRACK_LEAD_SOLO = 'Sia Soundtrack Solo';

test('FTC-ALBUM-DETAILS-021 and FTC-ARTIST-FAMILY-019 preserve featured track credits without guest album leakage', { tag: '@area:gallery-search' }, async ({
  artistFamilyActions, galleryActions, navigationPanelActions, page,
  searchToolbarActions, stepLogger, tagEditorActions, trackModalActions,
}) => {
  const filenames = ['01 - Track 1.mp3', '02 - Track 2.mp3', '03 - Track 3.mp3'];
  const editedArtists = [CONTROL_OWNER, `${CONTROL_LEAD}, ${CONTROL_PARTNER}`, 'Independent Credit Voice'];
  let originalCredits = [];
  let saveMayHaveStarted = false;
  const ownedAlbum = { artist: CONTROL_LEAD, album: CONTROL_LEAD_SOLO, year: '2026', searchToolbarActions, trackModalActions };
  const partnerScope = { primaryArtist: CONTROL_LEAD, memberArtist: CONTROL_PARTNER,
    ownedAlbum: CONTROL_PARTNER_SOLO, excludedAlbum: CONTROL_LEAD_SOLO, galleryActions, navigationPanelActions };
  try {
    await stepLogger.step('Edit three owned generated credits through the shared tag editor', async () => {
      await galleryActions.openSearchedAlbumDetails(ownedAlbum);
      originalCredits = await trackModalActions.readTrackCredits(3);
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 18 });
      for (let index = 0; index < filenames.length; index += 1) {
        await tagEditorActions.selectTrackByFilename(filenames[index]);
        await tagEditorActions.setArtist(editedArtists[index]);
      }
      saveMayHaveStarted = true;
      await tagEditorActions.applyAndWaitForSavedFiles();
      await searchToolbarActions.waitForQuery(CONTROL_LEAD_SOLO);
    });
    await stepLogger.step('Reload and retain raw credits while distinguishing guests, comma names, and another primary artist', async () => {
      await page.reload();
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.waitForQuery(CONTROL_LEAD_SOLO);
      await galleryActions.selectAlbumDetailsByIdentity({ artist: CONTROL_LEAD, album: CONTROL_LEAD_SOLO, year: '2026' });
      await trackModalActions.waitForInteractiveSummary();
      expect(await trackModalActions.readTrackCredits(3)).toEqual(originalCredits.map((credit, index) => ({
        ...credit, rawArtist: editedArtists[index],
        secondaryArtist: index === 0 ? `feat. ${CONTROL_PARTNER}` : editedArtists[index],
      })));
      await trackModalActions.close();
    });
    await stepLogger.step('Keep guest-only foreign albums out of the partner family while preserving genuine owned and shared releases', async () => {
      await searchToolbarActions.clearSearch({ submitWithEnter: true });
      await searchToolbarActions.waitForQuery('');
      await artistFamilyActions.selectMemberAndVerifyAlbumScope(partnerScope);
      await artistFamilyActions.selectOnlyChipByName(CONTROL_OWNER);
      await galleryActions.scrollToAlbumUnderHeading(CONTROL_OWNER, CONTROL_SHARED_ALBUM);
      await galleryActions.waitForAlbumVisibleUnderHeading(CONTROL_OWNER, CONTROL_SHARED_ALBUM);
      await searchToolbarActions.search(CONTROL_PARTNER, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(CONTROL_PARTNER);
      await artistFamilyActions.selectMemberAndVerifyAlbumScope({ ...partnerScope, query: CONTROL_PARTNER });
    });
  } finally {
    if (saveMayHaveStarted) {
      await stepLogger.step('Restore and verify all three owned Artist values through the UI', async () => {
        await galleryActions.openSearchedAlbumDetails(ownedAlbum);
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: 18 });
        for (let index = 0; index < filenames.length; index += 1) {
          await tagEditorActions.selectTrackByFilename(filenames[index]);
          await tagEditorActions.setArtist(originalCredits[index].rawArtist);
        }
        await tagEditorActions.applyAndWaitForSavedFiles();
        await searchToolbarActions.waitForQuery(CONTROL_LEAD_SOLO);
        await page.reload();
        await galleryActions.waitForGalleryReady();
        await searchToolbarActions.waitForQuery(CONTROL_LEAD_SOLO);
        await galleryActions.selectAlbumDetailsByIdentity({ artist: CONTROL_LEAD, album: CONTROL_LEAD_SOLO, year: '2026' });
        await trackModalActions.waitForInteractiveSummary();
        expect(await trackModalActions.readTrackCredits(3)).toEqual(originalCredits);
        await trackModalActions.close();
      });
    }
  }
});

test('FTC-ARTIST-FAMILY-015 excludes compilation track credits from family relations while keeping ordinary shared releases related', { tag: '@area:gallery-search' }, async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  startupRelationProjectionReadiness,
  stepLogger,
}) => {
  await stepLogger.step('Open the production app after startup builds the Postgres relation projection', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    expectStartupProjectionRebuilt(expect, startupRelationProjectionReadiness);
    await expectPostgresBrowse(expect, galleryActions);
    expect(await navigationPanelActions.readSidebarArtistNameCount(COMPILATION_LEAD)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(COMPILATION_GUEST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(CONTROL_LEAD)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(CONTROL_PARTNER)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(SOUNDTRACK_LEAD)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(SOUNDTRACK_GUEST)).toBe(1);
  });

  await stepLogger.step('Select one compilation member without inheriting the other member as family', async () => {
    await navigationPanelActions.selectSidebarArtistByName(COMPILATION_LEAD);
    await navigationPanelActions.waitForSidebarSelection(COMPILATION_LEAD);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      COMPILATION_LEAD,
      COMPILATION_LEAD_SOLO,
    );
    const familyPanel = await artistFamilyActions.readPanelState();
    expect(familyPanel.chipTexts).not.toContain(COMPILATION_GUEST);
    expect(familyPanel.chipTexts).not.toContain(COMPILATION_OWNER);
    const artistHeadings = await galleryActions.readArtistHeadings();
    expect(artistHeadings).not.toContain(COMPILATION_GUEST);
    expect(artistHeadings).not.toContain(COMPILATION_OWNER);
  });

  await stepLogger.step('Open the second compilation member through the normal sidebar', async () => {
    await navigationPanelActions.selectSidebarArtistByName(COMPILATION_GUEST);
    await navigationPanelActions.waitForSidebarSelection(COMPILATION_GUEST);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      COMPILATION_GUEST,
      COMPILATION_GUEST_SOLO,
    );
    const familyPanel = await artistFamilyActions.readPanelState();
    expect(familyPanel.chipTexts).not.toContain(COMPILATION_LEAD);
    expect(familyPanel.chipTexts).not.toContain(COMPILATION_OWNER);
    const artistHeadings = await galleryActions.readArtistHeadings();
    expect(artistHeadings).not.toContain(COMPILATION_LEAD);
    expect(artistHeadings).not.toContain(COMPILATION_OWNER);
  });

  await stepLogger.step('Keep a separate non-compilation shared release in Artist Family', async () => {
    await navigationPanelActions.selectSidebarArtistByName(CONTROL_LEAD);
    await navigationPanelActions.waitForSidebarSelection(CONTROL_LEAD);
    await artistFamilyActions.waitForViewReady(CONTROL_LEAD);
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(CONTROL_LEAD);
    const familyChips = await artistFamilyActions.readChipTexts();
    expect([...familyChips].sort()).toEqual(
      [CONTROL_LEAD, CONTROL_PARTNER, CONTROL_OWNER].sort(),
    );
    await galleryActions.waitForAlbumVisibleUnderHeading(CONTROL_LEAD, CONTROL_LEAD_SOLO);
    await galleryActions.scrollToAlbumUnderHeading(
      CONTROL_PARTNER,
      CONTROL_PARTNER_SOLO,
    );
    await galleryActions.waitForAlbumVisibleUnderHeading(
      CONTROL_PARTNER,
      CONTROL_PARTNER_SOLO,
    );
    expect(await galleryActions.readArtistHeadings()).toEqual(
      expect.arrayContaining([CONTROL_LEAD, CONTROL_PARTNER]),
    );
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Exclude Soundtracks and OST folder evidence', async () => {
    await navigationPanelActions.selectSidebarArtistByName(SOUNDTRACK_LEAD);
    await navigationPanelActions.waitForSidebarSelection(SOUNDTRACK_LEAD);
    await galleryActions.waitForAlbumVisibleUnderHeading(SOUNDTRACK_LEAD, SOUNDTRACK_LEAD_SOLO);
    const familyPanel = await artistFamilyActions.readPanelState();
    expect(familyPanel.chipTexts).not.toContain(SOUNDTRACK_GUEST);
    expect(familyPanel.chipTexts).not.toContain(SOUNDTRACK_OWNER);
  });

  await stepLogger.step('Require every emitted family pill to resolve a contributing album', async () => {
    await navigationPanelActions.selectSidebarArtistByName(CONTROL_LEAD);
    await navigationPanelActions.waitForSidebarSelection(CONTROL_LEAD);
    await artistFamilyActions.waitForViewReady(CONTROL_LEAD);
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(CONTROL_LEAD);
    expect([...(await artistFamilyActions.readChipTexts())].sort()).toEqual(
      [CONTROL_LEAD, CONTROL_PARTNER, CONTROL_OWNER].sort(),
    );
    for (const [familyArtist, expectedAlbum] of [
      [CONTROL_LEAD, CONTROL_LEAD_SOLO],
      [CONTROL_PARTNER, CONTROL_PARTNER_SOLO],
      [CONTROL_OWNER, CONTROL_SHARED_ALBUM],
    ]) {
      await artistFamilyActions.selectOnlyChipByName(familyArtist);
      await galleryActions.scrollToAlbumUnderHeading(familyArtist, expectedAlbum);
      await galleryActions.waitForAlbumVisibleUnderHeading(familyArtist, expectedAlbum);
      const visibleAlbums = await galleryActions.readAlbumNamesByHeading(familyArtist);
      expect(visibleAlbums.length, `${familyArtist} must own an album in the selected family payload`).toBeGreaterThan(0);
    }
  });
});

test('FTC-ARTIST-FAMILY-016 reuses complete virtualized family data for no-query member navigation', { tag: '@area:gallery-search' }, async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  stepLogger,
}) => {
  let initialHeadings = [];

  await stepLogger.step('Open the complete unfiltered ordinary family with viewport virtualization', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(CONTROL_LEAD);
    await navigationPanelActions.waitForSidebarSelection(CONTROL_LEAD);
    await artistFamilyActions.waitForViewReady(CONTROL_LEAD);
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(CONTROL_LEAD);
    initialHeadings = await galleryActions.readArtistHeadings();
    expect(initialHeadings[0]).toBe(CONTROL_LEAD);
  });

  await stepLogger.step('Promote another family member locally without a loading transition', async () => {
    const transition = await navigationPanelActions
      .selectMountedFamilyArtistAndObserveTransition(CONTROL_PARTNER);

    expect(transition.viewDataRequests).toEqual([]);
    expect(transition.loadingScreenActivated).toBe(false);
    expect(transition.loaderSpinnerActivated).toBe(false);
    expect(transition.galleryChildrenReplaced).toBe(false);
    expect(transition.galleryCleared).toBe(false);
    expect(transition.galleryReplaced).toBe(false);
    expect(transition.pendingSelectedArtistReconcile).toBe(false);
    expect(transition.pendingViewTransition).toBe(false);
    expect(transition.activeViewRequestUrl).toBe('');
    expect(transition.query).toBe('');
    expect(transition.locationHasQuery).toBe(false);
    expect(transition.locationArtist).toBe(CONTROL_PARTNER);
    expect(transition.selectedArtist).toBe(CONTROL_PARTNER);
    expect(transition.primaryGroupNames).toEqual([CONTROL_PARTNER]);
    expect([...transition.familyGroupNames].sort()).toEqual(
      [CONTROL_LEAD, CONTROL_OWNER].sort(),
    );
    expect(transition.visibleGroupNames[0]).toBe(CONTROL_PARTNER);
    expect(transition.visibleGroupNames).not.toEqual(initialHeadings);
  });

  await stepLogger.step('Keep the rearranged primary and virtualized family albums reachable', async () => {
    await navigationPanelActions.waitForSidebarSelection(CONTROL_PARTNER);
    await artistFamilyActions.waitForPrimaryChipActive(CONTROL_PARTNER);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      CONTROL_PARTNER,
      CONTROL_PARTNER_SOLO,
    );
    await galleryActions.scrollToAlbumUnderHeading(
      CONTROL_LEAD,
      CONTROL_LEAD_SOLO,
    );
    await galleryActions.waitForAlbumVisibleUnderHeading(
      CONTROL_LEAD,
      CONTROL_LEAD_SOLO,
    );
    await galleryActions.scrollToAlbumUnderHeading(
      CONTROL_OWNER,
      CONTROL_SHARED_ALBUM,
    );
    await galleryActions.waitForAlbumVisibleUnderHeading(
      CONTROL_OWNER,
      CONTROL_SHARED_ALBUM,
    );
  });
});
