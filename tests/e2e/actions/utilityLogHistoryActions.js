export class UtilityLogHistoryActions {
  constructor(utilityLogHistoryTab) {
    this.utilityLogHistoryTab = utilityLogHistoryTab;
  }

  async waitForReady(options = {}) {
    await this.utilityLogHistoryTab.waitForPageCondition((selectors) => {
      if (typeof state === 'undefined' || state.utility?.activeTab !== 'log-history') return false;
      if (state.utility?.logHistoryLoading) return false;
      return Boolean(document.querySelector(selectors.listItemSelector))
        || Boolean(document.querySelector(selectors.emptyStateSelector));
    }, {
      timeout: options.timeout || 60000,
    }, {
      listItemSelector: this.utilityLogHistoryTab.listItemSelector,
      emptyStateSelector: this.utilityLogHistoryTab.mainBody.emptyStateSelector,
    });
  }

  async readSummary() {
    const detailTitle = this.utilityLogHistoryTab.mainBody.ruleTitle;
    const emptyState = this.utilityLogHistoryTab.mainBody.emptyState;
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

  async readBrowserStoredEntry(entryId) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the existing browser-owned IndexedDB entry
    return this.utilityLogHistoryTab.page.evaluate(async ({ databaseName, storeName, id }) => {
      if (typeof indexedDB.databases !== 'function') {
        throw new Error('Browser database discovery is unavailable.');
      }
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === databaseName)) {
        throw new Error('Browser log history database is missing.');
      }
      return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(databaseName);
        openRequest.addEventListener('error', () => reject(
          openRequest.error || new Error('Unable to open browser log history.'),
        ), { once: true });
        openRequest.addEventListener('success', () => {
          const database = openRequest.result;
          if (!database.objectStoreNames.contains(storeName)) {
            reject(new Error('Browser log history object store is missing.'));
            return;
          }
          const databaseVersion = database.version;
          const transaction = database.transaction(storeName, 'readonly');
          const getRequest = transaction.objectStore(storeName).get(id);
          getRequest.addEventListener('error', () => reject(
            getRequest.error || new Error('Unable to read browser log history entry.'),
          ), { once: true });
          getRequest.addEventListener('success', () => {
            resolve({ databaseVersion, entry: getRequest.result || null });
          }, { once: true });
        }, { once: true });
      });
    }, {
      databaseName: 'album-haven-client-diagnostics',
      storeName: 'log-history',
      id: String(entryId),
    });
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
