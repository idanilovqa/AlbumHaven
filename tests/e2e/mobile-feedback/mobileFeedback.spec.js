import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { TrackModal } from '../poms/trackModal.js';
import { GlobalPlayer } from '../poms/globalPlayer.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';
import { UtilityIntegrationsTab } from '../poms/utilityIntegrationsTab.js';

test('row-body opens the sixteen-track album; scrolling shows a bar thumbnail; search leaves details', async ({ page, app, snapshot }) => {
  await app.search('Sixteen Horizons');
  await app.openAlbumBody('Sixteen Horizons');
  await expect(app.albumRows).toHaveCount(16);
  await expect(app.albumThumbnail).not.toBeVisible();
  const art = await app.albumCover.boundingBox(), table = await app.trackTable.boundingBox();
  expect(art.x).toBeCloseTo(table.x, 0);
  expect(art.x + art.width).toBeCloseTo(table.x + table.width, 0);
  await snapshot('21-sixteen-track-album');
  await app.scrollRegion('album', 520);
  await expect(app.albumThumbnail).toBeVisible();
  await snapshot('22-sticky-album-identity');
  await app.playRow(10);
  const player = new GlobalPlayer(page);
  await expect(player.title).toContainText('Quiet Motion');
  await expect(player.playButton).toHaveAttribute('aria-label', /Pause/);
  await expect(app.playerArtist).toHaveText('Northlight');
  await expect(app.playerTime).toHaveCSS('white-space', 'nowrap');
  await app.search('Echo Harbor');
  await expect(app.albumPage).not.toBeVisible();
  await expect(app.galleryCards.first()).toContainText('Another Shore');
  await expect(player.player).toBeVisible();
  await snapshot('23-search-from-album');
});

test('single expanding search and zoom support 1/2/3 columns; Rows disappears at desktop width', async ({ page, app, snapshot }) => {
  await expect(app.mobileNavigation.getByRole('button', { name: 'Search', exact: true })).toHaveCount(1);
  await app.searchButton.click();
  await expect(app.searchInput).toBeFocused();
  await app.searchButton.click();
  await expect(app.searchInput).not.toBeVisible();
  await app.search('Northlight');
  await app.selectView('covers');
  for (const columns of [3, 2, 1]) {
    await app.selectColumns(columns);
    await expect(app.zoomButton).toHaveAttribute('title', `Gallery zoom: ${columns} ${columns === 1 ? 'column' : 'columns'}`);
  }
  await expect.poll(async () => (await app.galleryCards.first().boundingBox())?.width).toBeGreaterThan(320);
  await snapshot('24-single-column-art');
  await page.setViewportSize({ width: 1366, height: 900 });
  await app.activeView.click();
  await expect(app.viewCluster.getByRole('button', { name: 'Rows', exact: true })).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(app.mobileNavigation).not.toBeVisible();
  await snapshot('25-desktop-gallery');
});

test('owner Settings drawer exposes real sections; subsections include Library and Scrobbling', async ({ page, app, snapshot }) => {
  await app.openSettings();
  await app.settingsSectionsButton.click();
  await expect(app.settingsDrawer.getByRole('button', { name: 'Rules', exact: true })).toBeVisible();
  await expect(app.settingsDrawer.getByRole('button', { name: 'Loops', exact: true })).toBeVisible();
  await expect(app.settingsDrawer.getByRole('button', { name: 'Log History', exact: true })).toBeVisible();
  expect((await app.settingsDrawer.boundingBox()).width).toBeLessThanOrEqual(390 * .75 + 1);
  await snapshot('26-settings-drawer');
  await page.keyboard.press('Escape');
  for (const section of ['rules', 'loops', 'log-history']) {
    await app.selectUtility(section);
    await expect(app.utilitiesPage).toHaveAttribute('data-active-tab', section);
  }
  await app.selectUtility('integrations');
  await app.selectSubsection('library');
  await expect(app.subsectionButton).toContainText('Library');
  await snapshot('27-library-settings');
  await app.selectSubsection('lastfm');
  const integration = new UtilityIntegrationsTab(page);
  await expect(integration.lastfmUsername).toBeVisible();
  await expect(app.subsectionButton).toHaveText('Scrobbling');
  await snapshot('28-scrobbling-settings');
});

test('mobile Appearance stays on Mobile, follows saved desktop, uses a page surface and pins player preview', async ({ page, app, snapshot }) => {
  const appearance = new UtilityAppearanceTab(page);
  await app.openSettings();
  await expect(app.mobileAppearance).toHaveAttribute('aria-pressed', 'true');
  await app.customAppearance.click();
  await appearance.paletteButton('parchment-pine').click();
  await app.saveAppearance.click();
  await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', 'parchment-pine');
  await snapshot('29-light-appearance-page');
  await app.selectSubsection('seekbar');
  await expect(appearance.playerPreviewDock).toBeVisible();
  await app.scrollRegion('album', 350);
  const bounds = await appearance.playerPreviewDock.boundingBox(), header = await app.pageTitle.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(header.y);
  expect(bounds.y).toBeLessThan(300);
  await snapshot('30-pinned-player-preview');
  await app.selectSubsection('album-page');
  await expect(app.mobileAlbumLayoutChoice).not.toBeVisible();
  await snapshot('31-mobile-album-options');
});

test('Cover Look Up has one header, two candidates, pinned action and artwork controls below the image', async ({ page, app, snapshot }) => {
  const details = new TrackModal(page);
  await app.search('Sixteen Horizons');
  await app.openAlbumBody('Sixteen Horizons');
  await details.coverLookupButton.click();
  await expect(app.pageTitle).toHaveText('Cover Art Look Up');
  await expect(app.coverCandidates).toHaveCount(2);
  const first = await app.coverCandidates.nth(0).boundingBox(), second = await app.coverCandidates.nth(1).boundingBox();
  expect(first.y).toBeCloseTo(second.y, 0);
  expect(second.x).toBeGreaterThan(first.x);
  await expect(app.manualCoverSearch).not.toBeVisible();
  await expect(app.coverResults).not.toBeVisible();
  const before = await app.findBetterArt.boundingBox();
  await app.scrollRegion('cover', 800);
  const after = await app.findBetterArt.boundingBox();
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.y + after.height).toBeLessThanOrEqual((await app.player.boundingBox()).y);
  await snapshot('32-cover-lookup');
  await app.backButton.click();
  await details.coverLightboxButton.click();
  await expect(app.fullArtwork).toBeVisible();
  await expect(app.fullArtworkNav.getByRole('button', { name: 'Next cover' })).toBeVisible();
  const picture = await app.fullArtwork.boundingBox(), controls = await app.fullArtworkNav.boundingBox();
  expect(controls.y).toBeGreaterThanOrEqual(picture.y + picture.height);
  await snapshot('33-full-artwork-controls');
});

test('long related family stays narrow and All Artists follows the top scrolled artist', async ({ page, app, snapshot }) => {
  await app.libraryButton.click();
  await expect(app.artistHeading).toHaveText('Artists');
  expect((await app.artistRail.boundingBox()).width).toBeLessThanOrEqual(390 * .75 + 1);
  await app.artist('Northlight').click();
  await app.familyButton.click();
  await expect(app.familyPanel).toBeVisible();
  expect((await app.familyPanel.boundingBox()).width).toBeLessThanOrEqual(390 * .75 + 1);
  await expect.poll(() => app.familyArtists.count()).toBeGreaterThan(5);
  await snapshot('34-extended-artist-family');
  await page.keyboard.press('Escape');
  await app.libraryButton.click();
  await app.allArtists.click();
  await expect(app.home).not.toBeVisible();
  await app.scrollRegion('gallery', 1100);
  await expect(app.galleryContextName).not.toHaveText(/^(Home|Gallery)$/);
  await snapshot('35-all-artists-scrolled');
});
