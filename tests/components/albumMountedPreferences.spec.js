// Component-only: real MountedSelection / MountedPreferences and shared Love
// controller, with a controlled async write boundary. No native authority, app
// boot, network, server, persistence or production E2E claim.
const {test, expect, mount, expectNoRowAction, waitForLoveWrite, waitForLoveAbort, settlePreferenceFrames, replacePreferenceSource} = require('./albumMountedPreferencesFixture');

test('real MountedPreferences click writes once, disables pending Love and isolates row gestures', async ({page}) => {
  await mount(page);
  const button = page.getByRole('button', {name: 'Love: Synthetic track', exact: true});
  await button.focus(); await button.click();
  const pending = page.getByRole('button', {name: 'Saving Love for Synthetic track', exact: true});
  await expect(pending).toBeDisabled(); await expect(pending).toHaveAttribute('aria-busy', 'true');
  await waitForLoveWrite(page);
  expect(await page.evaluate(() => ({tier: fixtureCalls.writes[0].love_tier,
    row: fixtureCalls.writes[0].row === fixtureRows[0], scope: fixtureCalls.writes[0].context.scopeKey})))
    .toEqual({tier: 'loved', row: true, scope: 'fixture'});
  for (const event of ['pointerdown', 'click', 'dblclick']) await pending.dispatchEvent(event,
    {bubbles: true, detail: event === 'dblclick' ? 2 : 1, button: 0, pointerType: 'touch', isPrimary: true});
  expect(await page.evaluate(() => fixtureCalls.writes.length)).toBe(1);
  await expectNoRowAction(page);
  await page.evaluate(() => {
    fixtureValue = {...fixtureValue, love_tier: 'loved'};
    for (const listener of preferenceListeners) listener();
    resolveFixtureWrite(fixtureValue);
  });
  const loved = page.getByRole('button', {name: 'Mark Obsessed: Synthetic track', exact: true});
  await expect(loved).toBeEnabled(); await expect(loved).toHaveAttribute('aria-pressed', 'true');
  await expectNoRowAction(page);
  expect(await page.evaluate(() => fixtureCalls.errors)).toEqual([]);
});

test('double-click detail never submits a second Love write or invokes row playback', async ({page}) => {
  await mount(page);
  const button = page.locator('[data-track-love]');
  await button.dispatchEvent('click', {bubbles: true, detail: 2, button: 0});
  await button.dispatchEvent('dblclick', {bubbles: true, detail: 2, button: 0});
  expect(await page.evaluate(() => fixtureCalls.writes.length)).toBe(0);
  await expectNoRowAction(page);
});

for (const settlement of ['resolve', 'reject']) test(`source replacement aborts pending Love and ignores stale ${settlement}`, async ({page}) => {
  await mount(page);
  await page.locator('[data-track-love]').click();
  await waitForLoveWrite(page);
  await replacePreferenceSource(page);
  await waitForLoveAbort(page);
  await expect(page.locator('[data-track-love-cell] [aria-label="Love unavailable"]')).toHaveCount(1);
  await page.evaluate(settlement => {
    if (settlement === 'resolve') resolveFixtureWrite({identity: 'opaque-fixture:one', love_tier: 'loved', rating: null,
      allowed_actions: {can_set_love_tier: true}});
    else rejectFixtureWrite(Object.assign(new Error('Retired request failed'), {status: 403}));
  }, settlement);
  // Drain the promise continuation and React commit before negative assertions.
  await settlePreferenceFrames(page);
  await expect(page.locator('[data-track-love]')).toHaveCount(0);
  await expect(page.locator('[data-track-love-cell] [aria-label="Love unavailable"]')).toHaveCount(1);
  await expectNoRowAction(page);
  expect(await page.evaluate(() => fixtureCalls.errors)).toEqual([]);
});

test('unmount aborts an in-flight Love and stale completion cannot recreate its controls', async ({page}) => {
  await mount(page); await page.locator('[data-track-love]').click();
  await waitForLoveWrite(page);
  await page.evaluate(() => {fixtureMount.dispose(); fixtureHost.replaceChildren();});
  expect(await page.evaluate(() => fixtureCalls.writes[0].signal.aborted)).toBe(true);
  expect(await page.evaluate(() => preferenceListeners.size)).toBe(0);
  await page.evaluate(() => resolveFixtureWrite({identity: 'opaque-fixture:one', love_tier: 'loved',
    allowed_actions: {can_set_love_tier: true}}));
  await settlePreferenceFrames(page);
  await expect(page.locator('[data-track-love-cell]')).toHaveCount(0);
  expect(await page.evaluate(() => fixtureCalls.errors)).toEqual([]);
  expect(await page.evaluate(() => fixtureCalls.plays)).toBe(0);
});
