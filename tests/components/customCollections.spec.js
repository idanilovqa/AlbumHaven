const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');

const repositoryRoot = path.join(__dirname, '..', '..');
const componentUrl = 'http://custom-collections-component.test/detail';

function modeButton(label, mode) {
  return renderActionButton({
    ariaLabel: label,
    title: label,
    className: `library-navigation-mode-action${mode === 'artists' ? ' is-active' : ''}`,
    presentation: 'bare',
    attributes: { 'data-library-navigation-mode': mode, 'aria-pressed': String(mode === 'artists') },
  }).replace(
    '<span class="action-button__icon" aria-hidden="true"></span>',
    '<svg class="action-button__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/></svg>',
  );
}

async function mount(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body>
      <div class="shell-layout" id="app-shell">
        <aside class="sidebar shell-navigation-rail${viewport.width <= 900 ? ' is-mobile-drawer-open' : ''}" id="shell-navigation-rail">
          <div id="artist-tree-expanded">
            <div class="sidebar-top shell-navigation-rail-header">
              <button class="shell-navigation-rail-toggle" aria-label="Collapse Artist Tree"${viewport.width <= 900 ? ' hidden' : ''}></button>
              <button class="mobile-bar-action" aria-label="Close library navigation"></button>
              <h2 id="library-navigation-heading">Custom Collections</h2>
            </div>
            <div class="library-navigation-body">
              <button class="mobile-tree-edge-anchor" id="mobile-tree-edge-anchor" aria-label="Show library views" hidden></button>
              <nav class="library-navigation-mode-rail" aria-label="Library views">
                ${modeButton('Artists', 'artists')}
                ${modeButton('Custom Collections', 'custom-collections')}
                ${modeButton('Loose Tracks', 'loose-tracks')}
              </nav>
              <div class="artist-list navigation-tree" id="sidebar-list">
                <button class="artist-link navigation-tree-item is-selected"><span class="artist-name-label">Nightg</span><span class="artist-count">2</span></button>
              </div>
            </div>
          </div>
        </aside>
        <main class="shell-main-surface">
          <div class="gallery-bar" data-gallery-bar-layout="mobile-primary">
            <div class="gallery-bar__context"><h2 class="gallery-bar__title"><span>Gallery</span></h2></div>
          </div>
          <div class="non-album-modal-table">
            <div class="custom-collection-detail">
              <div class="custom-collection-detail__art">
                <span class="album-artbox album-artbox--empty" aria-label="Night artwork">
                  <span class="album-artbox__missing-mark"></span>
                </span>
              </div>
              <div class="custom-collection-detail__tracks">
                <div class="album-track-table">
                  <div class="compact-data-table" role="table" aria-label="Night" data-cdt-mobile="grouped" style="--cdt-columns: 36px minmax(180px, 1fr) 104px 30px 76px 54px 48px minmax(220px, .9fr) 20px minmax(54px, auto); --cdt-mobile-columns: 36px minmax(0, 1fr) 30px 54px minmax(54px, auto)">
                    <div class="compact-data-table-header" role="row">
                      <div role="columnheader" data-cdt-column="number">#</div>
                      <div role="columnheader" data-cdt-column="title">Track</div>
                      <div role="columnheader" data-cdt-column="rating" data-cdt-visibility="desktop">Rating</div>
                      <div role="columnheader" data-cdt-column="love">♥</div>
                      <div role="columnheader" data-cdt-column="popularity" data-cdt-visibility="desktop">Popularity</div>
                      <div role="columnheader" data-cdt-column="plays">Plays</div>
                      <div role="columnheader" data-cdt-column="year" data-cdt-visibility="desktop">Year</div>
                      <div role="columnheader" data-cdt-column="path" data-cdt-visibility="desktop">File path</div>
                      <div data-cdt-column="problem" data-cdt-visibility="desktop"></div>
                      <div role="columnheader" data-cdt-column="duration">Length</div>
                    </div>
                    <div class="compact-data-table-row album-track-table__row" role="row">
                      <div role="cell" data-cdt-column="number">1</div>
                      <div role="cell" data-cdt-column="title"><span class="album-track-table__title">Track A<span class="album-track-table__secondary">Artist</span><span class="album-track-table__mobile-meta"><span>2001</span><span aria-hidden="true">·</span><span>4/5</span><span aria-hidden="true">·</span><span>4,200</span></span></span></div>
                      <div role="cell" data-cdt-column="rating" data-cdt-visibility="desktop">4/5</div>
                      <div role="cell" data-cdt-column="love"><span class="album-track-table__love is-active">♥</span></div>
                      <div role="cell" data-cdt-column="popularity" data-cdt-visibility="desktop">4,200</div>
                      <div role="cell" data-cdt-column="plays">23</div>
                      <div role="cell" data-cdt-column="year" data-cdt-visibility="desktop">2001</div>
                      <div role="cell" data-cdt-column="path" data-cdt-visibility="desktop">Night/a.flac</div>
                      <div role="cell" data-cdt-column="problem" data-cdt-visibility="desktop"></div>
                      <div role="cell" data-cdt-column="duration">3:45</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </body></html>`,
  }));
  await page.goto(componentUrl);
  for (const file of [
    'static/css/runtime/base-layout.css',
    'static/css/app-chrome.css',
    'static/css/gallery-main.css',
    'static/css/button-component.css',
    'static/css/runtime/compact-data-table.css',
    'static/css/runtime/album-track-table.css',
    'static/css/runtime/album-artbox-and-gallery-card.css',
    'static/css/runtime/non-album-and-player.css',
    'static/css/mobile-layout.css',
  ]) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', file) });
  }
}

test('mobile tree title aligns with Gallery and the approved edge handle is easy to grab', async ({ page }) => {
  await mount(page, { width: 390, height: 760 });
  const geometry = await page.locator('#shell-navigation-rail').evaluate((rail) => {
    const expandedWidth = rail.getBoundingClientRect().width;
    rail.classList.add('is-mobile-mode-rail-hidden');
    const anchor = rail.querySelector('#mobile-tree-edge-anchor');
    anchor.hidden = false;
    const heading = rail.querySelector('#library-navigation-heading').getBoundingClientRect();
    const firstRow = rail.querySelector('#sidebar-list .artist-link').getBoundingClientRect();
    const firstLabel = rail.querySelector('#sidebar-list .artist-name-label').getBoundingClientRect();
    const galleryTitle = document.querySelector('.gallery-bar__title').getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    return {
      titleCenterOffset: Math.abs(
        (heading.top + heading.height / 2) - (galleryTitle.top + galleryTitle.height / 2),
      ),
      titleToFirstRow: firstRow.top - heading.bottom,
      anchorLeft: anchorBox.left - railBox.left,
      anchorWidth: anchorBox.width,
      anchorHeight: anchorBox.height,
      anchorCursor: getComputedStyle(anchor).cursor,
      anchorRight: anchorBox.right,
      firstLabelLeft: firstLabel.left,
      widthReduction: expandedWidth - railBox.width,
    };
  });

  expect(geometry.titleCenterOffset).toBeLessThanOrEqual(1);
  expect(geometry.titleToFirstRow).toBeLessThanOrEqual(10);
  expect(geometry.anchorLeft).toBe(0);
  expect(geometry.anchorWidth).toBe(15);
  expect(geometry.anchorHeight).toBe(72);
  expect(geometry.anchorCursor).toBe('grab');
  expect(geometry.anchorRight).toBeLessThanOrEqual(geometry.firstLabelLeft);
  expect(geometry.widthReduction).toBeGreaterThanOrEqual(45);
});

test('library mode rail is divided from the tree and page headers have no bottom rule', async ({ page }) => {
  await mount(page, { width: 1200, height: 800 });
  const styles = await page.locator('.library-navigation-mode-rail').evaluate((modeRail) => ({
    border: getComputedStyle(modeRail).borderRightWidth,
  }));
  expect(styles.border).toBe('1px');

  const css = await fs.promises.readFile(
    path.join(repositoryRoot, 'music_app/static/css/runtime/non-album-and-player.css'),
    'utf8',
  );
  expect(css).toMatch(/\.non-album-modal--page \.non-album-modal-header\s*\{[^}]*border-bottom:\s*0/s);
});

test('desktop navigation keeps its header fixed while only the tree list scrolls', async ({ page }) => {
  await mount(page, { width: 1200, height: 800 });
  await page.locator('#shell-navigation-rail').evaluate(element => { element.style.height = '260px'; });
  await page.locator('#sidebar-list').evaluate((element) => {
    element.insertAdjacentHTML('beforeend', Array.from({ length: 40 }, (_, index) => (
      `<button class="artist-link navigation-tree-item"><span class="artist-name-label">Artist ${index}g</span><span class="artist-count">1</span></button>`
    )).join(''));
  });

  const before = await page.locator('.shell-navigation-rail-header').boundingBox();
  const titleCenters = await page.locator('body').evaluate(() => {
    const heading = document.querySelector('#library-navigation-heading').getBoundingClientRect();
    const gallery = document.querySelector('.gallery-bar__title').getBoundingClientRect();
    return {
      navigation: heading.top + heading.height / 2,
      gallery: gallery.top + gallery.height / 2,
    };
  });
  const metrics = await page.locator('#sidebar-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    const rail = list.closest('.shell-navigation-rail');
    const label = list.querySelector('.artist-name-label');
    return {
      listScrollTop: list.scrollTop,
      listScrollHeight: list.scrollHeight,
      listClientHeight: list.clientHeight,
      railScrollTop: rail.scrollTop,
      labelOverflowY: getComputedStyle(label).overflowY,
    };
  });
  const after = await page.locator('.shell-navigation-rail-header').boundingBox();

  expect(metrics.listScrollHeight).toBeGreaterThan(metrics.listClientHeight);
  expect(Math.abs(titleCenters.navigation - titleCenters.gallery)).toBeLessThanOrEqual(1);
  expect(metrics.listScrollTop).toBeGreaterThan(0);
  expect(metrics.railScrollTop).toBe(0);
  expect(after.y).toBe(before.y);
  expect(metrics.labelOverflowY).toBe('visible');
});

for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 760 }]) {
  test(`collection rail and empty art reuse the approved responsive geometry at ${viewport.width}px`, async ({ page }) => {
    await mount(page, viewport);
    const buttons = page.locator('.library-navigation-mode-action');
    await expect(buttons).toHaveCount(3);
    const boxes = await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    expect(boxes.every(box => Math.round(box.width) === 40 && Math.round(box.height) === 40)).toBe(true);
    expect(boxes[0].y).toBeLessThan(boxes[1].y);
    expect(boxes[1].y).toBeLessThan(boxes[2].y);
    await expect(page.getByRole('heading', { name: 'Custom Collections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Library views' })).toBeVisible();

    const art = await page.locator('.custom-collection-detail__art .album-artbox').evaluate(element => {
      const box = element.getBoundingClientRect();
      const missing = element.querySelector('.album-artbox__missing-mark');
      return {
        square: Math.round(box.width) === Math.round(box.height),
        missingDisplay: getComputedStyle(missing).display,
      };
    });
    expect(art.square).toBe(true);
    expect(art.missingDisplay).toBe('grid');

    const columns = await page.locator('.custom-collection-detail').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    if (viewport.width <= 700) {
      expect(columns.split(' ')).toHaveLength(1);
      await expect(page.locator('[data-cdt-column="rating"][role="cell"]')).toBeHidden();
      await expect(page.locator('[data-cdt-column="popularity"][role="cell"]')).toBeHidden();
      await expect(page.locator('[data-cdt-column="year"][role="cell"]')).toBeHidden();
      await expect(page.locator('[data-cdt-column="path"][role="cell"]')).toBeHidden();
      await expect(page.locator('.album-track-table__mobile-meta')).toBeVisible();
      await expect(page.locator('[data-cdt-column="love"][role="cell"]')).toBeVisible();
      await expect(page.locator('[data-cdt-column="plays"][role="cell"]')).toBeVisible();
      await expect(page.locator('[data-cdt-column="duration"][role="cell"]')).toBeVisible();
      expect(await page.locator('.custom-collection-detail__tracks').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    } else {
      expect(columns.split(' ')).toHaveLength(2);
      await expect(page.locator('[data-cdt-column="rating"][role="cell"]')).toBeVisible();
      await expect(page.locator('[data-cdt-column="popularity"][role="cell"]')).toBeVisible();
      await expect(page.locator('[data-cdt-column="year"][role="cell"]')).toBeVisible();
      await expect(page.locator('[data-cdt-column="path"][role="cell"]')).toBeVisible();
      await expect(page.locator('.album-track-table__mobile-meta')).toBeHidden();
    }
  });
}
