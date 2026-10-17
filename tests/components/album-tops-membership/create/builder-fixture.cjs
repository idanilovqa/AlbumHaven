const fs = require('node:fs');
const path = require('node:path');
const {test, expect} = require('@playwright/test');
const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../../..');
const entry = `
import {openAlbumTopBuilder} from '/music_app/static/js/album-tops/builder.mjs';
import {createAlbumTopController} from '/music_app/static/js/album-tops/model.mjs';
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
  const opener=document.querySelector('#opener');opener.focus();const host=document.querySelector('#mount');
  let owner=null,closed=false,disposed=false;
  const props=()=>({runtime,controller,providers,state:controller.getSnapshot(),existing:options.editing?original:null,
    onClose:()=>{closed=true;},onFormSaved:value=>calls.saved.push(value),returnFocus:()=>opener,fallbackHost:host});
  const update=()=>{if(!disposed&&!closed)owner?.update(props());},unsubscribe=controller.subscribe(update);
  try{owner=openAlbumTopBuilder(props());update();}catch(error){unsubscribe();owner?.dispose();controller.dispose();throw error;}
  window.topFixture={calls,controller,original,getPersisted:()=>persisted,resolveSearch:()=>heldSearch?.(),resolveWrite:()=>heldWrite?.(),
    dispose(){if(disposed)return;disposed=true;unsubscribe();owner.dispose();controller.dispose();},revoke(){controller.observeDenial('component:actor:library',Object.assign(new Error('Denied'),{status:403}));}};
};`;
// Resolve only the reachable native ES module graph. Exact review hashes live
// in the packet bindings, not in this durable browser delivery fixture.
function nativeDelivery(html) {
  const realRoot=fs.realpathSync(root), bodies=new Map();
  const nativeRoot=path.join(realRoot,'music_app/static/js');
  const confined=file=>{
    const resolved=fs.realpathSync(file);
    if(!resolved.startsWith(realRoot+path.sep))throw new Error('Native fixture path escaped repository: '+file);
    return resolved;
  };
  function collect(relative) {
    const url='/'+relative;
    if(bodies.has(url))return;
    if(!relative.startsWith('music_app/static/js/')||!relative.endsWith('.mjs'))throw new Error('Non-native module: '+relative);
    const file=confined(path.resolve(realRoot,relative));
    if(!file.startsWith(nativeRoot+path.sep)||!file.endsWith('.mjs'))throw new Error('Non-native module path: '+relative);
    const body=fs.readFileSync(file,'utf8');
    // Deliberately bounded static syntax, not a JavaScript parser or bundler.
    // Current owners use static imports. Dynamic imports fail closed.
    if(/\bimport\s*\(/.test(body))throw new Error('Dynamic module imports are not supported: '+relative);
    const imports=[];
    const declarations=/\bimport\s+(?:[^;'"`]*?\s+from\s*)?(['"])([^'"\r\n]+)\1\s*;|\bexport\s+(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\r\n]+)\3\s*;/g;
    const remaining=body.replace(declarations,(_match,_q,spec,_eq,exportSpec)=>{imports.push(spec||exportSpec);return '';});
    if(/^\s*import\b/m.test(remaining)||/^\s*export\s+(?:\*|\{)[^;]*\bfrom\b/m.test(remaining))throw new Error('Unsupported module declaration: '+relative);
    bodies.set(url,body);
    for(const spec of imports) {
      if(!/^\.{1,2}\/[a-zA-Z0-9_./-]+\.mjs$/.test(spec))throw new Error('Only relative native .mjs dependencies are allowed: '+spec);
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(relative),spec));
      collect(dependency);
    }
  }
  for(const entry of ["music_app/static/js/album-tops/builder.mjs", "music_app/static/js/album-tops/model.mjs"])collect(entry);
  const entryFile=confined(__filename);
  if(entryFile!==path.join(fs.realpathSync(__dirname),'builder-fixture.cjs'))throw new Error('Fixture entry escaped its fixed directory');
  return route=>{
    const request=route.request(),raw=request.url();
    const reject=()=>route.fulfill({status:404,contentType:'text/plain',body:'Unknown fixture resource'});
    let url;try{url=new URL(raw);}catch{return reject();}
    const pathname=url.pathname;
    // Never reinterpret encoded/malformed paths as the document fallback.
    if(request.method()!=='GET'||pathname.includes('%')||raw.includes('\\'))return reject();
    if(!url.search&&pathname==='/__album_tops_fixture__/fixture-entry.mjs')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:entry});
    if(!url.search&&bodies.has(pathname))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:bodies.get(pathname)});
    if(request.resourceType()==='document'&&!/\.(?:m?js|jsx|cjs)(?:\/|$)/i.test(pathname)&&!pathname.startsWith('/music_app/')&&!pathname.startsWith('/__album_tops_fixture__/'))return route.fulfill({contentType:'text/html',body:html});
    return reject();
  };
}

async function mount(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  // Host-provided Search macro contract. Actual shared renderer/clear behavior is loaded below.
  const html=('<!doctype html><html><body><button id="opener">Open Top builder</button><main id="mount"></main><template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template></body></html>');
  await page.route('https://albumhaven.test/**',nativeDelivery(html));await page.goto('https://albumhaven.test/');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js', 'runtime/alert-components.js',
    'runtime/album-artbox.js', 'runtime/gallery-main-components.js', 'runtime/gallery-card-component.js', 'runtime/in-page-tabs.js', 'runtime/search-input.js']) {
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
  }
  const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
  const styles = new Set(['button-component.css', ...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(match => match[1])]);
  for (const file of styles) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
  await page.addStyleTag({content: 'body{margin:0;overflow:auto;height:auto}[role=dialog]{width:100%;box-sizing:border-box;padding:12px}'});
  await page.evaluate(()=>{window.albumTopsFixtureReady=import('/__album_tops_fixture__/fixture-entry.mjs');return window.albumTopsFixtureReady.then(()=>undefined);}); await page.evaluate(options => window.startTopFixture(options), options);
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
