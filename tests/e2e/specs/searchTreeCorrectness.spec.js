import { expect, test } from '../support/baseFixtures.js';
import {
  WHITESPACE_DISPLAY_ARTIST,
  WHITESPACE_SEARCH_ARTIST,
} from '../helpers/artistAliasParityHelpers.js';
import {
  waitForPositiveLogicalAlbumTrackCounts,
} from '../helpers/rendererReconciliationHelpers.js';

const ONE_FAMILY_QUERY = 'The Neal Morse Band';
const DIRECT_LOADED_URL = `/?surface=albums&q=${encodeURIComponent(WHITESPACE_SEARCH_ARTIST)}&artist=${encodeURIComponent(WHITESPACE_DISPLAY_ARTIST)}&category=main_library`;
const FAMILY_ARTIST = 'Neal Morse';
const DEEP_LINK_QUERY = 'neal morse';
const DEEP_LINK_SCOPE_URL = '/?surface=albums&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals';
const DEEP_LINK_SELECTED_URL = `/?surface=albums&artist=${encodeURIComponent(FAMILY_ARTIST)}&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals`;
const DEEP_LINK_URL = `/?surface=albums&q=${encodeURIComponent(DEEP_LINK_QUERY)}&artist=${encodeURIComponent(FAMILY_ARTIST)}&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals`;
const RESONANCE_ARTIST = 'Neal Morse & The Resonance';
const EXPECTED_NEAL_FAMILY_ARTISTS = [
  FAMILY_ARTIST,
  'The Neal Morse Band',
  RESONANCE_ARTIST,
];
const FLOWER_KINGS_QUERY = 'flower kings';
const FLOWER_KINGS_ARTIST = 'The Flower Kings';
const EXPECTED_FLOWER_KINGS_SIDEBAR_ARTISTS = [
  'Agents Of Mercy',
  'Roine Stolt',
  FLOWER_KINGS_ARTIST,
];
const UNRELATED_ARTIST = 'Album Haven Last.fm Fixture';
const RECENT_SEARCH_QUERY = 'Joseph';
const NO_MATCH_QUERY = 'Album Haven deterministic no-match 7f4c29';
const DIRECT_COUNT_ARTIST = 'ДДТ';
const DIRECT_COUNT_ALBUM = 'Студийные записи';
const DIRECT_COUNT_YEAR = '1999';
const DIRECT_COUNT_TRACKS = 16;
const DIRECT_COUNT_ALBUMS = 60;
const DIRECT_COUNT_SELECTED_URL = `/?surface=albums&artist=${encodeURIComponent(DIRECT_COUNT_ARTIST)}`;
const DIRECT_COUNT_SEARCH_URL = `/?surface=albums&q=${encodeURIComponent(DIRECT_COUNT_ARTIST)}&artist=${encodeURIComponent(DIRECT_COUNT_ARTIST)}`;

test('FTC-SEARCH-NAV-027 keeps canonical positive card counts on direct load and reload', async ({
  freshBrowserSession,
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  testArtifacts,
  trackModalActions,
}) => {
  const observations = [];
  const surfaces = [
    ['selected-artist', DIRECT_COUNT_SELECTED_URL, '', {
      galleryActions,
      page,
      searchToolbarActions,
      trackModalActions,
    }],
    ['search-results', DIRECT_COUNT_SEARCH_URL, DIRECT_COUNT_ARTIST, null],
  ];
  for (const [surface, url, queryValue, existingSession] of surfaces) {
    await stepLogger.step(`Direct-load and reload the ${surface} gallery in a fresh browser`, async () => {
      const session = existingSession || await freshBrowserSession.create();
      await session.galleryActions.goto(url);
      await session.galleryActions.waitForGalleryReady();
      await session.galleryActions.waitForSelectedArtistGallery(DIRECT_COUNT_ARTIST, {
        queryValue,
      });
      observations.push({
        phase: `${surface}-direct`,
        inventory: await waitForPositiveLogicalAlbumTrackCounts({
          artist: DIRECT_COUNT_ARTIST,
          expectedAlbum: {
            artist: DIRECT_COUNT_ARTIST,
            album: DIRECT_COUNT_ALBUM,
            year: DIRECT_COUNT_YEAR,
            trackCount: DIRECT_COUNT_TRACKS,
          },
          expectedLogicalCount: DIRECT_COUNT_ALBUMS,
          galleryActions: session.galleryActions,
          page: session.page,
        }),
      });

      await session.searchToolbarActions.reloadCurrentView();
      await session.galleryActions.waitForGalleryReady();
      await session.galleryActions.waitForSelectedArtistGallery(DIRECT_COUNT_ARTIST, {
        queryValue,
      });
      observations.push({
        phase: `${surface}-reload`,
        inventory: await waitForPositiveLogicalAlbumTrackCounts({
          artist: DIRECT_COUNT_ARTIST,
          expectedAlbum: {
            artist: DIRECT_COUNT_ARTIST,
            album: DIRECT_COUNT_ALBUM,
            year: DIRECT_COUNT_YEAR,
            trackCount: DIRECT_COUNT_TRACKS,
          },
          expectedLogicalCount: DIRECT_COUNT_ALBUMS,
          galleryActions: session.galleryActions,
          page: session.page,
        }),
      });

      await session.galleryActions.selectAlbumDetailsByIdentity({
        artist: DIRECT_COUNT_ARTIST,
        album: DIRECT_COUNT_ALBUM,
        year: DIRECT_COUNT_YEAR,
      });
      expect(
        (await session.trackModalActions.waitForInteractiveSummary()).trackRows,
      ).toBe(DIRECT_COUNT_TRACKS);
    });
  }
  testArtifacts.queueJsonAttachment('ftc-search-nav-027-card-counts', observations);
});

test('FTC-SEARCH-NAV-002 keeps every projected family artist in the tree for a non-exact best match', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Search without the leading article and auto-select The Flower Kings', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.moveSidebarArtistOutsideViewport(FLOWER_KINGS_ARTIST);
    await searchToolbarActions.search(FLOWER_KINGS_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(FLOWER_KINGS_QUERY);
    await navigationPanelActions.waitForSidebarSelection(FLOWER_KINGS_ARTIST);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(FLOWER_KINGS_ARTIST, {
      queryValue: FLOWER_KINGS_QUERY,
    });
  });

  await stepLogger.step('Render the complete projected family tree in stable order', async () => {
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    await navigationPanelActions.waitForSidebarArtistNames(
      EXPECTED_FLOWER_KINGS_SIDEBAR_ARTISTS,
    );
    expect(await navigationPanelActions.readSidebarArtistNames()).toEqual(
      EXPECTED_FLOWER_KINGS_SIDEBAR_ARTISTS,
    );
    expect(await navigationPanelActions.readSidebarArtistCount()).toBe(
      EXPECTED_FLOWER_KINGS_SIDEBAR_ARTISTS.length,
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(
      FLOWER_KINGS_ARTIST,
    );
  });

  await stepLogger.step('Keep the selected gallery and Artist Family context aligned with the complete tree', async () => {
    await artistFamilyActions.waitForViewReady(FLOWER_KINGS_ARTIST, {
      queryValue: FLOWER_KINGS_QUERY,
    });
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(FLOWER_KINGS_ARTIST);
    expect(
      (await artistFamilyActions.readChipTexts())
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right, 'en', {
          numeric: true,
          sensitivity: 'base',
        })),
    ).toEqual(EXPECTED_FLOWER_KINGS_SIDEBAR_ARTISTS);
    expect(await galleryActions.readAlbumNamesByHeading(FLOWER_KINGS_ARTIST))
      .not.toHaveLength(0);
  });
});

test('FTC-SEARCH-NAV-026 clears Neal Morse search without remounting the selected gallery or family filters and restores the full tree', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  const rootArtistNames = await stepLogger.step('Capture the complete pre-search artist tree', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    const names = await navigationPanelActions.readSidebarArtistNames();
    expect(names.length).toBeGreaterThan(EXPECTED_NEAL_FAMILY_ARTISTS.length);
    return names;
  });

  await stepLogger.step('Search for Neal Morse and retain its automatic strongest-match selection', async () => {
    await searchToolbarActions.search(FAMILY_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(FAMILY_ARTIST);
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: FAMILY_ARTIST,
    });
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST, {
      queryValue: FAMILY_ARTIST,
    });
    await artistFamilyActions.waitForVisible();
    const searchedArtistNames = await navigationPanelActions.readSidebarArtistNames();
    expect(searchedArtistNames).toEqual(expect.arrayContaining(EXPECTED_NEAL_FAMILY_ARTISTS));
    expect(searchedArtistNames).not.toEqual(rootArtistNames);
  });

  await stepLogger.step('Clear with the search control while preserving the mounted gallery and family filters', async () => {
    const mountedAlbumNames = await galleryActions.readAlbumNamesByHeading(FAMILY_ARTIST);
    expect(mountedAlbumNames.length).toBeGreaterThan(0);
    await galleryActions.prepareMountedGalleryContinuityCheckpoint({
      minimumDecodedCovers: 1,
    });
    const transition = await searchToolbarActions.clearSearchAndObserveStableGallery();
    expect(transition).toEqual(expect.objectContaining({
      cardContentChanged: false,
      cardNodesChanged: false,
      familyChipContentChanged: false,
      familyChipNodesChanged: false,
      familyControlsHidden: false,
      familyListReplaced: false,
      familyMutationCount: 0,
      familyPanelContentChanged: false,
      familyPanelReplaced: false,
      familyScrollChanged: false,
      familySelectionChanged: false,
      familyToggleReplaced: false,
      familyViewDataRequests: [],
      galleryContentChanged: false,
      galleryReplaced: false,
      galleryScrollChanged: false,
      loaderActivated: false,
      spinnerActivated: false,
      viewDataRequests: [],
    }));
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootArtistNames);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST);
    await artistFamilyActions.waitForVisible();
  });
});

test('FTC-SEARCH-NAV-002, FTC-SEARCH-NAV-003, and FTC-SEARCH-NAV-026 keep one-family search narrow, alphabetical, and selected through full-tree restoration', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  const rootSnapshot = await stepLogger.step('Open the canonical root and capture its complete artist context', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    const names = await navigationPanelActions.readSidebarArtistNames();
    const count = await navigationPanelActions.readAllArtistsVisibleCount();
    expect(names.length).toBeGreaterThan(1);
    expect(count).toBe(names.length);
    return { names, count };
  });

  await stepLogger.step('Search for one exact artist inside one family', async () => {
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
  });

  await stepLogger.step('Keep the best match and its gallery selected without showing a misleading All artists row', async () => {
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(ONE_FAMILY_QUERY);
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY, {
      queryValue: ONE_FAMILY_QUERY,
    });
    const headings = (await galleryActions.readArtistHeadings())
      .map((heading) => String(heading || '').trim())
      .filter(Boolean);
    const albums = await galleryActions.readAlbumNamesByHeading(ONE_FAMILY_QUERY);
    expect(headings).toContain(ONE_FAMILY_QUERY);
    expect(albums.length).toBeGreaterThan(0);
  });

  await stepLogger.step('Display the one-family search tree alphabetically instead of relevance order', async () => {
    const alphabeticalState = await navigationPanelActions.readSidebarAlphabeticalState();
    expect(alphabeticalState.displayedNames.length).toBeGreaterThan(1);
    expect(alphabeticalState.displayedNames).toEqual(alphabeticalState.alphabeticalNames);
  });

  await stepLogger.step('Clear the query while retaining the best-match selection and gallery in the restored full tree', async () => {
    await artistFamilyActions.waitForViewReady(ONE_FAMILY_QUERY, {
      queryValue: ONE_FAMILY_QUERY,
    });
    await artistFamilyActions.waitForVisible();
    await galleryActions.prepareMountedGalleryContinuityCheckpoint({
      minimumDecodedCovers: 1,
    });
    const mountedAlbumNames = await galleryActions.readAlbumNamesByHeading(
      ONE_FAMILY_QUERY,
    );
    expect(mountedAlbumNames.length).toBeGreaterThan(0);
    const transition = await searchToolbarActions.clearSearchAndObserveStableGallery({
      submitWithEnter: true,
    });
    expect(transition).toEqual(expect.objectContaining({
      galleryContentChanged: false,
      galleryReplaced: false,
      familyChipContentChanged: false,
      familyChipNodesChanged: false,
      familyControlsHidden: false,
      familyListReplaced: false,
      familyMutationCount: 0,
      familyPanelContentChanged: false,
      familyPanelReplaced: false,
      familyScrollChanged: false,
      familySelectionChanged: false,
      familyToggleReplaced: false,
      familyViewDataRequests: [],
      loaderActivated: false,
      spinnerActivated: false,
      viewDataRequests: [],
    }));
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootSnapshot.names);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY);
    expect(
      (await galleryActions.readArtistHeadings())
        .map((heading) => String(heading || '').trim())
        .filter(Boolean),
    ).toContain(ONE_FAMILY_QUERY);
    expect(await galleryActions.readAlbumNamesByHeading(ONE_FAMILY_QUERY)).toEqual(
      mountedAlbumNames,
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(ONE_FAMILY_QUERY);
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootSnapshot.count);
    expect(searchToolbarActions.readLocation().pathname).toBe('/');
  });

  await stepLogger.step('Repeat the search and explicitly select a different artist from the filtered tree', async () => {
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: ONE_FAMILY_QUERY,
    });
    const headings = (await galleryActions.readArtistHeadings())
      .map((heading) => String(heading || '').trim())
      .filter(Boolean);
    const albums = await galleryActions.readAlbumNamesByHeading(FAMILY_ARTIST);
    expect(headings).toContain(FAMILY_ARTIST);
    expect(albums.length).toBeGreaterThan(0);
  });

  await stepLogger.step('Reapply the same committed query with Enter and reselect its best match', async () => {
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY, {
      queryValue: ONE_FAMILY_QUERY,
    });
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(ONE_FAMILY_QUERY);
  });

  await stepLogger.step('Reapply the same committed query with Apply and reselect its best match', async () => {
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: ONE_FAMILY_QUERY,
    });
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { clickApply: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY, {
      queryValue: ONE_FAMILY_QUERY,
    });
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(ONE_FAMILY_QUERY);
  });

  await stepLogger.step('Restore the manual family selection before validating clear-search retention', async () => {
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: ONE_FAMILY_QUERY,
    });
  });

  await stepLogger.step('Clear the query while retaining the manually selected artist and gallery in the restored full tree', async () => {
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST, {
      queryValue: ONE_FAMILY_QUERY,
    });
    await artistFamilyActions.waitForVisible();
    const continuityCheckpoint = await galleryActions
      .prepareMountedGalleryContinuityCheckpoint({ minimumDecodedCovers: 1 });
    expect(continuityCheckpoint.decodedCoverCount).toBeGreaterThanOrEqual(1);
    expect(continuityCheckpoint.maxScrollTop).toBeGreaterThan(0);
    expect(continuityCheckpoint.scrollTop).toBeGreaterThan(0);
    const mountedAlbumNames = await galleryActions.readAlbumNamesByHeading(
      FAMILY_ARTIST,
    );
    expect(mountedAlbumNames.length).toBeGreaterThan(0);
    await searchToolbarActions.openRecentSearches();
    const transition = await searchToolbarActions.clearSearchAndObserveStableGallery({
      submitWithEnter: true,
    });
    expect(transition).toEqual(expect.objectContaining({
      cardContentChanged: false,
      cardNodesChanged: false,
      coverNodesChanged: false,
      coverStateChanged: false,
      decodedCoverCount: expect.any(Number),
      familyChipContentChanged: false,
      familyChipNodesChanged: false,
      familyControlsHidden: false,
      familyListReplaced: false,
      familyMutationCount: 0,
      familyPanelContentChanged: false,
      familyPanelReplaced: false,
      familyScrollChanged: false,
      familySelectionChanged: false,
      familyToggleReplaced: false,
      familyViewDataRequests: [],
      galleryReplaced: false,
      galleryReplacementMutationCount: 0,
      galleryScrollChanged: false,
      libraryLoaderMutationCount: 0,
      loaderActivated: false,
      recentSearchPopoverVisible: false,
      searchAriaExpanded: 'false',
      spinnerMutationCount: 0,
      spinnerActivated: false,
      viewDataRequests: [],
    }));
    expect(transition.decodedCoverCount).toBeGreaterThanOrEqual(1);
    expect(transition.galleryScrollTop).toBe(continuityCheckpoint.scrollTop);
    await searchToolbarActions.expectRecentSearchesDismissed();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootSnapshot.names);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST);
    expect(
      (await galleryActions.readArtistHeadings())
        .map((heading) => String(heading || '').trim())
        .filter(Boolean),
    ).toContain(FAMILY_ARTIST);
    expect(await galleryActions.readAlbumNamesByHeading(FAMILY_ARTIST)).toEqual(
      mountedAlbumNames,
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(FAMILY_ARTIST);
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootSnapshot.count);
  });

  await stepLogger.step('Settle a no-match search with no artist selection', async () => {
    await searchToolbarActions.search(NO_MATCH_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(NO_MATCH_QUERY);
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe('');
  });

  await stepLogger.step('Clear the no-selection search naturally and restore the nonempty canonical root at its top', async () => {
    await searchToolbarActions.openRecentSearches();
    await searchToolbarActions.clearSearchByInputDebounce();
    await searchToolbarActions.waitForDefaultRootUrl();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootSnapshot.names);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForGalleryScrollAtStart();
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe('');
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootSnapshot.count);
    expect(searchToolbarActions.readLocation()).toEqual({ pathname: '/', search: '' });
  });
});

test('FTC-SEARCH-NAV-026 keeps a cold direct-loaded selected gallery mounted through natural search clear', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Direct-load the selected family without first warming the root browse cache', async () => {
    await galleryActions.goto(DIRECT_LOADED_URL);
    await galleryActions.waitForGalleryReady({ minimumCards: 2 });
    await searchToolbarActions.waitForQuery(WHITESPACE_SEARCH_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(WHITESPACE_DISPLAY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(WHITESPACE_DISPLAY_ARTIST, {
      queryValue: WHITESPACE_SEARCH_ARTIST,
    });
    await artistFamilyActions.waitForViewReady(WHITESPACE_DISPLAY_ARTIST, {
      queryValue: WHITESPACE_SEARCH_ARTIST,
    });
    await artistFamilyActions.waitForVisible();
  });

  await stepLogger.step('Clear naturally while one root-sidebar request preserves the mounted gallery', async () => {
    const continuityCheckpoint = await galleryActions
      .prepareMountedGalleryContinuityCheckpoint({ minimumDecodedCovers: 1 });
    expect(continuityCheckpoint.scrollTop).toBeGreaterThan(0);
    const mountedAlbumNames = await galleryActions.readAlbumNamesByHeading(
      WHITESPACE_DISPLAY_ARTIST,
    );
    const transition = await searchToolbarActions.clearSearchAndObserveStableGallery({
      expectedViewDataRequestCount: 1,
    });
    expect(transition).toEqual(expect.objectContaining({
      cardContentChanged: false,
      cardNodesChanged: false,
      coverNodesChanged: false,
      coverStateChanged: false,
      familyChipContentChanged: false,
      familyChipNodesChanged: false,
      familyControlsHidden: false,
      familyControlsVisibleDuringActiveRequest: true,
      familyListReplaced: false,
      familyMutationCount: 0,
      familyPanelContentChanged: false,
      familyPanelReplaced: false,
      familyScrollChanged: false,
      familySelectionChanged: false,
      familyToggleReplaced: false,
      familyViewDataRequests: [],
      galleryReplaced: false,
      galleryScrollChanged: false,
      loaderActivated: false,
      spinnerActivated: false,
      viewDataRequests: [expect.any(String)],
    }));
    expect(transition.galleryScrollTop).toBe(continuityCheckpoint.scrollTop);
    const requestUrl = new URL(transition.viewDataRequests[0]);
    expect(requestUrl.pathname).toBe('/view-data');
    expect(requestUrl.searchParams.has('q')).toBe(false);
    expect(requestUrl.searchParams.get('payload_tier')).toBe('sidebar');
    expect(requestUrl.searchParams.has('artist')).toBe(false);
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarSelection(WHITESPACE_DISPLAY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(WHITESPACE_DISPLAY_ARTIST);
    expect(await galleryActions.readAlbumNamesByHeading(WHITESPACE_DISPLAY_ARTIST)).toEqual(
      mountedAlbumNames,
    );
    await artistFamilyActions.waitForViewReady(WHITESPACE_DISPLAY_ARTIST);
    await artistFamilyActions.waitForVisible();
  });
});

test('FTC-SEARCH-NAV-003 direct query links hydrate the same one-family tree as visible search', async ({
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  const directUrlTrees = await stepLogger.step('Capture the full root tree and the filtered Neal Morse tree produced by visible search', async () => {
    await galleryActions.goto(DEEP_LINK_SCOPE_URL);
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    const rootNames = await navigationPanelActions.readSidebarArtistNames();
    expect(rootNames.length).toBeGreaterThan(EXPECTED_NEAL_FAMILY_ARTISTS.length);
    await searchToolbarActions.search(DEEP_LINK_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(DEEP_LINK_QUERY);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });

    const filteredNames = await navigationPanelActions.readSidebarArtistNames();
    expect(filteredNames.length).toBeGreaterThan(1);
    expect(filteredNames).toEqual(expect.arrayContaining(EXPECTED_NEAL_FAMILY_ARTISTS));
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(FAMILY_ARTIST);
    return { filteredNames, rootNames };
  });

  await stepLogger.step('Open the selected-artist link without q and retain the full root tree', async () => {
    await galleryActions.goto(DEEP_LINK_SELECTED_URL);
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(directUrlTrees.rootNames);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST);
    expect(await searchToolbarActions.readCanonicalSearchState({
      source: 'bootstrap',
    })).toEqual(
      expect.objectContaining({
        query: '',
        searchContext: null,
        selectedArtist: FAMILY_ARTIST,
        sidebarArtists: directUrlTrees.rootNames,
      }),
    );
  });

  await stepLogger.step('Open the equivalent query link as a new document', async () => {
    await galleryActions.goto(DEEP_LINK_URL);
    await searchToolbarActions.waitForQuery(DEEP_LINK_QUERY);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    const canonicalState = await searchToolbarActions.readCanonicalSearchState({
      source: 'bootstrap',
    });
    expect(canonicalState.query).toBe(DEEP_LINK_QUERY);
    expect(canonicalState.selectedArtist).toBe(FAMILY_ARTIST);
    expect(canonicalState.searchContext).toEqual(expect.objectContaining({
      committed_query: DEEP_LINK_QUERY,
      selected_artist: FAMILY_ARTIST,
    }));
  });

  await stepLogger.step('Hydrate the exact manual-search family tree without a misleading All artists row', async () => {
    await navigationPanelActions.waitForSidebarArtistNames(directUrlTrees.filteredNames);
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    expect(await navigationPanelActions.readSidebarArtistNames()).toEqual(
      directUrlTrees.filteredNames,
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(FAMILY_ARTIST);
  });
});

test('FTC-SEARCH-NAV-004A keeps a clicked related-family artist selected as the primary artist', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Open the Neal Morse family search with Neal Morse as the initial primary artist', async () => {
    await galleryActions.goto(DEEP_LINK_SCOPE_URL);
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(DEEP_LINK_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(DEEP_LINK_QUERY);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await navigationPanelActions.waitForAllArtistsVisibility(false);
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(FAMILY_ARTIST);
    expect(await navigationPanelActions.readSidebarArtistNameCount(RESONANCE_ARTIST)).toBe(1);
  });

  let resonanceAlbumNames;
  await stepLogger.step('Make the clicked Resonance row the selected primary artist instead of reverting to Neal Morse', async () => {
    await navigationPanelActions.selectSidebarArtistByName(RESONANCE_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(RESONANCE_ARTIST);
    await artistFamilyActions.waitForViewReady(RESONANCE_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(RESONANCE_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(RESONANCE_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    resonanceAlbumNames = await galleryActions.readAlbumNamesByHeading(RESONANCE_ARTIST);
    expect(resonanceAlbumNames.length).toBeGreaterThan(0);
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(RESONANCE_ARTIST);
    expect(new URLSearchParams(searchToolbarActions.readLocation().search).get('artist')).toBe(
      RESONANCE_ARTIST,
    );
  });

  await stepLogger.step('Keep Resonance primary after server-authoritative reload hydration', async () => {
    await searchToolbarActions.reloadCurrentView();
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.waitForQuery(DEEP_LINK_QUERY);
    await navigationPanelActions.waitForSidebarSelection(RESONANCE_ARTIST);
    await artistFamilyActions.waitForViewReady(RESONANCE_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(RESONANCE_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(RESONANCE_ARTIST, {
      queryValue: DEEP_LINK_QUERY,
    });
    expect(await galleryActions.readAlbumNamesByHeading(RESONANCE_ARTIST)).toEqual(
      resonanceAlbumNames,
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(RESONANCE_ARTIST);
    const hydratedSearchParams = new URLSearchParams(searchToolbarActions.readLocation().search);
    expect(hydratedSearchParams.get('q')).toBe(DEEP_LINK_QUERY);
    expect(hydratedSearchParams.get('artist')).toBe(RESONANCE_ARTIST);
  });
});

test('FTC-SEARCH-NAV-004A and FTC-SEARCH-NAV-007A (BUG-06) hide stale Artist Family content while an unrelated artist selection loads', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Open a Neal-family artist through the production sidebar', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST);
    await artistFamilyActions.waitForVisible();
  });

  await stepLogger.step('Hide the mounted Neal-family panel immediately when a different search commits', async () => {
    await searchToolbarActions.search(UNRELATED_ARTIST, { submitWithEnter: true });
    expect(await artistFamilyActions.readPanelState()).toEqual({
      visible: false,
      chipTexts: [],
    });
    await searchToolbarActions.waitForQuery(UNRELATED_ARTIST);
    await galleryActions.waitForSelectedArtistGallery(UNRELATED_ARTIST, {
      queryValue: UNRELATED_ARTIST,
    });
  });

  await stepLogger.step('Restore the Neal-family starting point for the sidebar-navigation contract', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(FAMILY_ARTIST);
    await artistFamilyActions.waitForViewReady(FAMILY_ARTIST);
    await artistFamilyActions.waitForVisible();
  });

  await stepLogger.step('Hide the Neal-family panel immediately when an unrelated artist starts loading', async () => {
    await navigationPanelActions.selectSidebarArtistByName(UNRELATED_ARTIST);
    expect(await artistFamilyActions.readPanelState()).toEqual({
      visible: false,
      chipTexts: [],
    });
  });

  await stepLogger.step('Settle on the unrelated artist without restoring the stale family panel', async () => {
    await navigationPanelActions.waitForSidebarSelection(UNRELATED_ARTIST);
    await galleryActions.waitForOnlyArtistHeadings([UNRELATED_ARTIST]);
    await artistFamilyActions.waitForHidden();
    expect(await artistFamilyActions.readPanelState()).toEqual({
      visible: false,
      chipTexts: [],
    });
  });
});

test('FTC-SEARCH-NAV-003 accepts a new search from direct-loaded state and clearing restores the full tree while retaining selection', async ({
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
}) => {
  const rootSnapshot = await stepLogger.step('Capture the unfiltered main-library tree and All artists count', async () => {
    await galleryActions.goto('/?surface=albums&category=main_library');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    const names = await navigationPanelActions.readSidebarArtistNames();
    const count = await navigationPanelActions.readAllArtistsVisibleCount();
    expect(names.length).toBeGreaterThan(1);
    expect(count).toBe(names.length);
    return { names, count };
  });

  const directLoadedGallerySnapshot = await stepLogger.step('Direct-load query, artist, and category state and capture its selected gallery', async () => {
    await galleryActions.goto(DIRECT_LOADED_URL);
    await galleryActions.waitForGalleryReady({ minimumCards: 2 });
    await searchToolbarActions.waitForQuery(WHITESPACE_SEARCH_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(WHITESPACE_DISPLAY_ARTIST);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(WHITESPACE_DISPLAY_ARTIST, {
      queryValue: WHITESPACE_SEARCH_ARTIST,
    });
    const headings = (await galleryActions.readArtistHeadings())
      .map((heading) => String(heading || '').trim())
      .filter(Boolean);
    const albums = await galleryActions.readAlbumNamesByHeading(WHITESPACE_DISPLAY_ARTIST);
    expect(headings).toContain(WHITESPACE_DISPLAY_ARTIST);
    expect(albums.length).toBeGreaterThan(0);
    return { headings, albums };
  });

  await stepLogger.step('Clear the direct-loaded query while retaining its artist and gallery in the restored full tree', async () => {
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await searchToolbarActions.waitForUrlWithoutQueryParameter('q');
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootSnapshot.names);
    await navigationPanelActions.waitForSidebarSelection(WHITESPACE_DISPLAY_ARTIST);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(WHITESPACE_DISPLAY_ARTIST);
    expect(
      (await galleryActions.readArtistHeadings())
        .map((heading) => String(heading || '').trim())
        .filter(Boolean),
    ).toContain(WHITESPACE_DISPLAY_ARTIST);
    expect(await galleryActions.readAlbumNamesByHeading(WHITESPACE_DISPLAY_ARTIST)).toEqual(
      expect.arrayContaining(directLoadedGallerySnapshot.albums),
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(
      WHITESPACE_DISPLAY_ARTIST,
    );
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootSnapshot.count);
    expect(searchToolbarActions.readLocation().pathname).toBe('/');
  });

  const selectedGallerySnapshot = await stepLogger.step('Commit a different search after clearing the direct-loaded state and capture its selected gallery', async () => {
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY, {
      queryValue: ONE_FAMILY_QUERY,
    });
    const headings = (await galleryActions.readArtistHeadings())
      .map((heading) => String(heading || '').trim())
      .filter(Boolean);
    const albums = await galleryActions.readAlbumNamesByHeading(ONE_FAMILY_QUERY);
    expect(headings).toContain(ONE_FAMILY_QUERY);
    expect(albums.length).toBeGreaterThan(0);
    return { headings, albums };
  });

  await stepLogger.step('Clear search and restore the full tree and count while retaining the current artist gallery', async () => {
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await searchToolbarActions.waitForUrlWithoutQueryParameter('q');
    await navigationPanelActions.waitForAllArtistsVisibility(true);
    await navigationPanelActions.waitForSidebarArtistNames(rootSnapshot.names);
    await navigationPanelActions.waitForSidebarSelection(ONE_FAMILY_QUERY);
    await navigationPanelActions.waitForActiveSelectionInViewport();
    await galleryActions.waitForSelectedArtistGallery(ONE_FAMILY_QUERY);
    expect(
      (await galleryActions.readArtistHeadings())
        .map((heading) => String(heading || '').trim())
        .filter(Boolean),
    ).toContain(ONE_FAMILY_QUERY);
    expect(await galleryActions.readAlbumNamesByHeading(ONE_FAMILY_QUERY)).toEqual(
      expect.arrayContaining(selectedGallerySnapshot.albums),
    );
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(ONE_FAMILY_QUERY);
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootSnapshot.count);
    expect(searchToolbarActions.readLocation().pathname).toBe('/');
  });
});

test('FTC-SEARCH-NAV-025 keeps committed searches in an app-owned keyboard and mouse popover', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Commit two searches without browser-native autocomplete', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.expectBrowserAutocompleteDisabled();
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await searchToolbarActions.search(RECENT_SEARCH_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(RECENT_SEARCH_QUERY);
  });

  await stepLogger.step('Reload the same tab and restore both session-scoped searches', async () => {
    await searchToolbarActions.reloadCurrentView();
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.openRecentSearches();
    expect(await searchToolbarActions.readRecentSearchQueries()).toEqual([
      RECENT_SEARCH_QUERY,
      ONE_FAMILY_QUERY,
    ]);
    await searchToolbarActions.dismissRecentSearchesWithEscape();
  });

  await stepLogger.step('Show committed searches newest first and select the older query with the mouse', async () => {
    await searchToolbarActions.openRecentSearches();
    expect(await searchToolbarActions.readRecentSearchQueries()).toEqual([
      RECENT_SEARCH_QUERY,
      ONE_FAMILY_QUERY,
    ]);
    await searchToolbarActions.selectRecentSearchWithMouse(ONE_FAMILY_QUERY);
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
  });

  await stepLogger.step('Select Joseph with two ArrowDown presses and Enter', async () => {
    await searchToolbarActions.openRecentSearches();
    expect(await searchToolbarActions.readRecentSearchQueries()).toEqual([
      ONE_FAMILY_QUERY,
      RECENT_SEARCH_QUERY,
    ]);
    await searchToolbarActions.selectRecentSearchWithKeyboard([
      ONE_FAMILY_QUERY,
      RECENT_SEARCH_QUERY,
    ]);
    await searchToolbarActions.waitForQuery(RECENT_SEARCH_QUERY);
  });

  await stepLogger.step('Dismiss the popover with Enter, Tab, focus loss, and an outside click', async () => {
    await searchToolbarActions.openRecentSearches();
    await searchToolbarActions.dismissRecentSearchesWithEnter();
    await searchToolbarActions.openRecentSearches();
    await searchToolbarActions.dismissRecentSearchesWithTab();
    await searchToolbarActions.openRecentSearches();
    await searchToolbarActions.dismissRecentSearchesWithFocusLoss();
    await searchToolbarActions.openRecentSearches();
    await searchToolbarActions.dismissRecentSearchesWithOutsideClick();
  });
});

test('FTC-SEARCH-NAV-025 persists only an explicitly submitted completed query after debounced prefixes', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
}) => {
  await stepLogger.step('Settle slow typed prefixes before explicitly submitting the completed query', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.expectNoRecentSearches();
    await searchToolbarActions.settleDebouncedPrefixesThenSubmit(
      RECENT_SEARCH_QUERY,
      ['J', 'Jo', 'Jos', 'Jose', RECENT_SEARCH_QUERY],
    );
  });

  await stepLogger.step('Keep only the explicit completed query in recent searches', async () => {
    await searchToolbarActions.openRecentSearches();
    expect(await searchToolbarActions.readRecentSearchQueries()).toEqual([
      RECENT_SEARCH_QUERY,
    ]);
  });
});

test('FTC-SEARCH-NAV-025 aligns the desktop recent-search popover below the search input', async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stepLogger.step('Start with no recent searches in the fresh browser context', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.expectNoRecentSearches();
  });

  await stepLogger.step('Open one committed recent search at desktop width', async () => {
    await searchToolbarActions.search(ONE_FAMILY_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ONE_FAMILY_QUERY);
    await searchToolbarActions.openRecentSearches();
  });

  await stepLogger.step('Keep the popover aligned, unclipped, and visually stable', async () => {
    const { input, popover } = await searchToolbarActions.readRecentSearchGeometry();
    expect(Math.abs(popover.x - input.x)).toBeLessThanOrEqual(1);
    expect(popover.width).toBe(input.width);
    expect(popover.y).toBeGreaterThanOrEqual(input.y + input.height);
    expect(popover.x + popover.width).toBeLessThanOrEqual(1440);
    expect(popover.y + popover.height).toBeLessThanOrEqual(900);
  });
});
