const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');
const { resolveAppearance } = require('../../music_app/static/js/appearance-backgrounds.js');
const { applyFixtureAppearance } = require('./appearanceFixture.js');
const template = fs.readFileSync(path.join(repositoryRoot, 'music_app/templates/index.html'), 'utf8');
const clearGlyph = template.match(/action_button\('Clear completed cover art lookups'[\s\S]*?%}\s*(<svg[\s\S]*?<\/svg>)/)[1];
const clearActionMarkup = renderActionButton({
  ariaLabel: 'Clear completed cover art lookups', presentation: 'bare', className: 'cover-lookup-drawer-clear',
}).replace('<span class="action-button__icon" aria-hidden="true"></span>', clearGlyph);

async function addDrawerStyles(page) {
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'css', 'button-component.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'css', 'runtime', 'cover-lookup-drawer-and-related.css') });
}

test('cover lookup drawer actions align complete title subtitle block', async ({ page }) => {
  await page.setContent(`
    <aside class="cover-lookup-drawer is-open">
      <div class="cover-lookup-drawer-header">
        <div>
          <h3 class="cover-lookup-drawer-title">Cover lookups</h3>
          <div class="cover-lookup-drawer-subtitle">No activity</div>
        </div>
        <div class="cover-lookup-drawer-actions">
          ${clearActionMarkup}
          <button class="cover-lookup-drawer-close action-button action-button--bare" aria-label="Close cover art lookups">
            <span class="action-button__content">
              <svg class="action-button__icon ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
            </span>
          </button>
        </div>
      </div>
    </aside>
  `);
  await addDrawerStyles(page);

  const geometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const textBlock = box('.cover-lookup-drawer-header > div:first-child');
    const title = box('.cover-lookup-drawer-title');
    const subtitle = box('.cover-lookup-drawer-subtitle');
    const buttons = [...document.querySelectorAll('.cover-lookup-drawer-actions .action-button')]
      .map(button => button.getBoundingClientRect());
    const brush = box('.cover-lookup-drawer-clear svg');
    const close = box('.cover-lookup-drawer-close .action-button__icon');

    return {
      textBlockCenterY: textBlock.y + textBlock.height / 2,
      subtitleTop: subtitle.y,
      titleBottom: title.bottom,
      buttonCentersY: buttons.map(button => button.y + button.height / 2),
      buttonSizes: buttons.map(button => [button.width, button.height]),
      brushBoxCenterY: brush.y + brush.height / 2,
      closeGlyphCenterY: close.y + close.height / 2,
    };
  });

  for (const centerY of geometry.buttonCentersY) {
    expect(centerY).toBeCloseTo(geometry.textBlockCenterY, 0);
  }
  expect(geometry.buttonSizes[0]).toEqual(geometry.buttonSizes[1]);
  expect(geometry.brushBoxCenterY).toBeCloseTo(geometry.closeGlyphCenterY, 1);
  expect(geometry.subtitleTop).toBeGreaterThanOrEqual(geometry.titleBottom);
});

async function renderClearAction(page, appearanceMode) {
  const palette = appearanceMode === 'light' ? 'paper' : 'black';
  await page.setContent(`<!doctype html><html><body style="background:var(--appearance-panel-background)">
    ${clearActionMarkup}
  </body></html>`);
  await addDrawerStyles(page);
  await applyFixtureAppearance(page, { palette_id: palette, panel_index: 0 });
  const ink = resolveAppearance({ palette_id: palette, panel_index: 0 }).tokens.ink;
  return `rgb(${ink.slice(1).match(/../g).map(part => parseInt(part, 16)).join(', ')})`;
}

for (const mode of ['light', 'dark']) {
  test(`${mode} theme keeps the shared Clear SVG legible through hover and focus`, async ({ page }) => {
    const expectedInk = await renderClearAction(page, mode);
    const clearAction = page.getByRole('button', { name: 'Clear completed cover art lookups' });
    const glyph = clearAction.locator('svg');
    await expect(glyph).toHaveCount(1);
    await expect(clearAction.locator('img')).toHaveCount(0);
    await expect(glyph).toHaveAttribute('aria-hidden', 'true');
    await expect(glyph).toHaveAttribute('viewBox', '0 0 20 20');
    await expect(glyph).toHaveCSS('stroke', expectedInk);
    await expect(glyph).toHaveCSS('fill', 'none');
    await expect(glyph).toHaveCSS('opacity', '1');
    await clearAction.hover();
    await expect(glyph).toHaveCSS('stroke', expectedInk);
    await expect(glyph).toHaveCSS('opacity', '1');
    await page.mouse.move(200, 200);
    await clearAction.focus();
    await expect(clearAction).toBeFocused();
    await expect(glyph).toHaveCSS('stroke', expectedInk);
    await expect(glyph).toHaveCSS('opacity', '1');
    await expect(clearAction).toHaveCSS('outline-style', 'solid');
    await expect(clearAction).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  });
}

test('light theme keeps the disabled clear brush legible', async ({ page }) => {
  const expectedInk = await renderClearAction(page, 'light');
  const clearAction = page.getByRole('button', { name: 'Clear completed cover art lookups' });
  await clearAction.evaluate(button => {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => { button.dataset.activated = 'true'; });
    button.click();
  });
  await expect(clearAction).toBeDisabled();
  await expect(clearAction).not.toHaveAttribute('data-activated', 'true');
  await expect(clearAction).toHaveCSS('opacity', '0.75');
  await expect(clearAction.locator('svg')).toHaveCSS('stroke', expectedInk);
  await expect(clearAction.locator('svg')).toHaveCSS('opacity', '1');
});
