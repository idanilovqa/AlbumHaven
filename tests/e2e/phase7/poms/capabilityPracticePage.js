import { expect } from '@playwright/test';
import { CapabilityPage } from './capabilityPage.js';

export class CapabilityPracticePage extends CapabilityPage {
  constructor(page) {
    super(page);
    this.artwork = page.locator('.utility-loop-detail-header .utility-detail-cover img');
  }

  async expectOwnedArtwork(loopId) {
    await expect(this.artwork).toBeVisible();
    await expect(this.artwork).toHaveAttribute('src', new RegExp(`loop_id=${loopId}(?:&|$)`));
    await expect(this.artwork).toHaveJSProperty('complete', true);
    // parity-check: allow-read-only-measurement-evaluate -- verify the real owned artwork decoded
    await expect.poll(() => this.artwork.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  }
}
