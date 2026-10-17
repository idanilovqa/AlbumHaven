const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const load=()=>import('../../../music_app/static/js/playlists/native-library-mix.mjs');
function pageProps(overrides={}){
 const listeners=new Set();let edits=0,subscriptions=0;
 const state={scopeKey:'s',resource:{status:'ready',data:null},mutation:{status:'idle'},title:'Mix',description:'',playbackOrder:'regular',coverage:{},recipe:{auto_update:true}};
 const controller={getSnapshot:()=>state,pendingSave:()=>false,canSave:()=>false,edit(){edits++;},setOrder(){},subscribe(fn){subscriptions++;listeners.add(fn);return()=>listeners.delete(fn);},...overrides};
 return {controller,onClose(){},onSaved(){},listeners,get edits(){return edits;},get subscriptions(){return subscriptions;}};
}
const savedProps=id=>({scopeKey:'s',detail:{playlist_id:id,library_mix:{playback_order:'regular'},allowed_actions:{can_play:true},track_rows:[{playlist_item_id:`${id}-one`,row_key:'one'}]}});
const publication=id=>({status:'ready',data:{scopeKey:'s',playlist_id:id,library_mix_order:'regular'}});
for(const failure of ['later control','subscribed renderer','table renderer'])test(`F4 page construction retires actual owners after ${failure} failure`,async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,props=pageProps();
 if(failure==='later control'){
  const original=h.runtime.actionHtml;
  h.runtime.actionHtml=value=>{if(value.label==='Close mix'){const trigger=h.host.querySelector('.ui-choice__trigger');h.click(trigger);throw new Error('injected failure');}return original(value);};
 }else if(failure==='subscribed renderer'){
  props.controller.getSnapshot=()=>({scopeKey:'s',resource:{status:'error'},mutation:{status:'idle'},coverage:{}});
  const alert=h.runtime.alertHtml,subscribe=props.controller.subscribe;let armed=false;
  props.controller.subscribe=fn=>{const stop=subscribe(fn);armed=true;return stop;};
  h.runtime.alertHtml=value=>{if(armed)throw new Error('injected failure');return alert(value);};
 }else{
  const detail=savedProps('mix').detail;detail.track_rows=[];
  props.controller.getSnapshot=()=>({scopeKey:'s',selectedPlaylistId:'mix',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},coverage:{},drafts:{},filters:{}});
  h.runtime.tableHtml=()=>{throw new Error('injected failure');};
 }
 assert.throws(()=>mountLibraryMixPage(h.host,h.runtime,props),/injected failure/);
 assert.equal(h.host.childNodes.length,0);assert.equal(props.listeners.size,0);assert.equal(h.listeners().length,baseline);
 for(const menu of h.menus)assert.equal(menu.isOpen,false);
});
test('F4 disposed page removes retained input listeners and cannot subscribe a replacement controller',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),props=pageProps(),next=pageProps(),baseline=h.listeners().length;
 const owner=mountLibraryMixPage(h.host,h.runtime,props),title=h.host.querySelector('input'),description=h.host.querySelector('textarea');
 owner.dispose();title.value='Detached title';description.value='Detached description';
 title.dispatchEvent(new h.context.Event('input',{bubbles:true}));description.dispatchEvent(new h.context.Event('input',{bubbles:true}));
 owner.update(next);owner.dispose();assert.equal(props.edits,0);assert.equal(next.edits,0);assert.equal(next.subscriptions,0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const failure of ['later choice','initial subscription','initial read'])test(`F4 saved-order constructor cleans actual controls after ${failure} failure`,async()=>{
 const {mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length;let stops=0;
 if(failure==='later choice')h.runtime.buttonHtml=()=>{throw new Error('injected failure');};
 else if(failure==='initial subscription')h.runtime.subscribePlayback=()=>{throw new Error('injected failure');};
 else{h.runtime.subscribePlayback=()=>()=>{stops++;};h.runtime.readPlayback=()=>{throw new Error('injected failure');};}
 assert.throws(()=>mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('one')),/injected failure/);
 assert.equal(stops,failure==='initial read'?1:0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const replacement of [false,true])test(`F4 synchronous saved-order publication safely ${replacement?'replaces':'retires'} owner before subscription returns`,async()=>{
 const {mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length,stops=[],reads=[],signals=[],callbacks=[];
 h.runtime.subscribePlayback=({playlist_id,onChange})=>{callbacks.push(onChange);if(playlist_id!=='initial')onChange(publication(playlist_id));return()=>stops.push(playlist_id);};
 h.runtime.readPlayback=({playlist_id,signal})=>{reads.push(playlist_id);signals.push(signal);return new Promise(()=>{});};
 const owner=mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('initial'));let once=true;
 h.runtime.canTrackIntent=()=>{if(once){once=false;if(replacement)owner.update(savedProps('replacement'));else owner.dispose();}return true;};
 owner.update(savedProps('outer'));
 assert.ok(stops.includes('initial'));assert.ok(stops.includes('outer'));assert.equal(reads.includes('outer'),false);
 if(replacement){assert.deepEqual(reads,['initial','replacement']);assert.equal(signals[1].aborted,false);}else assert.deepEqual(reads,['initial']);
 const before=reads.length;callbacks[1](publication('outer'));assert.equal(reads.length,before);
 owner.dispose();assert.equal(stops.filter(id=>id==='outer').length,1);assert.ok(signals.every(signal=>signal.aborted));assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const kind of ['page','saved'])test(`F4 ${kind} throwing unsubscribe retains first error after releasing all siblings`,async()=>{
 const {mountLibraryMixPage,mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length,error=new Error('unsubscribe failed');let stops=0;
 const stop=()=>{stops++;throw error;};let owner;
 if(kind==='page')owner=mountLibraryMixPage(h.host,h.runtime,pageProps({subscribe:()=>stop}));
 else{h.runtime.subscribePlayback=()=>stop;owner=mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('one'));}
 const trigger=h.host.querySelector('.ui-choice__trigger');if(!trigger.disabled)h.click(trigger);
 assert.throws(()=>owner.dispose(),value=>value===error);assert.equal(stops,1);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
 for(const menu of h.menus)assert.equal(menu.isOpen,false);assert.doesNotThrow(()=>owner.dispose());
});
test('F4 page construction keeps original renderer error when subscription cleanup also throws',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,original=new Error('render failed');
 let armed=false;const alert=h.runtime.alertHtml;
 const props=pageProps({subscribe:()=>{armed=true;return()=>{throw new Error('cleanup failed');};},getSnapshot:()=>({resource:{status:'error'},mutation:{status:'idle'},coverage:{}})});
 h.runtime.alertHtml=value=>{if(armed)throw original;return alert(value);};
 assert.throws(()=>mountLibraryMixPage(h.host,h.runtime,props),error=>error===original);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
test('F4 page synchronous replacement subscription releases returned disposer after render retires page',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,first=pageProps();let stops=0,armed=false;
 const owner=mountLibraryMixPage(h.host,h.runtime,first),action=h.runtime.actionHtml;
 h.runtime.actionHtml=value=>{if(armed&&value.label==='Play'){armed=false;owner.dispose();}return action(value);};
 const next=pageProps({subscribe(fn){armed=true;fn();return()=>{stops++;};}});
 owner.update(next);assert.equal(stops,1);assert.equal(first.listeners.size,0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
