// Settings → Edits Queue (MusicBrainz Delivery 2, S4): the Data Correction kinds and their pages.
export class UtilityEditsQueueActions {
  constructor(utilityEditsQueueTab) {
    this.utilityEditsQueueTab = utilityEditsQueueTab;
  }

  async waitForKind(kind, options = {}) {
    await this.utilityEditsQueueTab.kindButton(kind).waitFor({ state: 'visible', timeout: options.timeout || 60000 });
  }

  // Opens a kind and waits until its first page of albums is visible.
  async openKindFirstPage(kind, options = {}) {
    await this.utilityEditsQueueTab.kindButton(kind).click();
    await this.utilityEditsQueueTab.albumRows.first().waitFor({ state: 'visible', timeout: options.timeout || 60000 });
  }
}
