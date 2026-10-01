const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..', '..');
const bootstrapSource = fs.readFileSync(
  path.join(root, 'music_app/static/js/client-layout-bootstrap.js'),
  'utf8',
);

test('server preview fills six columns before gallery JavaScript runs', async ({ page }) => {
  const source = fs.readFileSync(path.join(root, 'music_app/services/startup_bootstrap.py'), 'utf8');
  const rowStyle = source.match(/class="album-row" style="([^"]+)"/)[1];
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.setContent(`<div class="album-row" style="display:grid;gap:14px;width:1610px;${rowStyle}">
    ${Array.from({ length: 32 }, (_, i) => `<div style="height:100px">Album ${i + 1}</div>`).join('')}
  </div>`);
  const geometry = await page.locator('.album-row').evaluate(row => {
    const cards = [...row.children].map(card => card.getBoundingClientRect());
    const firstRow = cards.filter(card => card.top === cards[0].top);
    return { columns: firstRow.length, gap: row.getBoundingClientRect().right - firstRow.at(-1).right };
  });
  expect(geometry.columns).toBe(6);
  expect(geometry.gap).toBeLessThanOrEqual(1);
});

test('saved tree, player, and gallery scale are applied before content becomes visible', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('albumhaven.shellLayoutPreferences.v1', JSON.stringify({ artistTreeFolded: true }));
    localStorage.setItem('albumhaven.compactPlayer.mode.v1', 'compact');
    localStorage.setItem('albumhaven.galleryDisplayPreferences.v1', JSON.stringify({ defaultGalleryScalePercent: 120 }));
  });
  await page.route('**/client-layout-bootstrap.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: bootstrapSource,
  }));
  await page.route('http://client-layout.test/', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html><head>
        <script id="appearance-bootstrap" type="application/json">{"compact_player_style":"docked","docked_compact_player_behavior":"follow_sidebar"}</script>
        <style>
          html[data-client-layout-pending="true"] body { visibility: hidden; }
          #app-shell { display:grid; grid-template-columns:var(--compact-rail-width,240px) 1fr; }
          #albums-scroll { width:1000px; }
        </style>
        <script src="/client-layout-bootstrap.js"></script>
        <script>AlbumHavenClientLayoutBootstrap.capture();</script>
      </head><body>
        <div id="app-shell"><aside id="shell-navigation-rail">
          <div id="artist-tree-expanded"><button id="artist-tree-fold-button"></button><div id="sidebar-list"></div></div>
          <nav id="shell-navigation-compact" hidden><button id="artist-tree-navigation-button"></button></nav>
        </aside><main><div id="albums-scroll"><div id="artist-groups"><div class="album-row"><div></div><div></div><div></div><div></div></div></div></div></main></div>
        <div class="global-player"><div class="player-shell"><button data-ui-button-action="player-collapse"></button></div>
          <div class="compact-player-shell" hidden><button data-ui-button-action="player-expand"></button><button data-compact-player-cover></button></div></div>
        <script>
          AlbumHavenClientLayoutBootstrap.finalize();
          window.firstVisibleLayout = {
            pending: document.documentElement.hasAttribute('data-client-layout-pending'),
            folded: document.getElementById('app-shell').classList.contains('is-artist-tree-folded'),
            expandedTreeHidden: document.getElementById('artist-tree-expanded').hidden,
            compactTreeHidden: document.getElementById('shell-navigation-compact').hidden,
            presentation: document.querySelector('.global-player').dataset.compactPresentation,
            compactPlayerHidden: document.querySelector('.compact-player-shell').hidden,
            grid: document.querySelector('.album-row').style.gridTemplateColumns,
          };
        </script>
      </body></html>`,
  }));

  await page.goto('http://client-layout.test/');
  expect(await page.evaluate(() => window.firstVisibleLayout)).toEqual({
    pending: false,
    folded: true,
    expandedTreeHidden: true,
    compactTreeHidden: false,
    presentation: 'rail_play',
    compactPlayerHidden: false,
    grid: 'repeat(3, minmax(0px, 322.666px))',
  });
  await expect(page.locator('body')).toHaveCSS('visibility', 'visible');
});

test('hidden startup gallery uses its settled main-surface width before reveal', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('albumhaven.shellLayoutPreferences.v1', JSON.stringify({ artistTreeFolded: true }));
  });
  await page.route('**/client-layout-bootstrap.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: bootstrapSource,
  }));
  await page.route('http://client-layout-hidden-gallery.test/', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html><head>
        <style>
          html[data-client-layout-pending="true"] body { visibility: hidden; }
          #app-shell { display:grid; grid-template-columns:var(--compact-rail-width,240px) 1fr; }
          #shell-main-surface { box-sizing:border-box; width:1000px; padding:0 20px; }
          #albums-scroll { width:100%; }
          [hidden] { display:none !important; }
        </style>
        <script src="/client-layout-bootstrap.js"></script>
        <script>AlbumHavenClientLayoutBootstrap.capture();</script>
      </head><body>
        <div id="app-shell">
          <aside id="shell-navigation-rail">
            <div id="artist-tree-expanded"><button id="artist-tree-fold-button"></button><div id="sidebar-list"></div></div>
            <nav id="shell-navigation-compact" hidden><button id="artist-tree-navigation-button"></button></nav>
          </aside>
          <main id="shell-main-surface">
            <div id="albums-scroll" hidden>
              <div id="artist-groups"><div class="album-row"><div></div><div></div><div></div><div></div></div></div>
            </div>
          </main>
        </div>
        <script>
          AlbumHavenClientLayoutBootstrap.finalize();
          const row = document.querySelector('.album-row');
          window.preRevealGrid = row.style.gridTemplateColumns;
          document.getElementById('albums-scroll').hidden = false;
          window.revealedGalleryWidth = document.getElementById('albums-scroll').clientWidth - 4;
        </script>
      </body></html>`,
  }));

  await page.goto('http://client-layout-hidden-gallery.test/');
  expect(await page.evaluate(() => ({
    grid: window.preRevealGrid,
    width: window.revealedGalleryWidth,
  }))).toEqual({
    grid: 'repeat(3, minmax(0px, 309.333px))',
    width: 956,
  });
});
