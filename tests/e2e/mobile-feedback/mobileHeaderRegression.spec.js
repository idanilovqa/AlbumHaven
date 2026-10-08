import { test } from '../fixtures/mobileFeedbackTest.js';
import { MobileHeaderRegressionPage } from '../poms/mobileHeaderRegressionPage.js';

test('Home hamburger glyph aligns with Recent and Top tracks text at narrow phone widths', async ({ page, app, snapshot }) => {
  const header = new MobileHeaderRegressionPage(page);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await header.expectHomeGlyphAlignment();
    await snapshot(`home-glyph-alignment-${width}`);
  }
});

test('Gallery sticky artist follows complete plain and wrapped label occlusion in both scroll directions', async ({ page, app, snapshot }) => {
  const header = new MobileHeaderRegressionPage(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await header.libraryButton.click();
  await header.allArtists.click();
  await header.selectView('cards');
  await header.selectColumns(2);
  // Independent deterministic fixture ordering, never the current header as an oracle.
  await header.expectLabelBoundary('Northlight', 'Mira Vale', false, snapshot);
  await header.expectLabelBoundary('Northlight & The Lumen Trio', 'Northlight & Orion Field', true, snapshot);
});
