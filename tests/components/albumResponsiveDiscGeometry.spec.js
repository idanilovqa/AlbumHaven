// Isolated native Album renderer and production React presentation mount.
// Measures grid tracks/anchored edges, never equates intrinsic labels with tracks.
const {test, expect, mount, settleGeometryFrames, discGeometry, decorationGeometry, retiredDecorationGeometry} = require('./albumResponsiveDiscGeometryFixture');

for (const width of [320, 390, 480, 1100]) test(`responsive Album disc decoration preserves aligned client grids at ${width}px`, async ({page}) => {
  const errors = await mount(page, width);
  await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(2);
  await settleGeometryFrames(page);
  const result = await discGeometry(page);
  expect(result.page).toBeLessThanOrEqual(result.viewport);
  const reference = result.tables[0].rows[0];
  for (const table of result.tables) {
    expect(table.width).toBe(result.tables[0].width);
    expect(table.scrollWidth).toBeLessThanOrEqual(table.width);
    expect(table.scrollHeight).toBeLessThanOrEqual(table.height);
    for (const row of table.rows) {
      expect(row.grid).toBe(reference.grid);
      for (const key of ['title', 'love']) {
        expect(Math.abs(row.cells[key].left - reference.cells[key].left)).toBeLessThanOrEqual(1);
        expect(Math.abs(row.cells[key].right - reference.cells[key].right)).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(row.cells.duration.right - reference.cells.duration.right)).toBeLessThanOrEqual(1);
    }
  }
  const finalTable = page.locator('.compact-data-table').last();
  expect(await decorationGeometry(finalTable)).toEqual({right: '0px', bottom: '0px', width: '1px', pointerEvents: 'none', gradient: true});
  await expect(page.locator('.album-track-table__row--playing')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.album-track-table__row--playing')).toHaveCSS('outline-width', '1px');
  for (const text of ['Total Length: 6m', 'Total Main Album Length: 3m', 'Bonus Disc Length: 3m']) await expect(page.getByText(text, {exact: true})).toBeVisible();
  await page.evaluate(() => fixtureMount.dispose());
  await expect(finalTable).not.toHaveAttribute('data-cdt-responsive', '');
  expect(await retiredDecorationGeometry(finalTable)).toEqual({right: '-1px', bottom: '-1px'});
  expect(errors).toEqual([]);
});
