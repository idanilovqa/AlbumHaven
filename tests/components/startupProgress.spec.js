const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { applyFixtureAppearance } = require('./appearanceFixture');

const root = path.resolve(__dirname, '../..');

const renderProgressMarkup = initialPercent => fs.readFileSync(
  path.join(root, 'music_app/templates/components/startup-progress.html'),
  'utf8',
)
  .replace(/{% set startup_progress_percent = [^%]+%}\s*/, '')
  .replaceAll('{{ startup_progress_percent }}', String(initialPercent))
  .replace(/{% if not startup_progress_percent %} hidden{% endif %}/, initialPercent ? '' : ' hidden')
  .replace(/<script[\s\S]*?<\/script>/, '');

const loadProgress = async (page, initialPercent, {
  themed = true,
  appearance = { palette_id: 'parchment-pine', panel_index: 0 },
} = {}) => {
  const markup = renderProgressMarkup(initialPercent);
  await page.setContent(`<body>${markup}<main><button>Gallery action</button></main></body>`);
  if (themed) await applyFixtureAppearance(page, appearance);
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/base-layout.css') });
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/startup-progress.css') });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/startup-progress.js') });
};

for (const width of [390, 1280]) {
  test(`startup progress glides with player-colored glow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await loadProgress(page, 50);

    const overlay = page.locator('[data-startup-progress]');
    await expect(overlay).toHaveCSS('background-color', 'rgb(7, 16, 29)');
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

test('startup progress keeps a colored bar without a themed palette or the sign-in stylesheet', async ({ page }) => {
  await loadProgress(page, 50, { themed: false });
  const colors = await page.evaluate(() => ({
    track: getComputedStyle(document.querySelector('.progress-bar')).backgroundColor,
    fill: getComputedStyle(document.querySelector('.progress-fill')).backgroundColor,
    fillTransition: getComputedStyle(document.querySelector('.progress-fill')).transitionDuration,
  }));
  expect(colors.track).toBe('rgba(24, 36, 53, 0.82)');
  expect(colors.fill).toBe('rgb(50, 188, 115)');
  expect(colors.fillTransition).toBe('0s');
});

test('startup progress paints its starting stage before the script runs', async ({ page }) => {
  await page.setContent(`<body>${renderProgressMarkup(50)}</body>`);
  await expect(page.locator('[data-startup-percent]')).toHaveText('50%');
  await expect(page.locator('.progress-fill')).toHaveAttribute('style', /width:\s*50%/);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
});

test('a startup failure hides the whole meter, never a lone percent', async ({ page }) => {
  await loadProgress(page, 50);
  await page.evaluate(() => window.AlbumHavenStartupProgress.fail());
  await expect(page.locator('[data-startup-meter]')).toBeHidden();
  await expect(page.locator('[data-startup-percent]')).toBeHidden();
  await expect(page.getByRole('alert')).toBeVisible();
});

// Default accounts set no player tokens, and the app page does not load login.css.
test('startup bar stays visible on the app page for a default-appearance account', async ({ page }) => {
  await loadProgress(page, 50, { appearance: { palette_id: null, panel_index: 0 } });
  await expect(page.locator('[data-startup-percent]')).toHaveText('50%');

  const bar = await page.evaluate(() => {
    const track = document.querySelector('.progress-bar');
    const fill = document.querySelector('.progress-fill');
    const percent = document.querySelector('[data-startup-percent]');
    return {
      fillColor: getComputedStyle(fill).backgroundColor,
      fillWidth: fill.getBoundingClientRect().width,
      percentColor: getComputedStyle(percent).color,
      trackBorder: getComputedStyle(track).borderTopStyle,
      trackColor: getComputedStyle(track).backgroundColor,
      trackHeight: track.getBoundingClientRect().height,
      trackWidth: track.getBoundingClientRect().width,
    };
  });
  expect(bar.fillColor).toBe('rgb(50, 188, 115)');
  expect(bar.percentColor).toBe(bar.fillColor);
  expect(bar.trackColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(bar.trackBorder).toBe('solid');
  expect(bar.trackHeight).toBeGreaterThanOrEqual(12);
  expect(bar.fillWidth).toBeGreaterThan(bar.trackWidth * 0.45);
});

test('startup progress honors reduced motion with an immediate stage update', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadProgress(page, 0);
  await page.evaluate(() => window.AlbumHavenStartupProgress.show(73));
  await expect(page.locator('.progress-fill')).toHaveAttribute('style', /width:\s*73%/);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '73');
});

test('sign-in progress continues on the app document without restarting or uncovering the page', async ({ page }) => {
  const script = fs.readFileSync(path.join(root, 'music_app/static/js/startup-progress.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'music_app/static/css/startup-progress.css'), 'utf8');
  const documentFor = initialPercent => `<!doctype html><html><head><style>${css}</style></head>`
    + `<body style="background:#000">${renderProgressMarkup(initialPercent)}<script>${script}</script></body></html>`;
  await page.route('http://startup.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: documentFor(route.request().url().endsWith('/app') ? 50 : 0),
  }));
  await page.goto('http://startup.test/login');
  await page.evaluate(() => window.AlbumHavenStartupProgress.show(25));
  await expect(page.locator('[data-startup-percent]')).toHaveText('25%');

  await page.goto('http://startup.test/app');
  const overlay = page.locator('[data-startup-progress]');
  // The overlay is painted with the first app frame, so the black body never shows.
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS('background-color', 'rgb(7, 16, 29)');
  const widths = await page.evaluate(async () => {
    const fill = document.querySelector('.progress-fill');
    const samples = [Number.parseFloat(fill.style.width)];
    for (let index = 0; index < 4; index += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.push(Number.parseFloat(fill.style.width));
    }
    return samples;
  });
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(50);
  await expect(page.locator('[data-startup-percent]')).toHaveText('50%');
  await page.evaluate(() => window.AlbumHavenStartupProgress.finish());
  await expect(overlay).toBeHidden();
});
