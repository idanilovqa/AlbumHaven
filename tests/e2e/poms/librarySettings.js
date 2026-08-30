import { BasePage } from './basePage.js';

export class LibrarySettings extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.integrationsTab = page.locator('[data-utility-tab="integrations"]');
    this.libraryIntegration = page.locator('[data-utility-integration-key="library"]');
    this.albumRatingsHeading = page.getByRole('heading', { name: 'Album ratings', exact: true });
    this.importRatingsButton = page.locator('[data-import-album-ratings="1"]');
    this.importResult = page.locator('[data-album-rating-import-result="1"]');
  }
}
