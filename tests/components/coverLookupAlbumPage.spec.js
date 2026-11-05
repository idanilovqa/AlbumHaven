const path = require('node:path');
const { test, expect } = require('@playwright/test');
const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const width of [320, 390]) {
  test(`album-entry Cover Lookup keeps its extractor and uses GalleryBar geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const title = 'Cover Art Look Up';
    const subtitle = 'The Hunchback of Notre Dame · Alan Menken · 1996';
    await page.setContent(`<header id="reference" class="gallery-bar" data-gallery-bar-layout="mobile-primary"><div class="gallery-bar__context"><h1 class="gallery-bar__title">${title}</h1><p class="gallery-bar__summary">${subtitle}</p></div></header>
      <main class="shell-main-surface" id="shell-main-surface"><header class="gallery-bar mobile-page-header" id="mobile-page-header"><button class="mobile-bar-action page-gallery-bar__back" id="mobile-back-button" data-mobile-back>Back</button><button id="mobile-settings-button" hidden></button><div class="gallery-bar__context"><h1 class="gallery-bar__title" id="mobile-page-title"></h1><p class="gallery-bar__summary" id="mobile-page-summary"></p></div><div class="gallery-bar__actions" id="mobile-settings-actions" hidden></div></header><div class="mobile-page-outlet" id="mobile-page-outlet"><section class="cover-lookup-modal is-mobile-page"><div class="cover-lookup-modal-dialog"><div class="cover-lookup-modal-body"><div class="cover-lookup-manual-add"><div class="cover-lookup-manual-row"><textarea aria-label="Image URL"></textarea><button>Add image</button></div><div class="cover-lookup-manual-actions"><button>Extract images</button></div></div></div></div></section></div></main><button id="mobile-library-button" hidden></button>`);
    for (const file of ['gallery-main.css', 'button-component.css', 'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/mobile-navigation.js') });
    await page.evaluate(({ title, subtitle }) => {
      mobilePageState.pages = [{ kind: 'cover-lookup', title, subtitle }];
      syncMobileAlbumHeader = () => {};
      syncMobileLoopHeader = () => {};
      syncMobilePageShell();
    }, { title, subtitle });
    await expect(page.getByRole('textbox', { name: 'Image URL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add image', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Extract images', exact: true })).toBeVisible();
    const geometry = selector => page.locator(selector).evaluate(node => {
      const header = node.getBoundingClientRect();
      const title = node.querySelector('.gallery-bar__title').getBoundingClientRect();
      const summary = node.querySelector('.gallery-bar__summary').getBoundingClientRect();
      return { titleX: title.x - header.x, titleY: title.y - header.y, titleHeight: title.height, summaryX: summary.x - header.x, summaryY: summary.y - header.y };
    });
    expect(await geometry('#mobile-page-header')).toEqual(await geometry('#reference'));
    await expect(page.locator('#mobile-page-summary')).toHaveCSS('white-space', 'nowrap');
    await page.getByRole('textbox', { name: 'Image URL' }).fill('https://example.com/cover.jpg');
    await page.getByRole('button', { name: 'Extract images', exact: true }).click();
  });
}
