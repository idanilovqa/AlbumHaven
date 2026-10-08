import { expect } from '@playwright/test';
import { MobileTouchFeedbackPage } from './mobileTouchFeedbackPage.js';

/** Native input at an exposed background control, without forced locator clicks. */
export class SurfaceDismissalPage extends MobileTouchFeedbackPage {
  constructor(page) {
    super(page);
    this.artworkTriggers = page.locator('#artist-groups .album-card__artbox-trigger');
    this.activeArtist = this.artistRail.locator('.navigation-tree-item.is-selected').first();
    this.activeAdminItem = page.locator('[data-settings-nav] .navigation-tree-item.is-selected').first();
    this.addUser = page.getByRole('link', { name: 'Add user', exact: true });
    this.artistTreeToggle = page.getByRole('button', { name: 'Artist Tree', exact: true });
    this.artistBackdrop = page.locator('#shell-navigation-rail-backdrop');
    this.trackOverlay = page.locator('#track-modal');
    this.trackClose = page.locator('#track-modal-close');
    this.lightboxTrigger = this.albumCover.locator('[data-open-lightbox]').first();
  }

  async pointOnBackgroundArtwork(surface) {
    const popup = await surface.boundingBox();
    const header = await this.mainGalleryBar.boundingBox();
    const player = await this.player.boundingBox();
    for (const trigger of await this.artworkTriggers.all()) {
      const box = await trigger.boundingBox();
      if (!box) continue;
      const top = Math.max(box.y, header.y + header.height) + 6;
      const bottom = Math.min(box.y + box.height, player.y) - 6;
      if (top >= bottom) continue;
      for (const x of [box.x + 6, box.x + box.width - 6]) {
        const y = (top + bottom) / 2;
        if (x <= 0 || x >= this.page.viewportSize().width) continue;
        if (x < popup.x || x > popup.x + popup.width || y < popup.y || y > popup.y + popup.height) return { x, y };
      }
    }
    throw new Error('No exposed real background artwork is available for the dismissal scenario');
  }

  async activatePoint(point, input = 'touch') {
    if (input === 'mouse') await this.page.mouse.click(point.x, point.y);
    else await this.page.touchscreen.tap(point.x, point.y);
  }

  async dismissOverAlbumAndOpenOnNextTap(surface, input = 'touch') {
    await expect(surface).toBeVisible();
    const point = await this.pointOnBackgroundArtwork(surface);
    const url = this.page.url();
    const heading = await this.galleryContextName.textContent();
    await this.activatePoint(point, input);
    await expect(surface).not.toBeVisible();
    await expect(this.trackTable).not.toBeVisible();
    expect(this.page.url()).toBe(url);
    await expect(this.galleryContextName).toHaveText(heading);
    await this.activatePoint(point, input);
    await expect(this.trackTable).toBeVisible();
  }

  async activateUncoveredArtwork(surface, input = 'touch') {
    await expect(surface).toBeVisible();
    await this.activatePoint(await this.pointOnBackgroundArtwork(surface), input);
    await expect(surface).not.toBeVisible();
    await expect(this.trackTable).toBeVisible();
  }

  async clickSettingsPosition() {
    const box = await this.settingsButton.boundingBox();
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  async toggleExposedPlayer() {
    // parity-check: allow-read-only-measurement-evaluate -- hit-test the actual exposed player and read its production playback owner.
    const before = await this.playerPlay.evaluate(button => {
      const box = button.getBoundingClientRect();
      return { exposed: button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
        paused: getPlayerPlaybackSnapshot().paused };
    });
    expect(before.exposed).toBe(true);
    await this.playerPlay.tap();
    // parity-check: allow-read-only-measurement-evaluate -- observe real playback state after the native action.
    await expect.poll(() => this.page.evaluate(() => getPlayerPlaybackSnapshot().paused)).toBe(!before.paused);
    await expect(this.playerPlay).toHaveAttribute('aria-label', before.paused ? 'Pause' : 'Play');
  }

  async expectSelectedAccent(item) {
    await expect(item).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- compare the actual selected edge with its inherited theme/account token.
    const edge = await item.evaluate(node => {
      const base = getComputedStyle(node), pseudo = getComputedStyle(node, '::before');
      return { width: pseudo.width, color: pseudo.backgroundColor, pointerEvents: pseudo.pointerEvents,
        token: base.getPropertyValue('--navigation-tree-selection-accent-color').trim()
          || base.getPropertyValue('--appearance-selected-accent').trim()
          || base.getPropertyValue('--accent').trim() };
    });
    expect(edge.width).toBe('3px');
    expect(edge.pointerEvents).toBe('none');
    const match = edge.token.match(/^#([a-f\d]{6})$/i);
    const expected = match ? `rgb(${[0, 2, 4].map(index => parseInt(match[1].slice(index, index + 2), 16)).join(', ')})` : edge.token;
    expect(edge.color).toBe(expected);
    expect(edge.color).not.toBe('rgba(0, 0, 0, 0)');
  }

  async openAccountMenuOutsideSettingsDrawer() {
    await this.openSettings();
    await this.settingsSectionsButton.tap();
    await this.expectSelectedAccent(this.selectedSettingsSection);
    await this.settingsButton.tap();
    await expect(this.settingsDrawer).not.toBeVisible();
    await expect(this.settingsMenu).toBeVisible();
    await this.settingsButton.tap();
  }

  async inspectStandaloneAdminDismissal() {
    await this.page.goto('/admin/members');
    await expect(this.usersTable).toBeVisible();
    await this.accountNavToggle.tap();
    await this.expectSelectedAccent(this.activeAdminItem);
    const add = await this.addUser.boundingBox();
    const point = { x: add.x + add.width - 6, y: add.y + add.height / 2 };
    const url = this.page.url();
    await this.activatePoint(point);
    await expect(this.adminDrawer).not.toBeVisible();
    expect(this.page.url()).toBe(url);
    await expect(this.usersTable).toBeVisible();
    await this.userActions.tap();
    await expect(this.memberMenu).toBeVisible();
    await this.activatePoint(point);
    await expect(this.memberMenu).not.toBeVisible();
    expect(this.page.url()).toBe(url);
    await this.activatePoint(point);
    await expect(this.page).toHaveURL(/\/admin\/accounts\/new$/);
  }
}
