const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { applyFixtureAppearance } = require('./appearanceFixture');

const root = path.resolve(__dirname, '../..');

const loadProgress = async (page, initialPercent) => {
  const markup = fs.readFileSync(
    path.join(root, 'music_app/templates/components/startup-progress.html'),
    'utf8',
  )
    .replace(/{{ startup_progress_initial \| default\(0\) }}/, String(initialPercent))
    .replace(/<script[\s\S]*?<\/script>/, '');
  await page.setContent(`<body>${markup}<main><button>Gallery action</button></main></body>`);
  await applyFixtureAppearance(page, { palette_id: 'parchment-pine', panel_index: 0 });
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/base-layout.css') });
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/startup-progress.css') });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/startup-progress.js') });
};

for (const width of [390, 1280]) {
  test(`startup progress glides with player-colored glow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await loadProgress(page, 50);

    const overlay = page.locator('[data-startup-progress]');
    await expect(overlay).toContainText('Just a sec');
    await expect(overlay.locator('[data-startup-percent]')).toHaveText('50%');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');

    const appearance = await page.evaluate(() => {
      const expected = document.createElement('span');
      expected.style.color = 'var(--appearance-play)';
      document.body.append(expected);
      const player = getComputedStyle(expected).color;
      expected.style.color = 'var(--appearance-ink)';
      const ink = getComputedStyle(expected).color;
      expected.remove();

      const fill = getComputedStyle(document.querySelector('.progress-fill'));
      const track = getComputedStyle(document.querySelector('.progress-bar'));
      const percent = getComputedStyle(document.querySelector('[data-startup-percent]'));
      return {
        fillColor: fill.backgroundColor,
        fillGlow: fill.boxShadow,
        headingColor: getComputedStyle(document.querySelector('h1')).color,
        ink,
        percentColor: percent.color,
        percentGlow: percent.textShadow,
        player,
        trackGlow: track.boxShadow,
      };
    });
    expect(appearance.fillColor).toBe(appearance.player);
    expect.soft(appearance.percentColor).toBe(appearance.player);
    expect(appearance.headingColor).toBe(appearance.ink);
    expect.soft(appearance.trackGlow).not.toBe('none');
    expect.soft(appearance.fillGlow).not.toBe('none');
    expect.soft(appearance.percentGlow).not.toBe('none');
    const shadowCount = value => (value.match(/0px 0px/g) || []).length;
    expect.soft(shadowCount(appearance.trackGlow)).toBeGreaterThanOrEqual(2);
    expect.soft(shadowCount(appearance.fillGlow)).toBeGreaterThanOrEqual(2);
    expect.soft(shadowCount(appearance.percentGlow)).toBeGreaterThanOrEqual(2);

    const meter = overlay.locator('.startup-progress-meter');
    await expect(meter).toHaveCSS('width', width === 390 ? '342px' : '560px');
    const layout = await meter.evaluate(element => {
      const bar = element.querySelector('.progress-bar').getBoundingClientRect();
      const percent = element.querySelector('[data-startup-percent]').getBoundingClientRect();
      return {
        centerDelta: Math.abs((percent.left + percent.width / 2) - (bar.left + bar.width / 2)),
        percentBelowBar: percent.top >= bar.bottom,
      };
    });
    expect.soft(layout.centerDelta).toBeLessThan(1);
    expect.soft(layout.percentBelowBar).toBe(true);

    const widths = await page.evaluate(async () => {
      window.AlbumHavenStartupProgress.reset();
      window.AlbumHavenStartupProgress.show(73);
      const fill = document.querySelector('.progress-fill');
      const samples = [];
      for (let index = 0; index < 6; index += 1) {
        await new Promise(resolve => requestAnimationFrame(() => {
          samples.push(fill.style.width);
          resolve();
        }));
      }
      return samples;
    });
    expect.soft(widths.some(value => /\.\d+%$/.test(value))).toBe(true);
    expect.soft(Number.parseFloat(widths[0])).toBeLessThan(73);

    await page.screenshot({ path: testInfo.outputPath(`startup-progress-${width}.png`) });
    await page.evaluate(() => window.AlbumHavenStartupProgress.finish());
    await expect(overlay).toBeHidden();
    await page.getByRole('button', { name: 'Gallery action' }).click();
    await page.evaluate(() => window.AlbumHavenStartupProgress.show(75));
    await expect(overlay).toBeHidden();
  });
}

test('startup progress honors reduced motion with an immediate stage update', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadProgress(page, 0);
  await page.evaluate(() => window.AlbumHavenStartupProgress.show(73));
  await expect(page.locator('.progress-fill')).toHaveAttribute('style', /width:\s*73%/);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '73');
});
