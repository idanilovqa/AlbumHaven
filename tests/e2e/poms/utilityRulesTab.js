import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

function toXPathStringLiteral(value) {
  const text = String(value || '');
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat(${text.split("'").map((part) => `'${part}'`).join(", \"'\", ")})`;
}

export class UtilityRulesTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator('[data-utility-rule-key].is-active');
    this.ruleDetail = page.locator('#utility-problematic-detail .utility-rule-detail');
    this.ruleTitle = page.locator('#utility-problematic-detail .utility-rule-title').first();
    this.ruleDescription = page.locator('#utility-problematic-detail .utility-rule-description').first();
    this.problemExclusionsRule = this.listItems.filter({ hasText: 'Problem exclusions' }).first();
    this.albumExclusionsTable = this.ruleDetail.getByRole('table', { name: 'Album exclusions', exact: true });
    this.fileExclusionsTable = this.ruleDetail.getByRole('table', { name: 'File exclusions', exact: true });
    this.exclusionRows = this.ruleDetail.locator(this.keyedTableRowSelector);
    this.revertButtons = page.getByRole('button', { name: 'Revert rule', exact: true });
  }

  get listItemSelector() {
    return '[data-utility-rule-key]';
  }

  get columnHeaderSelector() {
    return '[role="columnheader"]';
  }

  get keyedTableRowSelector() {
    return '[role="row"][data-cdt-row-key]';
  }

  get reasonColumnSelector() {
    return '[data-cdt-column="reason"]';
  }

  get targetColumnSelector() {
    return '[data-cdt-column="target"]';
  }

  get actionColumnSelector() {
    return '[data-cdt-action]';
  }

  get allDescendantsSelector() {
    return '*';
  }

  exclusionRowContaining(text) {
    return this.exclusionRows.filter({ hasText: String(text || '').trim() }).first();
  }

  exclusionRowByKey(rowKey) {
    const keyLiteral = toXPathStringLiteral(rowKey);
    return this.ruleDetail.locator(
      `xpath=.//*[@role="row" and @data-cdt-row-key=${keyLiteral}]`,
    ).first();
  }

  pendingExclusionRowContaining(text) {
    return this.exclusionRowContaining(text).and(this.page.locator('[aria-busy="true"]'));
  }

  revertButtonForRow(row) {
    return row.getByRole('button', { name: 'Revert rule', exact: true });
  }

  firstKeyedRow(table) {
    return table.locator(this.keyedTableRowSelector).first();
  }

  keyedRows(table) {
    return table.locator(this.keyedTableRowSelector);
  }
}
