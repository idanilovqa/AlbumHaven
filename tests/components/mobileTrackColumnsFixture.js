// Real Chromium DOM + unchanged production React/native renderers. Isolated DTOs,
// no server routes, database, global Rating mutation or app-E2E claim.
const {test}=require("@playwright/test");
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"../..");
const pageErrors=new WeakMap();
test.afterEach(async ({page})=>assert.deepEqual(pageErrors.get(page)||[],[],"No browser runtime errors"));
const {buildSync}=require('esbuild');
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {PlaylistTracks} from './music_app/static/js/playlists/track-table.jsx';
import {ActivityPanel} from './music_app/static/js/home-friends/activity.jsx';
import {bindTrackTablePresentation} from './music_app/static/js/playtables/track-table-presentation.mjs';
window.componentFixture={React,createRoot,flushSync,PlaylistTracks,ActivityPanel,bindTrackTablePresentation};`;
const bundle=buildSync({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
async function mount(page,width=390){
 await page.setViewportSize({width,height:800});const errors=[];pageErrors.set(page,errors);
 page.on("pageerror",error=>errors.push(String(error)));
 await page.setContent('<!doctype html><html><head></head><body><main id="root"></main></body></html>');
 for(const file of ['js/button-component.js','js/runtime/markup-format-helpers.js','js/runtime/loader-status-helpers.js','js/runtime/alert-components.js','js/runtime/album-artbox.js','js/runtime/gallery-main-components.js','js/runtime/gallery-card-component.js','js/runtime/album-details-components.js','js/runtime/compact-data-table.js','js/runtime/album-track-table.js'])
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static',file),'utf8')});
 for(const file of ['css/button-component.css',...new Set([...fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8').matchAll(/css\/([a-zA-Z0-9_\/-]+\.css)/g)].map(match=>'css/'+match[1]))])
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static',file),'utf8')});
 await page.addStyleTag({content:'body{margin:0;overflow:auto;height:auto}main{width:100%;min-width:0}'});
 await page.addScriptTag({content:bundle});
 await page.evaluate(()=>{
  window.calls={choices:[],changes:[],inspects:[],plays:[],reorders:[],closed:0};
  window.runtime={escapeHtml,tableHtml:buildCompactDataTable,buttonHtml:c=>ButtonComponent.renderButton(c),actionHtml:c=>ButtonComponent.renderActionButton(c),
   artboxHtml:buildAlbumArtboxHtml,iconHtml:(name,options)=>ButtonComponent.renderIconSvg(name,options),ratingHtml:buildGalleryRatingHtml,galleryCardHtml:buildGalleryCardHtml,alertHtml:buildOnPageAlertHtml,
   albumTrackRow:(row,i)=>buildAlbumTrackTableRow({...row,duration:row.duration_display},i,{readOnly:true}),
   openChoice:(anchor,config)=>{calls.choices.push({anchor,config});return {close(){calls.closed++;},isOpen:true};},
   canTrackIntent:()=>false,trackIntent:(...a)=>calls.plays.push(a)};
 });
 return page;
}
async function bind(page){
 await page.evaluate(()=>{
  const columns=[{key:'number',label:'#',width:36,required:true},{key:'title',label:'Track',width:140,identity:true},{key:'artist',label:'Artist',width:112},{key:'love',label:'Love',width:44,required:true},{key:'rating',label:'Rating',width:64},{key:'duration',label:'Length',width:56,required:true}];
  const html=runtime.tableHtml({columnsConfig:columns.map(c=>({...c,sortable:c.key==='duration'})),columns:'36px 140px 112px 44px 64px 56px',overflow:'local',rows:[{key:'one',cells:{number:'1',title:'An extremely long title retained',artist:'Subject Artist',love:'Loved',rating:'4',duration:'2:10'}},{key:'two',cells:{number:'2',title:'Other',artist:'Other Artist',love:'Off',rating:'2',duration:'9:00'}}]});
  document.querySelector('#root').innerHTML=html;
  window.host=document.querySelector('#root');window.source={id:'A'};
  window.binding=componentFixture.bindTrackTablePresentation(host,{columns,choices:{artist:false,rating:false},source,isCurrent:()=>true,openChoice:runtime.openChoice,onChoicesChange:next=>{calls.changes.push(next);binding.update({choices:next});}});
 });
}
const header='.compact-data-table-header';
const pointer=async(page,type,target=header,extra={})=>page.locator(target).dispatchEvent(type,{bubbles:true,pointerType:'touch',pointerId:1,isPrimary:true,button:0,clientX:40,clientY:20,...extra});

function initialGeometry(page) {
  return page.evaluate(()=>({title:document.querySelector('[role="cell"][data-cdt-column="title"]').getBoundingClientRect().width,body:document.body.scrollWidth,viewport:innerWidth}));
}

function tableGeometry(page) {
  return page.evaluate(()=>{
  const table=document.querySelector('.compact-data-table'),rows=[...table.querySelectorAll('.compact-data-table-header,.compact-data-table-row')];
  return {rows:rows.map(row=>[...row.children].filter(n=>getComputedStyle(n).display!=='none').map(n=>({key:n.dataset.cdtColumn,x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width}))),scroll:table.scrollWidth,client:table.clientWidth,body:document.body.scrollWidth,viewport:innerWidth,changes:calls.changes};
 });
}

function waitForMobilePress(page) {
  return page.waitForTimeout(620);
}

function waitForVisibleRating(page, rating) {
  return page.waitForFunction(key=>[...document.querySelectorAll('[role="cell"]')].some(c=>c.dataset.cdtColumn===key&&getComputedStyle(c).display!=='none'),rating.value);
}

async function renderConsumer(page,kind,id='A'){
 await page.evaluate(({kind,id})=>{
  const f=componentFixture;window.reactRoot ||= f.createRoot(document.querySelector('#root'));
  const row={id:'recent:one',row_key:'item:one',playlist_item_id:'one',kind:'track',source_readable:true,title:'Subject track',artist:'Subject artist',album_title:'Subject album',availability:'missing',duration_seconds:130,duration_display:'2:10',rating:4,track_rating:4,love_tier:'loved',listen_count:7,play_count:7,popularity_count:81,last_listened_at:'2026-10-10T10:00:00Z'};
  window.row=row;window.detail={playlist_id:id,title:'List '+id,track_rows:[row],items_complete:true,author_order:true,allowed_actions:{can_play:false,can_edit:false,can_reorder:false}};
  window.state={scopeKey:'owner',selectedPlaylistId:id,resource:{status:'ready',data:{detail}},mutation:{status:'idle'},drafts:{},filters:{}};
  const controller={getSnapshot:()=>state,reorder:ids=>calls.reorders.push(ids)};
  const props=kind==='playlist'?{runtime,rows:[row],detail,state,controller,onSelect:r=>calls.inspects.push(r),onError:()=>{}}:
   {runtime,value:{status:'ready',data:{rows:[row]}},kind:'tracks',scopeKey:'owner',account_ref:id,period:'week',onTracksSelect:ids=>calls.inspects.push(ids),selectedTrackIds:[]};
  f.flushSync(()=>reactRoot.render(f.React.createElement(kind==='playlist'?f.PlaylistTracks:f.ActivityPanel,props)));
 },{kind,id});
 await page.locator('[data-track-table-columns]').waitFor();
}

function bodyOverflows(page) {
  return page.evaluate(()=>document.body.scrollWidth>innerWidth);
}

function observeSorts(page) {
  return page.evaluate(()=>{window.sorts=0;document.querySelector('[data-cdt-sort]').addEventListener('click',()=>sorts++);});
}

module.exports = {test, assert, mount, bind, header, pointer, initialGeometry, tableGeometry, waitForMobilePress, waitForVisibleRating, renderConsumer, bodyOverflows, observeSorts};
