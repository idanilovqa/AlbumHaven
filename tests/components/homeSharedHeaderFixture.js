const path = require('node:path');
const {nativeDelivery} = require('./homeQueueNativeDelivery.cjs');
const {test, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const shared = '[data-shared-header="fixture"]';
const tools = page => page.locator(`${shared} [data-header-tools]`).locator('button').or(page.locator(`${shared} button[data-header-tools]`));
// Isolated actual-native-owner fixture. This neither boots the server
// application nor substitutes its configuration, authentication, or providers.
async function mount(page, width = 370, finalOrder = ['collapse']) {
  await page.setViewportSize({width, height: 700});
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="home-friends"><div id="fixture"></div></main><button id="outside">Outside target</button></body></html>';
  await page.route('https://albumhaven.test/**', nativeDelivery(root, html, ['homeSharedHeaderEntry.mjs', 'homeNativeWrappersEntry.mjs']));
  await page.goto('https://albumhaven.test/');
  for (const file of ['button-component.css', 'choice-component.css', 'gallery-main.css', 'runtime/trigger-anchor.css', 'runtime/home-friends.css', 'runtime/home-profile.css']) {
    await page.addStyleTag({path: path.join(root, 'music_app/static/css', file)});
  }
  await page.addStyleTag({content: 'body{margin:0;font:14px system-ui;--text:#111;--muted:#555;--border:#aaa;--panel:#fff;--appearance-card:#fff;--appearance-ink:#111} #fixture{width:100%;}'});
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js', 'runtime/alert-components.js', 'runtime/album-artbox.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js']) {
    await page.addScriptTag({path: path.join(root, 'music_app/static/js', file)});
  }
  await page.evaluate(order => {window.fixtureFinalOrder = order;}, finalOrder);
  await page.evaluate(() => {window.homeFixtureReady = import('/__home_queue_fixture__/homeSharedHeaderEntry.mjs'); return window.homeFixtureReady.then(() => undefined);});
  await expect(page.locator(shared)).toHaveCount(1);
}
async function compact(page) {
  await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'true');
  await expect(tools(page)).toBeVisible();
}
async function open(page) {await compact(page); await tools(page).click(); await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');}

function waitForResetCall(page) {
  return expect.poll(() => page.evaluate(() => window.fixtureCalls)).toContain('reset:0');
}

function waitForOnlyResetCall(page) {
  return expect.poll(() => page.evaluate(() => window.fixtureCalls)).toEqual(['reset:0']);
}

function actionBoxes(page) {
  return Promise.all(['Reset', 'Missing', 'View', 'Collapse'].map(name => page.getByRole('button', {name, exact: true}).boundingBox()));
}

function expandBounds(page) {
  return page.getByRole('button', {name: 'Full size', exact: true}).boundingBox();
}

function resetBounds(page) {
  return page.getByRole('button', {name: 'Reset', exact: true}).boundingBox();
}

function headerBounds(page) {
  return page.locator(shared).boundingBox();
}

async function assertTailOrder(page, names) {
      const tail = await Promise.all(names.map(name => page.getByRole('button', {name, exact: true}).boundingBox()));
      for (let index = 1; index < tail.length; index++) expect(tail[index].x).toBeGreaterThanOrEqual(tail[index - 1].x + tail[index - 1].width);
      const last = tail.at(-1);
      for (const name of ['Reset', 'Missing']) {
        const box = await page.getByRole('button', {name, exact: true}).boundingBox();
        expect(last.x + last.width).toBeGreaterThanOrEqual(box.x + box.width);
      }
}

function waitForVisibleHeaderFocus(page) {
  return expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active?.matches('button') && active.closest('[data-shared-header="fixture"]')
      && !active.disabled && active.getAttribute('aria-disabled') !== 'true'
      && !active.closest('[hidden], [inert], [aria-hidden="true"]')
      && active.getClientRects().length && getComputedStyle(active).visibility !== 'hidden');
  })).toBe(true);
}

function waitForReachablePanel(page, panel, obstructed) {
  return expect.poll(async () => {
    const box = await panel.boundingBox();
    const limit = obstructed ? (await page.locator('.global-player').boundingBox()).y : 320;
    return Boolean(box && box.y >= 0 && box.y + box.height <= limit && box.x >= 0 && box.x + box.width <= 370);
  }).toBe(true);
}

function waitForPanelGutters(page, panel) {
  return expect.poll(async()=> {
    const box=await panel.boundingBox(), width=await page.evaluate(()=>document.documentElement.clientWidth);
    return Boolean(box && box.x>=8 && box.x+box.width<=width-8);
  }).toBe(true);
}

function viewportWidths(page) {
  return page.evaluate(() => ({innerWidth:window.innerWidth,clientWidth:document.documentElement.clientWidth}));
}

function panelBounds(panel) {
  return panel.boundingBox();
}

function placeLowerHeader(page, obstructed) {
  return page.addStyleTag({content: `main.home-friends {margin-top:${obstructed ? 95 : 190}px}`});
}

function addDocumentScrollbar(page) {
  return page.addStyleTag({content: 'html{overflow-y:scroll;scrollbar-gutter:stable}body{min-height:1400px}#fixture{width:370px;max-width:100%}'});
}

async function mountNativeWrappers(page) {
  for (const file of ['runtime/in-page-tabs.js', 'unfolding-action-button.js']) {
    await page.addScriptTag({path: path.join(root, 'music_app/static/js', file)});
  }
  await page.addStyleTag({path: path.join(root, 'music_app/static/css/unfolding-action-button.css')});
  await page.evaluate(() => {window.wrapperFixtureReady = import('/__home_queue_fixture__/homeNativeWrappersEntry.mjs'); return window.wrapperFixtureReady.then(() => undefined);});
}

function mountPlayerObstruction(page) {
  return page.evaluate(() => {
    const player = document.createElement('aside'); player.className = 'global-player';
    player.textContent = 'Fixture player boundary'; player.setAttribute('aria-label', 'Fixture player boundary');
    Object.assign(player.style, {position: 'fixed', bottom: '0', left: '0', right: '0', height: '110px', background: '#ddd', zIndex: '100'});
    document.body.append(player);
  });
}

module.exports = {test, expect, shared, tools, mount, compact, open, waitForResetCall, waitForOnlyResetCall, actionBoxes, expandBounds, resetBounds, headerBounds, assertTailOrder, waitForVisibleHeaderFocus, waitForReachablePanel, waitForPanelGutters, viewportWidths, panelBounds, placeLowerHeader, addDocumentScrollbar, mountNativeWrappers, mountPlayerObstruction};
