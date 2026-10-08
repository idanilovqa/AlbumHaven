import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { expect, test } from '../support/baseFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
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
  const anchorPromise = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/view-data' && url.searchParams.get('gallery_cursor') === initial.gallery_page.next_cursor;
  }).then(() => ui.captureVisibleGalleryAnchor());
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
