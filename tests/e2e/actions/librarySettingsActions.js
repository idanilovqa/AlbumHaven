export class LibrarySettingsActions {
  constructor(librarySettings) {
    this.librarySettings = librarySettings;
  }

  async open() {
    await this.librarySettings.integrationsTab.click();
    await this.librarySettings.waitForVisible(this.librarySettings.libraryIntegration, { timeout: 60000 });
    await this.librarySettings.libraryIntegration.click();
    await this.librarySettings.waitForVisible(this.librarySettings.albumRatingsHeading, { timeout: 60000 });
    await this.librarySettings.waitForVisible(this.librarySettings.importRatingsButton, { timeout: 60000 });
  }

  async importRatings(previousResult = '') {
    await this.librarySettings.importRatingsButton.click();
    await this.librarySettings.waitForPageCondition((args) => {
      const result = document.querySelector(args.resultSelector);
      const button = document.querySelector(args.buttonSelector);
      const resultText = String(result?.textContent || '').replace(/\s+/gu, ' ').trim();
      return resultText.length > 0
        && resultText !== args.previousResult
        && button instanceof HTMLButtonElement
        && !button.disabled;
    }, { timeout: 60000 }, {
      resultSelector: '[data-album-rating-import-result="1"]',
      buttonSelector: '[data-import-album-ratings="1"]',
      previousResult,
    });
    return this.readImportResult();
  }

  async readImportResult() {
    const text = String(await this.librarySettings.importResult.textContent() || '')
      .replace(/\s+/gu, ' ')
      .trim();
    const match = /^Created: (\d+) · Authority skipped: (\d+) · Failed: (\d+)$/u.exec(text);
    if (!match) throw new Error(`Unexpected album-rating import result: ${text}`);
    return {
      created: Number(match[1]),
      authoritySkipped: Number(match[2]),
      failed: Number(match[3]),
      text,
    };
  }
}
