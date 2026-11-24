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
    'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
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

test('the art card delete icon is hollow red, and solid red under the pointer (owner, 11-16)', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body style="background:#101a29">
    <section id="cover-lookup-modal">
      <div class="cover-lookup-art-card" style="position:relative;width:200px;height:200px">
        <button class="cover-lookup-art-delete" type="button" data-delete-local-cover="/owned/cover.jpg"
          aria-label="Delete local cover art"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/></svg></button>
      </div>
    </section>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'appearance-backgrounds.css', 'button-component.css',
    'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  const remove = page.locator('[data-delete-local-cover]');
  const red = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--appearance-error, #ef5350)';
    document.body.append(probe);
    return getComputedStyle(probe).color;
  });
  const read = () => remove.evaluate((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, border: style.borderTopColor, color: style.color,
      stroke: getComputedStyle(button.querySelector('svg')).stroke };
  });
  await page.locator('.cover-lookup-art-card').hover({ position: { x: 20, y: 150 } });
  const idle = await read();
  expect(idle.border).toBe(red);
  expect(idle.color).toBe(red);
  expect(idle.stroke).toBe(red);
  expect(idle.background).not.toBe(red);
  await remove.hover();
  await expect.poll(read).toEqual({ background: red, border: red, color: 'rgb(255, 255, 255)', stroke: 'rgb(255, 255, 255)' });
});
