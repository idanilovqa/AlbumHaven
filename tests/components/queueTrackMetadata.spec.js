// Component regression only. Real browser/React/native renderers, isolated API
// responses. No Postgres, transport, full-app or end-to-end acceptance claim.
const {test, expect, row, love, mount, loveCalls, choose, waitForQueueLove, rejectQueueLoveAndDrain, waitForQueueClear, visibleQueueColumns, projectedQueueColumns, bodyFits} = require('./queueTrackMetadataHelpers');

for (const width of [320, 390]) test(`Queue ${width}px defaults keep title, Love and unknown Length without fabricated columns`, async ({page}) => {
  await mount(page, width);
  const columns = await visibleQueueColumns(page);
  expect(columns).toEqual(['title', 'love_tier', 'duration']);
  await expect(row(page, 'missing').locator('[data-cdt-column="duration"]')).toHaveText('–');
  await expect(row(page, 'other').locator('[data-cdt-column="duration"]')).toHaveText('0:00');
  await expect(row(page, 'missing').locator('[data-queue-play]')).toHaveCount(0);
  await expect(row(page, 'missing')).toHaveAttribute('tabindex', '0');
  await row(page, 'missing').locator('[data-cdt-column="title"]').click();
  expect(await page.evaluate(() => queueFixture.calls.selection.at(-1))).toEqual(['missing']);
  expect(await page.evaluate(() => queueFixture.calls.plays)).toEqual([]);
  const projected = await projectedQueueColumns(page);
  for (const key of ['play_count', 'popularity_count', 'rating', 'last_listened_at']) expect(projected).not.toContain(key);
  expect(await bodyFits(page)).toBe(true);
});

test('Queue shares duplicate Love pending identity, completes full cycle and keeps unrelated same-title tracks distinct', async ({page}) => {
  await mount(page);
  for (const [index, tier] of ['loved', 'obsessed', 'off'].entries()) {
    await love(page, 'one').click();
    await expect(love(page, 'one')).toBeDisabled(); await expect(love(page, 'two')).toBeDisabled();
    await expect(love(page, 'other')).toBeEnabled();
    await page.evaluate(() => document.querySelector('[data-queue-row="two"] [data-track-love]').click());
    expect(await loveCalls(page)).toHaveLength(index + 1);
    expect((await loveCalls(page))[index]).toMatchObject({id: 'one', tier, aborted: false});
    await page.evaluate(({index, tier}) => queueFixture.acknowledge(index, tier), {index, tier});
    for (const id of ['one', 'two']) {await expect(love(page, id)).toBeEnabled(); await expect(love(page, id)).toHaveAttribute('data-love-tier', tier);}
    await expect(love(page, 'other')).toHaveAttribute('data-love-tier', 'off');
  }
  expect(await page.evaluate(() => queueFixture.calls.reorders)).toEqual([]);
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-queue-row]')].map(node => node.dataset.queueRow))).toEqual(['one', 'two', 'other', 'missing']);
});

test('Queue pending Love restores focus after acknowledgement and a fresh public snapshot repaint', async ({page}) => {
  await mount(page); await love(page, 'one').focus();
  await love(page, 'one').evaluate(node => {window.originalLove = node;});
  await page.keyboard.press('Enter'); await expect(love(page, 'one')).toBeDisabled();
  expect(await love(page, 'one').evaluate(node => node === window.originalLove)).toBe(true);
  await page.evaluate(() => queueFixture.repaint());
  await expect(love(page, 'one')).toBeDisabled();
  expect((await loveCalls(page))[0].aborted).toBe(false);
  await page.evaluate(() => queueFixture.acknowledge(0, 'loved'));
  await expect(love(page, 'one')).toBeFocused();
  await page.evaluate(() => queueFixture.repaint());
  await expect(love(page, 'one')).toBeFocused();
  await expect(love(page, 'one')).toHaveAttribute('data-love-tier', 'loved');
});

test('Queue Love completion does not steal focus moved to another control', async ({page}) => {
  await mount(page); await love(page, 'two').click(); await expect(love(page, 'two')).toBeDisabled();
  await page.locator('#outside').focus(); await page.evaluate(() => queueFixture.acknowledge(0, 'loved'));
  await expect(love(page, 'two')).toBeEnabled(); await expect(page.locator('#outside')).toBeFocused();
});

for (const retirement of ['revoke', 'source', 'scope', 'unmount']) test(`Queue ${retirement} retires pending Love and ignores late rejection`, async ({page}) => {
  await mount(page); await love(page, 'one').click();
  await waitForQueueLove(page);
  await page.evaluate(retirement => {
    if (retirement === 'revoke') queueFixture.revoke('one');
    if (retirement === 'source') queueFixture.patch('one', {sourceReadable: false, canPlay: false, title: '', artist: '', album: '', duration_seconds: null});
    if (retirement === 'scope') queueFixture.changeScope();
    if (retirement === 'unmount') queueFixture.unmount();
  }, retirement);
  expect((await loveCalls(page))[0].aborted).toBe(true);
  await rejectQueueLoveAndDrain(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  if (retirement === 'revoke' || retirement === 'source') await expect(love(page, 'one')).toHaveCount(0);
  if (retirement === 'unmount') expect(await page.evaluate(() => queueFixture.preferenceSubscribers())).toBe(0);
});

test('Queue mobile columns chooser is the shared owner, retains choices through metadata repaint and retires old menu', async ({page}) => {
  await mount(page, 320); const trigger = page.locator('[data-track-table-columns]');
  await expect(trigger).toHaveCount(1); await expect(trigger).toHaveAttribute('aria-haspopup', 'menu'); await trigger.click();
  const formats = await page.evaluate(() => queueFixture.calls.choices.at(-1).config.formats);
  expect(formats.map(item => item.value).sort()).toEqual(['__defaults', 'actions', 'album', 'number', 'timing'].sort());
  expect(formats.find(item => item.value === '__defaults').label).toBe('Restore default columns');
  await choose(page, 'album'); await expect(row(page, 'missing').locator('[data-cdt-column="album"]')).toBeVisible();
  await expect(row(page, 'missing').locator('[data-cdt-column="album"]')).toHaveText('Known album');
  await page.evaluate(() => queueFixture.repaint()); await expect(row(page, 'missing').locator('[data-cdt-column="album"]')).toBeVisible();
  await trigger.click(); await page.evaluate(() => {window.retiredMenu = queueFixture.calls.choices.at(-1); queueFixture.changeScope(); retiredMenu.config.onSelect('timing');});
  expect(await page.evaluate(() => retiredMenu.closed)).toBe(true);
  await expect(row(page, 'one').locator('[data-cdt-column="timing"]')).toBeHidden();
  await trigger.click(); await choose(page, 'actions');
  await row(page, 'other').locator('[data-queue-up]').click();
  expect(await page.evaluate(() => queueFixture.calls.reorders)).toEqual([['other', 'two', 'missing']]);
  await trigger.click(); await choose(page, 'timing');
  await row(page, 'two').locator('[data-queue-timing]').click(); await choose(page, 'later');
  expect(await page.evaluate(() => queueFixture.calls.retimes)).toEqual([['two', 'later']]);
});

test('Queue header keeps existing clear ownership and occurrence exclusion', async ({page}) => {
  await mount(page); await page.getByRole('button', {name: 'Clear queue', exact: true}).click();
  await waitForQueueClear(page);
  expect(await page.evaluate(() => queueFixture.calls.confirms)).toEqual(['Clear the queued tracks?']);
  await expect(page.getByRole('button', {name: 'Clear queue', exact: true})).toHaveCount(1);
});
