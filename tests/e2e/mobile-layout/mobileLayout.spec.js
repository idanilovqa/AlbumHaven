const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs/promises');

const screenshotDirectory = path.resolve('test-results/mobile-screenshots');
async function capture(page, name) {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
  await page.getByLabel('Username').fill('rendref');
  await page.getByLabel('Password', { exact: true }).fill('Phase Seven Owner Passphrase 2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#app-shell')).toBeVisible();
  await expect(page.locator('#mobile-home .album-card')).toHaveCount(8);
}
async function selectView(page, view) {
  const cluster = page.locator('#gallery-view-cluster-options');
  await cluster.locator('.is-active').click();
  await cluster.locator(`[data-gallery-view-choice="${view}"]`).click();
  await expect(cluster).not.toHaveClass(/is-open/);
}
async function settings(page) {
  await page.locator('#app-shell [data-account-menu-trigger]').click();
  await page.locator('#app-shell [data-open-utilities]').click();
  await expect(page.locator('#mobile-page-outlet #utility-modal')).toBeVisible();
}

test.beforeEach(async () => {
  const response = await fetch(`${process.env.MOBILE_LAYOUT_CONTROL_URL}/reset`, { method: 'POST' });
  expect(response.ok).toBeTruthy();
});

test('mobile login, Home rows, artist drawer, search and right-side family panel', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await capture(page, '01-mobile-login');
  await login(page);
  await expect(page.locator('#search-input')).not.toBeVisible();
  await expect(page.locator('#mobile-home .album-card').first()).toHaveAttribute('data-gallery-display', 'list');
  await capture(page, '02-home-rows');
  await page.locator('#mobile-library-button').click();
  await expect(page.locator('#shell-navigation-rail')).toHaveClass(/is-mobile-drawer-open/);
  await capture(page, '03-artist-navigation');
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await expect(page.locator('#mobile-library-placeholder')).toContainText('when playlist support is available');
  await page.getByRole('button', { name: 'Artists', exact: true }).click();
  await page.locator('#shell-navigation-rail [data-close-artists-drawer]').click();
  await page.locator('#mobile-search-button').click();
  await expect(page.locator('#search-input')).toBeFocused();
  await page.locator('#search-input').fill('Northlight');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#artist-groups .album-card').first()).toBeVisible();
  await capture(page, '04-search-gallery');
  await page.locator('#mobile-library-button').click();
  await page.locator('#sidebar-list [data-sidebar-artist="Northlight"]').click();
  const family = page.locator('[data-gallery-bar-action="artist-family"]');
  await expect(family).toBeVisible();
  await family.click();
  await expect(page.locator('#artist-family-panel')).toBeVisible();
  await capture(page, '05-artist-family');
  expect(errors).toEqual([]);
});

test('two- and three-column cards and art-only modes persist to a fresh mobile session', async ({ page, browser }) => {
  await login(page);
  await selectView(page, 'cards');
  await capture(page, '06-home-cards-two-columns');
  await page.getByRole('button', { name: 'Use three columns' }).click();
  await expect(page.locator('.mobile-home-grid')).toHaveCSS('grid-template-columns', /\S+ \S+ \S+/);
  await capture(page, '07-home-cards-three-columns');
  await selectView(page, 'covers');
  await capture(page, '08-home-art-only');
  await expect.poll(async () => (await page.request.get('/account/layout-preferences')).json()).toMatchObject({
    profiles: { mobile: { mobileGridColumns: 3, galleryDisplayPreferences: { defaultGalleryDisplayMode: 'covers' } } },
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const another = await context.newPage();
    await login(another);
    await expect(another.locator('#mobile-home .album-card').first()).toHaveAttribute('data-gallery-display', 'covers');
    await expect(another.getByRole('button', { name: 'Use two columns' })).toBeVisible();
  } finally { await context.close(); }
});

test('album details are a page, keep the player, support Back and full artwork', async ({ page }) => {
  await login(page);
  await page.locator('#mobile-home [data-open-tracklist]').first().click();
  await expect(page.locator('#mobile-page-outlet #track-modal')).toBeVisible();
  await expect(page.locator('#track-modal .album-track-table')).toBeVisible();
  await expect(page.locator('#track-modal [aria-modal="true"]')).toHaveCount(0);
  await expect(page.locator('#track-modal-edit-tags')).not.toBeVisible();
  await capture(page, '09-album-details');
  await page.locator('#mobile-back-button').click();
  await expect(page.locator('#mobile-home')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#track-modal .album-track-table')).toBeVisible();
  await page.locator('#mobile-back-button').click();
  await page.locator('#mobile-home [data-open-tracklist]').first().click();
  await expect(page.locator('#track-modal .album-track-table')).toBeVisible();
  await expect(page.locator('.global-player')).toBeVisible();
});

test('Appearance and Integrations use pages and restricted utilities are absent', async ({ page }) => {
  await login(page);
  await settings(page);
  await expect(page.locator('#utility-modal [data-utility-tab="problematic-files"]')).not.toBeVisible();
  await expect(page.locator('#utility-modal [data-utility-tab="rules"]')).not.toBeVisible();
  await expect(page.locator('#utility-modal [role="dialog"]')).toHaveCount(0);
  await capture(page, '10-appearance');
  await page.locator('#utility-modal [data-utility-tab="integrations"]').click();
  await expect(page.locator('#mobile-page-title')).toHaveText('Integrations');
  await capture(page, '11-integrations');
  await page.locator('#mobile-back-button').click();
  await expect(page.locator('#mobile-home')).toBeVisible();
  await page.locator('#app-shell .account-profile-button').click();
  await expect(page.getByRole('heading', { name: 'Password & security' })).toBeVisible();
  await capture(page, '12-account');
});

test('narrow phones do not overflow and wide tablets retain desktop geometry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await login(page);
  await selectView(page, 'cards');
  await capture(page, '13-narrow-phone');
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBeTruthy();
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(page.locator('#mobile-navigation')).not.toBeVisible();
  await expect(page.locator('#shell-navigation-rail')).toBeVisible();
  await page.locator('#search-input').fill('Northlight');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#artist-groups .album-card').first()).toBeVisible();
  await capture(page, '14-wide-tablet');
});
