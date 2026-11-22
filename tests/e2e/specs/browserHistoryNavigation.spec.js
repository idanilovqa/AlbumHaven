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
  // Nothing stale: the gallery shows exactly the search's artists, in the tree's order.
  await expect.poll(() => galleryActions.readArtistHeadings()).toEqual(SEARCH_TREE_ARTISTS);
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

// Two ways in and out of a search: from the library page cleared with the field's Clear button, and from the
// gallery cleared with Enter on an emptied field.
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

// Owner 2026-11-21 (Sandbox1, after a server restart): a page loaded from a search URL that selects an artist other
// than the best match (q=rhapsody&artist=Thundercross). Its tree selected the URL's artist while the gallery showed
// the best match, and emptying the field then clicking outside left the search on screen. Both kinds of selected
// artist: a family artist of the best match, and an artist found only by an album title.
const DIRECT_SEARCHES = [
  { query: SEARCH_QUERY, artist: 'Roine Stolt' },
  { query: 'transatlantic', artist: 'Neal Morse' },
];

function directSearchUrl({ query, artist }) {
  return `/?surface=albums&q=${encodeURIComponent(query)}&artist=${encodeURIComponent(artist)}`
    + '&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard';
}

async function readGalleryHeading(page) {
  return (await page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]').innerText())
    .trim().replace(/ family$/, '');
}

// The page the URL describes: the search in the field, the search's tree, and the URL's artist selected in the tree
// and shown in the gallery.
async function expectDirectSearchPage(page, { query, artist }, { navigationPanelActions }) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return [url.searchParams.get('q'), url.searchParams.get('artist')];
  }).toEqual([query, artist]);
  await expect(page.locator('#search-input')).toHaveValue(query);
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await navigationPanelActions.waitForSidebarSelection(artist);
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(artist);
  await expect.poll(() => readGalleryHeading(page)).toBe(artist);
  await expect(page.locator('#sidebar-list [data-sidebar-all-artists="1"]')).toBeHidden();
}

// A search ended: no query anywhere, the library's whole tree, and the tree's selection is what the gallery shows.
async function expectSearchEnded(page, { galleryActions, navigationPanelActions }) {
  await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);
  await expect(page.locator('#search-input')).toHaveValue('');
  await galleryActions.waitForGalleryReady();
  await expect(page.locator('#sidebar-list')).toHaveAttribute('data-navigation-tree', 'artists');
  await expect(page.locator('#sidebar-list [data-sidebar-all-artists="1"]')).toBeVisible();
  await expect(page.locator('#sidebar-list')).not.toContainText('No match found');
  await expect.poll(async () => page.locator('#sidebar-list [data-sidebar-artist]').count()).toBeGreaterThan(5);
  const urlArtist = new URL(page.url()).searchParams.get('artist') || '';
  if (urlArtist) {
    await navigationPanelActions.waitForSidebarSelection(urlArtist);
    await expect.poll(() => readGalleryHeading(page)).toBe(urlArtist);
  } else {
    await expect(navigationPanelActions.navigationPanel.activeAllArtistsLink).toHaveCount(1);
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe('');
  }
}

const DIRECT_SEARCH_ENDINGS = ['emptying the field and clicking outside', 'emptying the field and pressing Enter'];

test('FTC-GALLERY-NAV-044 a page loaded from a search URL selects its artist and ends the search like a typed one', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  for (const search of DIRECT_SEARCHES) for (const ending of DIRECT_SEARCH_ENDINGS) {
    await stepLogger.step(`Load ${directSearchUrl(search)}: its artist is selected in the tree and the gallery`, async () => {
      await galleryActions.goto(directSearchUrl(search));
      await galleryActions.waitForGalleryReady();
      await expectDirectSearchPage(page, search, actions);
    });

    await stepLogger.step(`End the search by ${ending}`, async () => {
      const input = page.locator('#search-input');
      await input.click();
      await input.fill('');
      if (ending.endsWith('Enter')) await input.press('Enter');
      else await page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]').click();
      await expectSearchEnded(page, actions);
    });

    await stepLogger.step('Back returns to the search page, Forward ends it again', async () => {
      await page.goBack();
      await expectDirectSearchPage(page, search, actions);
      await page.goForward();
      await expectSearchEnded(page, actions);
    });
  }
});

test('FTC-GALLERY-NAV-045 the logo goes home from a page loaded from a search URL', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  const expectHome = async () => {
    await expect.poll(() => {
      const url = new URL(page.url());
      return [url.searchParams.has('q'), url.searchParams.has('artist')];
    }).toEqual([false, false]);
    await expectSearchEnded(page, actions);
    await expect(navigationPanelActions.navigationPanel.activeAllArtistsLink).toHaveCount(1);
  };
  for (const search of DIRECT_SEARCHES) {
    await stepLogger.step(`Load ${directSearchUrl(search)}, then click the logo`, async () => {
      await galleryActions.goto(directSearchUrl(search));
      await galleryActions.waitForGalleryReady();
      await expectDirectSearchPage(page, search, actions);
      await page.getByRole('link', { name: 'Album Haven library', exact: true }).click();
      await expectHome();
    });

    await stepLogger.step('Back returns to the search, Forward goes home again, and reload stays home', async () => {
      await page.goBack();
      await expectDirectSearchPage(page, search, actions);
      await page.goForward();
      await expectHome();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectHome();
    });
  }
});

// Owner 2026-11-21 (Sandbox1, server restarted under load): an artist clicked in a search's tree while its request
// could not finish left the tree and heading on the new artist, the URL on the old one and the gallery without its
// albums, and the cleared search then showed "All artists 0". A failed selection puts back the page it left.
const MIXED_SEARCH_QUERY = 'Signal';
const UNRELATED_SEARCH_ARTIST = 'Roine Stolt';

test('FTC-GALLERY-NAV-046 an artist that fails to load while the server is down puts back the page it left', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, managedAppLifecycle, navigationPanelActions, page, searchToolbarActions, stepLogger }) => {
  const actions = { galleryActions, navigationPanelActions };
  let searchPage = null;
  let libraryArtistCount = '';
  await stepLogger.step('Search for a word several unrelated artists match', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    libraryArtistCount = (await page.locator('#sidebar-list [data-sidebar-all-artists="1"]').innerText())
      .replace(/\s+/g, ' ').trim();
    await searchToolbarActions.search(MIXED_SEARCH_QUERY, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(MIXED_SEARCH_QUERY);
    await galleryActions.waitForGalleryReady();
    searchPage = await readVisibleState(page);
    expect(searchPage.artist).not.toBe(UNRELATED_SEARCH_ARTIST);
    await expect(page.locator(`#sidebar-list [data-sidebar-artist="${UNRELATED_SEARCH_ARTIST}"]`)).toHaveCount(1);
  });

  try {
    await stepLogger.step('With the server down, click an unrelated artist: the search page comes back', async () => {
      await managedAppLifecycle.stop();
      await page.locator(`#sidebar-list [data-sidebar-artist="${UNRELATED_SEARCH_ARTIST}"]`).click();
      await expect(page.locator('#toast-layer')).toContainText('could not be loaded', { timeout: 30000 });
      await expect.poll(() => readVisibleState(page), { timeout: 30000 }).toEqual(searchPage);
      await expect(page.locator('#artist-groups .album-card').first()).toBeVisible();
    });
  } finally {
    await managedAppLifecycle.restart();
  }

  await stepLogger.step('With the server back, the same click opens the artist and its URL', async () => {
    await page.locator(`#sidebar-list [data-sidebar-artist="${UNRELATED_SEARCH_ARTIST}"]`).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe(UNRELATED_SEARCH_ARTIST);
    await expect.poll(() => readGalleryHeading(page)).toBe(UNRELATED_SEARCH_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(UNRELATED_SEARCH_ARTIST);
    await expect(page.locator('#artist-groups .album-card').first()).toBeVisible();
  });

  await stepLogger.step('Ending the search shows the library tree with its real artist count', async () => {
    const input = page.locator('#search-input');
    await input.click();
    await input.fill('');
    await page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]').click();
    await expectSearchEnded(page, actions);
    await expect(page.locator('#sidebar-list [data-sidebar-all-artists="1"]')).toHaveText(libraryArtistCount, {
      useInnerText: true,
    });
  });
});

// Collections the test owns: the rarity fixture's two tracks, each moved to its own Custom Collection, and back.
const RARITY_ARTIST = 'E2E Rarity Artist';
const RARITY_ALBUM = 'Two Track Rarity Fixture';
const RARITY_YEAR = '2026';
const COLLECTION_A = {
  key: 'History Shelf A', heading: 'History Shelf A', filename: '01 - Apply Rarity Here.mp3', track: 'Apply Rarity Here',
};
const COLLECTION_B = {
  key: 'History Shelf B', heading: 'History Shelf B', filename: '02 - Remain Editable.mp3', track: 'Remain Editable',
};
const ALL_LOOSE_TRACKS = { key: '', heading: 'Loose Tracks', track: null };
const OWNED_TRACKS = [COLLECTION_A.track, COLLECTION_B.track];
const COLLECTION_SEARCH_QUERY = 'Rarity';

function looseTracksTreeRow(page, target) {
  const tree = page.locator('#sidebar-list');
  return target.key
    ? tree.locator(`[data-open-custom-collection=${JSON.stringify(target.key)}]`)
    : tree.locator('[data-open-loose-tracks]');
}

async function openLooseTracksPageFromTree(page, target) {
  if (await page.locator('#sidebar-list').getAttribute('data-navigation-tree') !== 'custom-collections') {
    await page.locator('[data-library-navigation-mode="custom-collections"]:visible').first().click();
  }
  const row = looseTracksTreeRow(page, target);
  await expect(row).toBeEnabled();
  await row.click();
}

async function expectLooseTracksPage(page, target, { query = '' } = {}) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return [url.pathname, url.searchParams.get('collection') || '', url.searchParams.get('q') || ''];
  }).toEqual(['/loose-tracks', target.key, query]);
  await expect(page.locator('#search-input')).toHaveValue(query);
  const looseTracks = page.locator('#non-album-modal');
  await expect(looseTracks).toBeVisible();
  await expect(page.locator('#non-album-modal-title')).toHaveText(target.heading);
  const trackRow = (track) => looseTracks.locator('[data-track-row-path]').filter({ hasText: track });
  if (query) {
    await expect(trackRow(target.track)).toHaveCount(1);
  } else {
    for (const track of OWNED_TRACKS) {
      await expect(trackRow(track)).toHaveCount(target.track === null || target.track === track ? 1 : 0);
    }
  }
  const tree = page.locator('#sidebar-list');
  await expect(tree).toHaveAttribute('data-navigation-tree', 'custom-collections');
  await expect(looseTracksTreeRow(page, target)).toHaveAttribute('aria-current', 'true');
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
  let collectionsMutated = false;
  // Both tracks go back on their album from the artist's Loose Tracks page, which stays open under the editor, so
  // the saved notice is read there.
  const restoreFixtures = async () => {
    if (!collectionsMutated) return;
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await artistPageSettingsActions.openNonAlbumTracks(OWNED_TRACKS.length);
    await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: OWNED_TRACKS.length });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(RARITY_ALBUM);
    await tagEditorActions.clearException();
    await tagEditorActions.applyAndWaitForSavedFiles({ savedNotificationDelivery: 'current-view' });
    collectionsMutated = false;
  };

  try {
    await stepLogger.step('Move each rarity track to its own Custom Collection', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await galleryActions.selectAlbumDetailsByIdentity({ artist: RARITY_ARTIST, album: RARITY_ALBUM, year: RARITY_YEAR });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: OWNED_TRACKS.length });
      for (const collection of [COLLECTION_A, COLLECTION_B]) {
        await tagEditorActions.selectTrackByFilename(collection.filename);
        await tagEditorActions.setException('Custom Collection');
        await tagEditorActions.setCustomCollectionName(collection.key);
      }
      collectionsMutated = true;
      await tagEditorActions.applyAndWaitForSavedFiles({
        savedNotificationDelivery: 'status-page',
        beforeSavedNotification: () => trackModalActions.close(),
      });
    });

    const walk = [COLLECTION_A, COLLECTION_B, ALL_LOOSE_TRACKS];
    await stepLogger.step('Open collection A, collection B, then All Loose Tracks from the tree', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      for (const target of walk) {
        await openLooseTracksPageFromTree(page, target);
        await expectLooseTracksPage(page, target);
      }
    });

    await stepLogger.step('Back and Forward walk the pages with their tree selection', async () => {
      for (const target of walk.slice(0, -1).reverse()) {
        await page.goBack();
        await expectLooseTracksPage(page, target);
      }
      for (const target of walk.slice(1)) {
        await page.goForward();
        await expectLooseTracksPage(page, target);
      }
    });

    await stepLogger.step('Reload at a collection URL keeps that collection', async () => {
      await page.goBack();
      await expectLooseTracksPage(page, COLLECTION_B);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectLooseTracksPage(page, COLLECTION_B);
    });

    await stepLogger.step('Search, open a matching collection, then Back and Forward between them', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(COLLECTION_SEARCH_QUERY, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(COLLECTION_SEARCH_QUERY);
      await expectRaritySearchGallery(page, actions);
      await openLooseTracksPageFromTree(page, COLLECTION_A);
      await expectLooseTracksPage(page, COLLECTION_A, { query: COLLECTION_SEARCH_QUERY });
      await page.goBack();
      await expectRaritySearchGallery(page, actions);
      await page.goForward();
      await expectLooseTracksPage(page, COLLECTION_A, { query: COLLECTION_SEARCH_QUERY });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectLooseTracksPage(page, COLLECTION_A, { query: COLLECTION_SEARCH_QUERY });
    });

    await stepLogger.step('A search that only a collection matches opens it; Back and Forward return around it', async () => {
      const query = COLLECTION_A.track;
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      const beforeSearch = await readVisibleState(page);
      await searchToolbarActions.search(query, { submitWithEnter: true });
      await expectLooseTracksPage(page, COLLECTION_A, { query });
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
      await expectLooseTracksPage(page, COLLECTION_A, { query });
    });

    await stepLogger.step('Put the owned tracks back on their albums', restoreFixtures);
  } finally {
    if (collectionsMutated) {
      await tagEditorActions.dismissTopmostOverlayWithEscape().catch(() => {});
      await restoreFixtures();
    }
  }
});
