import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileHeaderPage } from '../poms/mobileHeaderPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`mobile Home tabs and long Gallery headers use compact aligned rows in ${palette}`, async ({ page, app, snapshot }) => {
    const header = new MobileHeaderPage(page);
    await header.usePalette(palette);
    await header.expectHomeTabsTogether();
    await snapshot(`90-compact-home-header-${palette}`);
    await header.browseArtist('Northlight & The Lumen Trio');
    await expect(header.galleryContextName).toContainText('Northlight & The Lumen Trio');
    for (const width of [390, 320, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await header.expectCompactGalleryRows();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await snapshot(`91-compact-long-gallery-header-${palette}`);
  });
}
