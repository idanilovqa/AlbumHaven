export class UtilityAppearanceActions {
  constructor(utilityAppearanceTab) {
    this.utilityAppearanceTab = utilityAppearanceTab;
  }

  async waitForReady(options = {}) {
    await this.utilityAppearanceTab.waitForPageCondition((selectors) => {
      if (typeof state === 'undefined' || state.utility?.activeTab !== 'appearance') return false;
      return Boolean(document.querySelector(selectors.listItemSelector))
        && document.querySelectorAll(selectors.seekbarModeSelector).length >= 2;
    }, {
      timeout: options.timeout || 60000,
    }, {
      listItemSelector: this.utilityAppearanceTab.listItemSelector,
      seekbarModeSelector: this.utilityAppearanceTab.seekbarModeSelector,
    });
  }

  async readSummary() {
    return {
      itemCount: await this.utilityAppearanceTab.listItems.count(),
      seekbarModeCount: await this.utilityAppearanceTab.seekbarModeInputs.count(),
      colorInputCount: await this.utilityAppearanceTab.colorInputs.count(),
      detailTitle: String(await this.utilityAppearanceTab.mainBody.ruleTitle.textContent() || '').trim(),
    };
  }

  async selectSeekbarMode(mode) {
    const normalized = mode === 'waveform' ? 'waveform' : 'default';
    const input = this.utilityAppearanceTab.seekbarModeInput(normalized);
    await input.check();
    await this.utilityAppearanceTab.waitForPageCondition((expected) => {
      const selected = document.querySelector(expected.selector);
      return selected instanceof HTMLInputElement
        && selected.checked
        && state.player?.appearance?.seekbarMode === expected.mode;
    }, { timeout: 60000 }, {
      mode: normalized,
      selector: this.utilityAppearanceTab.seekbarModeSelectorFor(normalized),
    });
  }
}
