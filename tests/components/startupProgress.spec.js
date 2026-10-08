const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { applyFixtureAppearance } = require('./appearanceFixture');
const root = path.resolve(__dirname, '../..');
for (const width of [390, 1280]) {
  test(`startup progress uses player colors and releases content at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const markup = fs.readFileSync(path.join(root, 'music_app/templates/components/startup-progress.html'), 'utf8')
      .replace(/{{ startup_progress_initial \| default\(0\) }}/, '50').replace(/<script[\s\S]*?<\/script>/, '');
    await page.setContent(`<body>${markup}<main><button>Gallery action</button></main></body>`);
    await applyFixtureAppearance(page, { palette_id: 'parchment-pine', panel_index: 0 });
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/base-layout.css') });
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/startup-progress.css') });
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/startup-progress.js') });
    const overlay = page.locator('[data-startup-progress]');
    await expect(overlay).toContainText('Just a sec');
    await expect(overlay.locator('[data-startup-percent]')).toHaveText('50%');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    const colors = await page.evaluate(() => {
      const fill = document.querySelector('.progress-fill');
      const expected = document.createElement('span');
      expected.style.color = 'var(--appearance-play)'; document.body.append(expected);
      const heading = getComputedStyle(document.querySelector('h1')).color;
      expected.style.color = 'var(--appearance-ink)';
      const ink = getComputedStyle(expected).color;
      expected.style.color = 'var(--appearance-play)';
      const result = { heading, ink, fill: getComputedStyle(fill).backgroundColor, player: getComputedStyle(expected).color,
        glow: getComputedStyle(document.querySelector('.progress-bar')).boxShadow };
      expected.remove(); return result;
    });
    expect(colors.fill).toBe(colors.player);
    expect(colors.heading).toBe(colors.ink);
    expect(colors.glow).not.toBe('none');
    const meterWidth = await overlay.locator('.startup-progress-meter').evaluate(element => element.getBoundingClientRect().width);
    expect(meterWidth).toBe(width === 390 ? 342 : 560);
    await page.screenshot({ path: testInfo.outputPath(`startup-progress-${width}.png`) });
    await page.evaluate(() => window.AlbumHavenStartupProgress.finish());
    await expect(overlay).toBeHidden();
    await page.getByRole('button', { name: 'Gallery action' }).click();
    await page.evaluate(() => window.AlbumHavenStartupProgress.show(75));
    await expect(overlay).toBeHidden();
  });
}
