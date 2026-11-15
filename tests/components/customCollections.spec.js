const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');

const repositoryRoot = path.join(__dirname, '..', '..');
const componentUrl = 'http://custom-collections-component.test/detail';

test('desktop collection cover stays sticky while its track pane scrolls', async ({ page }) => {
  await mount(page, { width: 1200, height: 600 });
  const geometry = await page.locator('.custom-collection-detail__art').evaluate(async (element) => {
    element.hidden = false;
    element.innerHTML = '<span class="album-artbox" style="display:block;height:220px"></span>';
    const table = element.closest('.non-album-modal-table');
    const scrollPane = document.createElement('div');
    scrollPane.className = 'non-album-modal-table-wrap';
    scrollPane.style.height = '300px';
    scrollPane.style.overflow = 'auto';
    table.before(scrollPane);
    scrollPane.appendChild(table);
    element.nextElementSibling.insertAdjacentHTML('beforeend', '<div style="height:1400px"></div>');
    scrollPane.scrollTop = 500;
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      position: getComputedStyle(element).position,
      top: getComputedStyle(element).top,
      scrollTop: scrollPane.scrollTop,
      scrollPaneTop: scrollPane.getBoundingClientRect().top,
      scrollPaneBottom: scrollPane.getBoundingClientRect().bottom,
      elementTop: element.getBoundingClientRect().top,
    };
  });
  expect(geometry.position).toBe('sticky');
  expect(geometry.top).toBe('0px');
  expect(geometry.scrollTop).toBe(500);
  expect(geometry.elementTop).toBeGreaterThanOrEqual(geometry.scrollPaneTop);
  expect(geometry.elementTop).toBeLessThan(geometry.scrollPaneBottom);
});

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
            <div class="library-navigation-body navigation-tree-shell">
              <button class="button ui-button ui-button--icon ui-button--medium action-button action-button--bare mobile-tree-edge-anchor" id="mobile-tree-edge-anchor" aria-label="Show library views" hidden><span class="mobile-tree-edge-anchor__chevron" aria-hidden="true">&rsaquo;</span></button>
              <nav class="library-navigation-mode-rail navigation-tree-mode-bar" aria-label="Library views">
                ${modeButton('Artists', 'artists')}
                ${modeButton('Custom Collections', 'custom-collections')}
                ${modeButton('Loose Tracks', 'loose-tracks')}
              </nav>
              <div class="artist-list navigation-tree" id="sidebar-list">
                <button class="artist-link navigation-tree-item is-selected"><span class="artist-name-label">Nightg</span><span class="artist-count">2</span></button>
                <div class="navigation-tree-separator" role="separator" aria-label="Custom Collections"></div>
              </div>
            </div>
          </div>
        </aside>
        <main class="shell-main-surface">
          <div class="gallery-bar" data-gallery-bar-layout="mobile-primary">
            <span class="custom-collection-header-art"><span class="album-artbox album-artbox--add" aria-label="Night artwork"><button type="button" class="album-artbox__add" data-choose-custom-collection-artwork="Night"><span class="album-artbox__add-plus" aria-hidden="true">+</span><span>Add art</span></button><span class="album-artbox__action"><input type="file" accept="image/*" hidden data-custom-collection-artwork-input="Night"></span></span></span>
            <div class="gallery-bar__context"><h2 class="gallery-bar__title"><span>Gallery</span></h2><span class="gallery-bar__summary">162,984 albums</span></div>
          </div>
          <section class="${viewport.width <= 900 ? 'is-mobile-page' : ''}">
          <div class="non-album-modal-table">
            <div class="custom-collection-detail track-modal-body">
              <div class="custom-collection-detail__art track-modal-cover" hidden></div>
              <div class="custom-collection-detail__tracks track-modal-main">
                <div class="album-track-table">
                  <div class="compact-data-table" role="table" aria-label="Night" data-cdt-mobile="grouped" style="--cdt-columns: 36px minmax(0, 1fr) minmax(0, .9fr) 20px minmax(54px, auto); --cdt-mobile-columns: 36px minmax(0, 1fr) minmax(54px, auto)">
                    <div class="compact-data-table-header" role="row">
                      <div role="columnheader" data-cdt-column="number">#</div>
                      <div role="columnheader" data-cdt-column="title">Track</div>
                      <div role="columnheader" data-cdt-column="path" data-cdt-visibility="desktop">File path</div>
                      <div data-cdt-column="problem" data-cdt-visibility="desktop"></div>
                      <div role="columnheader" data-cdt-column="duration">Length</div>
                    </div>
                    <div class="compact-data-table-row album-track-table__row" role="row">
                      <div role="cell" data-cdt-column="number">1</div>
                      <div role="cell" data-cdt-column="title"><span class="album-track-table__title">Track A<span class="album-track-table__secondary">Artist</span></span></div>
                      <div role="cell" data-cdt-column="path" data-cdt-visibility="desktop">Night/a.flac</div>
                      <div role="cell" data-cdt-column="problem" data-cdt-visibility="desktop"></div>
                      <div role="cell" data-cdt-column="duration">3:45</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div></section>
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
    'static/css/runtime/track-modal-and-lightbox.css',
    'static/css/appearance-backgrounds.css',
    'static/css/navigation-tree.css',
    'static/css/runtime/non-album-and-player.css',
    'static/css/mobile-layout.css',
  ]) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app', file) });
  }
}

for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 760 }]) {
  test(`NavigationTree owns the collection separator at ${viewport.width}px`, async ({ page }) => {
    await mount(page, viewport);
    const separator = page.locator('.navigation-tree-separator');
    await expect(separator).toHaveAttribute('role', 'separator');
    expect(await separator.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('linear-gradient');
  });
}

test('mobile tree keeps its view selector in a persistent bottom bar', async ({ page }) => {
  await mount(page, { width: 390, height: 760 });
  const geometry = await page.locator('#shell-navigation-rail').evaluate((rail) => {
    rail.classList.add('is-mobile-mode-rail-hidden');
    const anchor = rail.querySelector('#mobile-tree-edge-anchor');
    anchor.hidden = false;
    const textRect = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const heading = textRect(rail.querySelector('#library-navigation-heading'));
    const firstRow = rail.querySelector('#sidebar-list .artist-link').getBoundingClientRect();
    const galleryTitle = textRect(document.querySelector('.gallery-bar__title'));
    const railBox = rail.getBoundingClientRect();
    const list = rail.querySelector('#sidebar-list');
    list.insertAdjacentHTML('beforeend', Array.from({ length: 40 }, (_, index) => (
      `<button class="artist-link navigation-tree-item"><span class="artist-name-label">Artist ${index}</span></button>`
    )).join(''));
    const listBox = list.getBoundingClientRect();
    const modeRail = rail.querySelector('.library-navigation-mode-rail');
    const modeRailBox = modeRail.getBoundingClientRect();
    const artistWidths = [rail, rail.querySelector('.library-navigation-body'), list]
      .map(element => element.getBoundingClientRect().width);
    list.replaceChildren(Object.assign(document.createElement('button'), {
      className: 'artist-link navigation-tree-item',
      textContent: 'All Loose Tracks',
    }));
    const collectionWidths = [rail, rail.querySelector('.library-navigation-body'), list]
      .map(element => element.getBoundingClientRect().width);
    return {
      titleCenterOffset: Math.abs(
        (heading.top + heading.height / 2) - (galleryTitle.top + galleryTitle.height / 2),
      ),
      titleToFirstRow: firstRow.top - heading.bottom,
      anchorDisplay: getComputedStyle(anchor).display,
      listOverflowY: getComputedStyle(list).overflowY,
      modeRailDirection: getComputedStyle(modeRail).flexDirection,
      modeRailJustify: getComputedStyle(modeRail).justifyContent,
      separatorImage: getComputedStyle(modeRail).backgroundImage,
      artistWidths,
      collectionWidths,
      modeRailTop: modeRailBox.top,
      modeRailBottom: modeRailBox.bottom,
      modeRailLeft: modeRailBox.left,
      modeRailRight: modeRailBox.right,
      listBottom: listBox.bottom,
      railLeft: railBox.left,
      railRight: railBox.right,
      railBottom: railBox.bottom,
    };
  });

  expect(geometry.titleCenterOffset).toBeLessThanOrEqual(1);
  expect(geometry.titleToFirstRow).toBeLessThanOrEqual(10);
  expect(geometry.anchorDisplay).toBe('none');
  expect(geometry.listOverflowY).toBe('auto');
  expect(geometry.modeRailDirection).toBe('row');
  expect(geometry.modeRailJustify).toBe('flex-start');
  expect(geometry.separatorImage).toContain('linear-gradient');
  expect(geometry.collectionWidths).toEqual(geometry.artistWidths);
  expect(geometry.listBottom).toBeLessThanOrEqual(geometry.modeRailTop);
  expect(geometry.modeRailLeft).toBeGreaterThanOrEqual(geometry.railLeft);
  expect(geometry.modeRailRight).toBeLessThanOrEqual(geometry.railRight);
  expect(geometry.modeRailBottom).toBeLessThanOrEqual(geometry.railBottom);
});

test('mobile Loose Tracks uses the full shared track-table width', async ({ page }) => {
  await mount(page, { width: 390, height: 760 });
  const widths = await page.locator('.non-album-modal-table').evaluate((tableSurface) => {
    const main = tableSurface.closest('.shell-main-surface');
    const overlay = document.createElement('section');
    const dialog = document.createElement('div');
    const wrap = document.createElement('div');
    overlay.className = 'non-album-modal non-album-modal--page is-mobile-page';
    dialog.className = 'non-album-modal-dialog';
    wrap.className = 'non-album-modal-table-wrap';
    tableSurface.replaceWith(overlay);
    overlay.append(dialog);
    dialog.append(wrap);
    wrap.append(tableSurface);
    main.classList.add('has-mobile-page');
    const wrapStyle = getComputedStyle(wrap);
    return {
      dialog: dialog.getBoundingClientRect().width,
      table: tableSurface.querySelector('.album-track-table').getBoundingClientRect().width,
      paddingInline: parseFloat(wrapStyle.paddingInlineStart) + parseFloat(wrapStyle.paddingInlineEnd),
    };
  });

  expect(widths.paddingInline).toBe(0);
  expect(Math.abs(widths.dialog - widths.table)).toBeLessThanOrEqual(1);
});

test('mobile Loose Tracks inherits Album Details table paint and one-row headers', async ({ page }) => {
  await mount(page, { width: 390, height: 760 });
  const presentation = await page.locator('.non-album-modal-table').evaluate((looseSurface) => {
    document.documentElement.dataset.appearancePalette = 'parchment-pine';
    const albumSurface = looseSurface.cloneNode(true);
    const albumDialog = document.createElement('div');
    const looseDialog = document.createElement('div');
    albumDialog.className = 'track-modal-dialog';
    looseDialog.className = 'non-album-modal-dialog';
    looseSurface.replaceWith(looseDialog);
    looseDialog.append(looseSurface);
    albumDialog.append(albumSurface);
    document.body.append(albumDialog);
    albumSurface.querySelector('.compact-data-table').dataset.cdtMobile = 'preserve';
    const looseTable = looseSurface.querySelector('.compact-data-table');
    looseTable.style.removeProperty('--cdt-mobile-columns');
    const headerTops = [...looseTable.querySelectorAll('[role="columnheader"]')]
      .filter(cell => getComputedStyle(cell).display !== 'none')
      .map(cell => Math.round(cell.getBoundingClientRect().top));
    return {
      albumBackground: getComputedStyle(albumSurface.querySelector('.compact-data-table')).backgroundColor,
      looseBackground: getComputedStyle(looseTable).backgroundColor,
      headerTops,
    };
  });

  expect(new Set(presentation.headerTops).size).toBe(1);
  expect(presentation.looseBackground).toBe(presentation.albumBackground);
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

test('desktop hidden view rail leaves only a slim full-height edge affordance', async ({ page }) => {
  await mount(page, { width: 1200, height: 800 });
  const list = page.locator('#sidebar-list');
  const initialListLeft = await list.evaluate(element => element.getBoundingClientRect().left);
  const geometry = await page.locator('#mobile-tree-edge-anchor').evaluate((anchor) => {
    anchor.hidden = false;
    anchor.closest('#shell-navigation-rail').classList.add('is-library-mode-rail-hidden');
    const box = anchor.getBoundingClientRect();
    const mark = getComputedStyle(anchor, '::before');
    const navigationBody = anchor.closest('.library-navigation-body');
    const bodyStyle = getComputedStyle(navigationBody);
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      background: getComputedStyle(anchor).backgroundColor,
      markWidth: mark.width,
      markTop: mark.top,
      markTransform: mark.transform,
      markRadius: mark.borderRadius,
      anchorColor: getComputedStyle(anchor).color,
      pageColor: getComputedStyle(document.body).color,
      bodyPaddingLeft: bodyStyle.paddingLeft,
      bodyTransitionProperty: bodyStyle.transitionProperty,
      bodyTransitionDuration: bodyStyle.transitionDuration,
    };
  });

  await expect.poll(
    () => list.evaluate(element => element.getBoundingClientRect().left),
  ).toBeLessThan(initialListLeft - 50);
  expect(geometry.left).toBe(0);
  expect(geometry.top).toBe(0);
  expect(geometry.width).toBe(2);
  expect(geometry.height).toBe(800);
  expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
  expect(geometry.markWidth).toBe('2px');
  expect(geometry.markTop).toBe('400px');
  expect(geometry.markTransform).not.toBe('none');
  expect(geometry.markRadius).not.toBe('0px');
  expect(geometry.anchorColor).toBe(geometry.pageColor);
  expect(geometry.bodyPaddingLeft).toBe('0px');
  expect(geometry.bodyTransitionProperty).toContain('grid-template-columns');
  expect(geometry.bodyTransitionDuration).not.toBe('0s');
});

test('the displayed navigation tree button has a visible selected background', async ({ page }) => {
  await mount(page, { width: 390, height: 760 });
  const backgrounds = await page.locator('.library-navigation-mode-action').evaluateAll(nodes => (
    nodes.map(node => ({
      selected: node.getAttribute('aria-pressed') === 'true',
      background: getComputedStyle(node).backgroundColor,
    }))
  ));
  const active = backgrounds.find(item => item.selected);
  const inactive = backgrounds.find(item => !item.selected);

  expect(active.background).not.toBe(inactive.background);
  expect(active.background).not.toBe('rgba(0, 0, 0, 0)');
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
    const textRect = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const heading = textRect(document.querySelector('#library-navigation-heading'));
    const gallery = textRect(document.querySelector('.gallery-bar__title'));
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
    if (viewport.width <= 700) {
      expect(boxes.map(box => box.y)).toEqual([boxes[0].y, boxes[0].y, boxes[0].y]);
      expect(boxes[0].x).toBeLessThan(boxes[1].x);
      expect(boxes[1].x).toBeLessThan(boxes[2].x);
    } else {
      expect(boxes[0].y).toBeLessThan(boxes[1].y);
      expect(boxes[1].y).toBeLessThan(boxes[2].y);
    }
    await expect(page.getByRole('heading', { name: 'Custom Collections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Library views' })).toBeVisible();

    const art = await page.locator('.custom-collection-header-art .album-artbox').evaluate(element => {
      const box = element.getBoundingClientRect();
      const plus = element.querySelector('.album-artbox__add');
      const plusBox = plus.getBoundingClientRect();
      const plusMark = element.querySelector('.album-artbox__add-plus');
      const plusMarkBox = plusMark.getBoundingClientRect();
      return {
        square: Math.round(box.width) === Math.round(box.height),
        plusCenterOffset: Math.max(
          Math.abs((plusBox.left + plusBox.width / 2) - (box.left + box.width / 2)),
          Math.abs((plusBox.top + plusBox.height / 2) - (box.top + box.height / 2)),
        ),
        plusMarkCenterOffset: Math.max(
          Math.abs((plusMarkBox.left + plusMarkBox.width / 2) - (box.left + box.width / 2)),
          Math.abs((plusMarkBox.top + plusMarkBox.height / 2) - (box.top + box.height / 2)),
        ),
        plusWidth: plusBox.width,
        plusText: plusMark.textContent,
        plusTransform: getComputedStyle(plusMark).transform,
      };
    });
    expect(art.square).toBe(true);
    expect(art.plusCenterOffset).toBeLessThanOrEqual(1);
    expect(art.plusMarkCenterOffset).toBeLessThanOrEqual(1);
    expect(art.plusWidth).toBeGreaterThanOrEqual(38);
    expect(art.plusText).toBe('+');
    expect(art.plusTransform).not.toBe('none');
    await expect(page.locator('.custom-collection-detail__art')).toBeHidden();

    const bodyGeometry = await page.locator('.custom-collection-detail').evaluate(element => {
      const body = element.getBoundingClientRect();
      const tracks = element.querySelector('.custom-collection-detail__tracks').getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        leftOffset: Math.abs(tracks.left - body.left - parseFloat(style.paddingLeft)),
        rightOffset: Math.abs(body.right - tracks.right - parseFloat(style.paddingRight)),
      };
    });
    expect(bodyGeometry.leftOffset).toBeLessThanOrEqual(1);
    expect(bodyGeometry.rightOffset).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-cdt-column="rating"], [data-cdt-column="love"], [data-cdt-column="popularity"], [data-cdt-column="plays"]')).toHaveCount(0);
    const durationRightGap = await page.locator('.compact-data-table-row').evaluate((row) => {
      const table = row.closest('.compact-data-table').getBoundingClientRect();
      const duration = row.querySelector('[data-cdt-column="duration"]').getBoundingClientRect();
      return Math.abs(table.right - duration.right);
    });
    expect(durationRightGap).toBeLessThanOrEqual(16);
    if (viewport.width <= 700) {
      await expect(page.locator('[data-cdt-column="path"][role="cell"]')).toBeHidden();
      await expect(page.locator('[data-cdt-column="duration"][role="cell"]')).toBeVisible();
      expect(await page.locator('.custom-collection-detail__tracks').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    } else {
      await expect(page.locator('[data-cdt-column="path"][role="cell"]')).toBeVisible();
    }
  });
}
