const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const {test, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
function fixtureBundle() {
  return buildSync({stdin: {resolveDir: root, sourcefile: 'native-row-isolated-fixture.jsx', loader: 'jsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {ArtistSelectionRows} from './music_app/static/js/home-friends/artist-selection.jsx';
    import {PersonNavigation} from './music_app/static/js/home-friends/friends-directory.jsx';
    const runtime = {navigationItemHtml: config => window.NavigationTree.renderItem(config),
      artboxHtml: config => window.buildAlbumArtboxHtml(config), escapeHtml: value => window.escapeHtml(value)};
    window.rowCalls = []; const root = createRoot(document.getElementById('fixture'));
    function Fixture() {
      const [state, setState] = useState({revision:0, artistSelected:false, readable:true, personSelected:false,
        personDisabled:false, personVisible:true, personHidden:false, personTitle:'Person One', artistTitle:'Artist One', mode:'normal'});
      window.rowUpdate = patch => flushSync(() => setState(old => ({...old,...patch,revision:old.revision+1})));
      window.clickPersonTwice = () => {for (let i=0;i<2;i++) flushSync(() => document.querySelector('[data-home-person-row="person:one"]').click());};
      const artist = {id:'artist:one',title:state.artistTitle,listen_count:3,source_readable:state.readable,allowed_actions:{can_read:state.readable}};
      return <><ArtistSelectionRows runtime={runtime} rows={[artist]} selectedId={state.artistSelected ? artist.id : null}
        onSelect={row => {window.rowCalls.push('artist:'+state.revision+':'+row.title); setState(old=>({...old,artistSelected:true}));}}/>
        <div hidden={state.personHidden}>{state.personVisible && <PersonNavigation runtime={runtime}
          person={{account_ref:'member:one',display_name:state.personTitle,handle:'person',avatar_url:null}}
          rowKey="person:one" selected={state.personSelected} disabled={state.personDisabled}
          onSelect={() => {window.rowCalls.push('select'); setState(old=>({...old,revision:old.revision+1,personSelected:true,
            ...(old.mode==='revoke'?{personDisabled:true}:{}), ...(old.mode==='unmount'?{personVisible:false}:{}), ...(old.mode==='hide'?{personHidden:true}:{})}));}}
          onActivate={node => window.rowCalls.push('activate:'+state.revision+':'+String(node===document.querySelector('[data-home-person-row="person:one"]')))}/>}</div></>;
    }
    flushSync(() => root.render(<Fixture/>)); window.rowUnmount = () => flushSync(() => root.unmount());
  `}, bundle: true, platform: 'browser', format: 'iife', write: false}).outputFiles[0].text;
}
async function mount(page) {
  await page.setContent('<!doctype html><html><body><div id="fixture"></div><button id="outside">Outside target</button></body></html>');
  const template = fs.readFileSync(path.join(root, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  await page.evaluate(text => {const node=document.createElement('script');node.id='navigation-tree-item-template';node.type='text/plain';node.textContent=text;document.body.append(node);}, template);
  for (const file of ['button-component.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/album-artbox.js','navigation-tree.js']) {
    await page.addScriptTag({path:path.join(root,'music_app/static/js',file)});
  }
  for (const file of ['button-component.css','navigation-tree.css','runtime/home-friends.css','runtime/home-detail-projection.css']) {
    await page.addStyleTag({path:path.join(root,'music_app/static/css',file)});
  }
  await page.addScriptTag({content:fixtureBundle()});
  await expect(page.locator('[data-home-artist-select]')).toHaveCount(1);
  await expect(page.locator('[data-home-person-row]')).toHaveCount(1);
}
const settleFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

module.exports = {test, expect, mount, settleFrames};
