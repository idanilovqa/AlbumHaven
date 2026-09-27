import { expect } from '@playwright/test';
import { MobilePolishPage } from './mobilePolishPage.js';

/** Shared saved-loop controls; interactions use the production UI in both widths. */
export class MobileLoopsPage extends MobilePolishPage {
  constructor(page) {
    super(page);
    this.root = page.locator('#utility-modal');
    this.loopEntries = this.root.locator('[data-utility-loop-entry]');
    this.song = this.root.locator('[data-utility-loop-group-key]').filter({ hasText: 'After the Rain' }).first();
    this.entry = this.root.locator('[data-utility-loop-entry="mobile-demo-loop-opening-motif"]');
    this.play = this.entry.locator('[data-loop-play]');
    this.audio = this.entry.locator('audio');
    this.seek = this.entry.locator('[data-loop-timeline]');
    this.pitch = this.entry.locator('[data-loop-pitch-value-button]');
    this.speed = this.entry.locator('[data-loop-speed-value-button]');
    this.repeat = this.entry.locator('[data-toggle-loop-repeat]');
    this.pitchMenu = page.locator('[data-loop-pitch-menu="mobile-demo-loop-opening-motif"]');
    this.speedMenu = page.locator('[data-loop-speed-menu="mobile-demo-loop-opening-motif"]');
    this.desktopLoopsTab = this.root.locator('[data-utility-tab="loops"]');
  }

  async openFourLoopSong() {
    await this.openSettings();
    await this.selectUtility('loops');
    await this.song.click();
    await expect(this.loopEntries).toHaveCount(4);
    await expect(this.entry).toBeVisible();
  }

  async expectCompactPlayers() {
    await expect(this.loopEntries).toHaveCount(4);
    // parity-check: allow-read-only-measurement-evaluate -- measure every real card, control and text row; no injected product state.
    const cards = await this.loopEntries.evaluateAll(entries => entries.map(entry => {
      const rect = node => node.getBoundingClientRect().toJSON();
      const play = entry.querySelector('[data-loop-play]');
      const seek = entry.querySelector('[data-loop-timeline]');
      const controls = ['[data-toggle-loop-repeat]', '[data-loop-pitch-value-button]', '[data-loop-speed-value-button]'].map(selector => rect(entry.querySelector(selector)));
      const time = entry.querySelector('[data-loop-time]');
      return { box: rect(entry), play: rect(play), seek: rect(seek), controls,
        time: rect(time), whiteSpace: getComputedStyle(time).whiteSpace,
        overflow: entry.scrollWidth > entry.clientWidth + 1,
        glyph: play.querySelector('svg') !== null };
    }));
    for (const card of cards) {
      expect(card.overflow).toBe(false);
      expect(card.box.height).toBeLessThanOrEqual(160);
      expect(card.box.x).toBeGreaterThanOrEqual(0);
      expect(card.box.right).toBeLessThanOrEqual(this.page.viewportSize().width);
      expect(card.glyph).toBe(true);
      expect(card.play.y + card.play.height / 2).toBeCloseTo(card.seek.y + card.seek.height / 2, 0);
      expect(card.controls.every(control => Math.abs(control.y - card.controls[0].y) < 1)).toBe(true);
      expect(card.time.height).toBeLessThan(20);
      expect(card.whiteSpace).toBe('nowrap');
    }
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
  }

  async exercisePlaybackAndMenus() {
    await this.play.tap();
    await expect(this.play).toHaveAttribute('aria-label', 'Pause');
    // parity-check: allow-read-only-measurement-evaluate -- observe the actual saved clip clock after a native tap.
    await expect.poll(() => this.audio.evaluate(audio => audio.currentTime)).toBeGreaterThan(.2);
    await this.play.tap();
    await expect(this.play).toHaveAttribute('aria-label', 'Play');
    const box = await this.seek.boundingBox();
    await this.seek.click({ position: { x: box.width / 2, y: box.height / 2 } });
    // parity-check: allow-read-only-measurement-evaluate -- seeking must change the real clip, not just the range paint.
    await expect.poll(() => this.audio.evaluate(audio => audio.currentTime)).toBeGreaterThan(2);
    await this.speed.tap();
    await expect(this.speedMenu).toBeVisible();
    await this.speedMenu.getByRole('menuitemradio', { name: '2x', exact: true }).click();
    await expect(this.speed).toHaveText('2x');
    await expect(this.speedMenu).not.toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- speed operates on the same native saved-loop audio owner.
    expect(await this.audio.evaluate(audio => audio.playbackRate)).toBe(2);
    await this.speed.tap();
    await this.pitch.tap();
    await expect(this.speedMenu).not.toBeVisible();
    await expect(this.pitchMenu).toBeVisible();
    await this.page.keyboard.press('Escape');
    await expect(this.pitchMenu).not.toBeVisible();
    await expect(this.pitch).toBeFocused();
    await this.pitch.tap();
    const preview = this.page.waitForResponse(response => response.url().endsWith('/loops/pitch-preview') && response.request().method() === 'POST');
    await this.pitchMenu.getByRole('menuitemradio', { name: '+2 semitones', exact: true }).click();
    expect((await preview).ok()).toBe(true);
    await expect(this.pitch).toHaveText('Pitch +2');
    await expect(this.pitch).toHaveAttribute('aria-busy', 'false');
    await expect(this.pitchMenu).not.toBeVisible();
    await expect(this.audio).toHaveCount(1);
    await this.repeat.tap();
    await expect(this.repeat).toHaveAttribute('aria-pressed', 'true');
    await this.repeat.tap();
    await expect(this.repeat).toHaveAttribute('aria-pressed', 'false');
  }

  async expectPickerInsideViewport(menu) {
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox(), viewport = this.page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }

  async openDesktopLoops() {
    await this.page.setViewportSize({ width: 1440, height: 1000 });
    await this.page.goto('/');
    await this.settingsButton.click();
    await this.utilitiesButton.click();
    await expect(this.root).toBeVisible();
    await this.desktopLoopsTab.click();
    await this.song.click();
    await expect(this.loopEntries).toHaveCount(4);
    await expect(this.pitch).not.toBeVisible();
    await expect(this.entry.locator('[data-loop-pitch-step="1"]')).toBeVisible();
    await expect(this.entry.locator('[data-loop-speed-step="0.05"]')).toBeVisible();
    await expect(this.speed).toBeVisible();
  }
}
