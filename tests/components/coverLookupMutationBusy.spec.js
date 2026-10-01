const path = require('node:path');
const { test, expect } = require('@playwright/test');
const root = path.join(__dirname, '../..');

test('pending local cover actions remain visibly disabled on hover and re-enable normally', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body>
    <section id="cover-lookup-modal">
      <div class="cover-lookup-art-card" style="position:relative;width:200px;height:200px">
        <button class="cover-lookup-art-delete" data-delete-local-cover="/owned/cover.jpg" disabled>Delete</button>
      </div>
      <button class="button" id="cover-lookup-save-remote-button" disabled>Save</button>
    </section>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'appearance-backgrounds.css', 'button-component.css',
    'runtime/cover-lookup-modal.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  const remove = page.locator('[data-delete-local-cover]');
  const save = page.locator('#cover-lookup-save-remote-button');
  await page.locator('.cover-lookup-art-card').hover();
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveCSS('opacity', '0.55');
  await expect(remove).toHaveCSS('cursor', 'not-allowed');
  await expect(remove).toHaveCSS('filter', 'grayscale(1)');
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS('opacity', '0.55');
  await expect(save).toHaveCSS('cursor', 'not-allowed');
  await remove.evaluate(button => { button.disabled = false; });
  await expect(remove).toBeEnabled();
  await expect(remove).toHaveCSS('opacity', '1');
  await expect(remove).toHaveCSS('cursor', 'pointer');
  await expect(remove).toHaveCSS('filter', 'none');
});
