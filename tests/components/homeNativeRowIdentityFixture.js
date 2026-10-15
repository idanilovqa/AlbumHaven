const fs = require('node:fs');
const path = require('node:path');
const {nativeDelivery} = require('./homeQueueNativeDelivery.cjs');
const {test, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
async function mount(page) {
  const html = '<!doctype html><html><body><div id="fixture"></div><button id="outside">Outside target</button></body></html>';
  await page.route('https://albumhaven.test/**', nativeDelivery(root, html, ['homeNativeRowIdentityEntry.mjs']));
  await page.goto('https://albumhaven.test/');
  const template = fs.readFileSync(path.join(root, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  await page.evaluate(text => {const node=document.createElement('script');node.id='navigation-tree-item-template';node.type='text/plain';node.textContent=text;document.body.append(node);}, template);
  for (const file of ['button-component.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/album-artbox.js','navigation-tree.js']) {
    await page.addScriptTag({path:path.join(root,'music_app/static/js',file)});
  }
  for (const file of ['button-component.css','navigation-tree.css','runtime/home-friends.css','runtime/home-detail-projection.css']) {
    await page.addStyleTag({path:path.join(root,'music_app/static/css',file)});
  }
  await page.evaluate(() => {window.homeFixtureReady = import('/__home_queue_fixture__/homeNativeRowIdentityEntry.mjs'); return window.homeFixtureReady.then(() => undefined);});
  await expect(page.locator('[data-home-artist-select]')).toHaveCount(1);
  await expect(page.locator('[data-home-person-row]')).toHaveCount(1);
}
const settleFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

module.exports = {test, expect, mount, settleFrames};
