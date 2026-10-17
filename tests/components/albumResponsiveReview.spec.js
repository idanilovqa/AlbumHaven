// Additive review regressions using the real native owner and React mount.
const {test, expect, setup, mountButtonOnlyRuntime, mountNativePlayback, settlePlaybackFrames, waitForUnclippedPlayback, durationWidths, documentWidth} = require('./albumResponsiveReviewFixture');

test('a native button-only runtime leaves column action disabled without crashing selection', async ({page}) => {
  const errors = await setup(page);
  await mountButtonOnlyRuntime(page);
  await expect(page.getByRole('button', {name: 'Track columns', exact: true})).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('0 rows selected');
  expect(errors).toEqual([]);
});

test('native playback text growth remeasures Length on every disc without a viewport resize', async ({page}) => {
  const errors = await setup(page);
  await mountNativePlayback(page);
  await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(2);
  await settlePlaybackFrames(page);
  await page.evaluate(() => {state.player.current = {path: 'first'}; refreshTrackModalPlaybackState();});
  await expect(page.locator('[data-track-duration-path="first"]')).toHaveText('1:02:03 / 1:11:59');
  await waitForUnclippedPlayback(page);
  const widths = await durationWidths(page);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
  expect(await documentWidth(page)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});
