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
