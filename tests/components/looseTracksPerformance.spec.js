const path = require('node:path');
const { test, expect } = require('@playwright/test');
const staticRoot = path.resolve(__dirname, '../../music_app/static');
// DOM trace snapshots force offscreen rows to render and invalidate this measurement.
test.use({ trace: 'off', screenshot: 'off' });

for (const width of [390, 1000]) {
test(`large loose-track sections stay responsive and stable at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width, height: 720 });
  await page.setContent('<style>*{box-sizing:border-box}body{margin:0;font:14px Arial}#host{height:600px;overflow:auto}</style><div id="host" class="non-album-modal-table"></div>');
  for (const file of ['runtime/compact-data-table.css', 'runtime/album-track-table.css', 'runtime/non-album-and-player.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.ButtonComponent = { renderIconSvg: () => '<svg width="16" height="16"><path d="M2 2L14 8L2 14Z"/></svg>' };
  });
  for (const file of ['compact-data-table.js', 'album-track-table.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => {
    document.getElementById('host').innerHTML = buildAlbumTrackTableHtml({
      groups: ['Interviews', 'Other'].map((discLabel, group) => ({ discLabel, tracks: Array.from({ length: 3000 }, (_, index) => {
        const i = group * 3000 + index;
        return {
        path: `/fixture/track-${i}.flac`, title: `Loose track ${i}`, secondaryArtist: i % 2 ? 'Fixture artist' : '', duration: '3:00',
      }; }) })), showPath: true, forceGroupLabels: true, collapsibleGroups: true, totalLength: '300 hours',
    });
    window.originalFirstRow = document.querySelector('[data-track-row-path]');
  });
  const heading = page.locator('summary').first();
  await expect(heading).toBeVisible();
  const top = (await heading.boundingBox()).y;
  const timings = [];
  for (let i = 0; i < 4; i++) {
    await heading.evaluate(node => node.addEventListener('click', () => {
      const start = performance.now();
      window.toggleTiming = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))));
    }, { once: true }));
    await heading.click();
    timings.push(await page.evaluate(() => window.toggleTiming));
    expect(await page.locator('details').first().evaluate(node => node.open)).toBe(Boolean(i % 2));
    if (i % 2) await expect(page.locator('.album-track-table__total')).toBeVisible();
    else await expect(page.locator('.album-track-table__total')).toBeHidden();
    expect((await heading.boundingBox()).y).toBe(top);
  }
  console.log('Loose Tracks toggle milliseconds:', timings);
  expect(Math.max(...timings)).toBeLessThan(250);
  expect(await page.evaluate(() => originalFirstRow === document.querySelector('[data-track-row-path]'))).toBe(true);
  await expect(page.locator('[data-track-row-path]')).toHaveCount(6000);
  await page.locator('[data-track-row-path]').last().scrollIntoViewIfNeeded();
  await expect(page.locator('[data-track-row-path]').last().locator('.album-track-table__title')).toBeVisible();
  await expect(page.locator('[data-track-row-path]').last().locator('.album-track-table__title')).toContainText('Loose track 5999');
  const heightBefore = await page.locator('#host').evaluate(node => node.scrollHeight);
  await page.locator('[data-track-row-path]').first().scrollIntoViewIfNeeded();
  expect(await page.locator('#host').evaluate(node => node.scrollHeight)).toBe(heightBefore);
  await page.locator('[data-track-row-path]').first().hover();
  await page.locator('[data-track-row-path]').first().getByRole('button', { name: 'Play track', exact: true }).click();
});
}
