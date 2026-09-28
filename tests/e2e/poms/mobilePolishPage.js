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
    this.selectedSettingsSection = this.settingsDrawer.locator('.navigation-tree-item.is-selected');
    this.settingsDrawerBack = this.settingsDrawer.getByRole('button', { name: 'Back to settings', exact: true });
    this.adminDrawer = this.accountHost.locator('[data-settings-nav]');
    this.adminBack = this.adminDrawer.getByRole('button', { name: 'Back to page', exact: true });
    this.adminActions = this.accountHost.locator('[data-admin-action]:not(.is-danger)');
    this.ownerInfo = this.accountHost.locator('.admin-role-info');
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
    this.mainSurface = page.locator('#shell-main-surface');
    this.header = page.locator('.app-bar--library');
    this.brand = this.header.locator('.app-bar-brand');
    this.albumContextMenu = page.locator('#album-card-context-menu');
    this.selectionPreviewRow = page.locator('.selection-preview-example.is-navigation-selected');
    this.alertFamily = page.locator('[data-alert-family="signal"].appearance-alert-family-card');
    this.lightbox = page.locator('#image-lightbox');
    this.visibleAccountMenu = page.locator('#app-shell [data-account-menu]:not([hidden])');
  }

  async expectAdminFeedback() {
    await expect(this.ownerInfo).toHaveAttribute('data-on-page-alert', 'info');
    // parity-check: allow-read-only-measurement-evaluate -- compare the shared action controls' rendered dimensions.
    const boxes = await this.adminActions.evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    expect(boxes.length).toBeGreaterThan(1);
    for (const box of boxes) { expect(box.width).toBeCloseTo(140, 0); expect(box.height).toBeCloseTo(40, 0); }
    const header = await this.accountBar.boundingBox();
    expect(header.y).toBeLessThanOrEqual(85);
    await this.accountNavToggle.click();
    await expect(this.adminDrawer.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    await expect(this.adminBack.locator('svg')).toHaveCSS('stroke-width', '1.7px');
    await this.adminBack.click();
    await expect(this.adminDrawer).not.toBeVisible();
  }

  async expectHeaderActionsAligned() {
    const controls = this.page.locator('.app-bar--library .toolbar-right > .action-button, .app-bar--library [data-account-menu-trigger], #search-form .search-field-control');
    // parity-check: allow-read-only-measurement-evaluate -- measure actual mobile header button rectangles.
    const boxes = await controls.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()).filter(box => box.width && box.height).map(box => ({ width: box.width, height: box.height, center: box.y + box.height / 2 })));
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    for (const box of boxes) { expect(box.width).toBeCloseTo(40, 0); expect(box.height).toBeCloseTo(40, 0); }
    expect(Math.max(...boxes.map(box => box.center)) - Math.min(...boxes.map(box => box.center))).toBeLessThanOrEqual(1);
  }

  async expectAppearanceFooterFits() {
    const footer = this.page.locator('#utility-modal-footer');
    const boxes = await Promise.all(['reset', 'secondary', 'primary'].map(action => footer.locator(`[data-editor-footer-action="${action}"]`).boundingBox()));
    for (const box of boxes) { expect(box).not.toBeNull(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(this.page.viewportSize().width); }
    expect(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y))).toBeLessThanOrEqual(1);
    expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
    expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
  }

  async expectNumericRatings() {
    const rating = this.galleryCards.locator('.rating-row:not([data-rating-value="0"])').first();
    await expect(rating.locator('.rating-text')).toBeVisible();
    await expect(rating.locator('.rating-text')).toHaveText(/^[1-9]0?\/10$/);
    await expect(rating.locator('.stars')).not.toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- verify rendered rating colors and bounds.
    const paint = await rating.locator('.rating-text').evaluate(node => ({ ink: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, width: node.getBoundingClientRect().width, parent: node.closest('.album-card').getBoundingClientRect().width }));
    expect(paint.width).toBeLessThan(paint.parent);
    this.expectContrast([paint]);
  }

  async expectChromeMenu(menu) {
    await expect(menu).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- compare the menu paint against its actual app bar owner.
    const paint = await menu.evaluate(node => ({ ink: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, bar: getComputedStyle(document.querySelector('.app-bar')).backgroundColor }));
    expect(paint.background).toBe(paint.bar);
    this.expectContrast([paint]);
  }

  async inspectHeaderMenus() {
    const sources = this.page.locator('#gallery-sources-button');
    const sourceMenu = this.page.locator('#gallery-sources-menu');
    await sources.click();
    await this.expectChromeMenu(sourceMenu);
    await sources.click();
    await expect(sourceMenu).not.toBeVisible();
    await sources.click();
    await this.galleryContextName.click();
    await expect(sourceMenu).not.toBeVisible();
    await sources.click();
    await this.page.keyboard.press('Escape');
    await this.page.locator('#scan-indicator').click({ button: 'right' });
    await this.expectChromeMenu(this.page.locator('#status-context-menu'));
    await this.page.keyboard.press('Escape');
  }

  async expectPlayerMetadataNearCover() {
    const art = await this.page.locator('#player-cover-button').boundingBox();
    const title = await this.playerArtist.boundingBox();
    expect(title.x - (art.x + art.width)).toBeGreaterThanOrEqual(0);
    expect(title.x - (art.x + art.width)).toBeLessThanOrEqual(12);
  }

  async expectGalleryLoadingOwnsPage() {
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });
      await this.libraryButton.click();
      await this.artist('Northlight').click();
      const loader = this.page.locator('#library-loader');
      await expect(loader).toBeVisible();
      await expect(this.mainGalleryBar).not.toBeVisible();
      await expect(this.home).not.toBeVisible();
      const main = await this.page.locator('#shell-main-surface').boundingBox();
      const loading = await loader.boundingBox();
      expect(loading.y - main.y).toBeLessThanOrEqual(20);
      await expect(this.galleryCards.first()).toBeVisible();
    } finally { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await cdp.detach(); }
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
    this.expectContrast(colors);
  }

  async expectPrimaryActionContrast(name = 'Add user', role = 'link') {
    const button = this.accountHost.getByRole(role, { name, exact: true });
    await expect(button).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- verify the actual button's paired theme colors.
    const colors = await button.evaluate(node => ({ ink: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    this.expectContrast([colors]);
  }

  expectContrast(colors) {
    const luminance = color => {
      const values = color.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi).map(Number).slice(0, 3);
      if (color.startsWith('oklab(')) {
        const [L, a, b] = values;
        const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
        const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
        const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
        const rgb = [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
          -.0041960863 * l - .7034186147 * m + 1.707614701 * s].map(value => Math.max(0, Math.min(1, value)));
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      }
      const rgb = values.map(value => color.startsWith('color(') ? value : value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    for (const pair of colors) {
      const ink = luminance(pair.ink), background = luminance(pair.background);
      expect((Math.max(ink, background) + .05) / (Math.min(ink, background) + .05), JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
    }
  }

  async expectBarAligned(bar) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect visible shared bar controls in a single frame.
    const centers = await bar.evaluate(node => [...(node.matches('[data-gallery-bar-instance="gallery"]') ? node.querySelector('.gallery-bar__actions') : node).querySelectorAll('.action-button:not(.unfolding-action-button__action), .gallery-action-button, .gallery-view-cluster')]
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
    await this.expectNumericRatings();
    await expect(this.page.locator('.album-card .rating-row[data-rating-value="0"]:visible')).toHaveCount(0);
    // parity-check: allow-read-only-measurement-evaluate -- every rendered title and statistic keeps a single line.
    const wraps = await this.galleryCards.locator('.album-title-button, .album-subtitle, .track-count, .album-length')
      .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).whiteSpace));
    expect(wraps.length).toBeGreaterThan(0);
    expect(wraps.every(value => value === 'nowrap')).toBe(true);
  }
}
