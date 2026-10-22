// Native Album renderer + existing production React mount, isolated component
// DTOs only. This is not mobile navigation, production authority or app E2E.
const {test, expect, mount, choose, bounds, assertAligned, waitForAlbumPress, refreshAlbumRows, rehostAlbum} = require('./albumResponsiveMountFixture');

for (const width of [320, 390, 480, 1100]) test(`native multi-disc Album shares aligned measured grids at ${width}px`, async ({page}) => {
  await mount(page, width);
  assertAligned(await bounds(page));
  await expect(page.locator('.album-track-table__title').first()).toHaveCSS('text-overflow', 'ellipsis');
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="love"]')).toBeVisible();
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="duration"]')).toHaveText('1:20 / 13:04');
  await expect(page.locator('[data-cdt-row-key="third"] .play-track-button')).toBeDisabled();
  for (const text of ['Total Length: 38m 34s', 'Total Main Album Length: 16m 4s', 'Bonus Disc Length: 22m 30s']) await expect(page.getByText(text, {exact: true})).toBeVisible();
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});

test('Album toolbar controls every disc, offers only extras and keeps explicit overflow table-local', async ({page}) => {
  await mount(page, 320);
  await page.locator('[data-track-table-columns]').click();
  expect(await page.evaluate(() => fixtureCalls.choices.at(-1).config.formats.map(item => item.value).sort())).toEqual(['__defaults', 'path', 'problem', 'rating']);
  await page.evaluate(() => fixtureCalls.choices.at(-1).config.onSelect('rating'));
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeVisible();
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"] [aria-label="Track unrated"]')).toHaveCount(1);
  await expect(page.locator('[data-cdt-row-key="second"] [data-cdt-column="rating"]')).toHaveText('4');
  await expect(page.locator('[data-cdt-row-key="third"] [data-cdt-column="rating"]')).toHaveText('–');
  await choose(page, 'path');
  await expect(page.locator('[data-cdt-row-key="third"] [data-cdt-column="path"]')).toBeVisible();
  const result = await bounds(page); assertAligned(result);
  for (const table of result.tables) expect(table.scroll).toBeGreaterThan(table.client);
  await choose(page, '__defaults');
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeHidden();
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="path"]')).toBeHidden();
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});

test('same resource refresh preserves choice, replaces native rows and retires old menu callbacks', async ({page}) => {
  await mount(page, 320); await choose(page, 'rating');
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeVisible();
  await page.locator('[data-track-table-columns]').click();
  await refreshAlbumRows(page);
  await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(2);
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeVisible();
  await page.evaluate(() => staleMenu.onSelect('path'));
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="path"]')).toBeHidden();
  await page.evaluate(() => fixtureMount.update({tablePresentation: {...fixturePresentation, resourceKey: 'album-B', source: {}}}));
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeHidden();
});

for (const key of ['Alt+ArrowDown', 'Shift+F10', 'ContextMenu']) test(`native Album header opens shared columns menu with ${key}`, async ({page}) => {
  await mount(page, 390);
  await page.locator('.compact-data-table-header').first().focus(); await page.keyboard.press(key);
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(1);
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});

test('revoked or disposed Album cannot apply a pending columns action', async ({page}) => {
  await mount(page, 320);
  await page.locator('[data-track-table-columns]').click();
  await page.evaluate(() => {window.staleMenu = fixtureCalls.choices.at(-1).config; fixtureCurrent = false; fixtureMount.update({}); staleMenu.onSelect('rating');});
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="rating"]')).toBeHidden();
  await page.evaluate(() => fixtureMount.dispose());
  await expect(page.locator('[data-track-table-columns]')).toHaveCount(0);
  await page.evaluate(() => staleMenu.onSelect('path'));
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});

test('ordinary Album unknown Love never invents an Off heart or a taste mutation', async ({page}) => {
  await mount(page, 390, false);
  await expect(page.locator('[data-track-love-cell]')).toHaveCount(3);
  await expect(page.locator('[data-track-love-cell] button')).toHaveCount(0);
  await expect(page.locator('[data-track-love-cell] [aria-label="off"]')).toHaveCount(0);
  await expect(page.locator('[data-cdt-row-key="first"] [data-cdt-column="love"]')).toBeVisible();
  await page.locator('[data-track-table-columns]').click();
  expect(await page.evaluate(() => fixtureCalls.choices.at(-1).config.formats.map(item => item.value))).not.toContain('rating');
});

for (const cancellation of [null, 'source', 'rehost', 'dispose']) test(`native Album header long-press ${cancellation ? `cancels on ${cancellation}` : 'uses the shared menu'}`, async ({page}) => {
  await mount(page, 390);
  const header = page.locator('.compact-data-table-header').first();
  await header.dispatchEvent('pointerdown', {bubbles: true, pointerType: 'touch', pointerId: 1,
    isPrimary: true, button: 0, clientX: 40, clientY: 20});
  if (cancellation === 'source') await page.evaluate(() => fixtureMount.update({
    tablePresentation: {...fixturePresentation, source: {revision: 2}},
  }));
  if (cancellation === 'rehost') await rehostAlbum(page);
  if (cancellation === 'dispose') await page.evaluate(() => fixtureMount.dispose());
  // Deliberately exceed the production gesture window, including negative cases.
  await waitForAlbumPress(page);
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(cancellation ? 0 : 1);
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});
