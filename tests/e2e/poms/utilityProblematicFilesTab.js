import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySearchSection } from './utilitySearchSection.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

function albumTitleWithOptionalYear(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = escaped.replace(/\s+/g, '\\s+');
  return new RegExp(`^\\s*${normalized}(?:\\s+\\/\\s+.+)?\\s*$`, 'u');
}

function cssAttributeValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class UtilityProblematicFilesTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.searchSection = new UtilitySearchSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator(this.activeListItemSelector);
    this.listEmptyState = page.locator(this.listEmptyStateSelector).first();
    this.detailEmptyState = page.locator('#utility-problematic-detail .utility-empty-state').first();
    this.detailTitle = page.locator(this.detailTitleSelector).first();
    this.detailScroller = page.locator(this.detailScrollerSelector).first();
    this.detailArtist = page.locator('#utility-problematic-detail .utility-detail-meta').first();
    this.detailProblemChips = page.locator('#utility-problematic-detail .utility-track-problem-chip');
    this.detailProblemReasons = page.locator(
      '#utility-problematic-detail .utility-track-problem-chip, #utility-problematic-detail .utility-problem-item',
    );
    this.detailTrackRows = page.locator(this.problematicTrackRowSelector);
    this.detailFileTypeChips = page.locator('#utility-problematic-detail .utility-file-type-chip');
    this.detailDetectedProblemsSection = page.locator('[data-utility-section-toggle="detected"]').first();
    this.detailSuggestedEditsSection = page.locator('[data-utility-section-toggle="suggested"]').first();
    this.suggestedEditChoices = page.locator('#utility-problematic-detail [data-repair-choice]');
    this.suggestedEditRows = page.locator('#utility-problematic-detail .utility-repair-preview-item');
    this.suggestedEditsApplyButton = page.locator('#utility-problematic-detail [data-open-repair-confirm="1"]');
    this.detailOpenInExplorerButton = page.locator('[data-open-problematic-album-folder="1"]').first();
    this.detailEditTagsButton = page.locator('[data-open-tag-editor="1"]').first();
    this.detailDiscogsButton = page.locator('[data-find-on-discogs="1"]').first();
    this.detectedProblemsHeading = page.getByText('DETECTED PROBLEMS', { exact: true }).first();
    this.albumProblemsHeading = page.getByText('ALBUM-LEVEL PROBLEMS', { exact: true }).first();
    this.trackProblemsHeading = page.getByText('TRACK-LEVEL PROBLEMS', { exact: true }).first();
    this.trackProblemsTable = page.locator('#utility-problematic-detail [data-cdt-frame="inset"][role="table"]').first();
    this.trackProblemHeaders = this.trackProblemsTable.locator('[role="columnheader"]');
    this.trackProblemReasonCells = this.trackProblemsTable.locator('[role="cell"][data-cdt-column="reason"]');
    this.trackProblemRows = this.trackProblemsTable.locator('[role="row"][data-cdt-row-key]');
    this.albumProblemPills = page.locator(this.albumProblemPillSelector);
    this.selectedProblemPills = page.locator(this.selectedProblemPillSelector);
    this.problemReasonCount = page.locator(this.problemReasonCountSelector).first();
    this.forbiddenDetectedProblemElements = page.locator(this.forbiddenDetectedProblemSelector);
    this.excludeProblemButton = page.getByRole('button', { name: 'Exclude the problem', exact: true });
    this.exclusionConfirmDialog = page.locator('#repair-confirm-modal');
    this.exclusionConfirmText = page.locator('#repair-confirm-text');
    this.exclusionCancelButton = this.exclusionConfirmDialog.getByRole('button', { name: 'Cancel', exact: true });
    this.exclusionAcceptButton = this.exclusionConfirmDialog.getByRole('button', { name: 'Exclude', exact: true });
    this.repairConfirmDialog = page.getByRole('dialog', { name: 'Repair local files', exact: true });
    this.repairConfirmAcceptButton = page.locator('#repair-confirm-accept');
    this.repairProgressOverlay = page.locator('#repair-progress-overlay');
    this.mutationOverlay = page.locator('#utility-problematic-detail .problematic-mutation-overlay');
    this.mutationSpinners = this.mutationOverlay.locator(this.mutationSpinnerSelector);
    this.errorToasts = page.locator('#toast-layer .toast.is-error');
  }

  titleForListItem(item) {
    return item.locator(this.listItemTitleSelector);
  }

  metaForListItem(item) {
    return item.locator(this.listItemMetaSelector);
  }

  issuesForListItem(item) {
    return item.locator(this.listItemIssuesSelector);
  }

  get listItemSelector() {
    return '[data-problematic-album-key]';
  }

  get sidebarListSelector() {
    return '#utility-problematic-list';
  }

  get activeListItemSelector() {
    return '[data-problematic-album-key].is-active';
  }

  get detailTitleSelector() {
    return '#utility-problematic-detail .utility-detail-title';
  }

  get detailScrollerSelector() {
    return '#utility-problematic-detail';
  }

  get problematicTrackRowSelector() {
    return '#utility-problematic-detail [role="row"][data-cdt-row-key][data-problematic-track-path]';
  }

  get listEmptyStateSelector() {
    return '#utility-problematic-list .utility-empty-state';
  }

  get listItemTitleSelector() {
    return '.utility-list-item-title';
  }

  get listItemMetaSelector() {
    return '.utility-list-item-meta';
  }

  get listItemIssuesSelector() {
    return '.utility-list-item-issues';
  }

  problematicTrackRowByTitle(trackTitle) {
    return this.page.locator(this.problematicTrackRowSelector).filter({
      hasText: String(trackTitle || '').trim(),
    }).first();
  }

  problematicTrackRowByPath(trackPath) {
    return this.page.locator(
      `${this.problematicTrackRowSelector}[data-problematic-track-path="${cssAttributeValue(trackPath)}"]`,
    ).first();
  }

  filenameForTrackRow(row) {
    return row.locator('[role="cell"][data-cdt-column="filename"]');
  }

  reasonsForTrackRow(row) {
    return row
      .locator('[role="cell"][data-cdt-column="reason"]')
      .locator('[data-problem-exclusion-scope="file"]');
  }

  get albumProblemPillSelector() {
    return '[data-problem-exclusion-scope="album"]';
  }

  get albumProblemSectionSelector() {
    return '.utility-album-problem-list';
  }

  get detectedProblemActionsSelector() {
    return '.utility-detected-actions';
  }

  get trackProblemSectionSelector() {
    return '.utility-track-problem-table';
  }

  get selectedProblemPillSelector() {
    return '[data-problem-exclusion-scope][aria-pressed="true"]';
  }

  get problemReasonCountSelector() {
    return '.utility-problem-count';
  }

  get mutationOverlaySelector() {
    return '#utility-problematic-detail .problematic-mutation-overlay';
  }

  get mutationSpinnerSelector() {
    return '.problematic-mutation-spinner';
  }

  get trackProblemTableSelector() {
    return '[data-cdt-frame="inset"][role="table"]';
  }

  get columnHeaderSelector() {
    return '[role="columnheader"]';
  }

  get reasonCellSelector() {
    return '[role="cell"][data-cdt-column="reason"]';
  }

  get keyedTableRowSelector() {
    return '[role="row"][data-cdt-row-key]';
  }

  get directTableCellSelector() {
    return ':scope > [role="cell"]';
  }

  get forbiddenDetectedProblemSelector() {
    return '.utility-file-type-chip, [data-cdt-column="number"], [data-cdt-action], [data-problem-row-menu], [data-row-exclude]';
  }

  albumProblemPill(reason) {
    const canonicalReason = this.page.locator(
      `[data-problem-exclusion-scope="album"][data-problem-exclusion-reason="${cssAttributeValue(reason)}"]`,
    );
    const visibleReason = this.page.locator(this.albumProblemPillSelector).filter({
      hasText: exactNormalizedText(reason),
    });
    return canonicalReason.or(visibleReason).first();
  }

  fileProblemPill(filename, reason) {
    return this.problematicTrackRowByTitle(filename)
      .locator('[data-problem-exclusion-scope="file"]')
      .filter({ hasText: exactNormalizedText(reason) })
      .first();
  }

  suggestedEditRowByKey(rowKey) {
    return this.suggestedEditRows.filter({
      has: this.page.locator(`[data-repair-row-key="${cssAttributeValue(rowKey)}"]`),
    }).first();
  }

  suggestedEditChoice(row, choice) {
    return row.locator(`[data-repair-choice="${cssAttributeValue(choice)}"]`);
  }

  suggestedEditRowKey(row) {
    return row.locator('[data-repair-row-key]').first();
  }

  suggestedEditOriginal(row) {
    return row.locator('.utility-repair-preview-original').first();
  }

  suggestedEditRepaired(row) {
    return row.locator('.utility-repair-preview-repaired').first();
  }

  activeSuggestedEditChoice(row) {
    return row.locator('[data-repair-choice].is-active').first();
  }

  listItemByTitle(albumTitle) {
    return this.listItems.filter({
      has: this.page.locator(this.listItemTitleSelector).filter({ hasText: albumTitleWithOptionalYear(albumTitle) }),
    }).first();
  }
}
