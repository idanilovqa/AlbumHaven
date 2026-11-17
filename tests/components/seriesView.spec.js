// MusicBrainz Delivery 2, S6: the approved Series pieces render as the round-2 mockups do.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '../..');
const staticRoot = path.join(repoRoot, 'music_app/static');

async function loadAlbumDetailsComponents(page) {
  await page.addScriptTag({ content: 'window.escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));' });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
  for (const file of ['gallery-main-components.js', 'alert-components.js', 'album-details-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  for (const css of ['css/runtime/non-album-and-player.css', 'css/runtime/album-details-components.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, css) });
  }
}

const ALBUM = { musicbrainz_series: [{ mbid: '520f6fcd-251d-46cd-83a9-0bc725d42333', name: 'Colossus Projects' }] };

test('1B: web album details show "Series: <name>" on one line under the cover; the name links to its gallery', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent('<div id="track-modal"><div id="track-modal-cover" style="width:280px"><div class="cover" style="height:280px"></div></div><div id="track-modal-list"></div></div>');
  await loadAlbumDetailsComponents(page);
  await page.evaluate((album) => syncAlbumDetailsSeries(album, {
    cover: document.getElementById('track-modal-cover'), list: document.getElementById('track-modal-list'), mobile: false,
  }), ALBUM);
  const block = page.locator('#track-modal-cover > [data-album-details-series="series"]');
  await expect(block).toBeVisible();
  await expect(block).toHaveText('Series: Colossus Projects');
  await expect(block.locator('.section-split-label')).toHaveCount(0);
  const link = block.getByRole('button', { name: 'Colossus Projects' });
  await expect(link).toHaveAttribute('title', 'Show all albums in this series');
  await expect(link).toHaveAttribute('data-open-series', '520f6fcd-251d-46cd-83a9-0bc725d42333');
  const cover = await page.locator('#track-modal-cover .cover').boundingBox();
  const label = await block.locator('.album-details-series__label').boundingBox();
  const linkBox = await link.boundingBox();
  // One line under the cover: the label and its link share a line.
  expect(label.y).toBeGreaterThanOrEqual(cover.y + cover.height + 14 - 1);
  expect(Math.abs((linkBox.y + linkBox.height / 2) - (label.y + label.height / 2))).toBeLessThanOrEqual(2);
  expect(linkBox.x).toBeGreaterThan(label.x + label.width);
});

test('web album details wrap several series left-aligned under the first name, never clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent('<div id="track-modal"><div id="track-modal-cover" style="width:280px"><div class="cover" style="height:280px"></div></div><div id="track-modal-list"></div></div>');
  await loadAlbumDetailsComponents(page);
  const names = ['Colossus Projects', 'Rolling Stone: The 100 Greatest Metal Albums of All Time', 'Spirit of the Seventies', 'Kalevala Collection'];
  await page.evaluate((list) => syncAlbumDetailsSeries({ musicbrainz_series: list.map((name, index) => ({
    mbid: `00000000-0000-4000-8000-00000000000${index}`, name, kind: index === 1 ? 'featured_in' : 'series' })) }, {
    cover: document.getElementById('track-modal-cover'), list: document.getElementById('track-modal-list'), mobile: false,
  }), names);
  for (const [kind, label] of [['series', 'Series:'], ['featured_in', 'Featured In:']]) {
    const block = page.locator(`[data-album-details-series="${kind}"]`);
    await expect(block.locator('.album-details-series__label')).toHaveText(label);
    const geometry = await block.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const label = element.querySelector('.album-details-series__label').getBoundingClientRect();
      const lines = [...element.querySelectorAll('.album-details-series__link')]
        .flatMap((link) => [...link.getClientRects()]).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top }));
      return { box: { left: box.left, right: box.right }, label: { left: label.left, top: label.top },
        lines, clipped: element.scrollWidth > element.clientWidth };
    });
    // The first line starts with the label; the names never start under it.
    expect(Math.abs(geometry.label.left - geometry.box.left)).toBeLessThanOrEqual(1);
    const first = geometry.lines[0];
    expect(first.left).toBeGreaterThan(geometry.label.left);
    expect(Math.abs(first.top - geometry.label.top)).toBeLessThanOrEqual(3);
    // Every wrapped line starts at the first name's left edge.
    const wrapped = geometry.lines.filter((line) => line.top > first.top + 1);
    // Three series names cannot share one line in the cover column.
    if (kind === 'series') expect(wrapped.length).toBeGreaterThan(0);
    for (const line of wrapped) expect(Math.abs(line.left - first.left)).toBeLessThanOrEqual(1);
    // Nothing overflows the block or is clipped.
    expect(geometry.clipped).toBe(false);
    for (const line of geometry.lines) expect(line.right).toBeLessThanOrEqual(geometry.box.right + 0.5);
  }
});

test('4A: on a phone the SERIES block follows the track table, and an album of no series shows none', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<div id="track-modal"><div id="track-modal-cover"></div><div id="track-modal-list"><table><tr><td>Track</td></tr></table></div></div>');
  await loadAlbumDetailsComponents(page);
  const place = (album) => page.evaluate((value) => syncAlbumDetailsSeries(value, {
    cover: document.getElementById('track-modal-cover'), list: document.getElementById('track-modal-list'), mobile: true,
  }), album);
  await place(ALBUM);
  await expect(page.locator('#track-modal-list + [data-album-details-series]')).toBeVisible();
  await expect(page.locator('#track-modal-cover [data-album-details-series]')).toHaveCount(0);
  await place({});
  await expect(page.locator('[data-album-details-series]')).toHaveCount(0);
});

test('3A: the folded sidebar stacks the Series button directly below the Artist Tree button', async ({ page }) => {
  const template = fs.readFileSync(path.join(repoRoot, 'music_app/templates/index.html'), 'utf8');
  const icon = (id) => template.slice(template.indexOf(`id='${id}'`)).match(/<svg[\s\S]*?<\/svg>/)[0];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<aside class="sidebar shell-navigation-rail is-folded" style="width:64px"><nav class="shell-navigation-compact" id="shell-navigation-compact">
    <button class="action-button shell-navigation-compact-action" id="artist-tree-navigation-button" aria-label="Artist Tree">${icon('artist-tree-navigation-button')}</button>
    <button class="action-button shell-navigation-compact-action" id="series-tree-navigation-button" aria-label="Series">${icon('series-tree-navigation-button')}</button>
  </nav></aside>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/app-chrome.css') });
  const tree = await page.locator('#artist-tree-navigation-button').boundingBox();
  const series = await page.locator('#series-tree-navigation-button').boundingBox();
  expect(series.y).toBeGreaterThanOrEqual(tree.y + tree.height);
  expect(Math.abs((series.x + series.width / 2) - (tree.x + tree.width / 2))).toBeLessThanOrEqual(1);
  const svg = await page.locator('#series-tree-navigation-button svg').boundingBox();
  expect(svg.width).toBeGreaterThan(0);
  await expect(page.locator('#series-tree-navigation-button svg rect')).toHaveCount(3);
});

// Owner 2026-11-17: 4B (two groups under collapsible headings, no "All…" rows) and 5B (the
// tree's right-click menu marks a series).
const TREE = [
  { mbid: '520f6fcd-251d-46cd-83a9-0bc725d42333', name: 'Colossus project', count: 10, kind: 'series', owner_kind: null },
  { mbid: '00000000-0000-4000-8000-0000000001b1', name: 'Dream Theater Official Bootlegs', count: 3, kind: 'series', owner_kind: null },
  { mbid: 'd5471f85-4b54-45da-9de7-c9ad9843c4bd', name: '1001 Albums You Must Hear Before You Die', count: 6, kind: 'featured_in', owner_kind: null },
  { mbid: '00000000-0000-4000-8000-0000000001b2', name: 'Pitchfork: 10/10', count: 6, kind: 'featured_in', owner_kind: 'featured_in' },
];

async function loadSeriesTree(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const template = fs.readFileSync(path.join(repoRoot, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  await page.setContent(`<aside class="sidebar shell-navigation-rail" style="width:240px"><div id="sidebar-list" class="artist-list"></div></aside>
    <script id="navigation-tree-item-template" type="text/plain">${template}</script>`);
  await page.addScriptTag({ content: 'window.escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c])); window.state = { view: {}, ui: {} };' });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/navigation-tree.js') });
  for (const file of ['view-state-helpers.js', 'browser-navigation-helpers.js', 'view-value-helpers.js', 'markup-format-helpers.js',
    'render-markup-helpers.js', 'modal-and-overlay-helpers.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  for (const css of ['css/runtime/base-layout.css', 'css/navigation-tree.css', 'css/app-chrome.css', 'css/modals.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, css) });
  }
  const render = (collapsed) => page.evaluate(({ tree, groups }) => {
    document.getElementById('sidebar-list').innerHTML = buildSeriesSidebarHtml(
      { selected_series: tree[2].mbid, series_sidebar: tree }, groups);
  }, { tree: TREE, groups: collapsed });
  return render;
}

test('4B: the Series tree shows Series then Featured In under dimmed collapsible headings, never "All" rows', async ({ page }) => {
  const render = await loadSeriesTree(page);
  await render({});
  const list = page.locator('#sidebar-list');
  await expect(list.locator('.artist-name-label')).toHaveText(['Series', 'Colossus project', 'Dream Theater Official Bootlegs',
    'Featured In', '1001 Albums You Must Hear Before You Die', 'Pitchfork: 10/10']);
  await expect(list).not.toContainText('All series');
  await expect(list).not.toContainText('All Featured In');
  const headings = list.locator('button[data-series-tree-group]');
  await expect(headings).toHaveCount(2);
  for (const index of [0, 1]) await expect(headings.nth(index)).toHaveAttribute('aria-expanded', 'true');
  await expect(headings.locator('.navigation-tree-count')).toHaveCount(0);
  await expect(list.locator('[aria-current="true"]')).toHaveText(/1001 Albums/);
  // Headings are dimmed beside the series rows, and start at the rows' left edge.
  const heading = await headings.first().evaluate((element) => ({ color: getComputedStyle(element).color, left: element.getBoundingClientRect().left }));
  const row = await list.locator('a[data-sidebar-series]').first().evaluate((element) => ({ color: getComputedStyle(element).color, left: element.getBoundingClientRect().left }));
  expect(heading.color).not.toBe(row.color);
  expect(Math.abs(heading.left - row.left)).toBeLessThanOrEqual(1);
  // Without the NavigationTree separator nothing stands between the groups.
  await expect(list.locator('[role="separator"]')).toHaveCount(0);

  // A collapsed group keeps its heading and hides its series.
  await render({ series: true, featured_in: false });
  await expect(list.locator('.artist-name-label')).toHaveText(['Series', 'Featured In', '1001 Albums You Must Hear Before You Die', 'Pitchfork: 10/10']);
  await expect(list.locator('[data-series-tree-group="series"]')).toHaveAttribute('aria-expanded', 'false');

  // Where NavigationTree draws a separator, it sits between the last series and Featured In.
  await page.evaluate(() => { window.NavigationTree.renderSeparator = () => '<div role="separator" style="height:1px"></div>'; });
  await render({});
  const lastSeries = await list.locator('a[data-sidebar-series]').nth(1).boundingBox();
  const separator = await list.locator('[role="separator"]').boundingBox();
  const featured = await list.locator('[data-series-tree-group="featured_in"]').boundingBox();
  expect(separator.y).toBeGreaterThanOrEqual(lastSeries.y + lastSeries.height);
  expect(featured.y).toBeGreaterThanOrEqual(separator.y + separator.height);
});

test('5B: a series menu offers Mark as Series and Mark as Featured In, the current kind disabled, never Hidden', async ({ page }) => {
  await loadSeriesTree(page);
  // The Series tree's rows come from /series-tree (state.ui.seriesTree) while no series is open.
  await page.evaluate((tree) => { state.ui.seriesTree = tree; showSeriesTreeContextMenu(120, 300, tree[0].mbid); }, TREE);
  const menu = page.locator('#artist-tree-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button')).toHaveText(['Mark as Series', 'Mark as Featured In']);
  await expect(menu.getByRole('button', { name: 'Mark as Series', exact: true })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Mark as Featured In', exact: true })).toBeEnabled();
  await expect(menu).not.toContainText(/Hidden|Hide/);
  // The tree's menu is the app's dark anchored menu, at the pointer.
  const box = await menu.boundingBox();
  expect(Math.abs(box.x - 120)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - 300)).toBeLessThanOrEqual(1);
  // An owner's choice brings the MusicBrainz default back.
  await page.evaluate((tree) => showSeriesTreeContextMenu(120, 300, tree[3].mbid), TREE);
  await expect(menu.getByRole('button')).toHaveText(['Mark as Series', 'Mark as Featured In', 'Use MusicBrainz default']);
  await expect(menu.getByRole('button', { name: 'Mark as Featured In', exact: true })).toBeDisabled();
});

test('owner 2026-11-17: the Series button switches only the tree; the gallery header, URL and history stay and no row is selected', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const template = fs.readFileSync(path.join(repoRoot, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  const index = fs.readFileSync(path.join(repoRoot, 'music_app/templates/index.html'), 'utf8');
  const foldArrow = index.slice(index.indexOf("id='artist-tree-fold-button'")).match(/<svg[\s\S]*?<\/svg>/)[0];
  await page.setContent(`<div id="app-shell"><aside id="shell-navigation-rail" class="sidebar shell-navigation-rail" style="width:240px">
      <div id="artist-tree-expanded"><button id="artist-tree-fold-button" class="action-button shell-navigation-rail-toggle" aria-label="Collapse Artist Tree">${foldArrow}</button>
      <h2 class="desktop-artists-heading">Artists</h2>
      <div id="sidebar-list" class="artist-list navigation-tree"></div></div>
      <nav id="shell-navigation-compact" hidden><button id="artist-tree-navigation-button"></button></nav></aside>
    <main><div data-gallery-bar-instance="gallery"><h1 class="gallery-bar__name">Magma</h1></div></main></div>
    <script id="navigation-tree-item-template" type="text/plain">${template}</script>`);
  await page.addScriptTag({ content: `window.escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
    window.state = { view: { selected_artist: 'Magma', selected_series: '', visible_library_categories: ['main_library'] },
      ui: { artistTreeFolded: false, shellLayoutPreferences: {} } };` });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/navigation-tree.js') });
  for (const file of ['view-state-helpers.js', 'browser-navigation-helpers.js', 'view-value-helpers.js', 'markup-format-helpers.js',
    'render-markup-helpers.js', 'shell-navigation-drawer.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  for (const css of ['css/runtime/base-layout.css', 'css/navigation-tree.css', 'css/app-chrome.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, css) });
  }
  // The artist tree as the runtime draws it; the Series tree from the real builder.
  await page.evaluate((tree) => {
    window.__fetched = [];
    window.fetch = async (url) => { window.__fetched.push(String(url)); return { ok: true, json: async () => ({ series_sidebar: tree }) }; };
  }, TREE);
  await page.addScriptTag({ content: `window.fetchAndRender = () => { window.__navigated = true; };
    window.renderSidebar = () => { document.getElementById('sidebar-list').innerHTML = showsSeriesTree()
      ? buildSeriesSidebarHtml(state.view)
      : NavigationTree.renderItem({ label: 'Magma', key: 'artist:Magma', selected: state.view.selected_artist === 'Magma',
          attributes: { 'data-sidebar-artist': 'Magma', 'data-nav': '1' } }); };
    renderSidebar();` });
  const before = await page.evaluate(() => ({ href: location.href, length: history.length }));
  const header = page.locator('[data-gallery-bar-instance="gallery"] .gallery-bar__name');

  await page.evaluate(() => openNavigationTree('series'));
  const list = page.locator('#sidebar-list');
  await expect(list.locator('.artist-name-label')).toHaveText(['Series', 'Colossus project', 'Dream Theater Official Bootlegs',
    'Featured In', '1001 Albums You Must Hear Before You Die', 'Pitchfork: 10/10']);
  await expect(header).toHaveText('Magma');
  await expect(list.locator('[aria-current], .is-selected')).toHaveCount(0);
  // Each heading carries the artist tree's fold arrow, pointing down while its group is open.
  const arrows = list.locator('.navigation-tree-group-heading__chevron svg');
  await expect(arrows).toHaveCount(2);
  expect(await arrows.first().evaluate((svg) => getComputedStyle(svg).transform)).not.toBe('none');

  await page.evaluate(() => openNavigationTree('artists'));
  await expect(list.locator('.artist-name-label')).toHaveText(['Magma']);
  await expect(header).toHaveText('Magma');
  expect(await page.evaluate(() => ({ href: location.href, length: history.length }))).toEqual(before);
  expect(await page.evaluate(() => window.__navigated === true)).toBe(false);
  // Only the tree was read; never a gallery.
  expect(await page.evaluate(() => window.__fetched)).toEqual(['/series-tree?category=main_library']);
});
