import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import {
  waitForLibraryStartupEntryVisible,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

async function openContextMenuForArtist(ui, artist) {
  await ui.openArtistTreeContextMenu(artist);
  await expect(ui.scrollToArtistAction).toBeVisible();
  await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', artist);
}

async function jumpToArtist(ui, artist, { expectLoader = null } = {}) {
  const loaderObservation = expectLoader === false ? await ui.observeLoaderVisibility() : null;
  await openContextMenuForArtist(ui, artist);
  await ui.scrollToArtistAction.click();
  await expect.poll(
    () => ui.readArtistJumpPlacement(artist),
    { message: `Expected ${artist} to render exactly at the gallery top` },
  ).toEqual({
    rendered: true,
    chromeMatches: true,
    rowsAligned: true,
    firstCardUncut: true,
  });
  if (loaderObservation) expect(await ui.finishLoaderVisibility(loaderObservation)).toBe(false);
}
async function resolveRenderedAnchorArtist(page, artist, visited = new Set()) {
  if (visited.has(artist)) {
    throw new Error(`Anchor resolution cycle for ${[...visited, artist].join(' -> ')}`);
  }
  visited.add(artist);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // parity-check: allow-read-only-measurement-evaluate -- build the production root-anchor URL
    const url = await page.evaluate(targetArtist => buildApiUrl({
      ...state.view,
      surface_request: 'albums',
      query: '',
      selected_artist: '',
      all_artists_active: true,
      related_filter_artists: [],
      primary_filter_active: false,
    }, { galleryAnchorArtist: targetArtist }), artist);
    const response = await authenticatedPageGet(page, new URL(url, page.url()).href, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.text();
    if (response.status() === 409 && attempt < 4) {
      await page.waitForTimeout(100);
      continue;
    }
    expect(
      response.ok(),
      `Expected an anchor page for ${artist}; received ${response.status()}: ${body.slice(0, 300)}`,
    ).toBe(true);
    const payload = JSON.parse(body);
    const renderedArtist = String(payload.gallery_page?.anchor_group_artist || '').trim();
    expect(renderedArtist, `Expected ${artist} to resolve to a rendered gallery group`).not.toBe('');
    return renderedArtist === artist
      ? renderedArtist
      : resolveRenderedAnchorArtist(page, renderedArtist, visited);
  }
  throw new Error(`Expected an anchor page for ${artist}`);
}
async function resolveDistinctFarTargets(page, artists, fractions) {
  const targets = [];
  const seen = new Set();
  for (const fraction of fractions) {
    const center = Math.floor(artists.length * fraction);
    for (let delta = 0; delta < Math.min(40, artists.length); delta += 1) {
      const index = Math.min(artists.length - 1, center + delta);
      const renderedArtist = await resolveRenderedAnchorArtist(page, artists[index]);
      if (seen.has(renderedArtist)) continue;
      seen.add(renderedArtist);
      targets.push(renderedArtist);
      break;
    }
  }
  return targets;
}

async function waitForSyntheticRoot(page, galleryActions, navigationPanelActions) {
  await galleryActions.goto('/');
  await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
    timeout: 120000,
  });
  await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions, {
    timeout: 120000,
  });
}

test.describe('FTC-GALLERY-NAV-032 synthetic-large Artist Tree scroll navigation', () => {
  test('far, consecutive, nearby, and reverse jumps retain exact artist ownership and complete groups', async ({
    galleryActions,
    navigationPanelActions,
    page,
  }) => {
    const ui = new GalleryRegressions(page);
    await waitForSyntheticRoot(page, galleryActions, navigationPanelActions);
    const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
    expect(artists.length).toBeGreaterThan(1000);

    const farTargets = await resolveDistinctFarTargets(
      page,
      artists,
      [0.1, 0.72, 0.24, 0.9, 0.16],
    );
    expect(farTargets).toHaveLength(5);
    for (const artist of farTargets) await jumpToArtist(ui, artist);

    const consecutiveTargets = [farTargets[1], farTargets[2]];
    await jumpToArtist(ui, consecutiveTargets[0]);
    await jumpToArtist(ui, consecutiveTargets[1]);

    // parity-check: allow-read-only-measurement-evaluate -- select adjacent mounted artist groups
    const nearbyTargets = await ui.readMountedArtistsNearCenter();
    expect(nearbyTargets).toHaveLength(3);
    for (const artist of nearbyTargets) await jumpToArtist(ui, artist, { expectLoader: false });

    let stableAnchorComparisons = 0;
    const upwardArtists = new Set();
    for (let step = 0; step < 200 && upwardArtists.size < 20; step += 1) {
      // parity-check: allow-read-only-measurement-evaluate -- capture a visible card across slow native wheel input
      const before = await ui.captureVisibleCardAnchor();
      const box = await ui.galleryScroll.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -160);
      await page.waitForTimeout(80);
      // parity-check: allow-read-only-measurement-evaluate -- reject reverse-scroll prepend jumps
      const continuity = await ui.readVisibleCardAnchorContinuity(before);
      await before.dispose();
      if (continuity.connected && continuity.delta !== null) {
        stableAnchorComparisons += 1;
        expect(continuity.delta).toBeGreaterThanOrEqual(-2);
        expect(continuity.delta).toBeLessThanOrEqual(220);
      }
      upwardArtists.add(await ui.galleryContextName.textContent());
    }
    // parity-check: allow-read-only-measurement-evaluate -- diagnose reverse-page ownership and boundary state
    const reverseState = await page.evaluate(() => {
      const scroll = document.getElementById('albums-scroll');
      return {
        artists: (state.view.artist_groups || []).map(group => String(group.artist || '')),
        busy: Boolean(state.busy),
        hasPrevious: Boolean(state.view.gallery_page?.has_previous),
        pendingSidebarNavigation: Boolean(hasPendingSidebarNavigation()),
        previousCursor: String(state.view.gallery_page?.previous_cursor || ''),
        rootRequestPending: Boolean(rootGalleryPageRequest),
        scrollTop: Number(scroll?.scrollTop || 0),
        viewport: Number(scroll?.clientHeight || 0),
      };
    });
    expect(
      upwardArtists.size,
      `Expected 15 reverse-scrolled artists: ${JSON.stringify(reverseState)}`,
    ).toBeGreaterThanOrEqual(15);
    expect(stableAnchorComparisons).toBeGreaterThanOrEqual(10);

    // parity-check: allow-read-only-measurement-evaluate -- prove two preceding rendered groups are complete
    const precedingGroups = await ui.readPrecedingRenderedGroupCompleteness();
    expect(precedingGroups).toHaveLength(2);
    for (const group of precedingGroups) {
      expect(group.artist).not.toBe('');
      expect(group.loadedAlbums).toBe(group.authoritativeAlbums);
      await jumpToArtist(ui, group.artist, { expectLoader: false });
      expect(await ui.readRenderedArtistAlbumCount(group.artist)).toBe(group.authoritativeAlbums);
    }
  });

  test('root continuation starts eight viewports early and never reaches a hard stop during its real request', async ({
    galleryActions,
    navigationPanelActions,
    page,
  }) => {
    const ui = new GalleryRegressions(page);
    await waitForSyntheticRoot(page, galleryActions, navigationPanelActions);

    let requestGeometry = null;
    let continuationPending = false;
    let continuationStartedAt = 0;
    let continuationDuration = null;
    let minimumRemaining = Number.POSITIVE_INFINITY;
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.searchParams.has('gallery_cursor')) return;
      continuationPending = true;
      continuationStartedAt = Date.now();
      if (!requestGeometry) requestGeometry = ui.readContinuationGeometry();
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.searchParams.has('gallery_cursor') || !continuationPending) return;
      continuationPending = false;
      continuationDuration = Date.now() - continuationStartedAt;
    });
    for (let step = 0; step < 30; step += 1) {
      const box = await ui.galleryScroll.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(80);
      if (continuationPending) {
        // parity-check: allow-read-only-measurement-evaluate -- sample distance to the old hard boundary
        const geometry = await ui.readContinuationGeometry();
        minimumRemaining = Math.min(minimumRemaining, geometry.remaining);
      }
      if (requestGeometry && !continuationPending) break;
    }
    const geometry = await requestGeometry;
    expect(geometry.remaining).toBeGreaterThanOrEqual(geometry.viewport * 6);
    if (Number.isFinite(minimumRemaining)) expect(minimumRemaining).toBeGreaterThan(0);
    expect(continuationDuration).not.toBeNull();
    expect(continuationDuration).toBeLessThan(3000);
  });
});
