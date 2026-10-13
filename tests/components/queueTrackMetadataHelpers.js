// Component regression only. Real browser/React/native renderers, isolated API
// responses. No Postgres, transport, full-app or end-to-end acceptance claim.
const path = require('node:path');
const {buildSync} = require('esbuild');
const {test, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const errors = new WeakMap();
const row = (page, id) => page.locator(`[data-queue-row="${id}"]`);
const love = (page, id) => row(page, id).locator('[data-track-love]');
async function mount(page, width = 390) {
  const failures = []; errors.set(page, failures); page.on('pageerror', error => failures.push(String(error)));
  await page.setViewportSize({width, height: 800});
  await page.setContent('<!doctype html><html><body><main id="fixture"></main><button id="outside">Outside</button></body></html>');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js']) {
    await page.addScriptTag({path: path.join(root, 'music_app/static/js', file)});
  }
  for (const file of ['button-component.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css']) {
    await page.addStyleTag({path: path.join(root, 'music_app/static/css', file)});
  }
  await page.addStyleTag({content: 'body{margin:0}main{width:100%;min-width:0}'});
  const bundle = buildSync({entryPoints: [path.join(__dirname, 'queueTrackMetadataFixture.jsx')], bundle: true,
    platform: 'browser', format: 'iife', write: false}).outputFiles[0].text;
  await page.addScriptTag({content: bundle});
  await expect(row(page, 'one')).toHaveCount(1);
}
test.afterEach(async ({page}) => {expect(errors.get(page) || [], 'Browser runtime errors').toEqual([]);});
const loveCalls = page => page.evaluate(() => queueFixture.calls.love.map(call => ({id: call.row.id, tier: call.love_tier, aborted: call.signal.aborted})));
const choose = (page, key) => page.evaluate(key => queueFixture.calls.choices.at(-1).config.onSelect(key), key);

function waitForQueueLove(page) {
  return expect.poll(() => loveCalls(page)).toHaveLength(1);
}

function rejectQueueLoveAndDrain(page) {
  return page.evaluate(async () => {queueFixture.reject(0); await Promise.resolve(); await Promise.resolve();});
}

function waitForQueueClear(page) {
  return expect.poll(() => page.evaluate(() => queueFixture.calls.clears)).toEqual([['two', 'other', 'missing']]);
}

function visibleQueueColumns(page) {
  return row(page, 'one').locator('[data-cdt-column]').evaluateAll(cells => cells.filter(cell => getComputedStyle(cell).display !== 'none').map(cell => cell.dataset.cdtColumn));
}

function projectedQueueColumns(page) {
  return page.locator('[data-cdt-column]').evaluateAll(cells => [...new Set(cells.map(cell => cell.dataset.cdtColumn))]);
}

function bodyFits(page) {
  return page.evaluate(() => document.body.scrollWidth <= innerWidth);
}

module.exports = {test, expect, row, love, mount, loveCalls, choose, waitForQueueLove, rejectQueueLoveAndDrain, waitForQueueClear, visibleQueueColumns, projectedQueueColumns, bodyFits};
