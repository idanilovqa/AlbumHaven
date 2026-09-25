import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { TrackModal } from '../poms/trackModal.js';
import { GlobalPlayer } from '../poms/globalPlayer.js';
import { CoverLookup } from '../poms/coverLookup.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';

const screenshotDirectory = path.resolve('test-results/mobile-screenshots');
async function capture(page, name) {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function login(app) {
  await app.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
  await expect(app.homeCards).toHaveCount(8);
}

test.beforeEach(async () => {
  const response = await fetch(`${process.env.MOBILE_LAYOUT_CONTROL_URL}/reset`, { method: 'POST' });
  expect(response.ok).toBeTruthy();
});

test('mobile login, Home rows, artist drawer, search and right-side family panel', async ({ page }) => {
  const app = new MobileLayoutPage(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await capture(page, '01-mobile-login');
  await login(app);
  await expect(app.searchInput).not.toBeVisible();
  await expect(app.homeCards.first()).toHaveAttribute('data-gallery-display', 'list');
  await capture(page, '02-home-rows');
  await app.libraryButton.click();
  await expect(app.artistRail).toHaveClass(/is-mobile-drawer-open/);
  await expect.poll(() => app.librarySectionLabelsFit()).toBeTruthy();
  await capture(page, '03-artist-navigation');
  await app.playlistsMode.click();
  await expect(app.libraryPlaceholder).toContainText('when playlist support is available');
  await app.artistsMode.click();
  await app.closeArtistRail.click();
  await app.searchButton.click();
  await expect(app.searchInput).toBeFocused();
  await app.searchInput.fill('Northlight');
  await app.searchInput.press('Enter');
  await expect(app.galleryCards.first()).toBeVisible();
  await capture(page, '04-search-gallery');
  await app.libraryButton.click();
  await app.artist('Northlight').click();
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer-open/);
  const family = app.familyButton;
  await expect(family).toBeVisible();
  await family.click();
  try { await expect(app.familyPanel).toBeVisible(); }
  finally { await fs.writeFile(path.join(screenshotDirectory, 'family-diagnostic.json'), JSON.stringify({errors, ...await app.diagnosticState()}, null, 2)); }
  await capture(page, '05-artist-family');
  const familyBounds = await app.familyPanel.boundingBox();
  expect(familyBounds.x + familyBounds.width).toBeCloseTo(390, 0);
  await page.keyboard.press('Escape');
  await expect(app.familyPanel).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('two- and three-column cards and art-only modes persist to a fresh mobile session', async ({ page, browser }) => {
  const app = new MobileLayoutPage(page);
  await login(app);
  await app.selectView('cards');
  await capture(page, '06-home-cards-two-columns');
  await app.threeColumnsButton.click();
  await expect(app.homeGrid).toHaveCSS('grid-template-columns', /\S+ \S+ \S+/);
  await expect(app.galleryContextName).toHaveText('Home');
  await capture(page, '07-home-cards-three-columns');
  const saved = page.waitForResponse(response => response.url().includes('/account/layout-preferences')
    && response.request().method() === 'PUT'
    && response.request().postDataJSON()?.changes?.galleryDisplayPreferences?.defaultGalleryDisplayMode === 'covers');
  await app.selectView('covers');
  expect((await saved).status()).toBe(200);
  await capture(page, '08-home-art-only');
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const another = await context.newPage();
    const anotherApp = new MobileLayoutPage(another);
    await login(anotherApp);
    await expect(anotherApp.homeCards.first()).toHaveAttribute('data-gallery-display', 'covers');
    await expect(anotherApp.twoColumnsButton).toBeVisible();
  } finally { await context.close(); }
});

test('album details are a page, keep the player, support Back and full artwork', async ({ page }) => {
  const app = new MobileLayoutPage(page);
  await login(app);
  await app.homeAlbums.first().click();
  await expect(app.albumPage).toBeVisible();
  await expect(app.trackTable).toBeVisible();
  const details = new TrackModal(page);
  await details.coverLightboxButton.click();
  await expect(details.lightboxImage).toBeVisible();
  await capture(page, '15-full-artwork');
  await details.lightboxCloseButton.click();
  await expect(app.albumDialogs).toHaveCount(0);
  await expect(app.editTags).not.toBeVisible();
  await capture(page, '09-album-details');
  await app.backButton.click();
  await expect(app.home).toBeVisible();
  await page.goForward();
  await expect(app.trackTable).toBeVisible();
  await app.backButton.click();
  await app.homeAlbums.first().click();
  await expect(app.trackTable).toBeVisible();
  await expect(app.player).toBeVisible();
});

test('Appearance and Integrations use pages and restricted utilities are absent', async ({ page }) => {
  const app = new MobileLayoutPage(page);
  await login(app);
  await app.openSettings();
  await expect(app.utilityTab('problematic-files')).not.toBeVisible();
  await expect(app.utilityTab('rules')).not.toBeVisible();
  await expect(app.utilitiesDialogs).toHaveCount(0);
  await capture(page, '10-appearance');
  await app.utilityTab('integrations').click();
  await expect(app.pageTitle).toHaveText('Integrations');
  await capture(page, '11-integrations');
  await app.backButton.click();
  await expect(app.home).toBeVisible();
  await app.profileButton.click();
  await expect(app.securityHeading).toBeVisible();
  await capture(page, '12-account');
});

test('narrow phones do not overflow and wide tablets retain desktop geometry', async ({ page }) => {
  const app = new MobileLayoutPage(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await login(app);
  await app.selectView('cards');
  await capture(page, '13-narrow-phone');
  const noOverflow = await app.hasNoHorizontalOverflow();
  expect(noOverflow).toBeTruthy();
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(app.mobileNavigation).not.toBeVisible();
  await expect(app.artistRail).toBeVisible();
  await app.searchInput.fill('Northlight');
  await app.searchInput.press('Enter');
  await expect(app.galleryCards.first()).toBeVisible();
  await capture(page, '14-wide-tablet');
});


test('mobile appearance can be customized, saved and linked back without changing the base profile', async ({page}) => {
  const app = new MobileLayoutPage(page), appearance = new UtilityAppearanceTab(page);
  await login(app);
  await app.openSettings();
  await expect(app.mobileAppearance).toHaveAttribute('aria-pressed', 'true');
  await expect(app.followAppearance).toHaveAttribute('aria-pressed', 'true');
  await expect(app.appearanceFields).toHaveAttribute('disabled', '');
  await expect(appearance.paletteButton('parchment-pine')).toBeDisabled();
  const basePalette = await appearance.documentRoot.getAttribute('data-appearance-palette');
  await app.customAppearance.click();
  await expect(app.appearanceFields).not.toHaveAttribute('disabled');
  await expect(appearance.paletteButton('parchment-pine')).toBeEnabled();
  await appearance.paletteButton('parchment-pine').click();
  await expect.poll(() => appearance.documentRoot.getAttribute('data-appearance-palette')).toBe(basePalette);
  const saved = page.waitForResponse(response => response.url().endsWith('/account/appearance') && response.request().method() === 'PUT');
  await app.saveAppearance.click();
  expect((await saved).status()).toBe(200);
  await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', 'parchment-pine');
  await capture(page, '16-custom-mobile-appearance');
  await page.reload();
  await expect(app.customAppearance).toHaveAttribute('aria-pressed', 'true');
  await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', 'parchment-pine');
  await app.followAppearance.click();
  await app.saveAppearance.click();
  await expect.poll(() => appearance.documentRoot.getAttribute('data-appearance-palette')).toBe(basePalette);
});

test('real local playback continues across pages and player artwork opens its album', async ({page}) => {
  const app = new MobileLayoutPage(page), details = new TrackModal(page), player = new GlobalPlayer(page);
  await login(app);
  const mountedPlayer = await player.player.elementHandle();
  await app.homeAlbums.first().click();
  await details.playButtonAt(1).click();
  await expect(player.title).toContainText('Small Hours');
  await expect(player.playButton).toHaveAttribute('aria-label', /Pause/);
  const bounds = await player.playButton.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await capture(page, '17-playing-album');
  await app.openSettings();
  expect(await player.isConnected(mountedPlayer)).toBeTruthy();
  await expect(player.playButton).toHaveAttribute('aria-label', /Pause/);
  await expect(player.title).toContainText('Coming Home', {timeout: 25000});
  await player.coverButton.click();
  await expect(app.trackTable).toBeVisible();
  await expect(app.utilitiesPage).not.toBeVisible();
  await details.coverLookupButton.click();
  const lookup = new CoverLookup(page);
  await expect(app.coverLookupPage).toBeVisible();
  await expect(lookup.modalDialog).toHaveAttribute('role', 'region');
  await expect(lookup.activeLocalCoverCard).toBeVisible();
  await expect(app.utilitiesPage).not.toBeVisible();
  const coverBounds = await lookup.activeLocalCoverCard.boundingBox();
  expect(coverBounds.y).toBeGreaterThanOrEqual(100);
  expect(coverBounds.y).toBeLessThan(740);
  await capture(page, '18-cover-lookup');
  await app.backButton.click();
  await expect(app.trackTable).toBeVisible();
  await mountedPlayer.dispose();
});
