import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';

test('approved Home A has account identity, disabled News, keyboard tabs and no gallery controls', async ({ page, app, snapshot }) => {
  await expect(app.galleryContextName).toHaveText('Rendref');
  await expect(app.recentTab).toHaveAttribute('aria-selected', 'true');
  await expect(app.newsTab).toBeDisabled();
  await expect(app.viewCluster).not.toBeVisible();
  await expect(app.zoomButton).not.toBeVisible();
  await expect(app.libraryButton).toBeVisible();
  await app.expectHeaderNavigationBeforeTitle('gallery');
  await snapshot('40-approved-home-a-dark');
  for (const name of ['Top tracks', 'Top albums', 'Top Artists']) {
    const tab = app.homeTabs.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(app.homePanel).toHaveText('Nothing to show yet. Work in progress.');
  }
  await app.homeTabs.getByRole('tab', { name: 'Top Artists', exact: true }).press('Home');
  await expect(app.homeTabs.getByRole('tab', { name: 'Top tracks', exact: true })).toBeFocused();
  await app.openSettings();
  await app.customAppearance.click();
  await new UtilityAppearanceTab(page).paletteButton('parchment-pine').click();
  await app.saveAppearanceChanges();
  await app.backButton.click();
  await expect(app.galleryContextName).toHaveText('Rendref');
  await snapshot('41-approved-home-a-light');
  await app.browseArtist();
  await expect(app.viewCluster).toBeVisible();
  await expect(app.recentTab).not.toBeVisible();
});

test('original large album and both approved small-art choices persist with shared header and scroll identity', async ({ page, app, snapshot }) => {
  for (const [index, layout] of ['classic_bar', 'stacked_bar', 'editorial_canvas'].entries()) {
    await app.openSettings();
    await app.selectSubsection('album-page');
    if (index === 0) await app.customAppearance.click();
    await app.albumLayout(layout).click();
    await app.saveAppearanceChanges();
    await app.search('Sixteen Horizons');
    await app.openAlbumBody('Sixteen Horizons');
    await expect(app.albumRows).toHaveCount(16);
    await expect(app.albumPage).toHaveAttribute('data-mobile-album-layout', layout);
    await expect(app.pageTitle).toHaveText('Sixteen Horizons');
    await expect(app.albumThumbnail).not.toBeVisible();
    const cover = await app.albumCover.boundingBox(), table = await app.trackTable.boundingBox();
    if (layout === 'classic_bar') {
      await expect(app.albumIdentity).not.toBeVisible();
      await expect(app.pageTitle).toBeVisible();
      expect(cover.width).toBeCloseTo(table.width, 0);
    } else {
      await expect(app.albumIdentity).toContainText('Northlight');
      await expect(app.albumIdentityTitle).toBeInViewport();
      await expect(app.pageTitle).not.toBeVisible();
      await expect(app.pageSummary).not.toBeVisible();
      expect(cover.width).toBeLessThan(table.width);
      const identity = await app.albumIdentity.boundingBox();
      if (layout === 'stacked_bar') {
        expect(cover.width).toBeLessThanOrEqual(120);
        expect(identity.x).toBeGreaterThanOrEqual(cover.x + cover.width);
      } else {
        expect(cover.width).toBeGreaterThan(150);
        expect(identity.y).toBeGreaterThanOrEqual(cover.y + cover.height);
        expect(cover.x + cover.width / 2).toBeCloseTo(table.x + table.width / 2, 0);
        await expect(app.albumIdentityTitle).toHaveCSS('text-align', 'center');
        await expect(app.albumIdentitySummary).toHaveCSS('text-align', 'center');
        expect((await app.albumIdentityCopy.boundingBox()).width).toBeCloseTo(table.width, 0);
      }
    }
    if (layout !== 'classic_bar') await app.expectApprovedAlbumOverview(layout);
    await snapshot(`42-album-${layout.replaceAll('_', '-')}`);
    await app.scrollRegion('album', 900);
    await expect(app.albumThumbnail).toBeVisible();
    await expect(app.pageTitle).toBeVisible();
    await expect(app.pageSummary).toBeVisible();
    if (layout !== 'classic_bar') {
      await expect(app.albumIdentity).not.toBeInViewport();
      await expect(app.albumIdentity).toHaveAttribute('aria-hidden', 'true');
    }
    const thumb = await app.albumThumbnail.boundingBox(), title = await app.pageTitle.boundingBox();
    expect(thumb.x + thumb.width).toBeLessThanOrEqual(title.x);
    await snapshot(`43-scrolled-${layout.replaceAll('_', '-')}`);
    await app.scrollRegion('album', -1500);
    await expect(app.albumCover).toBeInViewport();
    await expect(app.albumThumbnail).not.toBeVisible();
    if (layout !== 'classic_bar') {
      await expect(app.albumIdentityTitle).toBeInViewport();
      await expect(app.pageTitle).not.toBeVisible();
    } else await expect(app.pageTitle).toBeVisible();
    await page.reload();
    await expect(app.albumRows).toHaveCount(16);
    await expect(app.albumPage).toHaveAttribute('data-mobile-album-layout', layout);
  }
});

test('thin mobile progress uses real playback, seeking and saved UI choice without changing desktop', async ({ page, app, snapshot, browser }) => {
  await app.search('Sixteen Horizons');
  await app.openAlbumBody('Sixteen Horizons');
  await app.playRow(0);
  await expect(app.playerPlay).toHaveAttribute('aria-label', 'Pause');
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'thin');
  await expect.poll(async () => (await app.thinProgressGeometry()).value).toBeGreaterThan(0);
  await app.seekAt(.4);
  await expect.poll(async () => (await app.thinProgressGeometry()).progress).toBeGreaterThan(35);
  const line = await app.thinProgressGeometry();
  expect(line.backgroundSize).toBe('100% 3px');
  expect(line.height).toBeGreaterThanOrEqual(24);
  expect(line.bottom).toBeCloseTo(line.playerBottom, 0);
  expect(line.progress).toBeCloseTo(line.value / line.max * 100, 1);
  await app.expectThinPlayerComposition();
  await snapshot('44-real-thin-progress');
  await page.setViewportSize({ width: 320, height: 740 });
  await app.expectThinPlayerComposition();
  await snapshot('46-narrow-thin-player');
  await page.setViewportSize({ width: 390, height: 844 });
  await app.playerPlay.click();
  await expect(app.playerPlay).toHaveAttribute('aria-label', 'Play');
  await app.expectThinPlayerComposition();
  const pausedPosition = Number(await app.timeline.inputValue());
  await app.openSettings();
  await app.selectSubsection('seekbar');
  await app.customAppearance.click();
  await expect(app.thinOption).toBeChecked();
  await app.regularOption.check();
  await app.saveAppearanceChanges();
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'regular');
  await app.thinOption.check();
  await app.cancelAppearance.click();
  await expect(app.regularOption).toBeChecked();
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'regular');
  await app.waveformOption.check();
  await app.saveAppearanceChanges();
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'waveform');
  await app.thinOption.check();
  const savedLayout = page.waitForResponse(response => response.url().endsWith('/account/layout-preferences')
    && response.request().method() === 'PUT' && response.request().postDataJSON()?.changes?.playerAppearance?.seekbarMode === 'thin');
  await app.saveAppearanceChanges();
  expect((await savedLayout).status()).toBe(200);
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'thin');
  expect(Number(await app.timeline.inputValue())).toBeCloseTo(pausedPosition, 0);
  await expect(app.playerPreview).toHaveAttribute('data-seekbar-mode', 'thin');
  await expect(app.playerPreviewKnob).not.toBeVisible();
  await snapshot('45-thin-progress-setting');
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const other = new MobileLayoutPage(await context.newPage());
    await other.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
    await expect(other.player).toHaveAttribute('data-player-seekbar-presentation', 'thin');
    await other.openSettings();
    await other.selectSubsection('seekbar');
    await expect(other.thinOption).toBeChecked();
  } finally { await context.close(); }
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(app.player).toHaveAttribute('data-player-seekbar-presentation', 'regular');
});


test('hamburger menus precede the name in Gallery, Settings and Password headers', async ({ app, snapshot }) => {
  await app.expectHeaderNavigationBeforeTitle('gallery');
  await app.browseArtist();
  await app.expectHeaderNavigationBeforeTitle('gallery');
  await app.openSettings();
  await app.expectHeaderNavigationBeforeTitle('settings');
  await app.selectUtility('integrations');
  await app.expectHeaderNavigationBeforeTitle('settings');
  await snapshot('47-settings-menu-left');
  await app.openPassword();
  await app.expectHeaderNavigationBeforeTitle('account');
  await snapshot('48-password-menu-left');
});


test('empty mobile player keeps its centered message beside the disabled transport', async ({ page, app, snapshot }) => {
  await app.expectEmptyPlayerComposition();
  await snapshot('49-empty-thin-player');
  await page.setViewportSize({ width: 320, height: 740 });
  await app.expectEmptyPlayerComposition();
  await page.setViewportSize({ width: 390, height: 844 });
  await app.openSettings();
  await app.selectSubsection('seekbar');
  await app.customAppearance.click();
  await app.regularOption.check();
  await app.saveAppearanceChanges();
  await app.expectEmptyPlayerComposition();
  await snapshot('50-empty-regular-player');
});

test('relocated album actions retain cover lookup and Back without changing the selected layout', async ({ app }) => {
  for (const [index, layout] of ['stacked_bar', 'editorial_canvas'].entries()) {
    await app.openSettings();
    await app.selectSubsection('album-page');
    if (index === 0) await app.customAppearance.click();
    await app.albumLayout(layout).click();
    await app.saveAppearanceChanges();
    await app.search('Sixteen Horizons');
    await app.openAlbumBody('Sixteen Horizons');
    await app.expectApprovedAlbumOverview(layout);
    await app.albumCoverSearch.click();
    await expect(app.coverLookupPage).toBeVisible();
    await app.backButton.click();
    await expect(app.albumPage).toHaveAttribute('data-mobile-album-layout', layout);
    await app.expectApprovedAlbumOverview(layout);
  }
});


test('switching through original artwork restores each approved overview without reloading', async ({ app, snapshot }) => {
  await app.search('Sixteen Horizons');
  await app.openAlbumBody('Sixteen Horizons');
  for (const [index, layout] of ['stacked_bar', 'classic_bar', 'editorial_canvas', 'classic_bar', 'stacked_bar'].entries()) {
    await app.openSettings();
    await app.selectSubsection('album-page');
    if (index === 0) await app.customAppearance.click();
    await app.albumLayout(layout).click();
    await app.saveAppearanceChanges();
    await app.backButton.click();
    await expect(app.albumPage).toHaveAttribute('data-mobile-album-layout', layout);
    await expect(app.albumRows).toHaveCount(16);
    if (layout === 'classic_bar') {
      await expect(app.pageTitle).toBeVisible();
      await expect(app.albumIdentity).not.toBeVisible();
    } else {
      await expect(app.pageTitle).not.toBeVisible();
      await expect(app.albumIdentity).toBeVisible();
      await app.expectApprovedAlbumOverview(layout);
    }
  }
  await snapshot('51-approved-a-after-layout-roundtrip');
});
