// Isolated native Album renderer and production native presentation mount.
// Measures grid tracks/anchored edges, never equates intrinsic labels with tracks.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../..');
const fromRoot = createRequire(path.join(root, 'package.json'));
const {test, expect} = fromRoot('@playwright/test');
const {nativeDelivery}=require('./albumPlaytableNativeDelivery.cjs');

const pageErrors = new WeakMap();
test.afterEach(async ({page}) => {
  try {if (!page.isClosed()) await page.evaluate(() => {
    try {window.fixtureMount?.dispose();} finally {window.mount?.dispose?.();}
  });}
  finally {expect(pageErrors.get(page) || []).toEqual([]);}
});

async function mount(page, width) {
  const errors = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({width, height: 844});
  await page.route('https://albumhaven.test/**',nativeDelivery(root,'<!doctype html><html><body><main id="tracks"></main></body></html>',['albumPlaytableNativeEntry.mjs']));
  await page.goto('https://albumhaven.test/');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js', 'runtime/album-track-table.js']) {
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
  }
  const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
  const styles = new Set(['button-component.css', ...[...template.matchAll(/css\/([a-zA-Z0-9_\/-]+\.css)/g)].map(match => match[1])]);
  for (const file of styles) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
  await page.addStyleTag({content: 'body{margin:0;height:auto;overflow:auto}main{width:100%;min-width:0}'});
  await page.evaluate(()=>import('/__album_playtable_fixture__/albumPlaytableNativeEntry.mjs').then(()=>undefined));
  await page.evaluate(() => {
    const host = document.querySelector('#tracks');
    const config = {groups: [
      {discNumber: 1, tracks: [{rowKey: 'one', readable: true, title: 'A long synthetic Album title '.repeat(8),
        path: 'first', duration: '3:00', isCurrent: true, isPlaying: true}]},
      {discNumber: 2, tracks: [{rowKey: 'two', readable: true, title: 'Second disc fixture', path: 'second', duration: '3:00'}]},
    ], totalLength: '6m', mainLength: '3m', bonusLength: '3m'};
    host.innerHTML = buildAlbumTrackTableHtml(config);
    const source = {snapshot: () => ({scopeKey: 'fixture', instance: 'album', revision: 1,
      rows: [{rowKey: 'one', readable: true, selectable: true}, {rowKey: 'two', readable: true, selectable: true}]}), subscribe: () => () => {}};
    window.fixtureMount = mountGeometryFixture(host, {sourceAdapter: source,
      runtime: {buttonHtml: config => ButtonComponent.renderButton(config), actionHtml: config => ButtonComponent.renderActionButton(config)},
      tablePresentation: {columns: albumTrackTableColumns(config), resourceKey: 'album', source, isCurrent: () => true}});
  });
  return errors;
}

function settleGeometryFrames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function discGeometry(page) {
  return page.evaluate(() => ({page: document.documentElement.scrollWidth, viewport: innerWidth,
    tables: [...document.querySelectorAll('.compact-data-table')].map(table => ({
      width: table.clientWidth, scrollWidth: table.scrollWidth, height: table.clientHeight, scrollHeight: table.scrollHeight,
      rows: [...table.querySelectorAll('.compact-data-table-header,.compact-data-table-row')].map(row => ({
        grid: getComputedStyle(row).gridTemplateColumns,
        cells: Object.fromEntries(['title', 'love', 'duration'].map(key => {
          const bounds = row.querySelector(`[data-cdt-column="${key}"]`).getBoundingClientRect();
          return [key, {left: bounds.left, right: bounds.right}];
        })),
      })),
    })),
  }));
}

function decorationGeometry(finalTable) {
  return finalTable.evaluate(table => {
    const style = getComputedStyle(table, '::after');
    return {right: style.right, bottom: style.bottom, width: style.width, pointerEvents: style.pointerEvents,
      gradient: style.backgroundImage.includes('linear-gradient')};
  });
}

function retiredDecorationGeometry(finalTable) {
  return finalTable.evaluate(table => {
    const style = getComputedStyle(table, '::after'); return {right: style.right, bottom: style.bottom};
  });
}

module.exports = {test, expect, mount, settleGeometryFrames, discGeometry, decorationGeometry, retiredDecorationGeometry};
