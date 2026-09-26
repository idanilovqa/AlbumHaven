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
      expect(cover.width).toBeCloseTo(table.width, 0);
    } else {
      await expect(app.albumIdentity).toContainText('Northlight');
      expect(cover.width).toBeLessThan(table.width);
      const identity = await app.albumIdentity.boundingBox();
      if (layout === 'stacked_bar') {
        expect(cover.width).toBeLessThanOrEqual(120);
        expect(identity.x).toBeGreaterThanOrEqual(cover.x + cover.width);
      } else {
        expect(cover.width).toBeGreaterThan(150);
        expect(identity.y).toBeGreaterThanOrEqual(cover.y + cover.height);
        expect(cover.x + cover.width / 2).toBeCloseTo(table.x + table.width / 2, 0);
      }
    }
    await snapshot(`42-album-${layout.replaceAll('_', '-')}`);
    await app.scrollRegion('album', 900);
    await expect(app.albumThumbnail).toBeVisible();
    const thumb = await app.albumThumbnail.boundingBox(), title = await app.pageTitle.boundingBox();
    expect(thumb.x + thumb.width).toBeLessThanOrEqual(title.x);
    await snapshot(`43-scrolled-${layout.replaceAll('_', '-')}`);
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
  await snapshot('44-real-thin-progress');
  await app.playerPlay.click();
  await expect(app.playerPlay).toHaveAttribute('aria-label', 'Play');
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
