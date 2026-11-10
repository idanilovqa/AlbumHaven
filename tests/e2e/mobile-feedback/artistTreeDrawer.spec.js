import { test, expect } from '../fixtures/mobileFeedbackTest.js';

const LONG_ARTIST = 'ZZ Drawer Fixture Artist 205 With An Intentionally Long Name That Must Stay Contained';

test.beforeEach(async ({ app }) => {
  await expect(app.artistList).toHaveAttribute('data-sidebar-virtualized', 'true');
});

async function expectDrawerContained(app) {
  await expect.poll(async () => (await app.artistDrawerGeometry()).x).toBeCloseTo(0, 0);
  const geometry = await app.artistDrawerGeometry();
  expect(geometry.x).toBeCloseTo(0, 0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 56 + 1);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.listClientWidth).toBeGreaterThan(0);
  expect(geometry.listScrollWidth).toBeLessThanOrEqual(geometry.listClientWidth);
  return geometry;
}

test('Artist Tree content-fits narrow and roomy phone screens without horizontal overflow', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await app.libraryButton.click();
  const narrow = await expectDrawerContained(app);
  expect(narrow.width).toBeLessThanOrEqual(264);

  await app.closeArtistRail.click();
  await page.setViewportSize({ width: 430, height: 820 });
  await app.libraryButton.click();
  const roomy = await expectDrawerContained(app);
  expect(roomy.width).toBeLessThan(430 * .75);
  expect(roomy.width).toBeGreaterThanOrEqual(narrow.width - 1);
});

test('Artist Tree contains an intentionally long artist name on a narrow phone', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await app.libraryButton.click();
  await app.scrollArtistTreeToEnd();

  const longArtist = app.artist(LONG_ARTIST);
  await expect(longArtist).toBeVisible();
  const [drawerBounds, artistBounds] = await Promise.all([
    app.artistRail.boundingBox(),
    longArtist.boundingBox(),
  ]);
  expect(artistBounds.x).toBeGreaterThanOrEqual(drawerBounds.x);
  expect(artistBounds.x + artistBounds.width).toBeLessThanOrEqual(drawerBounds.x + drawerBounds.width + 1);
  await expectDrawerContained(app);
});

test('selecting an artist closes the drawer and reopening reveals the selected artist', async ({ app }) => {
  await app.libraryButton.click();
  await app.artist('Northlight').click();
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(app.galleryContextName).toHaveText(/^Northlight(?: family)?$/);

  await app.libraryButton.click();
  const selected = app.artist('Northlight');
  await expect(selected).toBeVisible();
  await expect(selected).toHaveClass(/(?:active|is-selected)/);
  await expectDrawerContained(app);
});

test('backdrop and Back dismiss the Artist Tree and restore focus to its opener', async ({ app }) => {
  await app.libraryButton.click();
  await expectDrawerContained(app);
  await app.dismissArtistDrawerThroughBackdrop();
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(app.libraryButton).toBeFocused();

  await app.libraryButton.click();
  await app.closeArtistRail.click();
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(app.libraryButton).toBeFocused();
});

test('resizing through desktop resets the mobile Artist Tree before it is reopened', async ({ page, app }) => {
  await app.libraryButton.click();
  await expect(app.artistRail).toHaveClass(/is-mobile-drawer-open/);

  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer/);
  await expect(app.artistRail).toBeVisible();
  await expect(app.artistBackdrop).not.toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(app.artistRail).toHaveClass(/is-mobile-drawer/);
  await expect(app.artistRail).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(app.libraryButton).toHaveAttribute('aria-expanded', 'false');
  await app.libraryButton.click();
  await expectDrawerContained(app);
});

test('a large virtualized Artist Tree scrolls to its final real artist row', async ({ app }) => {
  await app.libraryButton.click();
  await expect(app.artistList).toHaveAttribute('data-sidebar-virtualized', 'true');
  const renderedEntryCount = await app.artistTreeEntries.count();
  expect(renderedEntryCount).toBeGreaterThan(0);
  expect(renderedEntryCount).toBeLessThan(205);
  const headerBefore = await app.closeArtistRail.boundingBox();

  await app.scrollArtistTreeToEnd();
  await expect(app.artist(LONG_ARTIST)).toBeVisible();
  const geometry = await expectDrawerContained(app);
  expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight);
  const headerAfter = await app.closeArtistRail.boundingBox();
  expect(headerAfter.y).toBeCloseTo(headerBefore.y, 0);
});
