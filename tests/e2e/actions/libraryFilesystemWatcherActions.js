import { expect } from '@playwright/test';

import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

export class LibraryFilesystemWatcherActions {
  constructor(libraryWatchStatus) {
    this.libraryWatchStatus = libraryWatchStatus;
  }

  async readStatus() {
    const response = await authenticatedPageGet(this.libraryWatchStatus.page, '/status');
    expect(response.ok()).toBe(true);
    return response.json();
  }

  async waitForRevisionAfter(previousRevision, options = {}) {
    let observed = null;
    await expect.poll(async () => {
      observed = await this.readStatus();
      return Number(observed.inventory_mutation_revision || 0);
    }, {
      timeout: options.timeout || 60000,
      intervals: [100, 250, 500, 1000],
      message: `Expected inventory revision to advance beyond ${previousRevision}`,
    }).toBeGreaterThan(Number(previousRevision || 0));
    return observed;
  }
}
