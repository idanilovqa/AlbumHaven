import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobilePolishPage } from '../poms/mobilePolishPage.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';
import { CoverLookup } from '../poms/coverLookup.js';
import { TagEditor } from '../poms/tagEditor.js';
import { TrackModal } from '../poms/trackModal.js';

for (const palette of ['black', 'paper', 'parchment-pine']) {
  test(`owner feedback: readable mobile controls, ratings, menus and appearance in ${palette}`, async ({ page, app, snapshot }) => {
    const phone = new MobilePolishPage(page), appearance = new UtilityAppearanceTab(page), covers = new CoverLookup(page);
    await phone.usePalette(palette);
    await phone.expectHeaderActionsAligned();
    await phone.inspectHeaderMenus();
    await covers.drawerButton.click();
    await expect(covers.drawer).toBeVisible();
    expect((await covers.drawer.boundingBox()).width).toBeLessThanOrEqual(page.viewportSize().width * .75 + 1);
    const [clear, close] = await covers.notificationActionDimensions();
    for (const key of Object.keys(clear)) expect(clear[key]).toBeCloseTo(close[key], 2);
    await snapshot(`90-notifications-${palette}`);
    await covers.drawerCloseButton.click();
    await phone.browseArtist();
    await phone.selectView('cards');
    await phone.expectGridColumns(3);
    await phone.expectNumericRatings();
    await phone.expectGalleryHeaderLayout();
    await expect(phone.zoomButton).not.toBeVisible();
    await phone.longPressAlbum();
    await expect(phone.albumContextMenu).not.toBeVisible();
    await phone.galleryCards.first().click({ button: 'right' });
    await expect(phone.albumContextMenu).not.toBeVisible();
    await snapshot(`91-three-columns-${palette}`);
    await phone.openSettings();
    await expect(phone.customAppearance).toHaveAttribute('aria-pressed', 'true');
    await expect(appearance.customizePlayerButton).toHaveCount(0);
    await appearance.paletteButton(palette === 'black' ? 'paper' : 'black').click();
    await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', palette === 'black' ? 'paper' : 'black');
    await phone.expectAppearanceFooterFits();
    await phone.cancelAppearance.click();
    await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', palette);
    await phone.selectSubsection('selection-accent');
    await expect(phone.followAppearance).toHaveAttribute('aria-pressed', 'true');
    await phone.customAppearance.click();
    await expect(appearance.selectionAccentEnabledInput).toBeEnabled();
    const before = await phone.selectionPreviewRow.boundingBox();
    await appearance.selectionAccentEnabledInput.uncheck();
    const after = await phone.selectionPreviewRow.boundingBox();
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.height).toBeCloseTo(before.height, 0);
    await expect(phone.selectionPreviewRow).toHaveCSS('border-left-width', '1px');
    await snapshot(`92-selection-no-accent-${palette}`);
    await appearance.interactionColorButton('item_selected', 'blue').click();
    await phone.saveAppearanceChanges();
    await phone.settingsSectionsButton.click();
    await expect(phone.selectedSettingsSection).toHaveCSS('background-color', 'rgb(63, 95, 126)');
    await phone.settingsDrawerBack.click();
    await phone.selectSubsection('alerts');
    await phone.customAppearance.click();
    await expect(phone.alertFamily).toBeEnabled();
    await phone.alertFamily.click();
    await expect(phone.alertFamily).toHaveAttribute('aria-pressed', 'true');
    await phone.expectAppearanceFooterFits();
    await phone.saveAppearanceChanges();
    await page.reload();
    await phone.selectSubsection('alerts');
    await expect(phone.customAppearance).toHaveAttribute('aria-pressed', 'true');
    await expect(phone.alertFamily).toHaveAttribute('aria-pressed', 'true');
  });
}

test('Home loading replaces the complete page and search expands beside the logo', async ({ page, app }) => {
  const phone = new MobilePolishPage(page);
  await phone.expectGalleryLoadingOwnsPage();
  await phone.searchButton.click();
  await expect(phone.searchInput).toBeFocused();
  const brand = await phone.brand.boundingBox(), search = await phone.searchControl.boundingBox();
  expect(search.x).toBeGreaterThanOrEqual(brand.x + brand.width);
  await expect.poll(async () => { const box = await phone.searchControl.boundingBox(); return box.x + box.width; }).toBeCloseTo(page.viewportSize().width - 12, 0);
  await expect(phone.settingsButton).not.toBeVisible();
  await phone.galleryContextName.click();
  await expect(phone.searchInput).not.toBeVisible();
  await phone.search('Northlight');
  await phone.galleryContextName.click();
  await expect(phone.searchInput).toBeVisible();
  await expect(phone.searchInput).toHaveValue('Northlight');
});

test('cover selection saves before closing, reopens with saved artwork, and backdrop closes full art', async ({ page, app, snapshot }) => {
  const phone = new MobilePolishPage(page), covers = new CoverLookup(page), details = new TrackModal(page);
  await phone.browseArtist();
  await phone.openAlbumBody('After the Rain');
  await phone.playRow(0);
  await phone.expectPlayerMetadataNearCover();
  await details.coverLightboxButton.click();
  await expect(phone.fullArtwork).toBeVisible();
  await phone.lightbox.click({ position: { x: 3, y: 3 } });
  await expect(phone.lightbox).not.toBeVisible();
  await details.coverLookupButton.click();
  await expect(covers.localCoverCards).toHaveCount(2);
  await covers.inactiveLocalCoverCards.first().click();
  await expect(covers.saveRemoteButton).toBeEnabled();
  await expect(covers.activeLocalCoverCard).toHaveCSS('outline-width', '3px');
  const saveBox = await covers.saveRemoteButton.boundingBox(), findBox = await covers.findBetterButton.boundingBox();
  expect(saveBox.y).toBeCloseTo(findBox.y, 0);
  expect(saveBox.x + saveBox.width).toBeLessThan(findBox.x);
  expect(findBox.width).toBeLessThan(180);
  await snapshot('93-cover-selection-footer');
  const saved = page.waitForResponse(response => response.url().endsWith('/utilities/cover-lookup/local-select'));
  await covers.saveRemoteButton.click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const data = await response.json();
  await expect(covers.modal).not.toBeVisible();
  const gallery = page.waitForResponse(response => response.url().endsWith('/utilities/cover-lookup/gallery'));
  await details.coverLookupButton.click();
  const reopened = await (await gallery).json();
  expect(reopened.local_covers.find(cover => cover.is_active).cover_revision).toBe(data.updated_album.cover_revision);
  await expect(covers.activeLocalCoverCard).toBeVisible();
  await expect(covers.saveRemoteButton).toBeDisabled();
  await snapshot('94-cover-reopened');
  await phone.backButton.click();
  await page.reload();
  const afterReload = page.waitForResponse(response => response.url().endsWith('/utilities/cover-lookup/gallery'));
  await details.coverLookupButton.click();
  const persisted = await (await afterReload).json();
  expect(persisted.local_covers.find(cover => cover.is_active).cover_revision).toBe(data.updated_album.cover_revision);
  expect(persisted.local_covers.map(cover => cover.cover_revision)).toEqual(reopened.local_covers.map(cover => cover.cover_revision));
  await covers.inactiveLocalCoverCards.first().click();
  await expect(covers.saveRemoteButton).toBeEnabled();
  await phone.backButton.click();
  const cancelled = page.waitForResponse(response => response.url().endsWith('/utilities/cover-lookup/gallery'));
  await details.coverLookupButton.click();
  const unchanged = await (await cancelled).json();
  expect(unchanged.local_covers.find(cover => cover.is_active).cover_revision).toBe(data.updated_album.cover_revision);
  await expect(covers.saveRemoteButton).toBeDisabled();
});


test('desktop tag fields, Apply and alternating track stripes work in dark and light palettes', async ({ page, app, browser, snapshot }) => {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1366, height: 900 }, isMobile: false, hasTouch: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36' });
  try {
    const desktop = await context.newPage();
    const web = new MobilePolishPage(desktop), appearance = new UtilityAppearanceTab(desktop), tags = new TagEditor(desktop), details = new TrackModal(desktop);
    await web.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
    for (const palette of ['black', 'paper', 'parchment-pine']) {
      await web.settingsButton.click();
      await web.utilitiesButton.click();
      await web.utilityTab('appearance').click();
      await appearance.sectionButton('backgrounds').click();
      await appearance.paletteButton(palette).click();
      await web.saveAppearanceChanges();
      await desktop.keyboard.press('Escape');
      await web.search('Sixteen Horizons');
      await web.galleryAlbums.first().click();
      await details.editTagsButton.click();
      await tags.trackButtons.first().getByRole('button').last().click();
      await tags.albumNameInput.fill('Unsaved preview title');
      await expect(tags.applyButton).toBeEnabled();
      // The shared button animates from disabled to enabled paint.
      await expect(async () => {
        const paint = await tags.readFormAndStripeColors();
        expect(paint.rows).toHaveLength(3);
        expect(paint.rows[0].background).not.toBe(paint.rows[1].background);
        expect(paint.rows[0].background).toBe(paint.rows[2].background);
        expect(paint.apply.background).not.toBe(paint.input.background);
        web.expectContrast([paint.apply, paint.input, ...paint.rows]);
      }).toPass({ timeout: 5000 });
      await desktop.screenshot({ path: `test-results/mobile-screenshots/95-desktop-tags-${palette}.png`, fullPage: true });
      await tags.cancelButton.click();
      await desktop.keyboard.press('Escape');
    }
  } finally { await context.close(); }
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`mobile pinch hint appears once and respects ${reducedMotion} motion`, async ({ page, app }) => {
    const phone = new MobilePolishPage(page);
    await page.emulateMedia({ reducedMotion });
    await phone.browseArtist();
    await phone.selectView('cards');
    await expect(phone.pinchHint).toBeVisible();
    await expect(phone.pinchHintLights).toHaveCount(2);
    await expect(phone.pinchHint).toHaveCSS('animation-name', reducedMotion === 'reduce' ? 'none' : 'mobile-hint-fade');
    await expect(phone.pinchHintLights.first()).toHaveCSS('animation-name', reducedMotion === 'reduce' ? 'none' : 'mobile-hint-spread');
    await expect(phone.pinchHint).toHaveCount(0, { timeout: 6000 });
    await phone.selectView('covers');
    await phone.selectView('cards');
    await expect(phone.pinchHint).toHaveCount(0);
    await phone.expectGridColumns(3);
  });
}
