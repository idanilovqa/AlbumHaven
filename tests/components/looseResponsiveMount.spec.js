const {test, expect, expectAligned} = require('./looseResponsiveFixture');

for (const width of [320, 390, 480, 1100]) test(`actual Loose sections share aligned native React presentation at ${width}px`, async ({page, loose}) => {
  await loose.mount(width);
  expectAligned(await loose.dimensions());
  await expect(page.locator('.compact-data-table-header')).toHaveCount(1);
  await expect(page.locator('.album-track-table__title').first()).toHaveCSS('text-overflow', 'ellipsis');
  await expect(page.locator('.album-track-table__secondary').first()).toHaveText('Rarity artist');
  await expect(page.locator('[data-track-love-cell] [aria-label="Love unavailable"]')).toHaveCount(3);
  await expect(page.locator('[data-track-love-cell] button, [data-track-love], [aria-label="off"], [data-cdt-column="rating"]')).toHaveCount(0);
  await expect(page.locator('.album-track-table__row--missing .play-track-button')).toBeDisabled();
  await expect(page.locator('.album-track-table__row--playing .play-track-button')).toHaveAttribute('aria-label', 'Pause track');
  await expect(page.getByText('Total Length: 107m 23s', {exact: true})).toBeVisible();
  await expect(page.locator('.compact-data-table-row [data-cdt-column="duration"]').nth(1)).toHaveText('100:23 / 100:23');
  for (const section of ['Non-album rarity', 'Interviews', 'Other']) await expect(page.getByRole('heading', {name: section, exact: true})).toBeVisible();
  expect(await page.evaluate(() => fixtureCalls.preferenceCalls)).toBe(0);
});

test('Loose columns offer only existing extras, retain section actions and confine explicit path overflow locally', async ({page, loose}) => {
  await loose.mount(320);
  await expect(page.locator('[data-playtable-section-action]')).toHaveCount(3);
  await loose.rememberMenu();
  expect(await page.evaluate(() => oldLooseMenu.formats.map(item => item.value).sort())).toEqual(['__defaults', 'path', 'problem']);
  await page.evaluate(() => oldLooseMenu.onSelect('path'));
  await expect(page.locator('.compact-data-table-row [data-cdt-column="path"]').first()).toBeVisible();
  const result = await loose.dimensions(); expectAligned(result);
  for (const table of result.tables) expect(table.scroll).toBeGreaterThan(table.client);
  await loose.choose('__defaults');
  await expect(page.locator('.compact-data-table-row [data-cdt-column="path"]').first()).toBeHidden();
  await page.locator('.compact-data-table-row [data-cdt-column="title"]').first().click();
  await expect(page.locator('.album-track-table__selection-actions [role="status"]')).toHaveText('1 row selected');
  expect(await page.evaluate(() => ({played: fixtureCalls.played, queue: fixtureCalls.queueReads, taste: fixtureCalls.preferenceCalls})))
    .toEqual({played: 0, queue: 0, taste: 0});
});

test('same Loose resource refresh keeps explicit choices and retires pre-refresh menu callbacks', async ({page, loose}) => {
  await loose.mount(320); await loose.choose('path'); await loose.rememberMenu();
  await loose.change('refresh');
  await expect(page.locator('.compact-data-table-row [data-cdt-column="path"]').last()).toBeVisible();
  await page.evaluate(() => oldLooseMenu.onSelect('problem'));
  await expect(page.locator('.compact-data-table-row [data-cdt-column="problem"]').first()).toBeHidden();
  await expect(page.locator('[data-track-table-columns]')).toHaveCount(1);
});

for (const kind of ['source', 'scope', 'close']) test(`Loose ${kind} replacement restores default choices and retires old menu`, async ({page, loose}) => {
  await loose.mount(320); await loose.choose('path'); await loose.rememberMenu();
  await loose.change(kind);
  await expect(page.locator('.compact-data-table-row [data-cdt-column="path"]').first()).toBeHidden();
  await page.evaluate(() => oldLooseMenu.onSelect('path'));
  await expect(page.locator('.compact-data-table-row [data-cdt-column="path"]').first()).toBeHidden();
  await expect(page.locator('[data-track-table-columns]')).toHaveCount(1);
});

test('actual Loose header uses the shared keyboard and long-press column owner', async ({page, loose}) => {
  await loose.mount(390);
  await page.locator('.compact-data-table-header').focus(); await page.keyboard.press('Alt+ArrowDown');
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(1);
  await loose.startPress(); await loose.waitForPress();
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(2);
  expect(await page.evaluate(() => fixtureCalls.played)).toBe(0);
});

test('Loose source replacement cancels a pending header long-press', async ({page, loose}) => {
  await loose.mount(390); await loose.startPress(); await loose.change('source'); await loose.waitForPress();
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(0);
});

test('Loose without shared Choice dependency has a visibly disabled column action', async ({page, loose}) => {
  await loose.mount(390, {choiceAvailable: false});
  const action = page.locator('[data-track-table-columns]');
  await expect(action).toBeDisabled(); await expect(action).toHaveCSS('cursor', 'not-allowed');
  expect(await action.evaluate(button => Number(getComputedStyle(button).opacity))).toBeLessThan(1);
  expect(await page.evaluate(() => fixtureCalls.choices.length)).toBe(0);
});
