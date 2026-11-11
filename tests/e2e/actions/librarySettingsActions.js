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

  /** What the Library Data Corrections section shows, in page order. */
  async readDataCorrections() {
    return this.librarySettings.page.evaluate(() => {
      const section = document.querySelector('[aria-labelledby="library-data-corrections-heading"]');
      const order = (text) => document.querySelector('.utility-rule-detail')?.textContent.indexOf(text) ?? -1;
      return {
        heading: section?.querySelector('h4')?.textContent.trim() || '',
        description: section?.querySelector('p')?.textContent.trim() || '',
        options: Array.from(section?.querySelectorAll('input[type="radio"]') || []).map((input) => ({
          label: input.closest('label')?.textContent.trim() || '',
          checked: input.checked,
          disabled: input.disabled,
        })),
        aboveAlbumRatings: order('Library Data Corrections') >= 0 && order('Library Data Corrections') < order('Album ratings'),
      };
    });
  }

  async chooseDataCorrectionsMode(label) {
    const radio = this.librarySettings.dataCorrectionsMode(label);
    await radio.check();
    await this.librarySettings.waitForPageCondition((expected) => (
      document.querySelector(`input[name="library-metadata-corrections"][value="${expected}"]`)?.checked === true
    ), { timeout: 10000 }, label === 'Write in tags' ? 'write_tags' : 'display_only');
  }

  async save() {
    await this.librarySettings.saveButton.click();
    await this.librarySettings.waitForPageCondition((selector) => {
      const button = document.querySelector(selector);
      return button instanceof HTMLButtonElement && !button.disabled && button.textContent.trim() === 'Save library settings';
    }, { timeout: 60000 }, '[data-save-library-settings="1"]');
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
