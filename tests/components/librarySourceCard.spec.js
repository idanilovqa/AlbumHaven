const { test, expect } = require('@playwright/test');
const { mountLibrarySourceCard } = require('./helpers/librarySourceCard');

test('artwork hover reveals icons but only the individual action expands its label', async ({ page }) => {
  const card = await mountLibrarySourceCard(page);
  await card.art.hover();
  await expect(card.hoard).toHaveCSS('opacity', '1');
  await expect(card.hoard.locator('span')).toHaveCSS('max-width', '0px');
  await expect(card.duplicate.locator('span')).toHaveCSS('max-width', '0px');
  await card.hoard.hover();
  await expect(card.hoard.locator('span')).toHaveCSS('opacity', '1');
  await expect(card.arrivals.locator('span')).toHaveCSS('max-width', '0px');
  await card.duplicate.focus();
  await expect(card.duplicate.locator('span')).toHaveCSS('opacity', '1');
});

test('disabling source icons preserves the independently focusable duplicate warning', async ({ page }) => {
  const card = await mountLibrarySourceCard(page, { icons: false, outline: true });
  await card.art.hover();
  await expect(card.hoard).toBeHidden();
  await expect(card.arrivals).toBeHidden();
  await card.duplicate.focus();
  await expect(card.duplicate).toBeFocused();
  await expect(card.duplicate).toHaveCSS('opacity', '1');
  await expect(card.duplicate).toHaveAttribute('data-open-tracklist', '1');
  await expect(card.card).toHaveAttribute('data-library-sources', 'main hoard new_arrivals');
});

for (const mode of ['dark', 'light']) {
  test(`mixed sources keep the neutral Main segment in the ${mode} colored frame`, async ({ page }) => {
    const card = await mountLibrarySourceCard(page, { colors: true, outline: true, mode });
    await card.art.hover();
    await expect.poll(() => card.art.evaluate(element => getComputedStyle(element, '::after').opacity)).toBe('1');
    const colors = await card.card.evaluate(element => {
      const style = getComputedStyle(element);
      const frame = getComputedStyle(element.querySelector('.cover'), '::after');
      return { card: style.backgroundImage, frame: frame.backgroundImage };
    });
    expect(colors.card).toContain('conic-gradient');
    expect(colors.frame).toContain('conic-gradient');
    expect(colors.frame).toContain(mode === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    expect(colors.frame).toContain('33.3333%');
    expect(colors.frame).toContain('66.6667%');
    await page.screenshot({ path: `test-results/library-source-${mode}.png` });
  });
}
