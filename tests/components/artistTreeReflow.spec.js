const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const { renderActionButton } = require(path.join(repositoryRoot, 'music_app/static/js/button-component.js'));
const componentUrl = 'http://artist-tree-component.test/reflow';

async function openArtistTreeFixture(page, { viewRail = '', compactViews = '' } = {}) {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body>
      <div class="shell-layout" id="app-shell">
    <header class="app-bar"><a class="app-bar-brand"><span class="app-bar-brand-mark"></span></a></header>
        <aside class="sidebar shell-navigation-rail" id="shell-navigation-rail" data-shell-default-collapsed="false">
          <div id="artist-tree-expanded">
            <div class="sidebar-top shell-navigation-rail-header">${renderActionButton({ ariaLabel: "Collapse Artist Tree", icon: "previous", presentation: "bare", className: "shell-navigation-rail-toggle", attributes: { id: "artist-tree-fold-button", "data-toggle-artist-tree-fold": "1", "aria-expanded": "true" } })}<h2>Artists</h2></div>
            ${viewRail}
            <div id="sidebar-list"><button id="selected-artist">Selected artist</button></div>
          </div>
      <nav class="shell-navigation-compact" id="shell-navigation-compact" aria-label="Library navigation" hidden>
            <button class="shell-navigation-compact-action" id="artist-tree-navigation-button" data-toggle-artist-tree-fold="1" aria-label="Artist Tree" aria-controls="sidebar-list" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5"></path></svg>
            </button>
            ${compactViews}
          </nav>
        </aside>
        <main class="shell-main-surface" id="shell-main-surface"></main>
      </div>
      <div class="global-player" id="global-player" data-identity="persistent"></div>
      <script>window.state={view:{shell_layout:{slots:{navigation_rail:{content_kind:'artists_sidebar'}}}},ui:{artistsDrawerOpen:false,artistTreeFolded:false}};</script>
    </body></html>`,
  }));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(componentUrl);
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/runtime/base-layout.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/app-chrome.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/appearance-backgrounds.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/button-component.css') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/shell-navigation-drawer.js') });
}

test('folding Artist Tree reclaims layout width and preserves the persistent player node', async ({ page }) => {
  await openArtistTreeFixture(page);
  await page.evaluate(() => {
    window.__artistTreeResizeWidths = [];
    window.__artistTreeSettlementWidths = [];
    window.addEventListener('resize', () => {
      window.__artistTreeResizeWidths.push(
        document.getElementById('shell-main-surface').getBoundingClientRect().width,
      );
    });
    window.addEventListener('album-haven:artist-tree-settled', () => {
      window.__artistTreeSettlementWidths.push(
        document.getElementById('shell-main-surface').getBoundingClientRect().width,
      );
    });
  });

  const header = await page.locator('.shell-navigation-rail-header').evaluate(element => {
    const title = element.querySelector('h2');
    const icon = element.querySelector('svg');
    const titleBox = title.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return { marginBottom: getComputedStyle(title).marginBottom, centerOffset: Math.abs(titleBox.y + titleBox.height / 2 - iconBox.y - iconBox.height / 2) };
  });
  expect(header.marginBottom).toBe('0px');
  expect(header.centerOffset).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('artist-tree-header.png') });

  const before = await page.locator('#shell-main-surface').boundingBox();
  const expandedBrandX = await page.locator('.app-bar-brand-mark').evaluate(
    element => element.getBoundingClientRect().x,
  );
  const expandedTreeControlCenterX = await page.locator('#artist-tree-fold-button').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.x + (box.width / 2);
  });
  const player = await page.locator('#global-player').elementHandle();
  // Owner 2026-11-17: the logo must not move while the tree folds (it used to ride the shrinking column).
  const foldingBrandX = await page.evaluate(() => {
    toggleArtistTreeFold();
    return document.querySelector('.app-bar-brand-mark').getBoundingClientRect().x;
  });
  expect(foldingBrandX).toBeCloseTo(expandedBrandX, 5);
  await expect.poll(async () => Math.round((await page.locator('#shell-main-surface').boundingBox()).x)).toBe(64);
  await expect.poll(() => page.evaluate(() => window.__artistTreeSettlementWidths.length)).toBe(1);
  const after = await page.locator('#shell-main-surface').boundingBox();
  const resizeWidth = await page.evaluate(() => window.__artistTreeSettlementWidths[0]);

  expect(before.x).toBe(320);
  expect(before.x - after.x).toBe(256);
  expect(Math.round(resizeWidth)).toBe(Math.round(after.width));
  expect(await page.evaluate(() => window.__artistTreeResizeWidths.length)).toBe(0);
  await expect(page.locator('#artist-tree-expanded')).toBeHidden();
  await expect(page.locator('#sidebar-list')).toBeHidden();
  await expect(page.locator('#artist-tree-fold-button')).toBeHidden();
  await expect(page.locator('#shell-navigation-compact')).toBeVisible();
  await expect(page.locator('#shell-navigation-compact button')).toHaveCount(1);
  await expect(page.locator('#artist-tree-navigation-button svg')).toBeVisible();
  const foldedBrandX = await page.locator('.app-bar-brand-mark').evaluate(
    element => element.getBoundingClientRect().x,
  );
  const foldedTreeControlCenterX = await page.locator('#artist-tree-navigation-button').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.x + (box.width / 2);
  });
  expect(foldedBrandX).toBeCloseTo(expandedBrandX, 5);
  expect(foldedTreeControlCenterX).toBeCloseTo(expandedTreeControlCenterX, 5);

  await page.evaluate(() => {
    document.addEventListener('click', handleArtistsDrawerClick);
    document.documentElement.dataset.compactPlayerMotion = 'slow';
  });
  await page.locator('#artist-tree-navigation-button').click();
  const exitingCompactControlCenterX = await page.locator('#artist-tree-navigation-button').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.x + (box.width / 2);
  });
  expect(exitingCompactControlCenterX).toBeCloseTo(foldedTreeControlCenterX, 5);
  await page.waitForTimeout(300);
  const midExitCompactControlCenterX = await page.locator('#artist-tree-navigation-button').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.x + (box.width / 2);
  });
  expect(midExitCompactControlCenterX).toBeCloseTo(foldedTreeControlCenterX, 5);
  const expandingGeometry = await page.evaluate(() => {
    const brandBox = document.querySelector('.app-bar-brand-mark').getBoundingClientRect();
    const controlBox = document.getElementById('artist-tree-fold-button').getBoundingClientRect();
    return {
      brandX: brandBox.x,
      treeControlCenterX: controlBox.x + (controlBox.width / 2),
    };
  });
  expect(expandingGeometry.brandX).toBeCloseTo(foldedBrandX, 5);
  expect(expandingGeometry.treeControlCenterX).toBeCloseTo(foldedTreeControlCenterX, 5);
  const expansionFrame = await page.locator('#shell-navigation-rail').evaluate((rail) => ({
    isExpanding: rail.classList.contains('is-expanding'),
    isTransitioning: rail.classList.contains('is-transitioning'),
    overflowY: getComputedStyle(rail).overflowY,
    expandedTreeHidden: document.getElementById('artist-tree-expanded').hidden,
    artistListHidden: document.getElementById('sidebar-list').hidden,
    compactNavigationHidden: document.getElementById('shell-navigation-compact').hidden,
    expandedTreeDisplay: getComputedStyle(document.getElementById('artist-tree-expanded')).display,
    expandedTreeWidth: document.getElementById('artist-tree-expanded').getBoundingClientRect().width,
  }));
  expect(expansionFrame).toEqual({
    isExpanding: true,
    isTransitioning: true,
    overflowY: 'hidden',
    expandedTreeHidden: false,
    artistListHidden: false,
    compactNavigationHidden: false,
    expandedTreeDisplay: 'flex',
    expandedTreeWidth: 292,
  });
  await page.waitForTimeout(600);
  const lateExpansionFrame = await page.locator('#shell-navigation-rail').evaluate((rail) => ({
    isExpanding: rail.classList.contains('is-expanding'),
    treeOpacity: Number(getComputedStyle(document.getElementById('artist-tree-expanded')).opacity),
  }));
  expect(lateExpansionFrame.isExpanding).toBe(true);
  expect(lateExpansionFrame.treeOpacity).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__artistTreeSettlementWidths.length)).toBe(2);
  await expect(page.locator('#artist-tree-expanded')).toBeVisible();
  await expect(page.locator('#sidebar-list')).toBeVisible();
  await expect(page.locator('#shell-navigation-compact')).toBeHidden();
  const expanded = await page.locator('#shell-main-surface').boundingBox();
  const expandedResizeWidth = await page.evaluate(() => window.__artistTreeSettlementWidths[1]);
  expect(Math.round(expandedResizeWidth)).toBe(Math.round(expanded.width));
  expect(await page.evaluate(() => window.__artistTreeResizeWidths.length)).toBe(0);
  expect(await player.evaluate(element => element.isConnected && element.dataset.identity === 'persistent')).toBe(true);
});

test('the view buttons travel in step with the moving edge', async ({ page }) => {
  // Owner 2026-11-17: expanding "does not feel like expansion and movement of the buttons happen at the same
  // time". A separate button animation ran ahead of the edge whenever the gallery layout slowed the frames.
  const view = (mode, top) => `<button data-library-navigation-mode="${mode}" style="height:36px;margin-top:${top}px">${mode}</button>`;
  await openArtistTreeFixture(page, {
    viewRail: `<div class="library-navigation-mode-rail">${view('artists', 40)}${view('custom-collections', 8)}</div>`,
    compactViews: `${view('artists', 0)}${view('custom-collections', 0)}`,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.shellMotion = 'instant';
    state.ui.artistTreeFolded = true;
    syncArtistTreeFoldVisibility();
    getComputedStyle(document.documentElement).getPropertyValue('--compact-rail-width');
    delete document.documentElement.dataset.shellMotion;
    document.documentElement.dataset.compactPlayerMotion = 'slow';
  });
  const samples = await page.evaluate(async () => {
    const rail = document.getElementById('shell-navigation-rail');
    const compact = [...document.querySelectorAll('#shell-navigation-compact [data-library-navigation-mode]')];
    const start = compact.map(button => button.getBoundingClientRect().top);
    toggleArtistTreeFold();
    const targets = [...document.querySelectorAll('.library-navigation-mode-rail [data-library-navigation-mode]')]
      .map(button => button.getBoundingClientRect().top);
    const frames = [];
    while (rail.classList.contains('is-expanding')) {
      // Busy frames like the gallery's re-layout: the buttons must still match the edge.
      const until = performance.now() + 40;
      while (performance.now() < until);
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!rail.classList.contains('is-expanding')) break;
      const progress = (rail.getBoundingClientRect().width - 64) / 256;
      frames.push(compact.map((button, i) => ({
        expected: start[i] + ((targets[i] - start[i]) * progress),
        actual: button.getBoundingClientRect().top,
        progress,
      })));
    }
    return frames.flat();
  });
  expect(samples.some(sample => sample.progress > 0.1 && sample.progress < 0.9)).toBe(true);
  for (const sample of samples) expect(Math.abs(sample.actual - sample.expected)).toBeLessThanOrEqual(1);
});
