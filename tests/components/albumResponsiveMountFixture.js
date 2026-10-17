// Native Album renderer + existing production native mount, isolated component
// DTOs only. This is not mobile navigation, production authority or app E2E.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../..');
const fromRoot = createRequire(path.join(root, 'package.json'));
const {test, expect} = fromRoot('@playwright/test');
const {nativeDelivery}=require('./albumPlaytableNativeDelivery.cjs');
const errors = new WeakMap();
test.afterEach(async ({page}) => {
  try {if (!page.isClosed()) await page.evaluate(async () => {
    try {window.fixtureMount?.dispose();}
    finally {window.resolveFixtureWrite?.(null); await Promise.resolve();}
  });}
  finally {expect(errors.get(page) || []).toEqual([]);}
});

async function mount(page, width = 390, subject = true) {
  await page.setViewportSize({width, height: 844});
  const seen = []; errors.set(page, seen); page.on('pageerror', error => seen.push(String(error)));
  await page.route('https://albumhaven.test/**',nativeDelivery(root,'<!doctype html><html><head></head><body><main><div id="table-host"></div></main></body></html>',['albumPlaytableNativeEntry.mjs']));
  await page.goto('https://albumhaven.test/');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js',
    'runtime/alert-components.js', 'runtime/album-artbox.js', 'runtime/gallery-main-components.js',
    'runtime/gallery-card-component.js', 'runtime/album-details-components.js', 'runtime/compact-data-table.js',
    'runtime/album-track-table.js']) {
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
  }
  const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
  const styles = new Set(['button-component.css', ...[...template.matchAll(/css\/([a-zA-Z0-9_\/-]+\.css)/g)].map(match => match[1])]);
  for (const file of styles) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
  await page.addStyleTag({content: 'body{margin:0;height:auto;overflow:auto}main{width:100%;min-width:0}'});
  await page.evaluate(()=>import('/__album_playtable_fixture__/albumPlaytableNativeEntry.mjs').then(()=>undefined));
  await page.evaluate(subjectTaste => {
    window.fixtureCalls = {choices: [], closed: 0, played: 0, selected: 0};
    window.fixtureCurrent = true;
    window.fixtureRuntime = {
      buttonHtml: config => ButtonComponent.renderButton(config),
      actionHtml: config => ButtonComponent.renderActionButton(config),
      iconHtml: (name, options) => ButtonComponent.renderIconSvg(name, options), escapeHtml,
      openChoice(anchor, config) {
        fixtureCalls.choices.push({anchor, config});
        return {isOpen: true, close() {fixtureCalls.closed++;}};
      },
    };
    window.fixtureConfig = {subjectTaste, selection: 'multiple', showPath: true, groups: [
      {discNumber: 1, tracks: [
        {rowKey: 'first', readable: true, title: 'A very long native album title that should retain useful space '.repeat(3),
          path: 'synthetic-first.flac', displayPath: 'synthetic-fixture/first.flac', trackNumber: 1,
          duration: '1:20 / 13:04', isCurrent: true, isPlaying: true, isProblematic: true,
          subjectTasteState: 'available', subjectRating: null, subjectLove: 'loved'},
        {rowKey: 'second', readable: true, title: 'Positive subject rating', path: 'synthetic-second.flac',
          duration: '3:00', subjectTasteState: 'available', subjectRating: 4, subjectLove: 'off'},
      ]},
      {discNumber: 2, isBonus: true, discLabel: 'Bonus Disc', tracks: [
        {rowKey: 'third', readable: true, title: 'Unavailable taste and media', path: 'synthetic-third.flac',
          availability: 'missing', canPlay: false, duration: '22:30', subjectTasteState: 'unavailable'},
      ]},
    ], totalLength: '38m 34s', mainLength: '16m 4s', bonusLength: '22m 30s'};
    window.fixtureHost = document.querySelector('#table-host');
    fixtureHost.innerHTML = buildAlbumTrackTableHtml(fixtureConfig);
    window.fixtureRows = fixtureConfig.groups.flatMap(group => group.tracks.map(track => ({
      rowKey: track.rowKey, readable: true, selectable: true,
    })));
    window.fixtureSource = {snapshot: () => fixtureCurrent ? {scopeKey: 'component', instance: 'album-A', revision: 1, rows: fixtureRows} : null,
      subscribe: () => () => {}};
    window.fixturePresentation = {columns: albumTrackTableColumns(fixtureConfig), resourceKey: 'album-A', source: {}, isCurrent: () => fixtureCurrent};
    window.fixtureMount = mountAlbumSelectionFixture(fixtureHost, {
      runtime: fixtureRuntime, sourceAdapter: fixtureSource, tableKey: 'album-tracks',
      tablePresentation: fixturePresentation,
      onPlay: () => fixtureCalls.played++, onSelectionChange: () => fixtureCalls.selected++,
    });
  }, subject);
  await expect(page.locator('[data-track-table-columns]')).toHaveCount(1);
  await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(2);
}
async function choose(page, key) {
  await page.locator('[data-track-table-columns]').click();
  await page.evaluate(key => {
    const menu = fixtureCalls.choices.at(-1)?.config;
    if (!menu?.formats.some(item => item.value === key)) throw new Error(`Missing column choice ${key}`);
    menu.onSelect(key);
  }, key);
}
async function bounds(page) {
  return page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
    tables: [...document.querySelectorAll('.compact-data-table')].map(table => ({
      scroll: table.scrollWidth, client: table.clientWidth,
      rows: [...table.querySelectorAll('.compact-data-table-header,.compact-data-table-row')].map(row => ({
        grid: getComputedStyle(row).gridTemplateColumns,
        cells: [...row.querySelectorAll(':scope > [data-cdt-column]')].filter(cell => getComputedStyle(cell).display !== 'none').map(cell => {
          const box = cell.getBoundingClientRect(); return {key: cell.dataset.cdtColumn, x: box.x, right: box.right, width: box.width};
        }),
      })),
    })),
  }));
}
function assertAligned(result) {
  expect(result.pageWidth).toBeLessThanOrEqual(result.viewport);
  const header = result.tables[0].rows[0];
  for (const table of result.tables) {
    expect(table.client).toBe(result.tables[0].client);
    for (const row of table.rows) {
      expect(row.grid).toBe(header.grid);
      expect(row.cells.map(cell => cell.key)).toEqual(header.cells.map(cell => cell.key));
      row.cells.forEach((cell, index) => {
        const heading = header.cells[index];
        // Number headings intentionally use a 28px label inside a 36px track;
        // action cells such as Length right-align intrinsic content. Compare
        // actual track plans and the appropriate anchored edges, not text width.
        if (['duration', 'problem'].includes(cell.key)) {
          expect(Math.abs(cell.right - heading.right)).toBeLessThanOrEqual(1);
        } else {
          expect(Math.abs(cell.x - heading.x)).toBeLessThanOrEqual(1);
          if (cell.key !== 'number') expect(Math.abs(cell.right - heading.right)).toBeLessThanOrEqual(1);
        }
      });
    }
  }
  expect(header.cells.map(cell => cell.key)).toEqual(expect.arrayContaining(['number', 'title', 'love', 'duration']));
  expect(header.cells.find(cell => cell.key === 'title').width).toBeGreaterThanOrEqual(100);
}

function waitForAlbumPress(page) {
  return page.waitForTimeout(650);
}

async function refreshAlbumRows(page) {
  await page.evaluate(() => {
    window.staleMenu = fixtureCalls.choices.at(-1).config;
    fixtureHost.innerHTML = buildAlbumTrackTableHtml(fixtureConfig);
    fixturePresentation = {...fixturePresentation, source: {revision: 2}};
    fixtureMount.update({tablePresentation: fixturePresentation});
  });
}

function rehostAlbum(page) {
  return page.evaluate(() => {
    const next = document.createElement('section'); document.querySelector('main').append(next); next.append(fixtureHost);
  });
}

module.exports = {test, expect, mount, choose, bounds, assertAligned, waitForAlbumPress, refreshAlbumRows, rehostAlbum};
