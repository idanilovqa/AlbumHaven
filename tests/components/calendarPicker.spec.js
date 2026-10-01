const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '../..');

async function mountAnchoredCalendar(page) {
  const template = fs.readFileSync(path.join(repositoryRoot, 'music_app/templates/partials/confirm-modals.html'), 'utf8');
  const modal = template.slice(template.indexOf('  <div class="confirm-modal" id="app-form-modal"'));
  await page.setViewportSize({ width: 900, height: 640 });
  await page.setContent(`<!doctype html><html><body>
    <main class="shell-main-surface"><button id="period" style="position:fixed;left:160px;top:355px;height:32px">Period</button></main>
    ${modal}</body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'runtime/utilities.css', 'runtime/non-album-and-player.css',
    'appearance-backgrounds.css', 'button-component.css', 'date-range-picker.css', 'runtime/trigger-anchor.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  for (const script of ['button-component.js', 'runtime/date-range-picker.js',
    'runtime/trigger-anchor.js', 'runtime/browser-dialog-helpers.js']) {
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js', script) });
  }
  // Wire component inputs; production form and calendar code own interaction and cleanup.
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    let dispose;
    const anchor = document.getElementById('period');
    anchor.addEventListener('click', () => {
      showAppFormDialog({
        title: 'Date range', anchor,
        contentHtml: buildDateRangePicker({ fromDate: '2026-09-01', toDate: '2026-09-23' }),
        onMount: container => { dispose = mountDateRangePicker(container); },
        onClose: () => dispose?.(),
        onSubmit: container => {
          anchor.dataset.savedDates = JSON.stringify([...container.querySelectorAll('input')].map(input => input.value));
        },
      });
    });
  });
}

test('calendar days remain clickable above the anchored form and Escape closes only the calendar', async ({ page }) => {
  await mountAnchoredCalendar(page);
  const period = page.getByRole('button', { name: 'Period', exact: true });
  await period.click();
  const form = page.getByRole('dialog', { name: 'Date range', exact: true });
  const trigger = form.getByRole('button', { name: 'Choose to date', exact: true });
  await trigger.click();
  const calendar = form.getByRole('dialog', { name: 'Choose to date', exact: true });
  const day = calendar.locator('[data-calendar-date="2026-09-05"]');
  const formBounds = await form.boundingBox();
  const dayBounds = await day.boundingBox();
  expect(dayBounds.y).toBeLessThan(formBounds.y);
  await day.click();
  await expect(form.getByRole('textbox', { name: 'To date', exact: true })).toHaveValue('2026-09-05');
  await expect(trigger).toBeFocused();
  await expect(calendar).toHaveCount(0);

  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(calendar).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(trigger).toBeFocused();
  await form.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(period).toHaveAttribute('data-saved-dates', '["2026-09-01","2026-09-05"]');
  await expect(form).toBeHidden();
  await expect(period).toBeFocused();
});
