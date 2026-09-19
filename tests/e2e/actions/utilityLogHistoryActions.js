import { expect } from '@playwright/test';

export class UtilityLogHistoryActions {
  constructor(utilityLogHistoryTab) {
    this.utilityLogHistoryTab = utilityLogHistoryTab;
  }

  async waitForReady(options = {}) {
    await expect(this.utilityLogHistoryTab.console).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.utilityLogHistoryTab.refresh).toBeEnabled({ timeout: options.timeout || 60000 });
    await expect(this.utilityLogHistoryTab.refresh).toHaveAccessibleName('Refresh');
  }

  async readSummary() {
    const detailTitle = this.utilityLogHistoryTab.detailTitle;
    const emptyState = this.utilityLogHistoryTab.emptySnapshot;
    return {
      itemCount: await this.utilityLogHistoryTab.listItems.count(),
      detailTitle: await detailTitle.count() ? String(await detailTitle.textContent() || '').trim() : '',
      fileCount: await this.utilityLogHistoryTab.detailFiles.count(),
      emptyState: await emptyState.count() ? String(await emptyState.textContent() || '').trim() : '',
    };
  }

  async waitForItemCount(count, options = {}) {
    await this.utilityLogHistoryTab.waitForPageCondition((expected) => (
      document.querySelectorAll(expected.listItemSelector).length === expected.count
    ), {
      timeout: options.timeout || 10000,
    }, {
      count: Number(count),
      listItemSelector: this.utilityLogHistoryTab.listItemSelector,
    });
  }

  async selectEntryByAction(action, options = {}) {
    const entry = this.utilityLogHistoryTab.listItems.filter({
      has: this.utilityLogHistoryTab.page.getByText(String(action), { exact: true }),
    }).first();
    await this.utilityLogHistoryTab.waitForVisible(entry, {
      timeout: options.timeout || 10000,
    });
    await entry.click();
    await this.utilityLogHistoryTab.waitForPageCondition((expected) => (
      String(document.querySelector(expected.activeItemSelector)?.textContent || '')
        .includes(expected.action)
    ), {
      timeout: options.timeout || 10000,
    }, {
      action: String(action),
      activeItemSelector: this.utilityLogHistoryTab.activeItemSelector,
    });
    return String(
      await this.utilityLogHistoryTab.activeListItem.getAttribute('data-utility-log-history-id')
      || '',
    );
  }

  async readSelectedEntryId() {
    return String(
      await this.utilityLogHistoryTab.activeListItem.getAttribute('data-utility-log-history-id')
      || '',
    );
  }

  async readVisibleHistoryText() {
    return String(await this.utilityLogHistoryTab.visibleHistorySurfaces.allTextContents() || '')
      .trim();
  }

  async readPersistedEntry(entryId) {
    return this.utilityLogHistoryTab.readPersistedEntry(String(entryId));
  }

  async reloadBrowserPage() {
    await this.utilityLogHistoryTab.page.reload({ waitUntil: 'domcontentloaded' });
  }

  async exportLogs(options = {}) {
    await this.utilityLogHistoryTab.waitForVisible(this.utilityLogHistoryTab.exportButton, {
      timeout: options.timeout || 10000,
    });
    const downloadPromise = this.utilityLogHistoryTab.page.waitForEvent('download', {
      timeout: options.timeout || 10000,
    });
    await this.utilityLogHistoryTab.exportButton.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Export Logs produced no readable download stream.');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      suggestedFilename: download.suggestedFilename(),
      text,
      document: JSON.parse(text),
    };
  }
}
