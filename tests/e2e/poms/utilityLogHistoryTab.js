import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

export class UtilityLogHistoryTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator('[data-utility-log-history-id][aria-current="true"]');
    this.detailFiles = page.locator('.utility-log-history-file');
    this.visibleHistorySurfaces = page.locator('#utility-problematic-list, #utility-problematic-detail');
    this.sourceLabel = page.locator('#utility-problematic-detail .utility-log-console-detail > p').first();
    this.exportButton = page.locator('#utility-problematic-detail [data-log-history-action="export-current"]');
    this.exportAllButton = page.getByRole('button', { name: 'Export all logs', exact: true });
    this.exportDialog = page.getByRole('dialog', { name: 'Export all logs', exact: true });
    this.exportCustomButton = this.exportDialog.getByRole('button', { name: 'Custom', exact: true });
    this.exportFrom = this.exportDialog.getByLabel('From date', { exact: true });
    this.exportTo = this.exportDialog.getByLabel('To date', { exact: true });
    this.exportCancel = this.exportDialog.getByRole('button', { name: 'Cancel', exact: true });
    this.consoleLines = page.locator('#utility-problematic-detail .console-log__line');
    this.console = page.locator('#utility-problematic-detail .console-log');
    this.emptySnapshot = this.console.getByText('No events in this snapshot.', { exact: true });
    this.detailTitle = page.locator('#utility-problematic-detail .utility-log-toolbar > h3');
    this.refresh = page.locator('#utility-problematic-detail [data-log-history-action="refresh"]');
    this.periodButton = page.locator('#utility-problem-filter-button');
    this.periodDialog = page.getByRole('dialog', { name: 'Date range', exact: true });
    this.periodFrom = this.periodDialog.getByRole('textbox', { name: 'From date', exact: true });
    this.periodTo = this.periodDialog.getByRole('textbox', { name: 'To date', exact: true });
    this.periodRow = page.locator('[data-log-query-row="1"]');
    this.clearPeriodButton = page.locator('[data-log-history-action="clear"]');
  }

  periodDateButton(field) {
    return this.periodDialog.getByRole('button', { name: `Choose ${field} date`, exact: true });
  }

  exportDateButton(field) {
    return this.exportDialog.getByRole('button', { name: 'Choose ' + field + ' date', exact: true });
  }

  exportCalendar(field) {
    return this.exportDialog.getByRole('dialog', { name: 'Choose ' + field + ' date', exact: true });
  }

  async readDateFocusOutline(input) {
    // parity-check: allow-read-only-measurement-evaluate -- verify the focused date outline remains inside every clipping ancestor
    return input.evaluate(inputNode => {
      const node = inputNode.closest('.date-range-picker__control');
      const style = getComputedStyle(node);
      const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      const bounds = node.getBoundingClientRect();
      let unclipped = true;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(parentStyle.overflowX)) {
          unclipped &&= bounds.left - extent >= rect.left + parent.clientLeft && bounds.right + extent <= rect.left + parent.clientLeft + parent.clientWidth;
        }
        if (/(auto|scroll|hidden|clip)/.test(parentStyle.overflowY)) {
          unclipped &&= bounds.top - extent >= rect.top + parent.clientTop && bounds.bottom + extent <= rect.top + parent.clientTop + parent.clientHeight;
        }
      }
      const content = node.closest('#app-form-content');
      return { painted: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0, unclipped, horizontalOverflow: content.scrollWidth > content.clientWidth };
    });
  }

  periodCalendar(field) {
    return this.periodDialog.getByRole('dialog', { name: `Choose ${field} date`, exact: true });
  }

  periodCalendarDay(field, date) {
    return this.periodCalendar(field).locator(`[data-calendar-date="${date}"]`);
  }

  get listItemSelector() {
    return '[data-utility-log-history-id]';
  }

  get activeItemSelector() {
    return '[data-utility-log-history-id][aria-current="true"]';
  }

  async readPersistedEntry(entryId) {
    const response = await authenticatedPageGet(this.page,
      `/utilities/log-history?event_ids=${encodeURIComponent(entryId)}`);
    if (!response.ok()) throw new Error(`Log History read returned HTTP ${response.status()}.`);
    const payload = await response.json();
    return { entry: payload.items.find(item => item.id === entryId) || null, snapshot: payload.snapshot };
  }
}
