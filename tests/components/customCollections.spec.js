const path = require('node:path');
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
                <button class="artist-link navigation-tree-item is-selected">Night<span class="artist-count">2</span></button>
              </div>
            </div>
          </div>
        </aside>
        <main class="shell-main-surface">
          <div class="non-album-modal-table">
            <div class="custom-collection-detail">
              <div class="custom-collection-detail__art">
                <span class="album-artbox album-artbox--empty" aria-label="Night artwork">
                  <span class="album-artbox__missing-mark"></span>
                  <span class="album-artbox__overlay"><span class="custom-collection-detail__plus" aria-hidden="true">+</span></span>
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
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const plus = element.querySelector('.custom-collection-detail__plus').getBoundingClientRect();
      return {
        border: style.borderTopWidth,
        background: style.backgroundColor,
        centered: Math.abs((plus.x + plus.width / 2) - (box.x + box.width / 2)) < 1,
        missingHidden: getComputedStyle(element.querySelector('.album-artbox__missing-mark')).display,
      };
    });
    expect(art).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)', centered: true, missingHidden: 'none' });

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
