const path = require('node:path');
const { test, expect } = require('@playwright/test');
const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const width of [320, 390, 768]) {
  test(`mobile Cover Lookup truncates long identity without growing its header at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent('<section class="cover-lookup-modal is-mobile-sheet"><div class="cover-lookup-modal-dialog" role="dialog"><div class="cover-lookup-modal-header"><div><h3 class="cover-lookup-modal-title">Cover Art Look Up Gallery</h3><div class="cover-lookup-modal-subtitle"></div></div></div><div class="cover-lookup-modal-body">Cover choices</div></div></section>');
    for (const file of ['button-component.css', 'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/cover-lookup-modal-and-drawer.js') });
    await page.evaluate(() => {
      window.escapeHtml = value => String(value);
      document.querySelector('.cover-lookup-modal-subtitle').innerHTML = buildCoverLookupAlbumSubtitleHtml({ album_artist: 'Artist', name: 'Album', year: 2026 });
      document.querySelector('.cover-lookup-modal-header').insertAdjacentHTML('beforeend', ButtonComponent.renderActionButton({ icon: 'close', ariaLabel: 'Close Cover Lookup', className: 'cover-lookup-modal-close' }));
    });
    const header = page.locator('.cover-lookup-modal-header');
    const shortBox = await header.boundingBox();
    const close = page.getByRole('button', { name: 'Close Cover Lookup' });
    const shortCloseBox = await close.boundingBox();
    const longName = 'The Hunchback of Notre Dame Original Motion Picture Soundtrack Complete Anniversary Edition';
    await page.evaluate(name => {
      document.querySelector('.cover-lookup-modal-subtitle').innerHTML = buildCoverLookupAlbumSubtitleHtml({ album_artist: 'Alan Menken and Stephen Schwartz with the Original Cast', name, year: '1996 / 2026 Anniversary Edition' });
    }, longName);
    const longBox = await header.boundingBox();
    expect(longBox.height).toBeCloseTo(shortBox.height, 1);
    const album = page.getByRole('button', { name: longName, exact: true });
    await expect(album).toBeVisible();
    await expect(album).toHaveCSS('white-space', 'nowrap');
    await expect(album).toHaveCSS('text-overflow', 'ellipsis');
    expect(await album.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    const closeBox = await close.boundingBox();
    expect(closeBox.width).toBeCloseTo(shortCloseBox.width, 1);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(width);
    expect(await header.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await close.click();
  });
}
