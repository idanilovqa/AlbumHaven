const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('close controls retain canonical component sizing across modal surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<main role="dialog"><div id="reference"></div><div id="utility-modal"></div><div class="is-mobile-artist-dialog"></div><div id="other"></div></main>');
  for (const file of ['button-component.css', 'appearance-backgrounds.css', 'runtime/album-details-components.css', 'runtime/track-modal-and-lightbox.css', 'runtime/utilities.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
  await page.evaluate(() => {
    const button = className => ButtonComponent.renderActionButton({ icon: 'close', ariaLabel: `Close ${className || 'reference'}`, presentation: 'bare', className });
    document.querySelector('#reference').innerHTML = button('');
    document.querySelector('#utility-modal').innerHTML = button('utility-modal-close');
    document.querySelector('.is-mobile-artist-dialog').innerHTML = button('mobile-artist-info-close');
    document.querySelector('#other').innerHTML = ['image-lightbox-close', 'track-modal-close', 'version-picker-close'].map(button).join('');
  });
  const dimensions = locator => locator.evaluate(node => {
    const style = getComputedStyle(node);
    const icon = getComputedStyle(node.querySelector('svg'));
    return { width: style.width, height: style.height, padding: style.padding, radius: style.borderRadius, iconWidth: icon.width, iconHeight: icon.height };
  });
  const canonical = await dimensions(page.locator('#reference button'));
  for (const name of ['utility-modal-close', 'mobile-artist-info-close', 'image-lightbox-close', 'track-modal-close', 'version-picker-close']) {
    expect(await dimensions(page.locator(`button.${name}`)), name).toEqual(canonical);
  }
  await page.evaluate(() => {
    document.body.innerHTML = `<div class="image-lightbox" role="dialog" aria-label="Full-screen cover">${ButtonComponent.renderActionButton({
      icon: 'close', ariaLabel: 'Close full-screen cover', presentation: 'bare', className: 'image-lightbox-close',
    })}</div>`;
  });
  const close = page.getByRole('button', { name: 'Close full-screen cover', exact: true });
  await expect(close).toBeVisible();
  await expect(close).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS('outline-width', '2px');
  await expect(close).toHaveCSS('outline-style', 'solid');
  await expect(close).toHaveCSS('outline-color', 'rgb(85, 199, 255)');
  await expect(close).toHaveCSS('outline-offset', '2px');
});
