const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const baseLayoutCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'base-layout.css',
);
const buttonCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'button-component.css',
);
const appearanceCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'appearance-backgrounds.css',
);
const buttonRuntimePath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'button-component.js',
);
const editorPageRuntimePath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'editor-page.js',
);
const componentUrl = 'http://button-interaction-component.test/editor-footer';
const outlineColor = 'rgb(255, 90, 117)';

async function mountEditorFooter(page) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html data-appearance-palette="component-test">
        <head>
          <style>
            :root {
              --appearance-interaction-outline: #ff5a75;
              --appearance-accent: #72baff;
              --appearance-line: #4b5563;
              --appearance-control: #1f2937;
              --appearance-item-action-hover-background: #293a50;
              --appearance-ink: #f3f6fa;
              --appearance-muted: #aeb9c7;
              --appearance-panel-background: #111827;
              --appearance-primary-button: #2563eb;
              --appearance-primary-button-ink: #ffffff;
            }
            body { margin: 40px; background: #111827; color: #f3f6fa; }
          </style>
        </head>
        <body>
          <div id="footer-host"></div>
          <div class="global-player">
            <button type="button" class="button" aria-label="Player action">Player action</button>
          </div>
          <div id="preview-host"></div>
        </body>
      </html>`,
  }));

  await page.goto(componentUrl);
  await page.addStyleTag({ path: baseLayoutCssPath });
  await page.addStyleTag({ path: appearanceCssPath });
  await page.addStyleTag({ path: buttonCssPath });
  await page.addScriptTag({ path: buttonRuntimePath });
  await page.addScriptTag({ path: editorPageRuntimePath });
  await page.evaluate(() => {
    EditorPage.mountFooter(document.getElementById('footer-host'), {
      resetLabel: 'Reset Appearance',
      status: 'Saved to your account',
      canSave: false,
      secondary: { label: 'Cancel' },
      primary: { label: 'Save' },
    });
    document.getElementById('preview-host').innerHTML = `<div class="background-preview-actions">
      <span><strong>Buttons</strong><small>Hover, press, or use Tab to preview interactions.</small></span>
      <div>${ButtonComponent.renderButton({ label: 'Cancel', variant: 'secondary', size: 'small', quiet: true, attributes: { 'data-background-preview-cancel': true } })}${ButtonComponent.renderButton({ label: 'Save', variant: 'primary', size: 'small', attributes: { 'data-background-preview-save': true } })}</div>
    </div>`;
  });
}

test('shared footer buttons render themed hover and keyboard-focus outlines while excluded controls stay inert', async ({ page }) => {
  await mountEditorFooter(page);

  const footer = page.locator('#footer-host');
  const reset = footer.getByRole('button', { name: 'Reset Appearance', exact: true });
  const cancel = footer.getByRole('button', { name: 'Cancel', exact: true });
  const save = footer.getByRole('button', { name: 'Save', exact: true });
  const playerAction = page.getByRole('button', { name: 'Player action', exact: true });
  const previewCancel = page.locator('[data-background-preview-cancel]');
  const previewSave = page.locator('[data-background-preview-save]');

  await expect(previewCancel).toHaveCount(1);
  await expect(previewSave).toHaveCount(1);

  await expect(save).toBeDisabled();
  await reset.hover();
  await expect(reset).toHaveCSS('outline-style', 'solid');
  await expect(reset).toHaveCSS('outline-width', '2px');
  await expect(reset).toHaveCSS('outline-offset', '2px');
  await expect(reset).toHaveCSS('outline-color', outlineColor);
  await expect(reset).toHaveCSS('border-color', outlineColor);

  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await expect(reset).toBeFocused();
  await expect(reset).toHaveCSS('outline-style', 'solid');
  await expect(reset).toHaveCSS('outline-width', '2px');
  await expect(reset).toHaveCSS('outline-color', outlineColor);

  await cancel.hover();
  await expect(cancel).toHaveClass(/ui-button--quiet/);
  await expect(cancel).toHaveCSS('outline-style', 'solid');
  await expect(cancel).toHaveCSS('outline-color', outlineColor);
  await expect(cancel).toHaveCSS('border-color', outlineColor);
  const quietHoverBackground = await cancel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(quietHoverBackground).not.toBe('rgb(41, 58, 80)');

  const bounds = await cancel.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const quietPressedBackground = await cancel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(quietPressedBackground).not.toBe(quietHoverBackground);
  await page.mouse.up();

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Tab');
  await expect(reset).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await expect(cancel).toHaveCSS('outline-style', 'solid');
  await expect(cancel).toHaveCSS('outline-color', outlineColor);

  await save.hover({ force: true });
  await expect(save).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');

  await playerAction.hover();
  await expect(playerAction).toHaveCSS('outline-style', 'none');

  await previewCancel.hover();
  await expect(previewCancel).toHaveCSS('outline-color', outlineColor);
  const previewQuietHover = await previewCancel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(previewQuietHover).not.toBe('rgb(41, 58, 80)');

  await previewCancel.focus();
  await page.keyboard.press('Tab');
  await expect(previewSave).toBeFocused();
  await expect(previewSave).toHaveCSS('outline-color', outlineColor);
});
