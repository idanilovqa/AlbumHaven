'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load,deferred,settle}=require('./home-friends-native-app-fixture.cjs');
const friendData=()=>({profile:{display_name:'Me',handle:'self',bio:'',allowed_actions:{can_edit:true}},friends:[],requests:[],allowed_actions:{}});
async function home(t,{failFriends=false}={}){
  const h=fixture(t),{createHomeFriendsController}=await load('model.mjs'),{mountHomeFriendsView}=await load('app.mjs');
  const reads=[],saved=[],queueListeners=new Set(),controllerListeners=new Set();let range='Initial range',released=0;
  const canonical=createHomeFriendsController({providers:{readFriends:async()=>friendData(),readActivity:async request=>{reads.push(request);return {rows:[],snapshot_ref:range,range_label:range};}}});const controller={...canonical,subscribe(fn){controllerListeners.add(fn);const release=canonical.subscribe(fn);return ()=>{controllerListeners.delete(fn);release();};}};controller.setScope('scope:one');await controller.loadFriends();
  const api={getSnapshot:()=>({entries:[],enabled:true,revision:0}),subscribe(fn){queueListeners.add(fn);return ()=>{released++;queueListeners.delete(fn);};}};
  Object.assign(h.runtime,{snapshot:()=>({scopeKey:'scope:one'}),explicitQueue:()=>api,savePresentation:value=>saved.push(value),navigate(){}});
  const props={runtime:h.runtime,controller,state:controller.getSnapshot(),shell:{section:'recent',friendRef:'',profileRef:'',presentation:{kind:'tracks',kindExplicit:true}}};
  const failure=new Error('late Friends renderer failure'),action=h.runtime.actionHtml;
  if(failFriends)h.runtime.actionHtml=value=>{if(value.label==='Friends')throw failure;return action(value);};
  let owner;const unsubscribe=controller.subscribe(()=>owner?.update({...props,state:controller.getSnapshot()}));
  t.after(()=>{unsubscribe();controller.dispose();});
  return {...h,props,controller,reads,saved,queueListeners,controllerListeners,releaseCount:()=>released,failure,
    mount(){owner=h.own(mountHomeFriendsView(h.host,props));return owner;},
    async reload(){range='Replacement range';await controller.loadActivity({kind:'tracks',period:'week'});await settle();}};
}
function headersRetired(h){assert.ok(h.observers.length>=5,'real shared headers acquired observers');assert.ok(h.observers.every(value=>!value.connected),'all acquired header/menu observers disconnected');assert.equal(h.queueListeners.size,0);assert.equal(h.releaseCount(),1);assert.equal(h.controllerListeners.size,1,'only root subscription survives; all view-owned subscribers retired');}

test('full Home late constructor failure releases all headers, queued frames and explicit queue subscription',async t=>{
  const h=await home(t,{failFriends:true});assert.throws(()=>h.mount(),error=>error===h.failure);
  headersRetired(h);assert.equal(h.host.childNodes.length,0);assert.equal(h.reads.length,0);assert.equal(h.saved.length,0);
  await settle();h.drain();assert.equal(h.host.childNodes.length,0);assert.equal(h.reads.length,0);assert.equal(h.frames.size,0);
});

test('actual native form focus retires Home before its dialog acquisition returns',async t=>{
  const h=await home(t),owner=h.mount();await settle();h.drain();
  let focusEvents=0,atRetirement;
  const focus=event=>{if(event.target.closest('.home-friends__profile-editor')){focusEvents++;atRetirement={reads:h.reads.length,saved:h.saved.length};owner.dispose();}};
  h.document.addEventListener('focusin',focus);t.after(()=>h.document.removeEventListener('focusin',focus));
  h.click(h.named('Edit profile',h.host));await settle();
  assert.equal(focusEvents,1,'real form helper synchronously dispatched focusin');headersRetired(h);
  assert.equal(h.form.hidden,true);assert.equal(h.document.querySelectorAll('.home-friends__profile-editor').length,0);assert.equal(h.host.childNodes.length,0);
  assert.equal(h.reads.length,atRetirement.reads);assert.equal(h.saved.length,atRetirement.saved,'finishRender cannot save after focus retirement');
  h.drain();assert.equal(h.host.childNodes.length,0);assert.equal(h.form.hidden,true);
});

test('actual Choice close focus retires Home during a parent update without late presentation work',async t=>{
  const h=await home(t),owner=h.mount();await settle();h.drain();
  const trigger=h.host.querySelector('.home-friends__period button');assert.ok(trigger);h.click(trigger);
  assert.ok(h.document.querySelector('[role="menu"]'));let retired=false,saves;
  const focus=event=>{if(event.target===trigger){retired=true;saves=h.saved.length;owner.dispose();}};
  h.document.addEventListener('focusin',focus);t.after(()=>h.document.removeEventListener('focusin',focus));
  await h.reload();assert.equal(retired,true,'native choice close restored focus during period update');headersRetired(h);
  assert.equal(h.saved.length,saves);assert.equal(h.host.childNodes.length,0);assert.equal(h.document.querySelector('[role="menu"]'),null);
  await settle();h.drain();assert.equal(h.host.childNodes.length,0);
});

for(const point of ['second-subscription','late-choice'])test(`library navigation ${point} failure retires prior subscriptions and internal reads`,async t=>{
  const h=fixture(t),{mountLibraryNavigation}=await load('library-navigation.mjs'),listeners=new Set(),playlistListeners=new Set(),reads=[],pending=deferred(),failure=new Error(point);
  const runtime={...h.runtime,snapshot:()=>({authenticated:true,inLibrary:true,sidebarMode:'playlists',scopeKey:'scope:one'}),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},selectSidebar(){}};
  const playlistRuntime={...h.runtime,snapshot:()=>({scopeKey:'scope:one',visible:false}),subscribe(fn){if(point==='second-subscription')throw failure;playlistListeners.add(fn);return ()=>playlistListeners.delete(fn);},readSidebarDirectory(request){reads.push(request);return pending.promise;},navigate:async()=>{}};
  if(point==='late-choice')runtime.buttonHtml=()=>{throw failure;};
  const playlistHost=h.add('playlist-sidebar-test');assert.throws(()=>mountLibraryNavigation({host:h.host,playlistHost,runtime,playlistRuntime}),error=>error===failure);
  assert.equal(listeners.size,0);assert.equal(playlistListeners.size,0);assert.equal(h.host.childNodes.length,0);assert.equal(playlistHost.childNodes.length,0);
  if(point==='late-choice'){assert.equal(reads.length,1);assert.equal(reads[0].signal.aborted,true);}else assert.equal(reads.length,0);
  pending.resolve({items:[]});await settle();assert.equal(h.host.childNodes.length,0);assert.equal(playlistHost.childNodes.length,0);
});

test('detail projection failure after native lease acquisition releases it exactly once before any provider read',async t=>{
  const h=fixture(t),{mountResourceDetail}=await load('resource-detail.mjs'),failure=new Error('projection unavailable renderer failed');
  let lease,disposals=0,reads=0,notifications=0;
  h.runtime.mountResourceSelection=(_host,options)=>{lease=options;return {dispose(){disposals++;}};};
  h.runtime.alertHtml=()=>{throw failure;};
  assert.throws(()=>mountResourceDetail(h.host,h.runtime,{scopeKey:'scope:one',selection:{kind:'album',ref:'album:one',allowed_actions:{can_view_details:true}},readDetail(){reads++;return Promise.resolve({status:'empty'});},onDetailChange(){notifications++;}}),error=>error===failure);
  assert.equal(disposals,1);assert.equal(reads,0);assert.equal(notifications,0);assert.equal(h.host.childNodes.length,0);
  lease.onState('ready');lease.onError(new Error('stale'));await settle();assert.equal(disposals,1);assert.equal(reads,0);assert.equal(h.host.childNodes.length,0);
});

test('unreturned ready detail panel releases controls when its final track table renderer throws',async t=>{
  const h=fixture(t),{mountDetailProjectionPanel}=await load('detail-projection-ui.mjs'),failure=new Error('late tracks failed'),baseline=h.listeners().length;let retained=[];
  h.runtime.tableHtml=()=>{retained=h.host.querySelectorAll('button');throw failure;};
  const selection={kind:'album',ref:'album:one',allowed_actions:{can_view_details:true}},data={kind:'album',ref:'album:one',title:'Album',tracks:[],artist:'Artist',track_count:0,duration_seconds:0};
  assert.throws(()=>mountDetailProjectionPanel(h.host,h.runtime,{selection,value:{status:'ready',data},canIntent:()=>true,onIntent(){throw new Error('retired control acted');}}),error=>error===failure);
  assert.ok(retained.length>0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);retained.forEach(button=>h.click(button));
});
