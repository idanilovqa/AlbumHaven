const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://gallery-player-boundary.test/';

test('gallery scroller ends at the player top edge without an empty gutter', async ({ page }) => {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html style="--player-height: 76px">
        <body>
          <div class="shell-layout" id="app-shell">
            <header class="app-bar"></header>
            <aside class="shell-navigation-rail"></aside>
            <main class="shell-main-surface" id="shell-main-surface">
              <section class="gallery-bar"></section>
              <div class="albums-scroll" id="albums-scroll"><div style="height: 600px"></div></div>
            </main>
          </div>
          <div class="global-player"></div>
        </body>
      </html>`,
  }));
  await page.setViewportSize({ width: 1200, height: 500 });
  await page.goto(componentUrl);
  for (const stylesheet of [
    'music_app/static/css/runtime/base-layout.css',
    'music_app/static/css/app-chrome.css',
    'music_app/static/css/runtime/non-album-and-player.css',
    'music_app/static/css/runtime/shell-persistent-player.css',
  ]) {
    await page.addStyleTag({ path: path.join(repositoryRoot, stylesheet) });
  }

  const geometry = await page.evaluate(() => {
    const gallery = document.querySelector('#albums-scroll').getBoundingClientRect();
    const player = document.querySelector('.global-player').getBoundingClientRect();
    return { galleryBottom: gallery.bottom, playerTop: player.top };
  });

  expect(geometry.galleryBottom).toBe(geometry.playerTop);
});
