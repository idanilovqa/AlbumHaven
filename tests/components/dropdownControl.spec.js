const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');

test('shared dropdown keeps a centered neutral chevron and pointer cursor across its control', async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <div class="ui-dropdown-control" style="width:240px;--muted:rgb(126, 132, 141)">
      <input type="text" aria-label="Exception" value="Custom Collection" readonly>
    </div>
  `);
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/runtime/base-layout.css'),
  });
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/button-component.css'),
  });

  const control = page.locator('.ui-dropdown-control');
  const input = control.getByRole('textbox');
  const rendered = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const chevron = getComputedStyle(element, '::after');
    const chevronPointTarget = document.elementFromPoint(box.right - 16, box.top + (box.height / 2));
    return {
      inputCursor: getComputedStyle(element.querySelector('input')).cursor,
      inputCaretColor: getComputedStyle(element.querySelector('input')).caretColor,
      chevronPointCursor: getComputedStyle(chevronPointTarget).cursor,
      chevronPointTarget: chevronPointTarget?.tagName,
      visualCenterOffset: (() => {
        const matrix = new DOMMatrix(chevron.transform);
        const borderBoxHeight = Number.parseFloat(chevron.height)
          + Number.parseFloat(chevron.borderTopWidth)
          + Number.parseFloat(chevron.borderBottomWidth);
        return Number.parseFloat(chevron.top) + (borderBoxHeight / 2) + matrix.f
          - (box.height / 2);
      })(),
      width: chevron.width,
      height: chevron.height,
      borderRightColor: chevron.borderRightColor,
      pointerEvents: chevron.pointerEvents,
    };
  });

  expect(rendered.inputCursor).toBe('pointer');
  expect(rendered.inputCaretColor).toBe('rgba(0, 0, 0, 0)');
  expect(rendered.chevronPointCursor).toBe('pointer');
  expect(rendered.chevronPointTarget).toBe('INPUT');
  expect(Math.abs(rendered.visualCenterOffset)).toBeLessThanOrEqual(2);
  expect(rendered.width).toBe('5px');
  expect(rendered.height).toBe('5px');
  expect(rendered.borderRightColor).toBe('rgb(126, 132, 141)');
  expect(rendered.pointerEvents).toBe('none');
  await expect(input).toHaveCSS('cursor', 'pointer');

  await control.click({ position: { x: 224, y: 18 } });
  await expect(input).toBeFocused();

  await input.evaluate((element) => { element.disabled = true; });
  await expect(input).toHaveCSS('cursor', 'not-allowed');
  await expect(control).toHaveCSS('cursor', 'not-allowed');

  await input.evaluate((element) => { element.disabled = false; });
  await expect(input).toHaveCSS('cursor', 'pointer');
  await expect(control).toHaveCSS('cursor', 'pointer');
});

test('exception dropdown toggles its production menu on consecutive pointer clicks', async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <form id="tag-editor-form">
      <div class="ui-dropdown-control" data-tag-editor-exception-anchor>
        <input
          type="text"
          data-tag-field="exception_type"
          role="combobox"
          aria-expanded="false"
          value="Custom Collection"
          readonly
        >
      </div>
      <div id="tag-editor-exception-menu" role="listbox" hidden></div>
    </form>
  `);
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/button-component.css'),
  });
  await page.addScriptTag({ content: `
    var state = { view: { non_album_tracks: [] } };
    function escapeHtml(value) { return String(value ?? ''); }
    function getTagEditorElements() { return { form: document.getElementById('tag-editor-form') }; }
  ` });
  await page.addScriptTag({
    path: path.join(repositoryRoot, 'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'),
  });
  await page.addScriptTag({
    path: path.join(repositoryRoot, 'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),
  });
  await page.evaluate(() => {
    document.addEventListener('click', (event) => handleUtilityBootstrapClick(event));
  });

  const input = page.getByRole('combobox');
  const menu = page.getByRole('listbox');
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');

  await input.click();
  await expect(menu).toBeVisible();
  await expect(input).toHaveAttribute('aria-expanded', 'true');

  await input.click();
  await expect(menu).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});
