import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

// Owner 2026-11-21: "When I search for something, then clear it, then click Back button in the browser - it brings
// URL back but the app itself does not load searched page." Browser Back and Forward must restore exactly what the
// URL describes: the query in the field, the main panel, and the side-bar tree that follows it.

const SEARCH_QUERY = 'flower kings';
const SEARCH_ARTIST = 'The Flower Kings';
const SEARCH_TREE_ARTISTS = [SEARCH_ARTIST, 'Agents Of Mercy', 'Roine Stolt'];

async function expectSearchResults(page, { galleryActions, navigationPanelActions }) {
  await expect(page).toHaveURL(/[?&]q=flower(\+|%20)kings(&|$)/);
  await expect(page.locator('#search-input')).toHaveValue(SEARCH_QUERY);
  await galleryActions.waitForSelectedArtistGallery(SEARCH_ARTIST, { queryValue: SEARCH_QUERY });
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await navigationPanelActions.waitForSidebarArtistNames(SEARCH_TREE_ARTISTS);
  await navigationPanelActions.waitForSidebarSelection(SEARCH_ARTIST);
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(SEARCH_ARTIST);
  await navigationPanelActions.waitForAllArtistsVisibility(false);
}

// What the page shows, for comparing a history entry with the page it was when it was left.
async function readVisibleState(page) {
  const url = new URL(page.url());
  const tree = page.locator('#sidebar-list');
  const contextName = page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]');
  return {
    path: url.pathname,
    query: url.searchParams.get('q') || '',
    artist: url.searchParams.get('artist') || '',
    collection: url.searchParams.get('collection') || '',
    field: await page.locator('#search-input').inputValue(),
    tree: await tree.getAttribute('data-navigation-tree'),
    selectedRows: (await tree.locator('.artist-link.active, [aria-current="true"]').allInnerTexts())
      .map((text) => text.replace(/\s+/g, ' ').trim()),
    allArtistsRow: (await tree.locator('[data-sidebar-all-artists="1"]').allInnerTexts())
      .map((text) => text.replace(/\s+/g, ' ').trim()),
    heading: await contextName.isVisible() ? (await contextName.innerText()).trim() : '',
    looseTracksOpen: await page.locator('#non-album-modal').isVisible(),
  };
}

async function expectClearedSearch(page) {
  await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);
  await expect(page.locator('#search-input')).toHaveValue('');
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await expect(page.locator('#sidebar-list [data-sidebar-all-artists="1"]')).toBeVisible();
  await expect.poll(async () => page.locator('#sidebar-list [data-sidebar-artist]').count())
    .toBeGreaterThan(SEARCH_TREE_ARTISTS.length);
  await expect(page.locator('#artist-groups .album-card').first()).toBeVisible();
}

// The owner's report started on the library page and cleared with the field's Clear button; Enter clears too.
const SEARCH_ENTRIES = [
  { start: '/', clear: 'the Clear button' },
  { start: '/?surface=albums', clear: 'Enter on an emptied field' },
];

test('FTC-GALLERY-NAV-039 browser Back and Forward restore a cleared search and its tree', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, searchToolbarActions, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  for (const entry of SEARCH_ENTRIES) {
    let cleared = null;
    await stepLogger.step(`From ${entry.start}, search, then clear it with ${entry.clear}`, async () => {
      await galleryActions.goto(entry.start);
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(SEARCH_QUERY, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(SEARCH_QUERY);
      await expectSearchResults(page, actions);
      if (entry.clear === 'the Clear button') {
        await searchToolbarActions.searchToolbar.clearButton.click();
        await expect(page.locator('#search-input')).toHaveValue('');
        await page.locator('#search-input').press('Enter');
        await searchToolbarActions.waitForQuery('');
      } else {
        await searchToolbarActions.clearSearchWithEnter();
      }
      await expectClearedSearch(page);
      await galleryActions.waitForGalleryReady();
      cleared = await readVisibleState(page);
    });

    await stepLogger.step('Back shows the search results again', async () => {
      await page.goBack();
      await expectSearchResults(page, actions);
    });

    await stepLogger.step('Forward clears the search again, exactly as it was', async () => {
      await page.goForward();
      await expectClearedSearch(page);
      await expect.poll(() => readVisibleState(page)).toEqual(cleared);
    });

    await stepLogger.step('Back, then reload at the search URL', async () => {
      await page.goBack();
      await expectSearchResults(page, actions);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await expectSearchResults(page, actions);
    });
  }
});

test.describe('phone', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  // The phone's Artists tree lives in a drawer; its rows are read whether or not the drawer is open.
  async function expectPhoneSearch(page, mobile) {
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(SEARCH_QUERY);
    await expect(mobile.searchInput).toHaveValue(SEARCH_QUERY);
    await expect(mobile.home).toBeHidden();
    await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
    await expect(page.locator('#sidebar-list .artist-link.active[data-sidebar-artist]'))
      .toHaveAttribute('data-sidebar-artist', SEARCH_ARTIST);
    await expect(page.locator('#sidebar-list [data-sidebar-artist]')).toHaveCount(SEARCH_TREE_ARTISTS.length);
    await expect.poll(async () => (await mobile.galleryContextName.innerText()).trim().replace(/ family$/, ''))
      .toBe(SEARCH_ARTIST);
    await expect(mobile.galleryCards.first()).toBeVisible();
  }

  // A cleared search leaves the search's tree: the library's whole tree is there, drawer open or not.
  async function expectPhoneClearedSearch(page, mobile) {
    await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);
    await expect(mobile.searchInput).toHaveValue('');
    await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
    await expect.poll(async () => page.locator('#sidebar-list [data-sidebar-artist]').count()).toBeGreaterThan(5);
  }

  async function readPhoneState(page, mobile) {
    return { ...(await readVisibleState(page)), homeShown: await mobile.home.isVisible() };
  }

  test('FTC-GALLERY-NAV-043 phone Back and Forward restore a cleared search and its tree', {
    tag: '@area:gallery-search',
  }, async ({ galleryActions, page, stepLogger }) => {
    const mobile = new MobileLayoutPage(page);
    let cleared = null;
    await stepLogger.step('Open an artist, search, then clear the search', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(SEARCH_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await mobile.search(SEARCH_QUERY);
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneSearch(page, mobile);
      if (!(await mobile.searchInput.isVisible())) await mobile.searchButton.click();
      await mobile.searchInput.fill('');
      await mobile.searchInput.press('Enter');
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneClearedSearch(page, mobile);
      cleared = await readPhoneState(page, mobile);
    });

    await stepLogger.step('Back shows the search, Forward clears it again exactly as it was', async () => {
      await page.goBack();
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneSearch(page, mobile);
      await page.goForward();
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneClearedSearch(page, mobile);
      await expect.poll(() => readPhoneState(page, mobile)).toEqual(cleared);
    });

    await stepLogger.step('Back, then reload at the search URL', async () => {
      await page.goBack();
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneSearch(page, mobile);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await mobile.closeArtistDrawerIfOpen();
      await expectPhoneSearch(page, mobile);
    });
  });
});

const FIRST_ARTIST = 'The Flower Kings';
const SECOND_ARTIST = 'Transatlantic';

async function expectArtistPage(page, artist, { galleryActions, navigationPanelActions }) {
  await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe(artist);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator('#search-input')).toHaveValue('');
  await galleryActions.waitForSelectedArtistGallery(artist, { requireArtistQuery: true });
  // An artist with family artists is headed "<artist> family".
  await expect.poll(async () => (
    await page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]').innerText()
  ).trim().replace(/ family$/, '')).toBe(artist);
  // The library's whole Artists tree, never a search's, with this artist selected.
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await expect(page.locator('#sidebar-list [data-sidebar-all-artists="1"]')).toBeVisible();
  await expect(page.locator('#sidebar-list')).not.toContainText('No match found');
  await expect.poll(async () => page.locator('#sidebar-list [data-sidebar-artist]').count()).toBeGreaterThan(5);
  await navigationPanelActions.waitForSidebarSelection(artist);
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(artist);
}

async function expectAllArtistsPage(page, { navigationPanelActions }) {
  await expect(page).not.toHaveURL(/[?&](artist|q)=/);
  await expect(page.locator('#search-input')).toHaveValue('');
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await expect(navigationPanelActions.navigationPanel.activeAllArtistsLink).toHaveCount(1);
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe('');
  await expect.poll(async () => (await page.locator('#artist-groups .artist-section').count())).toBeGreaterThan(1);
}

test('FTC-GALLERY-NAV-040 browser Back and Forward move between artists and All artists with their tree selection', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  await stepLogger.step('Open one artist, another, then All artists', async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(FIRST_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await expectArtistPage(page, FIRST_ARTIST, actions);
    await navigationPanelActions.selectSidebarArtistByName(SECOND_ARTIST);
    await expectArtistPage(page, SECOND_ARTIST, actions);
    await navigationPanelActions.clickAllArtists({ expectArtistQueryCleared: true });
    await expectAllArtistsPage(page, actions);
  });

  await stepLogger.step('Back returns to each artist in turn', async () => {
    await page.goBack();
    await expectArtistPage(page, SECOND_ARTIST, actions);
    await page.goBack();
    await expectArtistPage(page, FIRST_ARTIST, actions);
  });

  await stepLogger.step('Forward replays the artist and All artists', async () => {
    await page.goForward();
    await expectArtistPage(page, SECOND_ARTIST, actions);
    await page.goForward();
    await expectAllArtistsPage(page, actions);
  });

  await stepLogger.step('Reload at an artist URL keeps that artist', async () => {
    await page.goBack();
    await expectArtistPage(page, SECOND_ARTIST, actions);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await expectArtistPage(page, SECOND_ARTIST, actions);
  });
});

const NO_MATCH_QUERY = 'Album Haven deterministic no-match 7f4c29';

async function expectNoMatchSearch(page) {
  await expect(page).toHaveURL(/[?&]q=Album(\+|%20)Haven/);
  await expect(page.locator('#search-input')).toHaveValue(NO_MATCH_QUERY);
  await expect(page.locator('#sidebar-list')).toContainText('No match found');
  await expect(page.locator('#sidebar-list .artist-link.active')).toHaveCount(0);
  await expect(page.locator('#artist-groups .album-card')).toHaveCount(0);
}

test('FTC-GALLERY-NAV-041 browser Back and Forward restore a search with no match', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, searchToolbarActions, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  await stepLogger.step('Open an artist, then search for something with no match', async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(FIRST_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await expectArtistPage(page, FIRST_ARTIST, actions);
    await searchToolbarActions.search(NO_MATCH_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(NO_MATCH_QUERY);
    await expectNoMatchSearch(page);
  });

  await stepLogger.step('Back returns to the artist, Forward to the no-match search', async () => {
    await page.goBack();
    await expectArtistPage(page, FIRST_ARTIST, actions);
    await page.goForward();
    await expectNoMatchSearch(page);
  });

  await stepLogger.step('Reload keeps the no-match search', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForInitialRefreshCompleted();
    await expectNoMatchSearch(page);
  });
});

// Two collections the test owns: the rarity fixture's two tracks, each moved to its own Custom Collection, and back.
const RARITY_ARTIST = 'E2E Rarity Artist';
const RARITY_ALBUM = 'Two Track Rarity Fixture';
const RARITY_YEAR = '2026';
const COLLECTIONS = [
  { name: 'History Shelf A', filename: '01 - Apply Rarity Here.mp3', title: 'Apply Rarity Here' },
  { name: 'History Shelf B', filename: '02 - Remain Editable.mp3', title: 'Remain Editable' },
];
const COLLECTION_SEARCH_QUERY = 'Rarity';

async function openCollectionFromTree(page, name) {
  const tree = page.locator('#sidebar-list');
  if (await tree.getAttribute('data-navigation-tree') !== 'custom-collections') {
    await page.locator('[data-library-navigation-mode="custom-collections"]:visible').first().click();
  }
  const row = name
    ? tree.locator(`[data-open-custom-collection=${JSON.stringify(name)}]`)
    : tree.locator('[data-open-loose-tracks]');
  await expect(row).toBeEnabled();
  await row.click();
}

async function expectCollectionPage(page, collection, { query = '' } = {}) {
  const name = collection?.name || '';
  await expect.poll(() => {
    const url = new URL(page.url());
    return [url.pathname, url.searchParams.get('collection') || '', url.searchParams.get('q') || ''];
  }).toEqual(['/loose-tracks', name, query]);
  await expect(page.locator('#search-input')).toHaveValue(query);
  const looseTracks = page.locator('#non-album-modal');
  await expect(looseTracks).toBeVisible();
  await expect(page.locator('#non-album-modal-title')).toHaveText(name || 'Loose Tracks');
  for (const other of COLLECTIONS) {
    const row = looseTracks.locator('[data-track-row-path]').filter({ hasText: other.title });
    await expect(row).toHaveCount(!collection || other === collection ? 1 : 0);
  }
  const tree = page.locator('#sidebar-list');
  await expect(tree).toHaveAttribute('data-navigation-tree', 'custom-collections');
  const selectedRow = name
    ? tree.locator(`[data-open-custom-collection=${JSON.stringify(name)}]`)
    : tree.locator('[data-open-loose-tracks]');
  await expect(selectedRow).toHaveAttribute('aria-current', 'true');
  await expect(tree.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(tree.locator('[data-sidebar-artist]')).toHaveCount(0);
}

async function expectRaritySearchGallery(page, { galleryActions, navigationPanelActions }) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return [url.pathname, url.searchParams.get('q'), url.searchParams.get('collection')];
  }).toEqual(['/', COLLECTION_SEARCH_QUERY, null]);
  await expect(page.locator('#search-input')).toHaveValue(COLLECTION_SEARCH_QUERY);
  await expect(page.locator('#non-album-modal')).toBeHidden();
  await galleryActions.waitForSelectedArtistGallery(RARITY_ARTIST, { queryValue: COLLECTION_SEARCH_QUERY });
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
}

test('FTC-GALLERY-NAV-042 browser Back and Forward move between collections, All Loose Tracks and a search gallery', {
  tag: '@area:tag-edit',
}, async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  page,
  searchToolbarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  const actions = { galleryActions, navigationPanelActions };
  let fixtureMutated = false;
  const restoreFixture = async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await artistPageSettingsActions.openNonAlbumTracks(COLLECTIONS.length);
    await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: COLLECTIONS.length });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(RARITY_ALBUM);
    await tagEditorActions.clearException();
    // The artist's Loose Tracks page stays open under the editor, so the notice is read where the save finished.
    await tagEditorActions.applyAndWaitForSavedFiles({ savedNotificationDelivery: 'current-view' });
    fixtureMutated = false;
  };

  try {
    await stepLogger.step('Move each rarity track to its own Custom Collection', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await galleryActions.selectAlbumDetailsByIdentity({ artist: RARITY_ARTIST, album: RARITY_ALBUM, year: RARITY_YEAR });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: COLLECTIONS.length });
      for (const collection of COLLECTIONS) {
        await tagEditorActions.selectTrackByFilename(collection.filename);
        await tagEditorActions.setException('Custom Collection');
        await tagEditorActions.setCustomCollectionName(collection.name);
      }
      fixtureMutated = true;
      await tagEditorActions.applyAndWaitForSavedFiles({
        savedNotificationDelivery: 'status-page',
        beforeSavedNotification: () => trackModalActions.close(),
      });
    });

    await stepLogger.step('Open collection A, collection B, then All Loose Tracks from the tree', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await openCollectionFromTree(page, COLLECTIONS[0].name);
      await expectCollectionPage(page, COLLECTIONS[0]);
      await openCollectionFromTree(page, COLLECTIONS[1].name);
      await expectCollectionPage(page, COLLECTIONS[1]);
      await openCollectionFromTree(page, '');
      await expectCollectionPage(page, null);
    });

    await stepLogger.step('Back and Forward walk the collection pages with their tree selection', async () => {
      await page.goBack();
      await expectCollectionPage(page, COLLECTIONS[1]);
      await page.goBack();
      await expectCollectionPage(page, COLLECTIONS[0]);
      await page.goForward();
      await expectCollectionPage(page, COLLECTIONS[1]);
      await page.goForward();
      await expectCollectionPage(page, null);
    });

    await stepLogger.step('Reload at a collection URL keeps that collection', async () => {
      await page.goBack();
      await expectCollectionPage(page, COLLECTIONS[1]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectCollectionPage(page, COLLECTIONS[1]);
    });

    await stepLogger.step('Search, open a matching collection, then Back and Forward between them', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(COLLECTION_SEARCH_QUERY, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(COLLECTION_SEARCH_QUERY);
      await expectRaritySearchGallery(page, actions);
      await openCollectionFromTree(page, COLLECTIONS[0].name);
      await expectCollectionPage(page, COLLECTIONS[0], { query: COLLECTION_SEARCH_QUERY });
      await page.goBack();
      await expectRaritySearchGallery(page, actions);
      await page.goForward();
      await expectCollectionPage(page, COLLECTIONS[0], { query: COLLECTION_SEARCH_QUERY });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectCollectionPage(page, COLLECTIONS[0], { query: COLLECTION_SEARCH_QUERY });
    });

    await stepLogger.step('A search that only a collection matches opens it; Back and Forward return around it', async () => {
      const query = COLLECTIONS[0].title;
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const beforeSearch = await readVisibleState(page);
      await searchToolbarActions.search(query, { submitWithEnter: true });
      await expectCollectionPage(page, COLLECTIONS[0], { query });
      // The search may leave its own entry before the collection's; whichever entry is shown matches its URL.
      await page.goBack();
      if (new URL(page.url()).searchParams.get('q') === query) {
        await expect(page.locator('#search-input')).toHaveValue(query);
        await expect(page.locator('#non-album-modal')).toBeHidden();
        await page.goBack();
      }
      await expect.poll(() => readVisibleState(page)).toEqual(beforeSearch);
      await page.goForward();
      if (new URL(page.url()).pathname !== '/loose-tracks') await page.goForward();
      await expectCollectionPage(page, COLLECTIONS[0], { query });
    });

    await stepLogger.step('Put the rarity tracks back on their album', restoreFixture);
  } finally {
    if (fixtureMutated) {
      await tagEditorActions.dismissTopmostOverlayWithEscape().catch(() => {});
      await restoreFixture();
    }
  }
});
