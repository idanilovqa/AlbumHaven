export class UtilityProblematicFilesActions {
  constructor(utilityProblematicFilesTab) {
    this.utilityProblematicFilesTab = utilityProblematicFilesTab;
    this.mutationObservation = null;
    this.navigationObservation = null;
  }

  async waitForReady(options = {}) {
    const timeout = options.timeout || 60000;
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      const isVisible = (element) => Boolean(element && (
        element.offsetWidth
        || element.offsetHeight
        || element.getClientRects().length
      ));
      const firstItem = document.querySelector(expected.listItemSelector);
      const activeItem = document.querySelector(expected.activeListItemSelector);
      const detailTitle = document.querySelector(expected.detailTitleSelector);
      const populatedReady = isVisible(firstItem)
        && isVisible(activeItem)
        && isVisible(detailTitle)
        && Boolean(String(detailTitle.textContent || '').trim());
      if (expected.requirePopulated) {
        return populatedReady;
      }
      return populatedReady || isVisible(document.querySelector(expected.listEmptyStateSelector));
    }, { timeout }, {
      requirePopulated: Boolean(options.requirePopulated),
      listItemSelector: this.utilityProblematicFilesTab.listItemSelector,
      activeListItemSelector: this.utilityProblematicFilesTab.activeListItemSelector,
      detailTitleSelector: this.utilityProblematicFilesTab.detailTitleSelector,
      listEmptyStateSelector: this.utilityProblematicFilesTab.listEmptyStateSelector,
    });
  }

  async expectCoreLayoutVisible(options = {}) {
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.sidebar.label);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.sidebar.count);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.searchSection.searchInput);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.searchSection.problemFilterButton);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.sidebar.list);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.mainBody.detail);
    const visibleListItems = await this.utilityProblematicFilesTab.listItems.count();
    if (options.requirePopulated && visibleListItems === 0) {
      throw new Error('Expected Problematic Files to render a populated list, but the utility stayed empty.');
    }
    if (visibleListItems === 0) {
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.listEmptyState);
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailEmptyState);
      return;
    }
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailOpenInExplorerButton);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailEditTagsButton);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailDiscogsButton);
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailDetectedProblemsSection);
    if (await this.utilityProblematicFilesTab.detailSuggestedEditsSection.count()) {
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailSuggestedEditsSection);
    }
  }

  async openTagEditor() {
    await this.utilityProblematicFilesTab.waitForVisible(
      this.utilityProblematicFilesTab.detailEditTagsButton,
    );
    await this.utilityProblematicFilesTab.detailEditTagsButton.click();
  }

  async expectTrackVisibleInDetail(trackTitle, options = {}) {
    await this.utilityProblematicFilesTab.waitForVisible(
      this.utilityProblematicFilesTab.problematicTrackRowByTitle(trackTitle),
      { timeout: options.timeout || 60000 },
    );
  }

  async readVisibleListItems() {
    // parity-check: allow-read-only-measurement-evaluate -- one atomic snapshot avoids per-row browser round trips
    return this.utilityProblematicFilesTab.listItems.evaluateAll((elements, selectors) => (
      elements.map((element) => ({
        key: String(element.getAttribute('data-problematic-album-key') || ''),
        title: String(element.querySelector(selectors.titleSelector)?.textContent || '').trim(),
        meta: String(element.querySelector(selectors.metaSelector)?.textContent || '').trim(),
        issues: String(element.querySelector(selectors.issuesSelector)?.textContent || '').trim(),
      })).filter((item) => item.key)
    ), {
      titleSelector: this.utilityProblematicFilesTab.listItemTitleSelector,
      metaSelector: this.utilityProblematicFilesTab.listItemMetaSelector,
      issuesSelector: this.utilityProblematicFilesTab.listItemIssuesSelector,
    });
  }

  async readActiveListItem() {
    const activeItem = this.utilityProblematicFilesTab.activeListItem;
    return {
      key: (await activeItem.getAttribute('data-problematic-album-key')) || '',
      title: ((await this.utilityProblematicFilesTab.titleForListItem(activeItem).textContent()) || '').trim(),
    };
  }

  async readRepresentativeSearchToken() {
    const items = await this.readVisibleListItems();
    return items
      .flatMap((item) => [item.title, item.meta])
      .flatMap((text) => String(text || '').split(/[^A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+/))
      .map((part) => part.trim())
      .find((part) => part.length >= 4) || 'the';
  }

  async search(searchTerm) {
    await this.utilityProblematicFilesTab.searchSection.searchInput.fill(searchTerm);
  }

  async waitForSearchResults(searchTerm, options = {}) {
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      if (typeof state === 'undefined') return false;
      if ((state.utility?.searchQuery || '') !== expected.term) return false;
      const items = Array.from(document.querySelectorAll(expected.listItemSelector));
      return items.length > 0;
    }, {
      timeout: options.timeout || 60000,
    }, {
      term: searchTerm,
      listItemSelector: this.utilityProblematicFilesTab.listItemSelector,
    });
  }

  async clearSearch() {
    await this.utilityProblematicFilesTab.searchSection.searchInput.fill('');
    await this.utilityProblematicFilesTab.waitForPageCondition(() => (
      typeof state !== 'undefined' && (state.utility?.searchQuery || '') === ''
    ), { timeout: 60000 });
  }

  async readProblemFilterValues() {
    const values = await this.utilityProblematicFilesTab.searchSection.problemFilterOptions.all();
    return (await Promise.all(values.map((element) => element.getAttribute('data-problem-filter-value')))).filter(Boolean);
  }

  async applySingleProblemFilter(problemType) {
    const searchSection = this.utilityProblematicFilesTab.searchSection;
    if (await searchSection.filterChipByValue(problemType).count()) {
      return;
    }
    await searchSection.problemFilterButton.click();
    await this.utilityProblematicFilesTab.waitForVisible(searchSection.problemFilterMenu);
    await searchSection.filterOptionByValue(problemType).click();
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      if (typeof state === 'undefined') return false;
      const selected = state.utility?.selectedProblemFilters || [];
      if (selected.length !== 1 || selected[0] !== expected.problemType) return false;
      return document.querySelector(expected.filterChipSelector) !== null;
    }, {
      timeout: 60000,
    }, {
      problemType,
      filterChipSelector: searchSection.filterChipSelector(problemType),
    });
    if (await searchSection.problemFilterMenu.isVisible()) {
      await searchSection.problemFilterButton.click();
      await searchSection.problemFilterMenu.waitFor({ state: 'hidden', timeout: 60000 });
    }
  }

  async clearProblemFilter(problemType) {
    const chip = this.utilityProblematicFilesTab.searchSection.filterChipByValue(problemType);
    if (!await chip.count()) {
      return;
    }
    const waitForFilterRemoved = async (timeout = 60000) => {
      await this.utilityProblematicFilesTab.waitForPageCondition((expectedProblemType) => {
        if (typeof state === 'undefined') return false;
        const selected = state.utility?.selectedProblemFilters || [];
        return !selected.includes(expectedProblemType);
      }, {
        timeout,
      }, problemType);
    };
    await chip.click();
    await waitForFilterRemoved();
    if (await this.utilityProblematicFilesTab.searchSection.problemFilterMenu.isVisible()) {
      await this.utilityProblematicFilesTab.searchSection.problemFilterButton.click();
      await this.utilityProblematicFilesTab.searchSection.problemFilterMenu.waitFor({ state: 'hidden', timeout: 60000 });
    }
  }

  async readSelectedDetailSummary() {
    const problemReasons = await this.utilityProblematicFilesTab.detailProblemReasons.allTextContents();
    const fileTypes = await this.utilityProblematicFilesTab.detailFileTypeChips.allTextContents();
    // parity-check: allow-read-only-measurement-evaluate -- expose the server summary count with the selected detail
    const issueCount = await this.utilityProblematicFilesTab.page.evaluate(() => (
      typeof getSelectedProblematicAlbum === 'function'
        ? Number(getSelectedProblematicAlbum()?.issue_count)
        : Number.NaN
    ));
    return {
      title: ((await this.utilityProblematicFilesTab.detailTitle.textContent()) || '').trim(),
      artist: ((await this.utilityProblematicFilesTab.detailArtist.textContent()) || '').trim(),
      issueCount,
      problemReasons: problemReasons.map((value) => value.trim()).filter(Boolean),
      fileTypes: fileTypes.map((value) => value.trim()).filter(Boolean),
    };
  }

  async selectListItemByIndex(index) {
    const target = this.utilityProblematicFilesTab.listItems.nth(index);
    const key = (await target.getAttribute('data-problematic-album-key')) || '';
    const title = ((await this.utilityProblematicFilesTab.titleForListItem(target).textContent()) || '').trim();
    await target.click();
    await this.waitForSelectedDetailSelection({ expectedKey: key, expectedTitle: title });
    return { key, title };
  }

  async waitForSelectedDetailSelection({ expectedKey = '', expectedTitle = '' } = {}, options = {}) {
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      if (typeof state === 'undefined') return false;
      if (expected.key && String(state.utility?.selectedProblematicKey || '') !== expected.key) {
        return false;
      }
      const activeKey = document.querySelector(expected.activeListItemSelector)?.getAttribute('data-problematic-album-key') || '';
      if (expected.key && activeKey !== expected.key) {
        return false;
      }
      const selectedAlbum = typeof getSelectedProblematicAlbum === 'function'
        ? getSelectedProblematicAlbum()
        : null;
      if (expected.key && String(selectedAlbum?.key || '') !== expected.key) {
        return false;
      }
      if (selectedAlbum && selectedAlbum.detail_loaded === false) {
        return false;
      }
      const detailTitle = (document.querySelector(expected.detailTitleSelector)?.textContent || '').trim();
      if (!detailTitle) {
        return false;
      }
      return !expected.title || detailTitle === expected.title || activeKey === expected.key;
    }, {
      timeout: options.timeout || 60000,
    }, {
      key: expectedKey,
      title: expectedTitle,
      activeListItemSelector: this.utilityProblematicFilesTab.activeListItemSelector,
      detailTitleSelector: this.utilityProblematicFilesTab.detailTitleSelector,
    });
  }

  async readDetectedTrackRows() {
    const rows = this.utilityProblematicFilesTab.detailTrackRows;
    const result = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      result.push({
        filename: String(
          await this.utilityProblematicFilesTab.filenameForTrackRow(row).textContent() || '',
        ).trim(),
        path: String(await row.getAttribute('data-problematic-track-path') || ''),
        reasons: (await this.utilityProblematicFilesTab.reasonsForTrackRow(row).allTextContents())
          .map((reason) => String(reason || '').trim())
          .filter(Boolean),
      });
    }
    return result;
  }

  async waitForNoSearchResults(searchTerm, options = {}) {
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      if (typeof state === 'undefined') return false;
      if ((state.utility?.searchQuery || '') !== expected.term) return false;
      return document.querySelectorAll(expected.listItemSelector).length === 0
        && document.querySelector(expected.listEmptyStateSelector) !== null;
    }, {
      timeout: options.timeout || 60000,
    }, {
      term: searchTerm,
      listItemSelector: this.utilityProblematicFilesTab.listItemSelector,
      listEmptyStateSelector: this.utilityProblematicFilesTab.listEmptyStateSelector,
    });
  }

  async waitForTargetAlbumBelowSidebarViewport(albumTitle, options = {}) {
    const targetItem = this.utilityProblematicFilesTab.listItemByTitle(albumTitle);
    await targetItem.waitFor({ state: 'visible', timeout: options.timeout || 60000 });
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      const scroller = document.querySelector(expected.sidebarListSelector);
      const items = Array.from(document.querySelectorAll(expected.listItemSelector));
      const target = items.find((item) => {
        const title = String(
          item.querySelector(expected.listItemTitleSelector)?.textContent || '',
        ).trim();
        return title === expected.albumTitle || title.startsWith(`${expected.albumTitle} / `);
      });
      if (!(scroller instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
      const viewport = scroller.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      return items.length >= expected.minimumResultCount
        && scroller.scrollTop === 0
        && row.height > 0
        && row.top >= viewport.bottom;
    }, {
      timeout: options.timeout || 60000,
    }, {
      albumTitle: String(albumTitle || '').trim(),
      minimumResultCount: options.minimumResultCount || 9,
      sidebarListSelector: this.utilityProblematicFilesTab.sidebarListSelector,
      listItemSelector: this.utilityProblematicFilesTab.listItemSelector,
      listItemTitleSelector: this.utilityProblematicFilesTab.listItemTitleSelector,
    });
  }

  async waitForActiveAlbumInSidebarViewport(albumTitle, options = {}) {
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      const scroller = document.querySelector(expected.sidebarListSelector);
      const activeItem = document.querySelector(expected.activeListItemSelector);
      const activeTitle = String(activeItem?.querySelector(expected.listItemTitleSelector)?.textContent || '').trim();
      if (!(scroller instanceof HTMLElement) || !(activeItem instanceof HTMLElement)) return false;
      const viewport = scroller.getBoundingClientRect();
      const row = activeItem.getBoundingClientRect();
      return (activeTitle === expected.albumTitle || activeTitle.startsWith(`${expected.albumTitle} / `))
        && scroller.scrollTop > 0
        && row.height > 0
        && row.top >= viewport.top
        && row.bottom <= viewport.bottom;
    }, {
      timeout: options.timeout || 60000,
    }, {
      albumTitle: String(albumTitle || '').trim(),
      sidebarListSelector: this.utilityProblematicFilesTab.sidebarListSelector,
      activeListItemSelector: this.utilityProblematicFilesTab.activeListItemSelector,
      listItemTitleSelector: this.utilityProblematicFilesTab.listItemTitleSelector,
    });
  }

  async waitForProblematicTrackInDetailViewport(trackPath, options = {}) {
    const targetRow = this.utilityProblematicFilesTab.problematicTrackRowByPath(trackPath);
    await targetRow.waitFor({ state: 'visible', timeout: options.timeout || 60000 });
    await this.utilityProblematicFilesTab.waitForPageCondition((expected) => {
      const scroller = document.querySelector(expected.detailScrollerSelector);
      const target = Array.from(document.querySelectorAll(expected.problematicTrackRowSelector))
        .find((row) => String(row.getAttribute('data-problematic-track-path') || '') === expected.trackPath);
      if (!(scroller instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
      const viewport = scroller.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      return row.width > 0
        && row.height > 0
        && scroller.scrollTop > 0
        && row.top >= viewport.top
        && row.bottom <= viewport.bottom;
    }, {
      timeout: options.timeout || 60000,
    }, {
      detailScrollerSelector: this.utilityProblematicFilesTab.detailScrollerSelector,
      problematicTrackRowSelector: this.utilityProblematicFilesTab.problematicTrackRowSelector,
      trackPath: String(trackPath || ''),
    });
    return String(await targetRow.getAttribute('data-problematic-track-path') || '');
  }

  async readVisibleResultCount() {
    return this.utilityProblematicFilesTab.listItems.count();
  }

  async readSearchQuery() {
    return this.utilityProblematicFilesTab.searchSection.searchInput.inputValue();
  }

  async waitForAlbumInSidebarList(albumTitle, options = {}) {
    const item = this.utilityProblematicFilesTab.listItemByTitle(albumTitle);
    await item.waitFor({ state: 'visible', timeout: options.timeout || 60000 });
    return ((await this.utilityProblematicFilesTab.titleForListItem(item).textContent()) || '').trim();
  }

  async selectAlbumByTitle(albumTitle, options = {}) {
    const item = this.utilityProblematicFilesTab.listItemByTitle(albumTitle);
    await item.waitFor({ state: 'visible', timeout: options.timeout || 60000 });
    const key = String(await item.getAttribute('data-problematic-album-key') || '');
    await item.click();
    await this.waitForSelectedDetailSelection({
      expectedKey: key,
      expectedTitle: albumTitle,
    }, options);
    return this.readSelectedDetailSummary();
  }

  async readErrorToastCount() {
    return this.utilityProblematicFilesTab.errorToasts.count();
  }

  async waitForErrorToast(text) {
    const toast = this.utilityProblematicFilesTab.errorToasts.filter({ hasText: text }).last();
    await toast.waitFor({ state: 'visible', timeout: 60000 });
    return String(await toast.textContent() || '').trim();
  }

  async readLoadDiagnostics() {
    // parity-check: allow-read-only-measurement-evaluate -- utility timing telemetry only
    return this.utilityProblematicFilesTab.page.evaluate(() => {
      const diagnostics = state?.utility?.problematicDiagnostics || null;
      return diagnostics ? JSON.parse(JSON.stringify(diagnostics)) : null;
    });
  }

  async readApprovedDetectedProblemsLayout() {
    const detail = this.utilityProblematicFilesTab.detailScroller;
    // parity-check: allow-read-only-measurement-evaluate -- capture semantic table structure and geometry atomically
    return detail.evaluate((element, selectors) => {
      const text = (node) => String(node?.textContent || '').trim();
      const table = element.querySelector(selectors.table);
      const reasonHeader = Array.from(table?.querySelectorAll(selectors.headers) || [])
        .find((header) => text(header) === 'Reason');
      const reasonCells = Array.from(table?.querySelectorAll(selectors.reasonCells) || []);
      return {
        albumHeadingIndex: text(element).indexOf('ALBUM-LEVEL PROBLEMS'),
        trackHeadingIndex: text(element).indexOf('TRACK-LEVEL PROBLEMS'),
        trackRowCount: Number(element.querySelector(selectors.trackRowCount)?.textContent || NaN),
        albumReasons: Array.from(element.querySelectorAll(selectors.albumProblems), text),
        headers: Array.from(table?.querySelectorAll(selectors.headers) || [], text),
        rows: Array.from(table?.querySelectorAll(selectors.rows) || []).map((row) => ({
          cells: Array.from(row.querySelectorAll(selectors.directCells), (cell) => ({
            column: cell.getAttribute('data-cdt-column'),
            text: text(cell),
          })),
        })),
        reasonOrigins: [reasonHeader, ...reasonCells]
          .filter(Boolean)
          .map((node) => Math.round(node.getBoundingClientRect().left * 100) / 100),
        forbiddenCount: element.querySelectorAll(selectors.forbidden).length,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, {
      table: this.utilityProblematicFilesTab.trackProblemTableSelector,
      headers: this.utilityProblematicFilesTab.columnHeaderSelector,
      reasonCells: this.utilityProblematicFilesTab.reasonCellSelector,
      trackRowCount: this.utilityProblematicFilesTab.problemReasonCountSelector,
      albumProblems: this.utilityProblematicFilesTab.albumProblemPillSelector,
      rows: this.utilityProblematicFilesTab.keyedTableRowSelector,
      directCells: this.utilityProblematicFilesTab.directTableCellSelector,
      forbidden: this.utilityProblematicFilesTab.forbiddenDetectedProblemSelector,
    });
  }

  async selectAlbumProblem(reason) {
    const pill = this.utilityProblematicFilesTab.albumProblemPill(reason);
    await pill.click();
    await pill.waitFor({ state: 'visible', timeout: 60000 });
    await pill.getAttribute('aria-pressed').then((pressed) => {
      if (pressed !== 'true') throw new Error('Expected the album problem to remain selected.');
    });
  }

  async unselectAlbumProblem(reason) {
    const pill = this.utilityProblematicFilesTab.albumProblemPill(reason);
    await pill.click();
    await pill.waitFor({ state: 'visible', timeout: 60000 });
    await pill.getAttribute('aria-pressed').then((pressed) => {
      if (pressed !== 'false') throw new Error('Expected the album problem to become unselected.');
    });
  }

  async selectFileProblem(filename, reason) {
    const pill = this.utilityProblematicFilesTab.fileProblemPill(filename, reason);
    await pill.click();
    await pill.waitFor({ state: 'visible', timeout: 60000 });
    await pill.getAttribute('aria-pressed').then((pressed) => {
      if (pressed !== 'true') throw new Error('Expected the file problem to remain selected.');
    });
  }

  async unselectFileProblem(filename, reason) {
    const pill = this.utilityProblematicFilesTab.fileProblemPill(filename, reason);
    await pill.click();
    await pill.waitFor({ state: 'visible', timeout: 60000 });
    await pill.getAttribute('aria-pressed').then((pressed) => {
      if (pressed !== 'false') throw new Error('Expected the file problem to become unselected.');
    });
  }

  async readExcludeProblemEnabled() {
    return this.utilityProblematicFilesTab.excludeProblemButton.isEnabled();
  }

  async readAlbumProblemReasons() {
    return (await this.utilityProblematicFilesTab.albumProblemPills.allTextContents())
      .map((value) => String(value || '').trim()).filter(Boolean);
  }

  async readDetectedProblemsLayout() {
    // parity-check: allow-read-only-measurement-evaluate -- capture section ordering atomically
    return this.utilityProblematicFilesTab.detailScroller.evaluate((detail, selectors) => {
      const albumSection = detail.querySelector(selectors.albumSection);
      const trackSection = detail.querySelector(selectors.trackSection);
      const actions = detail.querySelectorAll(selectors.actions);
      const action = actions.item(0);
      const follows = (section) => Boolean(
        section
        && action
        && (section.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      return {
        actionCount: actions.length,
        hasTrackSection: Boolean(trackSection),
        actionAfterAlbum: follows(albumSection),
        actionAfterTrack: follows(trackSection),
      };
    }, {
      albumSection: this.utilityProblematicFilesTab.albumProblemSectionSelector,
      trackSection: this.utilityProblematicFilesTab.trackProblemSectionSelector,
      actions: this.utilityProblematicFilesTab.detectedProblemActionsSelector,
    });
  }

  async readVisibleProblemReasonCount() {
    return Number(await this.utilityProblematicFilesTab.problemReasonCount.textContent() || NaN);
  }

  async chooseFirstSuggestedEditWithoutApplying() {
    const choice = this.utilityProblematicFilesTab.suggestedEditChoices.first();
    await choice.waitFor({ state: 'visible', timeout: 60000 });
    await choice.click();
    return this.readSelectedProblemInstances();
  }

  async readSuggestedEditsApplyEnabled() {
    const button = this.utilityProblematicFilesTab.suggestedEditsApplyButton;
    await button.waitFor({ state: 'visible', timeout: 60000 });
    return button.isEnabled();
  }

  async readSuggestedEditRows() {
    const rows = this.utilityProblematicFilesTab.suggestedEditRows;
    const result = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const rowKey = String(
        await this.utilityProblematicFilesTab.suggestedEditRowKey(row)
          .getAttribute('data-repair-row-key') || '',
      );
      const separator = rowKey.lastIndexOf('::');
      const path = separator >= 0 ? rowKey.slice(0, separator) : rowKey;
      result.push({
        rowKey,
        path,
        filename: path.split(/[\\/]/).pop() || '',
        field: separator >= 0 ? rowKey.slice(separator + 2) : '',
        original: String(
          await this.utilityProblematicFilesTab.suggestedEditOriginal(row).textContent() || '',
        ).trim(),
        repaired: String(
          await this.utilityProblematicFilesTab.suggestedEditRepaired(row).textContent() || '',
        ).trim(),
        activeChoice: String(
          await this.utilityProblematicFilesTab.activeSuggestedEditChoice(row)
            .getAttribute('data-repair-choice') || '',
        ),
      });
    }
    return result;
  }

  async applySuggestedEditSubset(selectedRowKey) {
    const rows = await this.readSuggestedEditRows();
    if (rows.length < 2 || !rows.some((row) => row.rowKey === selectedRowKey)) {
      throw new Error('A strict Suggested Edits subset requires one selected row among at least two suggestions.');
    }
    for (const row of rows.filter((item) => item.rowKey !== selectedRowKey)) {
      const rowLocator = this.utilityProblematicFilesTab.suggestedEditRowByKey(row.rowKey);
      await this.utilityProblematicFilesTab.suggestedEditChoice(rowLocator, 'ignore').click();
    }
    const selected = await this.readSuggestedEditRows();
    if (selected.filter((row) => row.activeChoice === 'repair').map((row) => row.rowKey).join() !== selectedRowKey) {
      throw new Error('Suggested Edits did not retain the requested strict repair subset.');
    }
    await this.utilityProblematicFilesTab.suggestedEditsApplyButton.click();
    await this.utilityProblematicFilesTab.repairConfirmDialog.waitFor({ state: 'visible', timeout: 60000 });
    await this.utilityProblematicFilesTab.repairConfirmAcceptButton.click();
    await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
    await this.utilityProblematicFilesTab.waitForPageCondition((selectors) => (
      !document.querySelector(selectors.overlay)
      && document.querySelector(selectors.detail)
    ), { timeout: 90000 }, {
      overlay: this.utilityProblematicFilesTab.mutationOverlaySelector,
      detail: this.utilityProblematicFilesTab.detailTitleSelector,
    });
  }

  async dragFileProblemRange(filenames, reason) {
    const pills = filenames.map((filename) => this.utilityProblematicFilesTab.fileProblemPill(filename, reason));
    const boxes = [];
    for (const pill of pills) {
      await pill.waitFor({ state: 'visible', timeout: 60000 });
      boxes.push(await pill.boundingBox());
    }
    if (boxes.some((box) => !box)) throw new Error('Expected every Problematic reason pill to have pointer geometry.');
    const center = (box) => ({ x: box.x + (box.width / 2), y: box.y + (box.height / 2) });
    const start = center(boxes[0]);
    await this.utilityProblematicFilesTab.page.mouse.move(start.x, start.y);
    await this.utilityProblematicFilesTab.page.mouse.down();
    for (const box of boxes.slice(1)) {
      const point = center(box);
      await this.utilityProblematicFilesTab.page.mouse.move(point.x, point.y, { steps: 4 });
    }
    await this.utilityProblematicFilesTab.page.mouse.up();
  }

  async dragBetweenProblemPills(start, end) {
    const pills = [
      this.utilityProblematicFilesTab.fileProblemPill(start.filename, start.reason),
      this.utilityProblematicFilesTab.fileProblemPill(end.filename, end.reason),
    ];
    const boxes = [];
    for (const pill of pills) {
      await pill.waitFor({ state: 'visible', timeout: 60000 });
      boxes.push(await pill.boundingBox());
    }
    if (boxes.some((box) => !box)) throw new Error('Expected both boundary pills to have pointer geometry.');
    const center = (box) => ({ x: box.x + (box.width / 2), y: box.y + (box.height / 2) });
    const startPoint = center(boxes[0]);
    const endPoint = center(boxes[1]);
    await this.utilityProblematicFilesTab.page.mouse.move(startPoint.x, startPoint.y);
    await this.utilityProblematicFilesTab.page.mouse.down();
    await this.utilityProblematicFilesTab.page.mouse.move(endPoint.x, endPoint.y, { steps: 8 });
    await this.utilityProblematicFilesTab.page.mouse.up();
  }

  async readSelectedProblemInstances() {
    // parity-check: allow-read-only-measurement-evaluate -- capture selected problem identities atomically
    return this.utilityProblematicFilesTab.selectedProblemPills.evaluateAll((elements) => elements.map((element) => ({
      scope: element.getAttribute('data-problem-exclusion-scope'),
      key: element.getAttribute('data-problem-exclusion-row-key'),
      reason: String(element.textContent || '').trim(),
    })));
  }

  async openExclusionConfirmation() {
    await this.utilityProblematicFilesTab.excludeProblemButton.click();
    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.exclusionConfirmDialog);
    return String(await this.utilityProblematicFilesTab.exclusionConfirmText.textContent() || '').trim();
  }

  async cancelExclusion() {
    await this.utilityProblematicFilesTab.exclusionCancelButton.click();
    await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
  }

  async confirmExclusion() {
    const acknowledgement = this.utilityProblematicFilesTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/rules/problem-ignores'
    ));
    await this.utilityProblematicFilesTab.exclusionAcceptButton.click();
    await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
    await this.utilityProblematicFilesTab.waitForPageCondition((selectors) => (
      !document.querySelector(selectors.overlay)
      && (
        document.querySelector(selectors.detail)
        || document.querySelector(selectors.empty)
      )
    ), { timeout: 90000 }, {
      overlay: this.utilityProblematicFilesTab.mutationOverlaySelector,
      detail: this.utilityProblematicFilesTab.detailTitleSelector,
      empty: this.utilityProblematicFilesTab.listEmptyStateSelector,
    });
    const response = await acknowledgement;
    if (!response.ok()) {
      throw new Error(`Problem Exclusion creation returned HTTP ${response.status()}.`);
    }
  }

  async beginConfirmExclusion() {
    const requestStarted = this.utilityProblematicFilesTab.page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/utilities/rules/problem-ignores'
    ));
    const acknowledgement = this.utilityProblematicFilesTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/rules/problem-ignores'
    ));
    let acknowledgementSettled = false;
    acknowledgement.then(
      () => { acknowledgementSettled = true; },
      () => { acknowledgementSettled = true; },
    );
    await this.utilityProblematicFilesTab.exclusionAcceptButton.click();
    await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
    await requestStarted;
    return {
      isAcknowledgementSettled: () => acknowledgementSettled,
      waitForAcknowledgement: async () => {
        const response = await acknowledgement;
        if (!response.ok()) {
          throw new Error(`Problem Exclusion creation returned HTTP ${response.status()}.`);
        }
      },
    };
  }

  async waitForOptimisticAlbumRemoval(albumTitle) {
    await this.utilityProblematicFilesTab.listItemByTitle(albumTitle)
      .waitFor({ state: 'detached', timeout: 60000 });
  }

  async readRepairProgressOverlayVisible() {
    return this.utilityProblematicFilesTab.repairProgressOverlay.isVisible();
  }

  async readTagRepairErrorToastCount() {
    return this.utilityProblematicFilesTab.errorToasts.filter({
      hasText: 'Failed to repair local tags',
    }).count();
  }

  async prepareSelectedMutationContinuity() {
    await this.utilityProblematicFilesTab.activeListItem.scrollIntoViewIfNeeded();
    this.mutationObservation = await this.utilityProblematicFilesTab.page.evaluateHandle((selectors) => {
      const list = document.querySelector(selectors.listSelector);
      const active = document.querySelector(selectors.activeSelector);
      const items = Array.from(document.querySelectorAll(selectors.itemSelector));
      const removedIndex = items.indexOf(active);
      if (!(list instanceof HTMLElement) || removedIndex <= 0) {
        throw new Error('Mutation continuity requires a selected Problematic row with a previous survivor.');
      }
      const snapshot = {
        removedKey: String(active.getAttribute('data-problematic-album-key') || ''),
        previousKey: String(items[removedIndex - 1].getAttribute('data-problematic-album-key') || ''),
        previousTitle: String(items[removedIndex - 1].querySelector(selectors.titleSelector)?.textContent || '').trim(),
        order: items.map((item) => String(item.getAttribute('data-problematic-album-key') || '')),
        text: items.map((item) => String(item.textContent || '').trim()),
        nodes: items,
        scrollTop: list.scrollTop,
        listMutations: 0,
      };
      const observer = new MutationObserver(() => {
        snapshot.listMutations += 1;
        if (!Array.from(document.querySelectorAll(selectors.itemSelector)).includes(active)) observer.disconnect();
      });
      observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
      return { ...snapshot, observer };
    }, {
      listSelector: this.utilityProblematicFilesTab.sidebarListSelector,
      activeSelector: this.utilityProblematicFilesTab.activeListItemSelector,
      itemSelector: this.utilityProblematicFilesTab.listItemSelector,
      titleSelector: this.utilityProblematicFilesTab.listItemTitleSelector,
    });
    // parity-check: allow-read-only-measurement-evaluate -- read the retained MutationObserver snapshot without changing application state
    return this.mutationObservation.evaluate((snapshot) => ({
      removedKey: snapshot.removedKey,
      previousKey: snapshot.previousKey,
      previousTitle: snapshot.previousTitle,
      scrollTop: snapshot.scrollTop,
    }));
  }

  async waitForMutationOverlayAndReadContinuity() {
    await this.utilityProblematicFilesTab.mutationOverlay.waitFor({ state: 'visible', timeout: 60000 });
    if (!this.mutationObservation) throw new Error('Mutation continuity observation was not prepared.');
    // parity-check: allow-read-only-measurement-evaluate -- compare the retained DOM snapshot while the detail overlay is visible
    return this.mutationObservation.evaluate((snapshot, selectors) => {
      const list = document.querySelector(selectors.listSelector);
      const items = Array.from(document.querySelectorAll(selectors.itemSelector));
      const overlay = document.querySelector(selectors.overlaySelector);
      return {
        listMutations: Number(snapshot?.listMutations || 0),
        sameNodes: Boolean(snapshot) && items.length === snapshot.nodes.length
          && items.every((item, index) => item === snapshot.nodes[index]),
        sameOrder: Boolean(snapshot) && items.every((item, index) => (
          item.getAttribute('data-problematic-album-key') === snapshot.order[index]
        )),
        sameText: Boolean(snapshot) && items.every((item, index) => (
          String(item.textContent || '').trim() === snapshot.text[index]
        )),
        scrollTop: Number(list?.scrollTop || 0),
        expectedScrollTop: Number(snapshot?.scrollTop || 0),
        overlayText: String(overlay?.textContent || '').trim(),
        spinnerCount: overlay?.querySelectorAll(selectors.spinnerSelector).length || 0,
        detailBusy: document.querySelector(selectors.detailSelector)?.getAttribute('aria-busy'),
      };
    }, {
      listSelector: this.utilityProblematicFilesTab.sidebarListSelector,
      itemSelector: this.utilityProblematicFilesTab.listItemSelector,
      overlaySelector: this.utilityProblematicFilesTab.mutationOverlaySelector,
      spinnerSelector: this.utilityProblematicFilesTab.mutationSpinnerSelector,
      detailSelector: this.utilityProblematicFilesTab.detailScrollerSelector,
    });
  }

  async waitForMutationRemovalAndPreviousSelection(expected, options = {}) {
    await this.utilityProblematicFilesTab.waitForPageCondition((value) => {
      const list = document.querySelector(value.listSelector);
      const items = Array.from(document.querySelectorAll(value.itemSelector));
      const removed = items.find((item) => item.getAttribute('data-problematic-album-key') === value.removedKey);
      const active = document.querySelector(value.activeSelector);
      return !removed
        && active?.getAttribute('data-problematic-album-key') === value.previousKey
        && Math.abs(Number(list?.scrollTop || 0) - Number(value.scrollTop || 0)) <= 1;
    }, { timeout: options.timeout || 90000 }, {
      ...expected,
      listSelector: this.utilityProblematicFilesTab.sidebarListSelector,
      itemSelector: this.utilityProblematicFilesTab.listItemSelector,
      activeSelector: this.utilityProblematicFilesTab.activeListItemSelector,
    });
    const result = await this.readActiveListItem();
    await this.mutationObservation?.dispose();
    this.mutationObservation = null;
    return result;
  }

  async startNavigationRenderObservation() {
    this.navigationObservation = await this.utilityProblematicFilesTab.page.evaluateHandle((selectors) => {
      const records = [];
      const capture = () => {
        const detail = document.querySelector(selectors.detailSelector);
        const active = document.querySelector(selectors.activeListItemSelector);
        records.push({
          activeKey: String(active?.getAttribute('data-problematic-album-key') || ''),
          detailTitle: String(detail?.querySelector(selectors.detailTitleSelector)?.textContent || '').trim(),
          detailText: String(detail?.textContent || '').trim(),
          listScrollTop: Number(document.querySelector(selectors.sidebarListSelector)?.scrollTop || 0),
        });
      };
      const targets = [
        document.querySelector(selectors.detailSelector),
        document.querySelector(selectors.sidebarListSelector),
      ].filter(Boolean);
      const observer = new MutationObserver(capture);
      targets.forEach((target) => observer.observe(target, { childList: true, subtree: true, attributes: true }));
      return { records, observer };
    }, {
      detailSelector: this.utilityProblematicFilesTab.detailScrollerSelector,
      detailTitleSelector: this.utilityProblematicFilesTab.detailTitleSelector,
      activeListItemSelector: this.utilityProblematicFilesTab.activeListItemSelector,
      sidebarListSelector: this.utilityProblematicFilesTab.sidebarListSelector,
    });
  }

  async finishNavigationRenderObservation() {
    if (!this.navigationObservation) return [];
    // parity-check: allow-read-only-measurement-evaluate -- finish the read-only MutationObserver capture without changing application state
    const records = await this.navigationObservation.evaluate((observation) => {
      observation.observer.disconnect();
      return observation.records.map((record) => ({ ...record }));
    });
    await this.navigationObservation.dispose();
    this.navigationObservation = null;
    return records;
  }
}
