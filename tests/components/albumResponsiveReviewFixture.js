// Additive review regressions using the real native owner and React mount.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../..');
const fromRoot = createRequire(path.join(root, 'package.json'));
const {test, expect} = fromRoot('@playwright/test');
const bundle = fromRoot('esbuild').buildSync({stdin: {contents: `
  import {mountPlaytableSelection} from './music_app/static/js/playtables/selection.jsx';
  window.AlbumHavenPlaytableUI = {mount: mountPlaytableSelection};
`, resolveDir: root, loader: 'jsx'}, bundle: true, write: false, platform: 'browser', format: 'iife'}).outputFiles[0].text;
const read = file => fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8');
async function setup(page) {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({width: 390, height: 844});
  await page.setContent('<!doctype html><html><body><main><div id="track-modal"><div id="tracks"></div></div></main></body></html>');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js', 'runtime/album-track-table.js']) await page.addScriptTag({content: read(file)});
  for (const file of ['button-component.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css']) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
  await page.addStyleTag({content: 'body{margin:0;font:14px Arial}main{width:100%;min-width:0}*{box-sizing:border-box}'});
  await page.addScriptTag({content: bundle});
  return errors;
}

async function mountButtonOnlyRuntime(page) {
  await page.evaluate(() => {
    const host = document.querySelector('#tracks');
    const config = {groups: [{tracks: [{rowKey: 'one', readable: true, title: 'Native fixture', duration: '3:00'}]}]};
    host.innerHTML = buildAlbumTrackTableHtml(config);
    const sourceAdapter = {snapshot: () => ({scopeKey: 'fixture', instance: 'A', revision: 1,
      rows: [{rowKey: 'one', readable: true, selectable: true}]}), subscribe: () => () => {}};
    window.mount = AlbumHavenPlaytableUI.mount(host, {sourceAdapter,
      runtime: {buttonHtml: options => ButtonComponent.renderButton(options)},
      tablePresentation: {columns: albumTrackTableColumns(config), resourceKey: 'A', source: {}, isCurrent: () => true}});
  });
}

async function mountNativePlayback(page) {
  await page.addScriptTag({content: `
    var state = {view: {}, player: {current: null}};
    const fixtureScope = {};
    const TrackActionsRuntime = {scope: () => ({token: fixtureScope}), subscribePreferences: () => () => {}};
    window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'fixture'})};
    function getTrackModalPreferenceSource() {return null;}
    function getPlayerPlaybackSnapshot() {return {currentTime: 3723, duration: 4319, paused: false, ended: false};}
    function formatTrackDuration(seconds) {return seconds === 3723 ? '1:02:03' : '1:11:59';}
    function showToast() {}
  `});
  await page.addScriptTag({content: read('runtime/playtable-source.js')});
  // Load this production function verbatim, without unrelated modal setup.
  const source = read('runtime/tag-editor-and-optimistic-updates.js');
  const start = source.indexOf('function refreshTrackModalPlaybackState()');
  const end = source.indexOf('function refreshNonAlbumModalPlaybackState()', start);
  if (start < 0 || end < start) throw new Error('Production playback refresh seam was not found');
  await page.addScriptTag({content: source.slice(start, end)});
  await page.evaluate(() => {
    window.fixtureGroups = [
      {discNumber: 1, tracks: [{title: 'First fixture', path: 'first', duration: '3:00'}]},
      {discNumber: 2, tracks: [{title: 'Second fixture', path: 'second', duration: '3:00'}]},
    ];
    const config = {groups: fixtureGroups, selection: 'multiple'};
    NativePlaytables.prepare('album-tracks', {}, fixtureGroups,
      [{inventory_track_ref: 'inventory-track:1:1'}, {inventory_track_ref: 'inventory-track:1:2'}],
      () => true, undefined, {columns: albumTrackTableColumns(config)});
    const host = document.querySelector('#tracks'); host.innerHTML = buildAlbumTrackTableHtml(config);
    NativePlaytables.mount('album-tracks', host);
  });
}

function settlePlaybackFrames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function waitForUnclippedPlayback(page) {
  return expect.poll(() => page.locator('[data-track-duration-path="first"]').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return range.getBoundingClientRect().right <= element.closest('[data-cdt-column]').getBoundingClientRect().right + 1;
  })).toBe(true);
}

function durationWidths(page) {
  return page.locator('[role="cell"][data-cdt-column="duration"]').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
}

function documentWidth(page) {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

module.exports = {test, expect, setup, mountButtonOnlyRuntime, mountNativePlayback, settlePlaybackFrames, waitForUnclippedPlayback, durationWidths, documentWidth};
