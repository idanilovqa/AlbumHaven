const fs = require('node:fs');
const path = require('node:path');
const {test, expect} = require('@playwright/test');
const {buildSync} = require('esbuild');
const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../../..');
const entry = `
import React, {useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {AlbumTopBuilder} from './music_app/static/js/album-tops/builder.jsx';
import {createAlbumTopController} from './music_app/static/js/album-tops/model.mjs';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
const TOP=id(1), A=id(11), B=id(12), C=id(13), IA=id(21), IB=id(22), SOURCE=id(31);
const BROWSE='library.browse.read', CREATE='library.album_tops.create', MANAGE='library.album_tops.manage', ITEMS='library.album_tops.items.manage';
window.startTopFixture = async options => {
  const calls = {search:[],admit:[],writes:[],confirms:[],closed:[],saved:[]}; let heldSearch, heldWrite;
  const items=[{item_ref:IA,album_ref:A,title:'Retained local',artist:'Artist',year:2001,original_position:4,position:1},
    {item_ref:IB,album_ref:B,title:'Retained nonlocal',artist:'Artist',year:null,original_position:9,position:2}];
  let persisted={top_ref:TOP,revision:'7',title:'Curated Top',description:'Subtitle',visibility:'private',items,
    allowed_actions:{[BROWSE]:true,[MANAGE]:true,[ITEMS]:true,can_read:true,can_edit:true,can_rename:true,can_add:true,can_remove:true,can_reorder:true},
    edit_draft:{items:[{item_ref:IA,album_ref:A,selected_local_album_id:11,selected_source_ref:SOURCE},{item_ref:IB,album_ref:B}],publication_preview_required:false}};
  if(options.denied) persisted.allowed_actions.can_edit=false;
  const original=structuredClone(persisted);
  const album={local_album_id:13,album_ref:C,title:'Found edition',artist:'Artist',year:2002};
  const providers={
    list:async()=>({tops:[persisted],next_cursor:null,allowed_actions:{[BROWSE]:true,[CREATE]:true,can_create:true}}),
    read:async()=>persisted,
    searchAlbums:async value=>{calls.search.push({q:value.q,cursor:value.cursor,scopeKey:value.scopeKey});
      if(options.holdSearch) return new Promise(resolve=>{heldSearch=()=>resolve({albums:[album],next_cursor:null});});
      if(value.q==='failure') throw Object.assign(new Error('Search unavailable'),{status:503});
      if(value.q==='filtered'&&!value.cursor) return {albums:[],next_cursor:'continued'};
      return {albums:[album],next_cursor:null};},
    admitAlbum:async(localId,value)=>{calls.admit.push({localId,scopeKey:value.scopeKey});return {album_ref:C};},
    execute:async(action,command)=>{calls.writes.push({action,command:structuredClone(command)});
      if(options.holdWrite) await new Promise(resolve=>{heldWrite=resolve;});
      if(options.uncertain) throw new TypeError('Lost acknowledgement');
      persisted={...persisted,title:command.title,description:command.description,revision:'8'};
      return {top_ref:TOP,revision:'8',action,request_key:command.request_key};},
  };
  const controller=createAlbumTopController({providers,requestKey:()=>id(100)}); controller.setScope('component:actor:library'); await controller.load();
  if(options.editing) await controller.open(TOP);
  const runtime={buttonHtml:value=>ButtonComponent.renderButton(value),actionHtml:value=>ButtonComponent.renderActionButton(value),
    alertHtml:value=>buildOnPageAlertHtml(value),galleryCardHtml:value=>buildGalleryCardHtml(value),artboxHtml:value=>buildAlbumArtboxHtml(value),
    searchHtml:value=>buildSearchInputHtml(value),tabsHtml:value=>buildInPageTabsHtml(value),mountTabs:value=>mountInPageTabs(value),
    confirm:async(message,settings)=>{calls.confirms.push({message,settings});return options.confirmDiscard===true;},confirmRetryOriginal:async()=>false,
    openForm(settings){const outer=document.createElement('section');outer.setAttribute('role','dialog');outer.setAttribute('aria-label',settings.title);
      const host=document.createElement('div');outer.appendChild(host);document.body.appendChild(outer);settings.onMount(host);let disabled=settings.dismissDisabled,closed=false;
      return {setDismissDisabled(value){disabled=value;},async close(_value,closeOptions={}){
        if(closed)return true;if(!closeOptions.force&&(disabled||settings.beforeDismiss&&await settings.beforeDismiss('cancel')!==true))return false;
        closed=true;calls.closed.push(closeOptions);settings.onClose(host,closeOptions);outer.remove();
        if(closeOptions.restoreFocus!==false)settings.returnFocus?.()?.focus();return true;}};},};
  const opener=document.querySelector('#opener');opener.focus();const reactRoot=createRoot(document.querySelector('#mount'));
  function App(){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),[open,setOpen]=useState(true);
    return open?React.createElement(AlbumTopBuilder,{runtime,controller,providers,state,existing:options.editing?original:null,
      onClose:()=>setOpen(false),onFormSaved:value=>calls.saved.push(value),returnFocus:()=>opener}):null;}
  reactRoot.render(React.createElement(App));
  window.topFixture={calls,controller,original,getPersisted:()=>persisted,resolveSearch:()=>heldSearch?.(),resolveWrite:()=>heldWrite?.(),
    dispose(){reactRoot.unmount();controller.dispose();},revoke(){controller.observeDenial('component:actor:library',Object.assign(new Error('Denied'),{status:403}));}};
};`;
let bundle;
test.beforeAll(() => {bundle = buildSync({stdin: {contents: entry, resolveDir: root, loader: 'jsx'}, bundle: true, write: false, platform: 'browser', format: 'iife'}).outputFiles[0].text;});

async function mount(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  // Host-provided Search macro contract. Actual shared renderer/clear behavior is loaded below.
  await page.setContent('<!doctype html><html><body><button id="opener">Open Top builder</button><main id="mount"></main><template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template></body></html>');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js', 'runtime/alert-components.js',
    'runtime/album-artbox.js', 'runtime/gallery-main-components.js', 'runtime/gallery-card-component.js', 'runtime/in-page-tabs.js', 'runtime/search-input.js']) {
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
  }
  const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
  const styles = new Set(['button-component.css', ...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(match => match[1])]);
  for (const file of styles) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
  await page.addStyleTag({content: 'body{margin:0;overflow:auto;height:auto}[role=dialog]{width:100%;box-sizing:border-box;padding:12px}'});
  await page.addScriptTag({content: bundle}); await page.evaluate(options => window.startTopFixture(options), options);
  await expect(page.getByRole('dialog')).toBeVisible();
  if (!options.editing) {
    const find = page.getByRole('button', {name: 'Find albums', exact: true});
    await expect(page.getByRole('searchbox')).toBeHidden();
    await expect(find).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => topFixture.calls.search)).toEqual([]);
    await find.click();
    await expect(find).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('searchbox')).toBeVisible();
  }
  return {errors, search: page.getByRole('searchbox'), name: page.locator('input[name="top-name"]')};
}
const pick = page => page.getByRole('button', {name: /(?:select|add).*Found edition/i});
const primary = page => page.getByRole('button', {name: /^Create(?: Album Top)?$/});


module.exports={mount,pick,primary};
