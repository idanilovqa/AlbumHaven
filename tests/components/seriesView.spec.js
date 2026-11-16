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
