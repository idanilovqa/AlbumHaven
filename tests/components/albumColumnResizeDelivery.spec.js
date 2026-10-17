// Component-only real native renderer and production React presentation. Choice
// callbacks are captured at the service boundary; no app/navigation/E2E claim.
const {test, expect, mount, settleResizeFrames, measureResizeGeometry} = require('./albumColumnResizeDeliveryFixture');

test('optional File path toggles across responsive discs settle without ResizeObserver errors', async ({page}) => {
  const errors = await mount(page);
  await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(2);
  for (const width of [320, 390, 480]) {
    await page.setViewportSize({width, height: 844});
    for (const visible of [true, false]) {
      await page.getByRole('button', {name: 'Track columns', exact: true}).click();
      expect(await page.evaluate(() => currentColumnMenu.formats.some(item => item.value === 'path'))).toBe(true);
      await page.evaluate(() => currentColumnMenu.onSelect('path'));
      const pathCell = page.locator('[data-cdt-row-key="two"] [data-cdt-column="path"]');
      if (visible) await expect(pathCell).toBeVisible(); else await expect(pathCell).toBeHidden();
      // Let the browser deliver observer notifications and the deferred repaint.
      await settleResizeFrames(page);
      const geometry = await measureResizeGeometry(page);
      expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.tables[0].client).toBe(geometry.tables[1].client);
      for (const table of geometry.tables) {
        if (visible) expect(table.scroll).toBeGreaterThan(table.client);
        else expect(table.scroll).toBeLessThanOrEqual(table.client);
      }
      expect(errors).toEqual([]);
    }
  }
  await page.evaluate(() => mount.dispose());
  expect(errors).toEqual([]);
});
