import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import {
  waitForLibraryStartupEntryVisible,
} from '../helpers/realAppBenchmarkHelpers.js';

async function revealArtistWithWheel(ui, artist) {
  const row = ui.page.locator(
    `${ui.sidebarArtistSelector}[data-sidebar-artist=${JSON.stringify(artist)}]`,
  ).first();
  const targetIndex = await ui.sidebarList.evaluate((list, targetArtist) => (
    Array.isArray(list.albumHavenSidebarArtistsSource)
      ? list.albumHavenSidebarArtistsSource.findIndex(item => String(item?.artist || '') === targetArtist)
      : -1
  ), artist);
  expect(targetIndex).toBeGreaterThan(50);

  for (let attempt = 0; attempt < 5 && !await row.isVisible().catch(() => false); attempt += 1) {
    const position = await ui.sidebarList.evaluate((list, index) => {
      const owner = list.clientHeight > 0 && list.scrollHeight > list.clientHeight + 1
        ? list
        : list.closest('.sidebar');
      if (!owner) return null;
      const bounds = owner.getBoundingClientRect();
      const listTop = owner === list ? 0 : list.getBoundingClientRect().top - bounds.top + owner.scrollTop;
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
        delta: listTop + index * 47 - owner.scrollTop,
      };
    }, targetIndex);
    expect(position).not.toBeNull();
    await ui.page.mouse.move(position.x, position.y);
    await ui.page.mouse.wheel(0, position.delta);
    await row.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});
  }
  await expect(row).toBeVisible();
  return row;
}

async function longPress(ui, row) {
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    radiusX: 1,
    radiusY: 1,
    force: 1,
    id: 1,
  };
  const cdp = await ui.page.context().newCDPSession(ui.page);
  try {
    await cdp.send('Input.synthesizeTapGesture', {
      x: point.x,
      y: point.y,
      duration: 600,
      gestureSourceType: 'touch',
      tapCount: 1,
    });
  } finally {
    await cdp.detach();
  }
}

test.describe('FTC-GALLERY-NAV-033 synthetic-large mobile anchored gallery restoration', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test('long-press Scroll, album, Back restores an artist beyond the first root page', async ({
    galleryActions,
    navigationPanelActions,
    page,
  }) => {
    const ui = new GalleryRegressions(page);
    await galleryActions.goto();
    await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
      timeout: 120000,
    });
    await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
    await galleryActions.waitForInitialAllArtistsSections({
      requireScrollable: false,
      timeout: 120000,
    });
    await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
    await page.waitForFunction(() => (
      typeof state !== 'undefined'
      && !state.busy
      && !String(state.ui?.activeViewRequestUrl || '').trim()
    ), null, { timeout: 120000 });

    await navigationPanelActions.openArtistTree();
    const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
    expect(artists.length).toBeGreaterThan(250);
    const requestedArtist = artists[200];
    const row = await revealArtistWithWheel(ui, requestedArtist);
    await longPress(ui, row);
    await expect(ui.scrollToArtistAction).toBeVisible();
    await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
    await ui.scrollToArtistAction.click();

    await expect.poll(() => page.evaluate(artist => ({
      requested: state.view?.gallery_page?.anchor_artist,
      rendered: state.view?.gallery_page?.anchor_group_artist || artist,
    }), requestedArtist)).toMatchObject({ requested: requestedArtist });
    const renderedArtist = await page.evaluate(
      artist => String(state.view?.gallery_page?.anchor_group_artist || artist),
      requestedArtist,
    );
    const expectedPlacement = {
      rendered: true,
      chromeMatches: true,
      rowsAligned: true,
      firstCardUncut: true,
    };
    await expect.poll(() => ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);

    const albumKey = await page.evaluate(({ artist, headingSelector }) => {
      const heading = [...document.querySelectorAll(headingSelector)]
        .find(candidate => candidate.getAttribute('data-scroll-artist') === artist);
      return heading?.closest('.artist-section')
        ?.querySelector('[data-open-tracklist="1"][data-album-key]')
        ?.getAttribute('data-album-key') || '';
    }, { artist: renderedArtist, headingSelector: ui.artistHeadingSelector });
    expect(albumKey).not.toBe('');

    await ui.albumCardByKey(albumKey).locator('.album-meta-row').click();
    const mobileAlbum = page.locator('#mobile-page-outlet #track-modal');
    await expect(mobileAlbum).toBeVisible();
    const anchoredBackRequests = [];
    const recordAnchoredBackRequest = (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.endsWith('/view-data')
        && url.searchParams.get('gallery_anchor_artist') === requestedArtist
      ) anchoredBackRequests.push(url.href);
    };
    page.on('request', recordAnchoredBackRequest);
    await page.locator('#mobile-back-button').click();
    await expect(mobileAlbum).toBeHidden();
    expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
    expect(new URL(page.url()).searchParams.has('gallery_anchor_artist')).toBe(false);

    await page.evaluate(({ targetArtist, headingSelector }) => {
      const samples = [];
      const readPlacement = () => {
        const scroll = document.getElementById('albums-scroll');
        const header = [...document.querySelectorAll(headingSelector)]
          .find(item => item.getAttribute('data-scroll-artist') === targetArtist);
        const section = header?.closest('.artist-section');
        const rows = section?.querySelector('.artist-rows');
        const firstCard = section?.querySelector('.album-card');
        const chromeName = document.querySelector(
          '[data-gallery-bar-instance="gallery"] [data-gallery-context-name]',
        );
        if (!scroll || !header || !rows || !firstCard || !chromeName) return false;
        const scrollRect = scroll.getBoundingClientRect();
        return chromeName.textContent.trim() === targetArtist
          && Math.abs(rows.getBoundingClientRect().top - scrollRect.top) <= 1
          && firstCard.getBoundingClientRect().top >= scrollRect.top - 1;
      };
      const sample = () => {
        samples.push({ at: performance.now(), stable: readPlacement() });
        window.__albumHavenArtistBackRecorderFrame = requestAnimationFrame(sample);
      };
      window.__albumHavenArtistBackSamples = samples;
      window.__albumHavenArtistBackRecorderFrame = requestAnimationFrame(sample);
    }, { targetArtist: renderedArtist, headingSelector: ui.artistHeadingSelector });

    await page.waitForTimeout(3000);
    const samples = await page.evaluate(() => {
      cancelAnimationFrame(window.__albumHavenArtistBackRecorderFrame);
      return window.__albumHavenArtistBackSamples;
    });
    expect(samples.length).toBeGreaterThan(30);
    expect(samples.filter(sample => !sample.stable)).toEqual([]);
    expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
    page.off('request', recordAnchoredBackRequest);
    expect(anchoredBackRequests).toEqual([]);
  });
});
