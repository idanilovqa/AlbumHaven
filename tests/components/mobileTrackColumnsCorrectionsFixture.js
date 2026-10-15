// Additive actual-native-owner regression cases. Authored only; headless browser
// blocked in current environment. Do not count an unrun case as passing evidence.
const {test}=require("@playwright/test");
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"../..");
const pageErrors=new WeakMap();
test.afterEach(async ({page})=>{
 try {if(!page.isClosed()) await page.evaluate(()=>{try {window.nativeConsumerOwner?.dispose();} finally {window.binding?.dispose();}});}
 finally {assert.deepEqual(pageErrors.get(page)||[],[],"No browser runtime errors");}
});
const {nativeDelivery}=require('./mobileTrackColumnsNativeDelivery.cjs');
async function fixture(page){
 await page.setViewportSize({width:390,height:800});const errors=[];pageErrors.set(page,errors);page.on("pageerror",error=>errors.push(String(error)));
 await page.route('https://albumhaven.test/**',nativeDelivery(root,'<!doctype html><main id="host"></main><button id="outside">Outside</button>',['mobileTrackColumnsNativeEntry.mjs']));
 await page.goto('https://albumhaven.test/');
 for(const file of ['button-component.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/alert-components.js','runtime/album-artbox.js','runtime/gallery-main-components.js','runtime/album-details-components.js','runtime/compact-data-table.js','runtime/album-track-table.js','runtime/trigger-anchor.js','runtime/library-settings.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
 const styles=['button-component.css',...new Set([...fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8').matchAll(/css\/([a-zA-Z0-9_\/-]+\.css)/g)].map(m=>m[1]))];
 for(const file of styles)await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
 await page.addStyleTag({content:'body{margin:0;height:auto;overflow:auto}#host{width:390px;max-width:100%;min-width:0}'});
 await page.evaluate(()=>import('/__mobile_columns_fixture__/mobileTrackColumnsNativeEntry.mjs').then(()=>undefined));
 await page.evaluate(()=>{
  const columns=[{key:'title',label:'Track',width:140,identity:true},{key:'love',label:'Love',width:36,required:true},{key:'rating',label:'Rating',width:80},{key:'duration',label:'Length',width:56,required:true,sortable:true}];
  const host=document.querySelector('#host');
  host.innerHTML=buildCompactDataTable({id:'correction-table',columnsConfig:columns,columns:'140px 36px 80px 56px',overflow:'local',rows:[{key:'one',cells:{title:'Real native row',love:'Loved',rating:'4',duration:'2:10'}}]});
  window.pristineTitle=document.querySelector('.compact-data-table-header [data-cdt-column="title"]').innerHTML;
  window.pristineTitleNode=document.querySelector('.compact-data-table-header [data-cdt-column="title"]').firstChild;
  window.pristineSort=document.querySelector('[data-cdt-sort]');
  window.sorts=0;window.binding=bindTrackTablePresentation(host,{columns,source:{revision:1},choices:{rating:false},isCurrent:()=>true,openChoice:openUtilityChoiceDropdown,onChoicesChange:()=>{}});
  document.querySelector('[data-cdt-sort]').addEventListener('click',()=>sorts++);
 });
 // Let the actual initial ResizeObserver delivery settle before starting a press.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 return page;
}
const sort='[data-cdt-sort]',title='.compact-data-table-header [data-cdt-column="title"]',header='.compact-data-table-header';
async function pointer(page,type,selector=sort){await page.locator(selector).dispatchEvent(type,{bubbles:true,pointerType:'touch',pointerId:17,isPrimary:true,button:0,clientX:32,clientY:16});}
async function click(page,detail=1){await page.evaluate(detail=>document.querySelector('[data-cdt-sort]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail,button:0})),detail);}

function waitForReleasedSequence(page) {
  return page.waitForTimeout(1200);
}

function settleCorrectionFrames(page) {
  return page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

function focusedLabelGeometry(page) {
  return page.evaluate(()=>{const node=document.activeElement;return {text:node.textContent,width:node.getBoundingClientRect().width,tabindex:node.getAttribute('tabindex')};});
}

async function mountLongPlaylistTitle(page) {
 await page.evaluate(()=>{
  binding.dispose();document.querySelector('#host').replaceChildren();
  const runtime={escapeHtml,tableHtml:buildCompactDataTable,buttonHtml:c=>ButtonComponent.renderButton(c),actionHtml:c=>ButtonComponent.renderActionButton(c),iconHtml:(name,options)=>ButtonComponent.renderIconSvg(name,options),ratingHtml:buildGalleryRatingHtml,artboxHtml:buildAlbumArtboxHtml,alertHtml:buildOnPageAlertHtml,openChoice:openUtilityChoiceDropdown,albumTrackRow:(row,i)=>buildAlbumTrackTableRow({...row,duration:row.duration_display},i,{readOnly:true})};
  const rows=[{row_key:'item:one',playlist_item_id:'one',source_readable:true,title:'A very long production Playlist track title that must end in an ellipsis inside the flexible artwork identity area instead of merely clipping at the cell edge',artist:'Subject artist',album_title:'Subject album',availability:'missing',duration_seconds:130,love_tier:'loved'}];
  const detail={playlist_id:'ellipsis',title:'Ellipsis fixture',track_rows:rows,items_complete:true,author_order:true,allowed_actions:{can_play:false,can_edit:false,can_reorder:false}};
  const state={scopeKey:'owner',selectedPlaylistId:'ellipsis',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},drafts:{},filters:{}};
  window.nativeConsumerOwner?.dispose();
  window.nativeConsumerOwner=componentFixture.mountPlaylistTracks(document.querySelector('#host'),runtime,{rows,detail,state,controller:{getSnapshot:()=>state},onSelect:()=>{},onError:()=>{}});
 });
}

function playlistTitleGeometry(page) {
  return page.locator('[role="cell"][data-cdt-column="title"]').evaluate(cell=>{
  const title=cell.querySelector('.album-track-table__title'),textParent=title.parentElement,identity=title.closest('.home-detail__release'),art=identity.querySelector('.album-artbox');
  const a=title.getBoundingClientRect(),b=identity.getBoundingClientRect(),c=cell.getBoundingClientRect(),p=textParent.getBoundingClientRect(),style=getComputedStyle(title);
  return {title:a.width,parent:p.width,identity:b.width,cell:c.width,titleRight:a.right,cellRight:c.right,art:art.getBoundingClientRect().width,scroll:title.scrollWidth,client:title.clientWidth,overflow:style.overflowX,ellipsis:style.textOverflow,whiteSpace:style.whiteSpace};
 });
}

function documentOverflows(page) {
  return page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
}

function waitForColumnMenu(page) {
  return page.getByRole('menu',{name:'Track columns'}).waitFor();
}

function waitForColumnMenuDetached(page) {
  return page.getByRole('menu',{name:'Track columns'}).waitFor({state:'detached'});
}

function waitForResponsivePlaylist(page) {
  return page.locator('.compact-data-table[data-cdt-responsive]').waitFor();
}

function waitForMenu(menu) {
  return menu.waitFor();
}

function menuBounds(menu) {
  return menu.boundingBox();
}

function titleBounds(page) {
  return page.locator(title).boundingBox();
}

function tableBounds(page) {
  return page.locator('.compact-data-table').boundingBox();
}

module.exports = {test, assert, fixture, sort, title, header, pointer, click, waitForReleasedSequence, settleCorrectionFrames, focusedLabelGeometry, mountLongPlaylistTitle, playlistTitleGeometry, documentOverflows, waitForColumnMenu, waitForColumnMenuDetached, waitForResponsivePlaylist, waitForMenu, menuBounds, titleBounds, tableBounds};
