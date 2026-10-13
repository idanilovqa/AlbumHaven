const path = require('node:path');
const {buildSync} = require('esbuild');
const {test, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const shared = '[data-shared-header="fixture"]';
const tools = page => page.locator(`${shared} [data-header-tools]`).locator('button').or(page.locator(`${shared} button[data-header-tools]`));
// Isolated real-React/native-component fixture. This neither boots the server
// application nor substitutes its configuration, authentication, or providers.
function browserBundle() {
  return buildSync({stdin: {resolveDir: root, sourcefile: 'home-header-isolated-fixture.jsx', loader: 'jsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {SharedHeader, ListensBadge} from './music_app/static/js/home-friends/shared-header.jsx';
    import {Button, Period} from './music_app/static/js/home-friends/components.jsx';
    import {NativeChoice} from './music_app/static/js/home-friends/native-choice.jsx';
    import {ProfileIdentity} from './music_app/static/js/home-friends/profile.jsx';
    const runtime = {buttonHtml: x => window.ButtonComponent.renderButton(x), actionHtml: x => window.ButtonComponent.renderActionButton(x),
      iconHtml: x => window.ButtonComponent.renderIconSvg(x), openChoice: (...args) => window.openUtilityChoiceDropdown(...args),
      artboxHtml: x => window.buildAlbumArtboxHtml(x), alertHtml: x => window.buildOnPageAlertHtml(x), openAvatar() {}};
    window.fixtureCalls = []; const owner = createRoot(document.querySelector('#fixture'));
    function Fixture() {
      const [revision, setRevision] = useState(0), [permitted, setPermitted] = useState(true), [period, setPeriod] = useState('week');
      window.fixtureUpdate = patch => flushSync(() => {if ('permitted' in patch) setPermitted(patch.permitted); if ('period' in patch) setPeriod(patch.period); setRevision(x => x + 1);});
      return <SharedHeader runtime={runtime} id="fixture" className="gallery-bar home-friends__page-header"
        identity={<><ProfileIdentity runtime={runtime} profile={{display_name: 'Fixture Person', handle: 'fixture', avatar_url: null}}/>
          <ListensBadge runtime={runtime} total={period === 'week' ? 7 : 28} range="Selected period"/></>}
        leading={<Button runtime={runtime} icon="expand" onClick={() => window.fixtureCalls.push('expand')}>Full size</Button>}
        actions={<><Button runtime={runtime} key="reset" onClick={() => window.fixtureCalls.push('reset:' + revision)}>Reset</Button>
          <Period runtime={runtime} value={period} onChange={setPeriod}/>
          <NativeChoice runtime={runtime} label="Rows" showLabel={false} value="all" options={[['all','All rows'],['few','Few rows']]} onChange={x => window.fixtureCalls.push('rows:' + x)}/>
          <Button runtime={runtime} key="missing" disabled={!permitted} onClick={() => window.fixtureCalls.push('missing')}>Missing</Button></>}
        outsideActions={<Button runtime={runtime} icon="cover" onClick={() => window.fixtureCalls.push('view')}>View</Button>}
        finalAction={(window.fixtureFinalOrder || ['collapse']).map(icon => <Button key={icon} runtime={runtime} icon={icon}
          onClick={() => window.fixtureCalls.push(icon)}>{({collapse: 'Collapse', more: 'More actions', close: 'Close'})[icon]}</Button>)}/>
    }
    flushSync(() => owner.render(<Fixture/>)); window.fixtureUnmount = () => flushSync(() => owner.unmount());
  `}, bundle: true, platform: 'browser', format: 'iife', write: false}).outputFiles[0].text;
}
async function mount(page, width = 370, finalOrder = ['collapse']) {
  await page.setViewportSize({width, height: 700});
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="home-friends"><div id="fixture"></div></main><button id="outside">Outside target</button></body></html>');
  for (const file of ['button-component.css', 'choice-component.css', 'gallery-main.css', 'runtime/trigger-anchor.css', 'runtime/home-friends.css', 'runtime/home-profile.css']) {
    await page.addStyleTag({path: path.join(root, 'music_app/static/css', file)});
  }
  await page.addStyleTag({content: 'body{margin:0;font:14px system-ui;--text:#111;--muted:#555;--border:#aaa;--panel:#fff;--appearance-card:#fff;--appearance-ink:#111} #fixture{width:100%;}'});
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js', 'runtime/alert-components.js', 'runtime/album-artbox.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js']) {
    await page.addScriptTag({path: path.join(root, 'music_app/static/js', file)});
  }
  await page.evaluate(order => {window.fixtureFinalOrder = order;}, finalOrder);
  await page.addScriptTag({content: browserBundle()});
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
  // A second bounded mounted-React fixture exercises the remaining wrappers.
  // It mounts the real native tabs and unfolding owner, without app services.
  const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {Tabs} from './music_app/static/js/home-friends/components.jsx';
    import {ViewControl} from './music_app/static/js/home-friends/view-control.jsx';
    const runtime = {
      tabsHtml: config => window.buildInPageTabsHtml(config), mountTabs: host => window.mountInPageTabs(host),
      viewChooserHtml: config => window.UnfoldingActionButton.render(config),
      mountViewChooser: (host, config) => window.UnfoldingActionButton.mount(host, config),
    };
    window.wrapperCalls = [];
    function Probe() {
      const [revision, setRevision] = useState(0), [tab, setTab] = useState('recent'), [view, setView] = useState('grouped');
      window.refreshWrappers = () => flushSync(() => setRevision(x => x+1));
      return <><output data-probe-revision>{revision}</output>
        <Tabs runtime={runtime} id="native-wrapper-tabs" label="Probe tabs" items={ [['recent','Recent'],['news','News']] }
          value={tab} onChange={value => {window.wrapperCalls.push('tab:'+value); setTab(value);}}/>
        <ViewControl runtime={runtime} kind="tracks" value={view} onChange={value => {window.wrapperCalls.push('view:'+value); setView(value);}}/></>;
    }
    flushSync(() => createRoot(document.querySelector('#fixture')).render(<Probe/>));
  `;
  const bundle = buildSync({stdin: {contents: entry, resolveDir: root, sourcefile: 'native-header-wrapper-probe.jsx', loader: 'jsx'},
    bundle: true, platform: 'browser', format: 'iife', write: false}).outputFiles[0].text;
  await page.addScriptTag({content: bundle});
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
