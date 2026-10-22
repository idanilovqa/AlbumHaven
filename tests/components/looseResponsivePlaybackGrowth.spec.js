// Canonical mobile shell/table-wrapper component state, not navigation evidence.
// The actual playback updater grows the live cells after initial short totals.
const {test, expect, expectAligned, expectDurationGrowth} = require('./looseResponsiveFixture');

for (const width of [320, 390, 480]) test(`canonical Loose wrappers keep short required columns in view at ${width}px`, async ({page, loose}) => {
  await loose.mount(width, {canonicalShell: true, livePlayback: true});
  await expect(page.locator('.compact-data-table-row [data-cdt-column="duration"]').first()).toHaveText('3:00');
  const result = await loose.dimensions(); expectAligned(result);
  expect(result.hostWidth).toBeLessThan(width);
  for (const wrapper of result.wrappers) expect(wrapper.scroll).toBeLessThanOrEqual(wrapper.client);
  for (const table of result.tables) {
    expect(table.scroll).toBeLessThanOrEqual(table.client);
    expect(table.left).toBeGreaterThanOrEqual(0); expect(table.right).toBeLessThanOrEqual(width);
    for (const row of table.rows) {
      expect(row.cells.map(cell => cell.key)).toEqual(['number', 'title', 'love', 'duration']);
      for (const cell of row.cells) {
        expect(cell.left).toBeGreaterThanOrEqual(table.left);
        expect(cell.right).toBeLessThanOrEqual(table.right);
      }
    }
  }
});

test('live Loose duration growth remeasures all sections and confines unavoidable overflow to the compact tables', async ({page, loose}) => {
  await loose.mount(320, {canonicalShell: true, livePlayback: true});
  const before = await loose.dimensions();
  // Length is end-aligned intrinsic content; measure its grid track, not its
  // header label box, when proving the measured allocation has grown.
  const originalWidth = parseFloat(before.tables[0].rows[0].grid.split(/\s+/).at(-1));
  await loose.playback(6023, 6023);
  await expect(page.locator('.compact-data-table-row [data-cdt-column="duration"]').first()).toHaveText('100:23 / 100:23');
  await expectDurationGrowth(loose, originalWidth);
  const grown = await loose.dimensions(); expectAligned(grown);
  for (const wrapper of grown.wrappers) expect(wrapper.scroll).toBeLessThanOrEqual(wrapper.client);
  for (const table of grown.tables) {
    expect(table.left).toBeGreaterThanOrEqual(0); expect(table.right).toBeLessThanOrEqual(320);
    for (const row of table.rows) {
      const length = row.cells.find(cell => cell.key === 'duration');
      expect(parseFloat(row.grid.split(/\s+/).at(-1)) + 1).toBeGreaterThanOrEqual(length.textWidth);
    }
  }
  await expect(page.locator('.compact-data-table-row [data-cdt-column="duration"]').nth(1)).toHaveText('3:00');
  expect(await page.evaluate(() => fixtureCalls.preferenceCalls)).toBe(0);
});
