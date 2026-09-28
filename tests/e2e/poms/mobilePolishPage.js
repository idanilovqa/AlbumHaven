import { expect } from '@playwright/test';
import { MobileLayoutPage } from './mobileLayoutPage.js';
import { UtilityAppearanceTab } from './utilityAppearanceTab.js';

/** Native phone interactions and read-only visual measurements for the feedback batch. */
export class MobilePolishPage extends MobileLayoutPage {
  constructor(page) {
    super(page);
    this.mainGalleryBar = page.locator('[data-gallery-bar-instance="gallery"]');
    this.firstTrackTitle = this.albumRows.first().locator('.album-track-table__title');
    this.selectedCover = this.coverLookupPage.locator('.cover-lookup-art-card.is-active');
    this.accountHost = page.locator('[data-settings-host]:not([hidden])');
    this.accountBar = this.accountHost.locator('.page-gallery-bar');
    this.parentLink = this.accountBar.locator('[data-settings-parent]');
    this.usersTable = this.accountHost.getByRole('table');
    this.userActions = this.accountHost.getByRole('button', { name: 'Actions for Rendref', exact: true });
    this.memberMenu = this.accountHost.locator('[data-member-menu]:not([hidden])');
    this.permissionLabels = this.accountHost.locator('.permission-group label');
    this.recentSuggestions = page.locator('#recent-search-popover');
    this.clearSearch = page.locator('#search-form [data-search-clear]');
    this.searchField = page.locator('#search-form .search-field-control');
    this.artistDialog = page.locator('.artist-info-overlay[aria-modal="true"]');
    this.artistInfo = page.locator('#artist-groups [data-artist-info-trigger]').first();
    this.familyBody = this.familyPanel.locator('[data-gallery-family-panel-body]');
    this.loopSongs = this.utilitiesPage.locator('[data-utility-loop-group-key]');
    this.loopEntries = this.utilitiesPage.locator('[data-utility-loop-entry]');
    this.loopPlay = this.loopEntries.first().locator('[data-loop-play]');
    this.loopTime = this.loopEntries.first().locator('[data-loop-time]');
    this.visibleAccountMenu = page.locator('#app-shell [data-account-menu]:not([hidden])');
  }

  async usePalette(id) {
    await this.openSettings();
    await this.selectSubsection('backgrounds');
    await this.customAppearance.click();
    await new UtilityAppearanceTab(this.page).paletteButton(id).click();
    await this.saveAppearanceChanges();
    await this.backButton.click();
    await expect(this.galleryContextName).toHaveText('Rendref');
  }

  async openUsers() {
    await this.settingsButton.click();
    await this.adminLink.click();
    await expect(this.usersTable).toBeVisible();
  }

  async expectResponsiveUsers() {
    await expect(this.usersTable.getByRole('columnheader')).toHaveCount(3);
    await expect(this.userActions).toBeVisible();
    const frame = await this.usersTable.boundingBox();
    expect(frame.width).toBeLessThanOrEqual(this.page.viewportSize().width);
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
    await this.userActions.click();
    await expect(this.memberMenu.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible();
    const menu = await this.memberMenu.boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(this.page.viewportSize().width);
  }

  async expectPermissionContrast() {
    await expect(this.permissionLabels.first()).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- read text and surrounding theme colors, never modify the page.
    const colors = await this.permissionLabels.evaluateAll(labels => labels.map(label => ({
      ink: getComputedStyle(label).color,
      background: getComputedStyle(label.closest('.settings-outlet')).backgroundColor,
    })));
    const luminance = color => {
      const values = color.match(/[\d.]+/g).map(Number).slice(0, 3);
      const rgb = values.map(value => color.startsWith('color(') ? value : value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    for (const pair of colors) {
      const ink = luminance(pair.ink), background = luminance(pair.background);
      expect((Math.max(ink, background) + .05) / (Math.min(ink, background) + .05)).toBeGreaterThanOrEqual(4.5);
    }
  }

  async expectBarAligned(bar) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect visible shared bar controls in a single frame.
    const centers = await bar.evaluate(node => [...node.querySelectorAll('.action-button:not(.unfolding-action-button__action), .gallery-action-button, .gallery-view-cluster')]
      .map(button => button.getBoundingClientRect()).filter(rect => rect.width && rect.height)
      .map(rect => rect.top + rect.height / 2));
    expect(centers.length).toBeGreaterThan(1);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  }

  async expectSettingsDrawerAtBodyTop() {
    const body = await this.page.locator('#shell-main-surface').boundingBox();
    const drawer = await this.settingsDrawer.boundingBox();
    expect(drawer.y).toBeCloseTo(body.y, 0);
    expect(drawer.width).toBeLessThanOrEqual(this.page.viewportSize().width * .75 + 1);
  }

  async expectViewUnfoldsDown() {
    const before = await this.viewCluster.boundingBox();
    await this.activeView.click();
    await expect(this.viewCluster).toHaveClass(/is-open/);
    const after = await this.viewCluster.boundingBox();
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
    await expect.poll(async () => {
      const boxes = await Promise.all(['cards', 'covers', 'list'].map(view => this.viewCluster.locator(`[data-gallery-view-choice="${view}"]`).boundingBox()));
      return Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y));
    }).toBeGreaterThan(40);
    await this.viewCluster.locator('[data-gallery-view-choice="covers"]').click();
  }

  async nativePinch(scale) {
    const box = await this.galleryScroll.boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + Math.min(150, box.height / 2) };
    const cdp = await this.page.context().newCDPSession(this.page);
    const points = span => [0, 1].map(index => ({ x: center.x + (index ? 1 : -1) * span / 2, y: center.y, id: index }));
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(110) });
      for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(110 * (1 + (scale - 1) * step / 12)) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
  }

  async expectGridColumns(count) {
    // parity-check: allow-read-only-measurement-evaluate -- count computed grid tracks after a real gesture.
    await expect.poll(async () => (await this.galleryGrid.evaluate(grid => getComputedStyle(grid).gridTemplateColumns)).split(' ').length).toBe(count);
    // parity-check: allow-read-only-measurement-evaluate -- pinch changes application density, not browser magnification.
    expect(await this.page.evaluate(() => window.visualViewport.scale)).toBe(1);
  }

  async firstFamilySwipe() {
    await expect(this.familyBody).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- confirm the prepared short-phone panel has overflowing real entries.
    expect(await this.familyBody.evaluate(body => body.scrollHeight - body.clientHeight)).toBeGreaterThan(0);
    await expect.poll(async () => { const box = await this.familyPanel.boundingBox(); return box.x + box.width; }).toBeCloseTo(this.page.viewportSize().width, 0);
    const box = await this.familyBody.boundingBox();
    const cdp = await this.page.context().newCDPSession(this.page);
    const point = y => [{ x: box.x + box.width / 2, y, id: 0 }];
    try {
      const start = box.y + box.height - 20, end = box.y + 20;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start) });
      for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(start + (end - start) * step / 12) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    // parity-check: allow-read-only-measurement-evaluate -- inspect native scroll position after the first swipe.
    await expect.poll(() => this.familyBody.evaluate(body => body.scrollTop)).toBeGreaterThan(0);
  }

  async expectArtistDialogCentered() {
    const box = await this.artistDialog.boundingBox(), viewport = this.page.viewportSize();
    expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(viewport.height / 2, 0);
    await expect(this.artistDialog.getByRole('button', { name: 'Close artist information' })).toBeVisible();
  }

  async resumeBeforeDoubleTap() {
    const seconds = text => { const parts = text.split('/')[0].trim().split(':').map(Number); return parts[0] * 60 + parts[1]; };
    const frozen = seconds(await this.playerTime.textContent());
    await this.playerPlay.tap();
    await expect.poll(async () => seconds(await this.playerTime.textContent())).toBeGreaterThan(frozen);
  }

  async expectLoopAdvancing() {
    // parity-check: allow-read-only-measurement-evaluate -- observe the real saved-loop audio clock after tapping its play control.
    await expect.poll(() => this.loopEntries.first().locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(.2);
  }

  async expectJoinedSuggestions() {
    await expect(this.recentSuggestions).toBeVisible();
    await expect.poll(async () => {
      const field = await this.searchField.boundingBox(), menu = await this.recentSuggestions.boundingBox();
      return Math.abs(menu.x - field.x) + Math.abs(menu.width - field.width);
    }).toBeLessThanOrEqual(2);
    await expect(this.searchButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }

  async expectCardTextAndStats() {
    await expect(this.page.locator('.album-card .is-card-text-overflowing').first()).toBeVisible();
    await expect(this.page.locator('.album-card .rating-row:visible')).toHaveCount(0);
    // parity-check: allow-read-only-measurement-evaluate -- every rendered title and statistic keeps a single line.
    const wraps = await this.galleryCards.locator('.album-title-button, .album-subtitle, .track-count, .album-length')
      .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).whiteSpace));
    expect(wraps.length).toBeGreaterThan(0);
    expect(wraps.every(value => value === 'nowrap')).toBe(true);
  }
}
