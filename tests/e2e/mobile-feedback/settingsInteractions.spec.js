import fs from 'node:fs/promises';
import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileSettingsFeedbackPage } from '../poms/mobileSettingsFeedbackPage.js';
import { UtilityLogHistoryTab } from '../poms/utilityLogHistoryTab.js';
import { UtilityProblematicFilesTab } from '../poms/utilityProblematicFilesTab.js';
import { UtilityRulesTab } from '../poms/utilityRulesTab.js';

for (const palette of ['black', 'paper', 'parchment-pine']) {
  test(`mobile date filter validates, cancels, applies and exports in ${palette}`, async ({ page, app }) => {
    const ui = new MobileSettingsFeedbackPage(page), logs = new UtilityLogHistoryTab(page);
    await ui.usePalette(palette);
    await ui.openSettings();
    await ui.selectUtility('log-history');
    await logs.periodButton.click();
    const today = await logs.periodFrom.inputValue();
    // Read-only fields enforce ordering through the shared calendar.
    for (const field of ['from', 'to']) {
      await logs.periodDateButton(field).click();
      const calendar = logs.periodCalendar(field);
      await expect(calendar).toBeVisible();
      await ui.expectReadable(logs.periodCalendarDay(field, today));
      const box = await calendar.boundingBox(), viewport = page.viewportSize();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await calendar.getByRole('button', { name: field === 'from' ? 'Next month' : 'Previous month', exact: true }).click();
      await expect(logs.enabledPeriodDays(field)).toHaveCount(0);
      await calendar.getByRole('button', { name: field === 'from' ? 'Previous month' : 'Next month', exact: true }).click();
      await logs.periodCalendarDay(field, today).click();
      await expect(calendar).not.toBeVisible();
    }
    await logs.periodDateButton('from').click();
    await logs.periodCalendar('from').getByRole('button', { name: 'Previous month', exact: true }).click();
    await logs.enabledPeriodDays('from').first().click();
    await expect(logs.periodFrom).not.toHaveValue(today);
    await logs.periodDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(logs.periodDialog).not.toBeVisible();
    await expect(logs.periodRow).toHaveCount(0);
    await logs.periodButton.click();
    await expect(logs.periodFrom).toHaveValue(today);
    const captured = page.waitForResponse(response => new URL(response.url()).pathname === '/utilities/log-history'
      && new URL(response.url()).searchParams.has('from_utc'));
    await logs.periodDialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const response = await captured;
    expect(response.ok()).toBe(true);
    const data = await response.json();
    await expect(logs.periodDialog).not.toBeVisible();
    await expect(logs.periodRow).toHaveCount(1);
    await logs.periodRow.click();
    await expect(ui.detail).toBeVisible();
    const downloading = page.waitForEvent('download');
    await logs.exportButton.click();
    const download = await downloading;
    expect(await download.failure()).toBeNull();
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    expect(exported.snapshot).toBe(data.snapshot);
    expect(exported.items).toEqual(data.items);
    await logs.clearPeriodButton.click();
    await expect(logs.periodRow).toHaveCount(0);
  });
}

test('mobile Problematic Files search, filters and exact exceptions survive reload while Rules remains read-only', async ({ page, app }) => {
  const ui = new MobileSettingsFeedbackPage(page), problems = new UtilityProblematicFilesTab(page), rules = new UtilityRulesTab(page);
  const search = problems.searchSection;
  await ui.openSettings();
  await ui.selectUtility('rules');
  await ui.selectSubsection('problem-ignores');
  await expect(ui.detail).toContainText('No problem exclusions yet.');
  await ui.selectUtility('problematic-files');
  await search.searchInput.fill('no-such-generated-album');
  await expect(problems.listItems).toHaveCount(0);
  await expect(problems.listEmptyState).toBeVisible();
  await search.searchInput.fill('');
  await expect(problems.listItems.first()).toBeVisible();
  await search.problemFilterButton.click();
  await expect(search.problemFilterMenu).toBeVisible();
  await search.problemFilterButton.click();
  await expect(search.problemFilterMenu).not.toBeVisible();
  await search.problemFilterButton.click();
  await ui.pageTitle.click();
  await expect(search.problemFilterMenu).not.toBeVisible();
  await search.problemFilterButton.click();
  await search.filterOptionByValue('Missing year').click();
  await expect(search.filterChipByValue('Missing year')).toBeVisible();
  await expect(problems.listItems.filter({ hasText: 'Collected Skies 03' })).toBeVisible();
  await expect(problems.listItems.filter({ hasText: 'Collected Skies 02' })).toHaveCount(0);
  await search.filterChipByValue('Missing year').click();
  await expect(search.filterChipByValue('Missing year')).toHaveCount(0);
  await search.searchInput.fill('Collected Skies 02');
  await expect(problems.listItems).toHaveCount(1);
  await problems.listItems.click();
  await expect(problems.detailOpenInExplorerButton).not.toBeVisible();
  await expect(problems.excludeProblemButton).toBeDisabled();
  const first = problems.detailProblemChips.first();
  const reason = await first.getAttribute('data-problem-exclusion-reason');
  const count = await problems.detailProblemChips.count();
  expect(count).toBeGreaterThan(1);
  await first.click();
  await expect(problems.selectedProblemPills).toHaveCount(1);
  await first.click();
  await expect(problems.selectedProblemPills).toHaveCount(0);
  await first.click();
  await problems.excludeProblemButton.click();
  await expect(problems.exclusionConfirmDialog).toBeVisible();
  await problems.exclusionCancelButton.click();
  await expect(problems.detailProblemChips).toHaveCount(count);
  await problems.excludeProblemButton.click();
  const saved = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/utilities/rules/problem-ignores');
  await problems.exclusionAcceptButton.click();
  expect((await saved).ok()).toBe(true);
  await expect(problems.detailProblemChips).toHaveCount(count - 1);
  await page.reload();
  await expect(problems.detailProblemChips).toHaveCount(count - 1);
  await ui.selectUtility('rules');
  await ui.selectSubsection('problem-ignores');
  const row = rules.exclusionRowContaining('Collected Skies 02');
  await expect(rules.exclusionReason(row)).toHaveText(reason);
  await expect(rules.revertButtonForRow(row)).not.toBeVisible();
  await page.reload();
  await ui.selectSubsection('problem-ignores');
  await expect(rules.exclusionReason(rules.exclusionRowContaining('Collected Skies 02'))).toHaveText(reason);
});

test('mobile Library Refresh reloads saved settings and remains read-only after resizing', async ({ page, app }) => {
  const ui = new MobileSettingsFeedbackPage(page);
  await ui.openSettings();
  await ui.selectUtility('integrations');
  await ui.selectSubsection('library');
  await ui.expectLibraryReadOnly();
  const path = await ui.libraryPaths.first().inputValue();
  const refreshing = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/library-settings');
  await ui.libraryRefresh.click();
  expect((await refreshing).ok()).toBe(true);
  await expect(ui.libraryPaths.first()).toHaveValue(path);
  await ui.expectLibraryReadOnly();
  await page.setViewportSize({ width: 1180, height: 900 });
  await ui.expectLibraryReadOnly();
  await page.setViewportSize({ width: 390, height: 844 });
  await ui.expectLibraryReadOnly();
});
