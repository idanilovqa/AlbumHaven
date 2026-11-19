import { BasePage } from './basePage.js';

// Settings → Edits Queue (MusicBrainz Delivery 2, S4): Data Correction kinds and their album pages.
export class UtilityEditsQueueTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.albumRows = page.locator('[data-edits-queue-album-row]');
  }

  kindButton(kind) {
    return this.page.locator(`[data-edits-queue-open-kind="${kind}"]`);
  }
}
