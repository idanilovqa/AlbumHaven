import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import {
  PERFORMANCE_AUTH_PASSWORD,
  PERFORMANCE_AUTH_USERNAME,
} from '../support/performanceAuthentication.js';

test.use({ reuseAuthentication: false, viewport: { width: 390, height: 844 } });

test('FTC-NON-ALBUM-017 returns from Loose Tracks through bounded Home navigation', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions }) => {
  const mobile = new MobileLayoutPage(page);
  await page.goto('/login');
  await mobile.username.fill(PERFORMANCE_AUTH_USERNAME);
  await mobile.password.fill(PERFORMANCE_AUTH_PASSWORD);
  await Promise.all([
    page.waitForResponse(response => response.request().isNavigationRequest() && response.ok()),
    mobile.signInButton.click(),
  ]);
  await galleryActions.waitForGalleryReady();

  await mobile.libraryButton.click();
  await mobile.artistRail.getByRole('button', { name: 'Custom Collections', exact: true }).click();
  await mobile.artistRail.getByRole('button', { name: 'All Loose Tracks', exact: true }).click();
  await expect(mobile.pageTitle).toHaveText('Loose Tracks');

  const homeRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/home-data' || url.pathname === '/view-data') homeRequests.push(url);
  });
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/home-data' && response.ok()),
    page.getByRole('link', { name: 'Album Haven library', exact: true }).click(),
  ]);
  await expect(mobile.home).toBeVisible();
  expect(homeRequests.some(url => url.pathname === '/view-data'
    && url.searchParams.get('surface') === 'home')).toBe(false);

  await mobile.libraryButton.click();
  const firstArtist = mobile.artistTreeEntries.first();
  const artist = await firstArtist.getAttribute('data-sidebar-artist');
  await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/view-data' && url.searchParams.get('artist') === artist && response.ok();
    }),
    firstArtist.click(),
  ]);
  await galleryActions.waitForGalleryReady();
  await expect(mobile.galleryContextName).toHaveText(artist);
});

test('FTC-NON-ALBUM-019 direct Custom Collection URL repaints its tree after deferred projection hydration', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
  await Promise.all([
    page.waitForResponse(response => response.request().isNavigationRequest() && response.ok()),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await galleryActions.waitForGalleryReady();

  let requests = 0;
  await page.route('**/library/loose-tracks*', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(requests === 1 ? {
        library_non_album_tracks: [],
        non_album_tracks_deferred: true,
      } : {
        library_non_album_tracks: [{
          path: 'C:/Music/Night/one.flac',
          artist: 'Night Artist',
          title: 'One',
          exception_type: 'Custom Collection',
          custom_collection_name: 'Night',
        }],
        non_album_tracks_deferred: false,
      }),
    });
  });

  await page.goto('/loose-tracks?collection=Night');

  const collection = page.locator('#sidebar-list [data-open-custom-collection="Night"]');
  await expect(page.getByRole('heading', { name: 'Custom Collections', exact: true })).toBeVisible();
  await expect(collection).toBeVisible();
  await expect(collection).toHaveAttribute('aria-current', 'true');
  expect(requests).toBe(2);
});

test.describe('desktop library navigation inactivity', () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test('FTC-GALLERY-NAV-032 hides the expanded view rail after inactivity and restores it only from the left edge', {
    tag: '@area:gallery-search',
  }, async ({ page, galleryActions }) => {
    await page.clock.install({ time: Date.now() });
    await page.goto('/login');
    await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
    await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
    await Promise.all([
      page.waitForResponse(response => response.request().isNavigationRequest() && response.ok()),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    await galleryActions.waitForGalleryReady();

    const rail = page.locator('#shell-navigation-rail');
    const viewBar = rail.locator('.library-navigation-mode-rail');
    const edge = page.getByRole('button', { name: 'Show library views', exact: true });
    const tree = page.locator('#sidebar-list');
    const initialTreeLeft = await tree.evaluate(element => element.getBoundingClientRect().left);
    await expect(viewBar).toBeVisible();
    await page.mouse.move(700, 300);
    await page.clock.fastForward(30_001);
    await expect(viewBar).toBeHidden();
    await expect(edge).toBeVisible();
    expect(await edge.evaluate(element => ({
      hitWidth: element.getBoundingClientRect().width,
      markWidth: getComputedStyle(element, '::before').width,
    }))).toEqual({ hitWidth: 2, markWidth: '2px' });
    await expect.poll(
      () => tree.evaluate(element => element.getBoundingClientRect().left),
    ).toBeLessThan(initialTreeLeft - 50);

    await page.mouse.move(3, 300);
    await expect(viewBar).toBeHidden();

    await page.mouse.move(1, 300);
    await expect(viewBar).toBeVisible();
    await expect(edge).toBeHidden();

    await page.getByRole('button', { name: 'Collapse Artist Tree', exact: true }).click();
    await expect(page.locator('#app-shell')).toHaveClass(/is-artist-tree-folded/);
    await page.clock.fastForward(30_001);
    await expect(edge).toBeHidden();
    await expect(rail).not.toHaveClass(/is-library-mode-rail-hidden/);
  });

  test('FTC-NON-ALBUM-018 ends Loose Tracks range selection after release outside the table', {
    tag: '@area:gallery-search',
  }, async ({ page, galleryActions }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
    await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
    await Promise.all([
      page.waitForResponse(response => response.request().isNavigationRequest() && response.ok()),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await galleryActions.waitForGalleryReady();

    await page.getByRole('button', { name: 'Custom Collections', exact: true }).click();
    await page.getByRole('button', { name: 'All Loose Tracks', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Loose Tracks', exact: true })).toBeVisible();

    const rows = page.locator('#non-album-modal [data-track-row-path]');
    await expect(rows.nth(3)).toBeVisible();
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    const fourth = await rows.nth(3).boundingBox();
    const table = await page.locator('#non-album-modal .album-track-table').boundingBox();

    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
    await page.mouse.move(Math.max(1, table.x - 8), second.y + second.height / 2);
    await page.mouse.up();
    await page.mouse.move(fourth.x + fourth.width / 2, fourth.y + fourth.height / 2);

    await expect(page.locator('#non-album-modal .album-track-table__row--selected')).toHaveCount(2);
    await expect(rows.nth(3)).not.toHaveClass(/album-track-table__row--selected/);
    await expect(page.locator('[data-non-album-selection-count]')).toHaveText('2 selected');
  });
});
