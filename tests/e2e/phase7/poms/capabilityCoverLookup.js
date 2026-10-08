import { CoverLookup } from '../../poms/coverLookup.js';

export class CapabilityCoverLookup extends CoverLookup {
  localCandidate(path) {
    return this.modalBody.locator(`[data-select-local-cover=${JSON.stringify(path)}]`);
  }

  constructor(page, testInfo) {
    super(page, testInfo);
    this.providerCandidates = this.subsectionTitles.filter({ hasText: /^From services$/ })
      .locator('xpath=following-sibling::div[1]').locator('[data-select-remote-cover]');
    this.manualCandidates = this.subsectionTitles.filter({ hasText: /^MANUAL LINKS$/ })
      .locator('xpath=following-sibling::div[1]').locator('[data-select-remote-cover]');
  }
}
