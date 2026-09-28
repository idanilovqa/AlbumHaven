import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';
import { MobilePolishPage } from '../poms/mobilePolishPage.js';

// A desktop browser crossing 900px changes profile; a Pixel UA stays mobile.
test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36', isMobile: false });

for (const palette of ['black', 'parchment-pine']) {
  test(`appearance drafts and page navigation survive phone/desktop transitions in ${palette}`, async ({ page, app, snapshot }) => {
    const appearance = new UtilityAppearanceTab(page);
    await new MobilePolishPage(page).usePalette(palette);
    await app.openSettings();
    await appearance.paletteButton('paper').click();
    await app.selectSubsection('album-page');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(app.backButton).toBeVisible();
    await expect(appearance.deviceButton('Web / Desktop')).toHaveAttribute('aria-pressed', 'true');
    await expect(app.cancelAppearance).toBeEnabled();
    await snapshot(`80-retained-settings-desktop-${palette}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app.mobileAppearance).toHaveAttribute('aria-pressed', 'true');
    await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', palette);
    await app.selectSubsection('backgrounds');
    await expect(appearance.paletteButton('paper')).toHaveAttribute('aria-pressed', 'true');
    await app.cancelAppearance.click();
    await expect(appearance.paletteButton(palette)).toHaveAttribute('aria-pressed', 'true');
    await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', palette);
    await app.selectSubsection('seekbar');
    await expect(app.thinOption).toBeVisible();
    await app.customAppearance.click();
    await app.waveformOption.check();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(app.thinOption).toHaveCount(0);
    await expect(app.regularOption).toBeChecked();
    await app.saveAppearanceChanges();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app.waveformOption).toBeChecked();
    await page.setViewportSize({ width: 1280, height: 900 });
    await app.backButton.click();
    await expect(app.utilitiesPage).not.toBeVisible();

    // Fresh desktop Settings remains a dialog; shrinking promotes that same surface.
    await app.settingsButton.click();
    await app.utilitiesButton.click();
    await expect(app.utilitiesDialogs).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app.utilitiesPage).toBeVisible();
    await expect(app.utilitiesDialogs).toHaveCount(0);
    await expect(app.thinOption).toBeVisible();
    await expect(app.backButton).toBeVisible();
    await snapshot(`81-promoted-settings-phone-${palette}`);
    await app.backButton.click();
    await expect(app.utilitiesPage).not.toBeVisible();
    await expect(app.galleryContextName).toHaveText('Rendref');
    await app.search('After the Rain');
    await app.openAlbumBody('After the Rain');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(app.backButton).toBeVisible();
    await app.backButton.click();
    await expect(app.albumPage).not.toBeVisible();
    await app.selectView('cards');
    await app.galleryCards.getByRole('button', { name: 'After the Rain', exact: true }).click();
    await expect(app.albumDialogs).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app.albumPage).toBeVisible();
    await expect(app.albumDialogs).toHaveCount(0);
    await expect(app.backButton).toBeVisible();
    expect(await app.hasNoHorizontalOverflow()).toBe(true);
    await snapshot(`82-promoted-album-phone-${palette}`);
  });
}
