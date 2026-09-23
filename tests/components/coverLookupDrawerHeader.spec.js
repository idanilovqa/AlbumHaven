const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');

async function addDrawerStyles(page) {
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'css', 'button-component.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'css', 'runtime', 'cover-lookup-drawer-and-related.css') });
}

test('cover lookup drawer actions align complete title subtitle block', async ({ page }) => {
  await page.setContent(`
    <aside class="cover-lookup-drawer">
      <div class="cover-lookup-drawer-header">
        <div>
          <h3 class="cover-lookup-drawer-title">Cover lookups</h3>
          <div class="cover-lookup-drawer-subtitle">No activity</div>
        </div>
        <div class="cover-lookup-drawer-actions">
          <button class="cover-lookup-drawer-clear action-button action-button--bare" aria-label="Clear completed cover art lookups">
            <span class="action-button__content">
              <span class="cover-lookup-drawer-clear-glyph" aria-hidden="true"></span>
            </span>
          </button>
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
    const brush = box('.cover-lookup-drawer-clear-glyph');
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
  await page.setContent(`
    <html data-appearance-mode="${appearanceMode}">
      <body>
        <button class="cover-lookup-drawer-clear action-button action-button--bare" aria-label="Clear completed cover art lookups">
          <span class="action-button__content">
            <span class="cover-lookup-drawer-clear-glyph" aria-hidden="true">
              <img class="cover-lookup-drawer-clear-glyph-default" alt="">
              <img class="cover-lookup-drawer-clear-glyph-hover" alt="">
            </span>
          </span>
        </button>
      </body>
    </html>
  `);
  await addDrawerStyles(page);
}

test('light theme keeps the dark clear glyph through hover and focus', async ({ page }) => {
  await renderClearAction(page, 'light');
  const clearAction = page.getByRole('button', { name: 'Clear completed cover art lookups' });
  const defaultGlyph = page.locator('.cover-lookup-drawer-clear-glyph-default');
  const hoverGlyph = page.locator('.cover-lookup-drawer-clear-glyph-hover');

  await expect(defaultGlyph).toHaveCSS('opacity', '0');
  await expect(hoverGlyph).toHaveCSS('opacity', '1');

  await clearAction.hover();
  await expect(defaultGlyph).toHaveCSS('opacity', '0');
  await expect(hoverGlyph).toHaveCSS('opacity', '1');

  await page.mouse.move(200, 200);
  await clearAction.focus();
  await expect(clearAction).toBeFocused();
  await expect(defaultGlyph).toHaveCSS('opacity', '0');
  await expect(hoverGlyph).toHaveCSS('opacity', '1');
});

test('light theme keeps the disabled clear brush legible', async ({ page }) => {
  await renderClearAction(page, 'light');
  const clearAction = page.getByRole('button', { name: 'Clear completed cover art lookups' });
  await clearAction.evaluate(button => {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
  });

  await expect(clearAction).toHaveCSS('opacity', '0.75');
  await expect(page.locator('.cover-lookup-drawer-clear-glyph-hover')).toHaveCSS('opacity', '1');
});

test('dark theme retains the current clear glyph swap', async ({ page }) => {
  await renderClearAction(page, 'dark');
  const clearAction = page.getByRole('button', { name: 'Clear completed cover art lookups' });
  const defaultGlyph = page.locator('.cover-lookup-drawer-clear-glyph-default');
  const hoverGlyph = page.locator('.cover-lookup-drawer-clear-glyph-hover');

  await expect(defaultGlyph).toHaveCSS('opacity', '1');
  await expect(hoverGlyph).toHaveCSS('opacity', '0');

  await clearAction.hover();
  await expect(defaultGlyph).toHaveCSS('opacity', '0');
  await expect(hoverGlyph).toHaveCSS('opacity', '1');

  await page.mouse.move(200, 200);
  await clearAction.focus();
  await expect(clearAction).toBeFocused();
  await expect(defaultGlyph).toHaveCSS('opacity', '0');
  await expect(hoverGlyph).toHaveCSS('opacity', '1');
});
