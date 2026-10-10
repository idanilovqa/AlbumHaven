import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { expect, test } from '../support/baseFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { parseProductionBootstrapPayloadScriptSources } from '../poms/basePage.js';
import { PERFORMANCE_AUTH_USERNAME, PERFORMANCE_AUTH_PASSWORD } from '../support/performanceAuthentication.js';

const CASE = 'FTC-GALLERY-STARTUP-006 preserves authoritative root metadata and mounted cards across a native page continuation';
const occurrences = view => (view.artist_groups || []).flatMap(group =>
  (group.albums || []).map(album => `${group.artist}\u0000${album.key}`));

test.use({ reuseAuthentication: false, viewport: { width: 1024, height: 480 } });

test(CASE, { tag: '@area:gallery-search' }, async ({ page, galleryActions, testArtifacts }) => {
  const ui = new GalleryRegressions(page);
  const manifest = JSON.parse(await readFile(path.join(process.env.ALBUM_HAVEN_FIXTURE_ROOT, 'manifest.json'), 'utf8'));
  const fixture = manifest.profiles['functional-core'];
  expect(fixture.namedScenarioAssertions.ddt.albumCount).toBeGreaterThan(58);
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/view-data') requests.push(url.search);
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
  const documentResponse = page.waitForResponse(response => response.request().isNavigationRequest()
    && new URL(response.url()).pathname === '/' && response.ok());
  await page.getByRole('button', { name: 'Sign in' }).click();
  const html = await (await documentResponse).text();
  const bootstrap = parseProductionBootstrapPayloadScriptSources(
    [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]),
  );
  const initial = bootstrap.initial_view;
  expect(initial.gallery_page.page_size).toBe(8);
  expect(initial.gallery_page.has_more).toBe(true);
  expect(occurrences(initial)).toHaveLength(8);
  expect(initial.artist_count).toBe(initial.artists_sidebar.length);
  expect(initial.album_count).toBeGreaterThan(58);
  expect(initial.initial_view_partial).toBe(false);
  const summary = `${initial.artist_count} artists · ${initial.album_count} albums`;
  expect(html).toContain(`data-gallery-context-summary>${summary}`);
  await galleryActions.waitForGalleryReady();
  await galleryActions.waitForInitialRefreshCompleted();
  await expect(ui.summary).toHaveText(summary);
  await expect(ui.rootArtistCount).toHaveText(String(initial.artist_count));
  const sidebar = ui.sidebarArtists;
  await expect(sidebar).toHaveCount(initial.artists_sidebar.length);
  // parity-check: allow-read-only-measurement-evaluate -- read rendered artist identity attributes
  expect(await sidebar.evaluateAll(items => items.map(item => item.getAttribute('data-sidebar-artist'))))
    .toEqual(initial.artists_sidebar.map(item => item.artist));

  // parity-check: allow-read-only-measurement-evaluate -- inspect the live loaded occurrence inventory without changing runtime state
  const readLoaded = () => page.evaluate(headingSelector => ({
    groups: state.view.artist_groups.map(group => ({ artist: group.artist, keys: group.albums.map(album => album.key) })),
    artistCount: state.view.artist_count, albumCount: state.view.album_count,
    hasMore: state.view.gallery_page.has_more,
    displayed: getFilteredGalleryMainModel().groups.map(group => ({
      artist: group.artist, label: group.artist_display || group.artist, keys: group.albums.map(album => album.key),
    })),
    headings: [...document.querySelectorAll(headingSelector)]
      .map(heading => heading.getAttribute('data-scroll-artist')),
  }), ui.artistHeadingSelector);
  const expectCanonicalDisplay = snapshot => {
    expect(snapshot.displayed.map(({ artist, keys }) => ({ artist, keys }))).toEqual(snapshot.groups);
    expect(snapshot.groups.map(group => group.artist))
      .toEqual(initial.artists_sidebar.slice(0, snapshot.groups.length).map(item => item.artist));
    const labels = snapshot.displayed.map(group => group.label);
    const headingPositions = snapshot.headings.map(heading => labels.indexOf(heading));
    expect(headingPositions.every(position => position >= 0)).toBe(true);
    expect(headingPositions).toEqual([...new Set(headingPositions)].sort((left, right) => left - right));
  };
  const before = await readLoaded();
  expectCanonicalDisplay(before);
  expect(before.groups.flatMap(group => group.keys)).toHaveLength(8);
  const geometry = await galleryActions.readGalleryScrollState();
  expect(geometry.maxScrollTop, 'The initial fixture must have a scrollable gallery').toBeGreaterThan(0);
  // Observe the continuation before native input, then retain a visible card at
  // its request boundary. A pre-scroll buffer card may legitimately virtualize out.
  const nextResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/view-data' && url.searchParams.get('gallery_cursor') === initial.gallery_page.next_cursor;
  }, { timeout: 30000 });
  const anchorPromise = ui.captureVisibleGalleryAnchorOnNextScroll();
  await galleryActions.scrollGalleryBy(geometry.maxScrollTop);
  const anchor = await anchorPromise;
  // parity-check: allow-read-only-measurement-evaluate -- prove the retained visible card predates the continuation merge
  expect(await anchor.evaluate(saved => ({ visible: Boolean(saved.element), loadedCount: saved.loadedCount })))
    .toEqual({ visible: true, loadedCount: 8 });
  const response = await nextResponse;
  expect(response.status()).toBe(200);
  const continuation = await response.json();
  expect(continuation.gallery_page.page_size).toBe(50);
  expect(occurrences(continuation)).toHaveLength(50);
  expect(continuation.artists_sidebar).toBeUndefined();
  await expect.poll(async () => (await readLoaded()).groups.flatMap(group => group.keys).length).toBe(58);
  const after = await readLoaded();
  expectCanonicalDisplay(after);
  const actual = after.groups.flatMap(group => group.keys.map(key => `${group.artist}\u0000${key}`));
  expect(actual).toEqual([...occurrences(initial), ...occurrences(continuation)]);
  expect(new Set(actual).size).toBe(actual.length);
  const artistOrder = [...new Set(after.groups.map(group => group.artist))];
  expect(artistOrder).toEqual(initial.artists_sidebar.slice(0, artistOrder.length).map(item => item.artist));
  const continuity = await ui.readGalleryAnchorContinuity(anchor);
  await anchor.dispose();
  expect(continuity.connected).toBe(true);
  expect(Math.abs(continuity.drift)).toBeLessThanOrEqual(2);
  expect(after.artistCount).toBe(initial.artist_count);
  expect(after.albumCount).toBe(initial.album_count);
  await expect(ui.rootArtistCount).toHaveText(String(initial.artist_count));
  // The sticky bar intentionally describes the visible artist while scrolled.
  // Returning to the root must restore the authoritative whole-library totals.
  await galleryActions.scrollGalleryBy(-(await galleryActions.readGalleryScrollState()).scrollTop);
  await expect(ui.summary).toHaveText(summary);
  expect(requests.every(query => new URLSearchParams(query).has('gallery_cursor'))).toBe(true);
  // Compare the additive paged contract to the unchanged full-root API after
  // observing the native journey. This request cannot hydrate the browser view.
  const fullResponse = await authenticatedPageGet(page, '/view-data?surface=albums');
  expect(fullResponse.ok()).toBe(true);
  const full = await fullResponse.json();
  expect(initial.album_count).toBe(full.album_count);
  expect(initial.artist_count).toBe(full.artist_count);
  expect(initial.artists_sidebar).toEqual(full.artists_sidebar);
  expect(initial.album_count).toBeGreaterThanOrEqual(fixture.namedScenarioAssertions.ddt.albumCount);
  expect(initial.artists_sidebar.map(item => item.artist)).toEqual(expect.arrayContaining([
    fixture.namedScenarioAssertions.joseph.artist,
    fixture.namedScenarioAssertions.mastodon.artist,
  ]));
  expect(actual).toEqual(occurrences(full).slice(0, actual.length));
  // Continue through every canonical artist, rather than proving only a long
  // first artist's prefix. Native wheel input remains the continuation trigger.
  let complete = after;
  let crossedArtistBoundary = after.groups.length > before.groups.length;
  let continuationCount = 1;
  const maximumContinuations = Math.ceil(occurrences(full).length / 50) + 1;
  for (; complete.hasMore && continuationCount <= maximumContinuations; continuationCount += 1) {
    const prior = complete;
    const priorCount = prior.groups.reduce((count, group) => count + group.keys.length, 0);
    const loadedGeometry = await galleryActions.readGalleryScrollState();
    await galleryActions.scrollGalleryBy(loadedGeometry.maxScrollTop - loadedGeometry.scrollTop);
    await expect.poll(async () => {
      complete = await readLoaded();
      return complete.groups.reduce((count, group) => count + group.keys.length, 0);
    }, { timeout: 30000 }).toBeGreaterThan(priorCount);
    expectCanonicalDisplay(complete);
    crossedArtistBoundary ||= complete.groups.length > prior.groups.length;
  }
  expect(complete.hasMore, 'Native traversal must finish within the fixture-derived page bound').toBe(false);
  expect(crossedArtistBoundary, 'Native continuation must cross a canonical artist boundary').toBe(true);
  expect(complete.groups.length).toBeGreaterThan(1);
  expect(complete.displayed.map(group => group.artist)).toEqual(initial.artists_sidebar.map(item => item.artist));
  expect(complete.displayed.flatMap(group => group.keys.map(key => `${group.artist}\u0000${key}`)))
    .toEqual(occurrences(full));
  expect(complete.artistCount).toBe(initial.artist_count);
  expect(complete.albumCount).toBe(initial.album_count);
  expect(errors).toEqual([]);
  testArtifacts.queueJsonAttachment('root-gallery-pagination.json', { initialOccurrences: occurrences(initial), continuationOccurrences: occurrences(continuation), artistOrder, continuity, requests, continuationCount, finalDisplayArtists: complete.displayed.map(group => group.artist) });
  const screenshot = testArtifacts.outputPath('root-gallery-pagination.png');
  await page.screenshot({ path: screenshot });
  testArtifacts.queuePathAttachment('root-gallery-pagination.png', screenshot, 'image/png');
});

test('FTC-GALLERY-STARTUP-006M mobile native scrolling prefetches before and advances beyond the first full-page boundary', { tag: '@area:gallery-search' }, async ({ page, galleryActions, testArtifacts }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = new MobileLayoutPage(page);
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/view-data' && url.searchParams.has('gallery_cursor')) {
      requests.push(url.searchParams.get('gallery_cursor'));
    }
  });

  await page.goto('/login');
  await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
  const documentResponse = page.waitForResponse(response => response.request().isNavigationRequest()
    && new URL(response.url()).pathname === '/' && response.ok());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await documentResponse;
  await mobile.libraryButton.click();
  await expect(mobile.artistRail).toHaveAttribute('aria-hidden', 'false');
  await mobile.allArtists.click();
  await expect(mobile.home).toBeHidden();
  await galleryActions.waitForGalleryReady();
  await galleryActions.waitForInitialRefreshCompleted();

  const readLoaded = () => page.evaluate(() => ({
    count: state.view.artist_groups.reduce((total, group) => total + group.albums.length, 0),
    groups: state.view.artist_groups.map(group => ({
      artist: group.artist,
      keys: group.albums.map(album => album.key),
    })),
    page: { ...state.view.gallery_page },
  }));
  const scrollIncrementallyUntilRequest = async (cursor, maximumSteps = 80) => {
    const samples = [];
    for (let step = 0; step < maximumSteps && !requests.includes(cursor); step += 1) {
      const before = await galleryActions.readGalleryScrollState();
      await galleryActions.scrollGalleryBy(Math.max(160, Math.floor(before.clientHeight * 0.7)));
      await page.waitForTimeout(25);
      const after = await galleryActions.readGalleryScrollState();
      samples.push({ before, after });
    }
    expect(requests, `Expected native mobile scrolling to request cursor ${cursor}.`).toContain(cursor);
    return samples;
  };

  const firstFullPage = await readLoaded();
  expect(firstFullPage.count).toBe(50);
  const reportedBoundaryArtist = firstFullPage.groups.at(-1).artist;
  const oldExtent = await galleryActions.readGalleryScrollState();
  const secondCursor = firstFullPage.page.next_cursor;
  expect(secondCursor).toBeTruthy();
  const secondResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/view-data' && url.searchParams.get('gallery_cursor') === secondCursor;
  });
  const approachSamples = await scrollIncrementallyUntilRequest(secondCursor);
  expect(approachSamples.length).toBeGreaterThan(0);
  // The request event and a local response can both settle inside one browser turn.
  // Derive the old-extent boundary from the geometry immediately before the
  // triggering fixed-size native wheel so a fast response cannot inflate it.
  const requestBoundary = approachSamples.at(-1).before;
  const triggeringDelta = Math.max(160, Math.floor(requestBoundary.clientHeight * 0.7));
  const remainingAtRequest = Math.max(
    0,
    requestBoundary.maxScrollTop - requestBoundary.scrollTop - triggeringDelta,
  );
  expect(
    remainingAtRequest,
    `Mobile continuation after ${reportedBoundaryArtist} must begin with at least three viewports of travel remaining.`,
  ).toBeGreaterThanOrEqual(requestBoundary.clientHeight * 3);

  let stationaryOldMaximum = false;
  for (let step = 0; step < 24; step += 1) {
    const before = await galleryActions.readGalleryScrollState();
    if (before.maxScrollTop > oldExtent.maxScrollTop + 2) break;
    await galleryActions.scrollGalleryBy(Math.max(160, Math.floor(before.clientHeight * 0.7)));
    await page.waitForTimeout(25);
    const after = await galleryActions.readGalleryScrollState();
    stationaryOldMaximum ||= before.scrollTop >= before.maxScrollTop - 2
      && after.scrollTop === before.scrollTop
      && after.maxScrollTop === before.maxScrollTop;
  }
  const secondResponse = await secondResponsePromise;
  expect(secondResponse.status()).toBe(200);
  const secondPage = await secondResponse.json();
  await expect.poll(async () => (await readLoaded()).count).toBeGreaterThan(50);
  expect(stationaryOldMaximum, `Mobile scrolling stopped at the old ${reportedBoundaryArtist} extent.`).toBe(false);

  let finalScroll = await galleryActions.readGalleryScrollState();
  for (let step = 0; step < 24 && finalScroll.scrollTop <= oldExtent.maxScrollTop + 2; step += 1) {
    await galleryActions.scrollGalleryBy(Math.max(160, Math.floor(finalScroll.clientHeight * 0.7)));
    await page.waitForTimeout(25);
    finalScroll = await galleryActions.readGalleryScrollState();
  }
  expect(finalScroll.maxScrollTop).toBeGreaterThan(oldExtent.maxScrollTop);
  expect(finalScroll.scrollTop, `Expected native scrolling to advance beyond ${reportedBoundaryArtist}.`)
    .toBeGreaterThan(oldExtent.maxScrollTop + 2);
  const appendedKeys = new Set(occurrences(secondPage).map(item => item.split('\u0000')[1]));
  // parity-check: allow-read-only-measurement-evaluate -- prove newly appended production cards reached the mobile viewport
  const mountedKeys = await page.locator('.album-card[data-gallery-card-key]')
    .evaluateAll(cards => cards.map(card => card.getAttribute('data-gallery-card-key')));
  expect(mountedKeys.some(key => appendedKeys.has(key))).toBe(true);

  testArtifacts.queueJsonAttachment('root-gallery-pagination-mobile.json', {
    reportedBoundaryArtist,
    remainingAtRequest,
    requestBoundary,
    oldExtent,
    finalScroll,
    requests,
  });
});

async function openArtistTreeContextMenu(ui, artist) {
  const rows = ui.sidebarArtists;
  // parity-check: allow-read-only-measurement-evaluate -- find the owned Artist Tree locator index
  const rowIndex = await rows.evaluateAll((items, targetArtist) => (
    items.findIndex(candidate => candidate.getAttribute('data-sidebar-artist') === targetArtist)
  ), artist);
  expect(rowIndex, `Expected Artist Tree row for ${artist}`).toBeGreaterThanOrEqual(0);
  const row = rows.nth(rowIndex);
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await expect(ui.scrollToArtistAction).toBeVisible();
}

test('FTC-GALLERY-NAV-031 Artist Tree jump stays local when mounted and supports complete backward traversal',
  { tag: '@area:gallery-search' },
  async ({ page, galleryActions, testArtifacts }) => {
    const ui = new GalleryRegressions(page);
    const requests = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/view-data') requests.push(url.search);
    });

    await page.goto('/login');
    await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
    await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
    const navigation = page.waitForResponse(response => (
      response.request().isNavigationRequest() && new URL(response.url()).pathname === '/' && response.ok()
    ));
    await page.getByRole('button', { name: /sign in/i }).click();
    await navigation;
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForInitialRefreshCompleted();

    // parity-check: allow-read-only-measurement-evaluate -- choose a mounted artist below the gallery top
    const localTarget = await page.evaluate(({ scrollSelector, sidebarSelector, headingSelector }) => {
      const scroll = document.querySelector(scrollSelector);
      const sidebarArtists = new Set(
        [...document.querySelectorAll(sidebarSelector)]
          .map(item => item.getAttribute('data-sidebar-artist')),
      );
      return [...document.querySelectorAll(headingSelector)]
        .map(header => ({
          artist: header.getAttribute('data-scroll-artist'),
          top: header.getBoundingClientRect().top,
        }))
        .filter(item => sidebarArtists.has(item.artist))
        .sort((left, right) => right.top - left.top)
        .find(item => item.top > scroll.getBoundingClientRect().top + 24)?.artist || '';
    }, {
      scrollSelector: '#albums-scroll',
      sidebarSelector: ui.sidebarArtistSelector,
      headingSelector: ui.artistHeadingSelector,
    });
    expect(localTarget, 'Fixture needs a mounted artist below the gallery top').not.toBe('');

    const localUrl = page.url();
    const loaderObservation = await ui.observeLoaderVisibility();
    const requestCountBeforeLocalJump = requests.length;
    await openArtistTreeContextMenu(ui, localTarget);
    await ui.scrollToArtistAction.click();

    await expect.poll(() => {
      // parity-check: allow-read-only-measurement-evaluate -- measure exact mounted artist alignment
      return page.evaluate(({ artist, scrollSelector, headingSelector }) => {
      const scroll = document.querySelector(scrollSelector);
      const header = [...document.querySelectorAll(headingSelector)]
        .find(item => item.getAttribute('data-scroll-artist') === artist);
      return header ? Math.abs(header.getBoundingClientRect().top - scroll.getBoundingClientRect().top) : 9999;
      }, { artist: localTarget, scrollSelector: '#albums-scroll', headingSelector: ui.artistHeadingSelector });
    }).toBeLessThanOrEqual(1);
    expect(page.url()).toBe(localUrl);
    expect(requests.slice(requestCountBeforeLocalJump).some(query => (
      new URLSearchParams(query).has('gallery_anchor_artist')
    ))).toBe(false);
    expect(await ui.finishLoaderVisibility(loaderObservation)).toBe(false);

    // parity-check: allow-read-only-measurement-evaluate -- read native gallery position before wheel input
    const localScrollBeforeWheel = await ui.galleryScroll.evaluate(element => element.scrollTop);
    const scrollBox = await ui.galleryScroll.boundingBox();
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    await page.mouse.wheel(0, -Math.max(320, Math.floor(scrollBox.height * 0.8)));
    await expect.poll(() => {
      // parity-check: allow-read-only-measurement-evaluate -- confirm native wheel movement
      return ui.galleryScroll.evaluate(element => element.scrollTop);
    })
      .toBeLessThan(localScrollBeforeWheel);

    // parity-check: allow-read-only-measurement-evaluate -- choose a sidebar artist outside the loaded model
    const remoteTarget = await page.evaluate(sidebarSelector => {
      const loaded = new Set((state.view.artist_groups || []).map(group => String(group.artist || '')));
      const rendered = [...document.querySelectorAll(sidebarSelector)]
        .map(item => String(item.getAttribute('data-sidebar-artist') || ''));
      return rendered.reverse().find(artist => artist && !loaded.has(artist)) || '';
    }, ui.sidebarArtistSelector);
    expect(remoteTarget, 'Fixture needs a rendered Artist Tree row outside the loaded gallery page').not.toBe('');
    const anchorResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/view-data'
        && url.searchParams.get('gallery_anchor_artist') === remoteTarget
        && response.ok();
    });
    await openArtistTreeContextMenu(ui, remoteTarget);
    await ui.scrollToArtistAction.click();
    await anchorResponse;

    await expect.poll(() => {
      // parity-check: allow-read-only-measurement-evaluate -- measure exact remote artist alignment
      return page.evaluate(({ artist, scrollSelector, headingSelector }) => {
      const scroll = document.querySelector(scrollSelector);
      const header = [...document.querySelectorAll(headingSelector)]
        .find(item => item.getAttribute('data-scroll-artist') === artist);
      return header ? Math.abs(header.getBoundingClientRect().top - scroll.getBoundingClientRect().top) : 9999;
      }, { artist: remoteTarget, scrollSelector: '#albums-scroll', headingSelector: ui.artistHeadingSelector });
    }).toBeLessThanOrEqual(1);

    // parity-check: allow-read-only-measurement-evaluate -- compare anchored group sizes with sidebar totals
    const leading = await page.evaluate(artist => {
      const groups = state.view.artist_groups || [];
      const targetIndex = groups.findIndex(group => String(group.artist || '') === artist);
      const group = targetIndex > 0 ? groups[targetIndex - 1] : null;
      const sidebar = group
        ? (state.view.artists_sidebar || []).find(item => String(item.artist || '') === String(group.artist || ''))
        : null;
      return {
        artist: String(group?.artist || ''),
        loadedAlbums: group?.albums?.length || 0,
        authoritativeAlbums: Number(sidebar?.count || 0),
        hasPrevious: Boolean(state.view.gallery_page?.has_previous),
      };
    }, remoteTarget);
    expect(leading.artist, 'Anchored page must include an artist above the target').not.toBe('');
    expect(leading.loadedAlbums).toBe(leading.authoritativeAlbums);
    expect(leading.hasPrevious, 'Fixture target must leave earlier pages for upward traversal').toBe(true);

    const previousResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/view-data'
        && url.searchParams.get('gallery_page_direction') === 'previous'
        && response.ok();
    }, { timeout: 20_000 });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const box = await ui.galleryScroll.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -Math.max(500, Math.floor(box.height * 1.5)));
      await page.waitForTimeout(40);
      // parity-check: allow-read-only-measurement-evaluate -- stop after reaching production's previous-page buffer
      const reachedTopBuffer = await ui.galleryScroll.evaluate(element => (
        element.scrollTop <= element.clientHeight * 2
      ));
      if (reachedTopBuffer) break;
    }
    await previousResponse;

    await expect.poll(() => {
      // parity-check: allow-read-only-measurement-evaluate -- wait for complete prepended leading artist data
      return page.evaluate(() => {
      const groups = state.view.artist_groups || [];
      const first = groups[0];
      const sidebar = (state.view.artists_sidebar || [])
        .find(item => String(item.artist || '') === String(first?.artist || ''));
      return {
        artist: String(first?.artist || ''),
        loadedAlbums: first?.albums?.length || 0,
        authoritativeAlbums: Number(sidebar?.count || 0),
      };
      });
    }).toEqual(expect.objectContaining({
      loadedAlbums: expect.any(Number),
      authoritativeAlbums: expect.any(Number),
    }));
    // parity-check: allow-read-only-measurement-evaluate -- capture final leading artist completeness evidence
    const firstLoaded = await page.evaluate(() => {
      const first = (state.view.artist_groups || [])[0];
      const sidebar = (state.view.artists_sidebar || [])
        .find(item => String(item.artist || '') === String(first?.artist || ''));
      return {
        artist: String(first?.artist || ''),
        loadedAlbums: first?.albums?.length || 0,
        authoritativeAlbums: Number(sidebar?.count || 0),
      };
    });
    expect(firstLoaded.artist).not.toBe('');
    expect(firstLoaded.loadedAlbums).toBe(firstLoaded.authoritativeAlbums);

    testArtifacts.queueJsonAttachment('artist-tree-scroll-jump.json', {
      localTarget,
      remoteTarget,
      leading,
      firstLoaded,
      requests,
    });
  });
