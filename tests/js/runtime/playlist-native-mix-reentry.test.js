const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const {createSourceFactory}=require('./playtable-source-fixture.cjs');
const load=()=>import('../../../music_app/static/js/playlists/native-library-mix.mjs');
function pageHarness(){
 const h=fixture(),controllerListeners=new Set(),preferences=new Set(),created=[],factory=createSourceFactory(created),played=[];
 let state={scopeKey:'s',selectedPlaylistId:'p',resource:{status:'ready',data:null},mutation:{status:'idle'},title:'Mix',description:'',playbackOrder:'regular',coverage:{},drafts:{},filters:{}};
 const controller={getSnapshot:()=>state,pendingSave:()=>false,canSave:()=>false,edit(){},setOrder(){},subscribe(fn){controllerListeners.add(fn);return()=>controllerListeners.delete(fn);}};
 h.runtime.subscribeTrackPreferences=fn=>{preferences.add(fn);return()=>preferences.delete(fn);};
 h.runtime.createPlaytableSource=factory;h.runtime.canTrackIntent=()=>true;h.runtime.trackIntent=(_intent,row)=>played.push(row);
 return {...h,created,controllerListeners,preferences,played,controller,props:()=>({controller,onClose(){},onSaved(){}}),
  setRows(title){const row={row_key:'one',playlist_item_id:'one',source_readable:true,availability:'local',title,duration_seconds:90};const detail={playlist_id:'p',title:'Mix',track_rows:[row],items_complete:true,author_order:true,allowed_actions:{can_play:true}};state={...state,resource:{status:'ready',data:{detail}}};return row;}};
}
function click(h,target){assert.ok(target);const event=new h.context.Event('click');event.detail=1;target.dispatchEvent(event);}
for(const phase of ['table','panel'])test(`F4-A first ${phase} acquisition defers live replacement until stale owner has retired`,async()=>{
 const {mountLibraryMixPage}=await load(),h=pageHarness(),baseline=h.listeners().length;
 const owner=mountLibraryMixPage(h.host,h.runtime,h.props());let replacement,armed=true;
 h.setRows('Old row');
 if(phase==='table'){
  h.runtime.canTrackIntent=()=>{if(armed){armed=false;replacement=h.setRows('Newest row');owner.update(h.props());}return true;};
  owner.update(h.props());
 }else{
  owner.update(h.props());const tabs=h.runtime.tabsHtml;
  h.runtime.tabsHtml=value=>{if(armed){armed=false;replacement=h.setRows('Newest row');owner.update(h.props());}return tabs(value);};
  click(h,h.host.querySelector('[data-playlists-select]'));
 }
 const row=h.host.querySelector('[data-playlist-row-key="one"]');assert.ok(row?.isConnected);assert.match(row.textContent,/Newest row/);
 assert.equal(h.preferences.size,1);assert.equal(h.created.filter(source=>source.snapshot()!==null).length,1);
 click(h,h.host.querySelector('[data-playlists-play]'));assert.equal(h.played.at(-1),replacement);
 if(phase==='panel'){const panel=h.host.querySelector('.playlists__selection');assert.ok(panel?.isConnected);assert.match(panel.textContent,/Newest row/);}
 owner.dispose();assert.equal(h.preferences.size,0);assert.equal(h.controllerListeners.size,0);assert.ok(h.created.every(source=>source.snapshot()===null));assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
const savedProps=id=>({scopeKey:'s',detail:{playlist_id:id,library_mix:{playback_order:'regular'},allowed_actions:{can_play:true},track_rows:[{playlist_item_id:'one',row_key:'one'}]}});
const publication=id=>({status:'ready',data:{scopeKey:'s',playlist_id:id,library_mix_order:'regular'}});
for(const kind of ['page','saved'])for(const replacement of [false,true])test(`F4-B ${kind} ${replacement?'replacement':'initial'} subscribe records cleanup before throwing synchronous repaint`,async()=>{
 const {mountLibraryMixPage,mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length,registered=new Set(),error=new Error('publication renderer failed');
 let stops=0,reads=0,armed=false,retained,owner;
 const subscribe=callback=>{registered.add(callback);retained=callback;armed=true;callback();return()=>{stops++;registered.delete(callback);throw new Error('secondary cleanup failure');};};
 if(kind==='page'){
  const state={resource:{status:'ready',data:null},mutation:{status:'idle'},coverage:{}};
  const initial={getSnapshot:()=>state,pendingSave:()=>false,canSave:()=>false,subscribe:()=>()=>{}};
  const props=controller=>({controller,onClose(){},onSaved(){}});
  if(replacement)owner=mountLibraryMixPage(h.host,h.runtime,props(initial));
  const action=h.runtime.actionHtml;h.runtime.actionHtml=value=>{if(armed&&value.label==='Play')throw error;return action(value);};
  const next={...initial,subscribe};
  assert.throws(()=>replacement?owner.update(props(next)):mountLibraryMixPage(h.host,h.runtime,props(next)),value=>value===error);
 }else{
  h.runtime.readPlayback=()=>{reads++;return new Promise(()=>{});};
  if(replacement)owner=mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('initial'));
  const before=reads;h.runtime.subscribePlayback=({playlist_id,onChange})=>subscribe(()=>onChange(publication(playlist_id)));
  h.runtime.canTrackIntent=()=>{if(armed)throw error;return true;};
  assert.throws(()=>replacement?owner.update(savedProps('next')):mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('next')),value=>value===error);
  assert.equal(reads,before,'failed publication must not start a playback read');
 }
 assert.equal(stops,1);assert.equal(registered.size,0);assert.doesNotThrow(()=>retained());assert.equal(stops,1);assert.equal(h.host.childNodes.length,0);assert.equal(h.listeners().length,baseline);owner?.dispose();
});
test('F4-B setup buffers synchronous subscribe publication and releases returned cleanup on renderer failure',async()=>{
 const {mountLibraryMixSetup}=await load(),h=fixture(),baseline=h.listeners().length,registered=new Set(),error=new Error('setup publication failed');let armed=false,stops=0,retained;
 const controller={getSnapshot:()=>({resource:{status:'unavailable'}}),subscribe(fn){registered.add(fn);retained=fn;armed=true;fn();return()=>{stops++;registered.delete(fn);};},prepare:async()=>false};
 const button=h.runtime.buttonHtml;h.runtime.buttonHtml=value=>{if(armed)throw error;return button(value);};
 assert.throws(()=>mountLibraryMixSetup(h.host,h.runtime,{controller,onReady(){},onClose(){}}),value=>value===error);
 assert.equal(stops,1);assert.equal(registered.size,0);assert.doesNotThrow(()=>retained());assert.equal(h.listeners().length,baseline);
});
