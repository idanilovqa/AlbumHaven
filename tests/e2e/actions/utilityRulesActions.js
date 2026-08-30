export class UtilityRulesActions {
  constructor(utilityRulesTab) {
    this.utilityRulesTab = utilityRulesTab;
  }

  async waitForReady(options = {}) {
    await this.utilityRulesTab.waitForPageCondition((selectors) => {
      if (document.getElementById('utility-modal')?.hidden) return false;
      if (typeof state === 'undefined' || state.utility?.activeTab !== 'rules') return false;
      if (state.utility?.rulesLoading) return false;
      const ruleCount = document.querySelectorAll(selectors.listItemSelector).length;
      if (ruleCount === 0) {
        return Boolean(document.querySelector(selectors.listEmptyStateSelector))
          && Boolean(document.querySelector(selectors.detailEmptyStateSelector));
      }
      const title = (document.querySelector(selectors.ruleTitleSelector)?.textContent || '').trim();
      const description = (document.querySelector(selectors.ruleDescriptionSelector)?.textContent || '').trim();
      return title !== '' && description !== '';
    }, {
      timeout: options.timeout || 60000,
    }, {
      listItemSelector: this.utilityRulesTab.listItemSelector,
      listEmptyStateSelector: this.utilityRulesTab.sidebar.emptyStateSelector,
      detailEmptyStateSelector: this.utilityRulesTab.mainBody.emptyStateSelector,
      ruleTitleSelector: this.utilityRulesTab.mainBody.ruleTitleSelector,
      ruleDescriptionSelector: this.utilityRulesTab.mainBody.ruleDescriptionSelector,
    });
  }

  async expectLayoutVisible() {
    await this.utilityRulesTab.waitForVisible(this.utilityRulesTab.sidebar.label);
    await this.utilityRulesTab.waitForVisible(this.utilityRulesTab.sidebar.count);
    await this.utilityRulesTab.waitForVisible(this.utilityRulesTab.sidebar.list);
    await this.utilityRulesTab.waitForVisible(this.utilityRulesTab.mainBody.detail);
  }

  async readSelectedRuleSummary() {
    return {
      title: String(await this.utilityRulesTab.ruleTitle.textContent() || '').trim(),
      description: String(await this.utilityRulesTab.ruleDescription.textContent() || '').trim(),
    };
  }

  async openProblemExclusions() {
    await this.utilityRulesTab.problemExclusionsRule.click();
    await this.utilityRulesTab.ruleTitle.filter({ hasText: 'Problem exclusions' })
      .waitFor({ state: 'visible', timeout: 60000 });
  }

  async readProblemExclusionTables() {
    const readTable = async (table) => {
      if (!await table.count()) {
        return {
          headers: [],
          rows: [],
          actionTrack: '',
          reasonOrigins: [],
        };
      }
      // parity-check: allow-read-only-measurement-evaluate -- capture semantic table structure and geometry atomically
      return table.evaluate((element, selectors) => {
        return {
          headers: Array.from(element.querySelectorAll(selectors.headers), (node) => String(node.textContent || '').trim()),
          rows: Array.from(element.querySelectorAll(selectors.rows), (row) => String(row.textContent || '').trim()),
          actionTrack: getComputedStyle(element).getPropertyValue('--cdt-action-track').trim(),
          reasonOrigins: Array.from(element.querySelectorAll(selectors.reasons), (node) => (
            Math.round(node.getBoundingClientRect().left * 100) / 100
          )),
        };
      }, {
        headers: this.utilityRulesTab.columnHeaderSelector,
        rows: this.utilityRulesTab.keyedTableRowSelector,
        reasons: this.utilityRulesTab.reasonColumnSelector,
      });
    };
    return {
      album: await readTable(this.utilityRulesTab.albumExclusionsTable),
      file: await readTable(this.utilityRulesTab.fileExclusionsTable),
    };
  }

  async readProblemExclusionRows() {
    const readRows = async (table) => (
      (await this.utilityRulesTab.keyedRows(table).allTextContents())
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    return {
      album: await readRows(this.utilityRulesTab.albumExclusionsTable),
      file: await readRows(this.utilityRulesTab.fileExclusionsTable),
    };
  }

  async readProblemExclusionMobileLayout() {
    const readFirstRow = async (table) => {
      const row = this.utilityRulesTab.firstKeyedRow(table);
      // parity-check: allow-read-only-measurement-evaluate -- capture semantic mobile stacking and geometry atomically
      return row.evaluate((element, selectors) => {
        const target = element.querySelector(selectors.target);
        const reason = element.querySelector(selectors.reason);
        const action = element.querySelector(selectors.action);
        const rowBox = element.getBoundingClientRect();
        const targetBox = target?.getBoundingClientRect();
        const reasonBox = reason?.getBoundingClientRect();
        const actionBox = action?.getBoundingClientRect();
        return {
          reasonColumn: reason?.getAttribute('data-cdt-column') || '',
          reasonBelowTarget: Boolean(targetBox && reasonBox && reasonBox.top >= targetBox.bottom - 1),
          revertTopRight: Boolean(actionBox
            && Math.abs(actionBox.top - rowBox.top) <= 12
            && Math.abs(actionBox.right - rowBox.right) <= 12),
          visibleReasonLabelCount: Array.from(element.querySelectorAll(selectors.descendants)).filter((node) => (
            String(node.textContent || '').trim() === 'Reason'
            && getComputedStyle(node).display !== 'none'
            && getComputedStyle(node).visibility !== 'hidden'
          )).length,
        };
      }, {
        target: this.utilityRulesTab.targetColumnSelector,
        reason: this.utilityRulesTab.reasonColumnSelector,
        action: this.utilityRulesTab.actionColumnSelector,
        descendants: this.utilityRulesTab.allDescendantsSelector,
      });
    };
    return {
      album: await readFirstRow(this.utilityRulesTab.albumExclusionsTable),
      file: await readFirstRow(this.utilityRulesTab.fileExclusionsTable),
    };
  }

  async revertRuleContaining(text) {
    const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
    ));
    const row = this.utilityRulesTab.exclusionRowContaining(text);
    await this.utilityRulesTab.revertButtonForRow(row).click();
    await row.waitFor({ state: 'detached', timeout: 60000 });
    const response = await acknowledgement;
    if (!response.ok()) {
      throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
    }
  }

  async revertRuleByKey(rowKey) {
    const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
    ));
    const row = this.utilityRulesTab.exclusionRowByKey(rowKey);
    await this.utilityRulesTab.revertButtonForRow(row).click();
    await row.waitFor({ state: 'detached', timeout: 60000 });
    const response = await acknowledgement;
    if (!response.ok()) {
      throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
    }
  }

  async beginRevertRuleContaining(text) {
    const requestStarted = this.utilityRulesTab.page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/utilities/rules/problem-ignores/revert'
    ));
    const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
    ));
    let acknowledgementSettled = false;
    acknowledgement.then(
      () => { acknowledgementSettled = true; },
      () => { acknowledgementSettled = true; },
    );
    const row = this.utilityRulesTab.exclusionRowContaining(text);
    await this.utilityRulesTab.revertButtonForRow(row).click();
    await row.waitFor({ state: 'detached', timeout: 60000 });
    await requestStarted;
    return {
      isAcknowledgementSettled: () => acknowledgementSettled,
      waitForAcknowledgement: async () => {
        const response = await acknowledgement;
        if (!response.ok()) {
          throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
        }
      },
    };
  }

  async waitForPendingAlbumExclusion(text) {
    const row = this.utilityRulesTab.pendingExclusionRowContaining(text);
    await row.waitFor({ state: 'visible', timeout: 60000 });
    const revertButton = this.utilityRulesTab.revertButtonForRow(row);
    await revertButton.waitFor({ state: 'visible', timeout: 60000 });
    return {
      ariaBusy: await row.getAttribute('aria-busy'),
      revertDisabled: await revertButton.isDisabled(),
      text: String(await row.textContent() || '').trim(),
    };
  }

  async waitForExclusionAcknowledged(text) {
    const row = this.utilityRulesTab.exclusionRowContaining(text);
    await row.waitFor({ state: 'visible', timeout: 60000 });
    await this.utilityRulesTab.pendingExclusionRowContaining(text)
      .waitFor({ state: 'hidden', timeout: 60000 });
    await this.utilityRulesTab.revertButtonForRow(row).waitFor({ state: 'visible', timeout: 60000 });
    if (await this.utilityRulesTab.revertButtonForRow(row).isDisabled()) {
      throw new Error('Acknowledged Problem Exclusion row kept Revert rule disabled.');
    }
  }
}
