'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load,deferred,settle}=require('./home-friends-native-app-fixture.cjs');
function store(initial){let state=initial;const listeners=new Set();return {getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},set(next){state=next;for(const fn of [...listeners])fn();},listenerCount:()=>listeners.size,mutate:async(action,target)=>({status:'ready',action,target}),loadFriends:async()=>{}};}
const person=(ref,extra={})=>({account_ref:ref,display_name:ref,handle:'member',bio:'',avatar_url:null,relationship:'accepted',allowed_actions:{can_view_profile:true,can_view_activity:true,can_remove:true},...extra});
const incoming=()=>person('member:one',{request_ref:'request:one',direction:'incoming',relationship:'incoming_pending',allowed_actions:{can_accept:true,can_decline:true,can_view_profile:true}});
function state(){return {scopeKey:'scope:one',friends:{status:'ready',data:{profile:person('self',{display_name:'Me',handle:'self',allowed_actions:{can_edit:true}}),friends:[],requests:[incoming()],allowed_actions:{can_discover_members:true}}},mutation:{status:'idle'},members:{status:'idle',data:null},memberQuery:'',profile:{status:'idle',data:null}};}

for(const afterMount of [false,true])test(`hosted failed request ${afterMount?'after':'before'} mount unsubscribes immediately and keeps Close`,async t=>{
  const h=fixture(t),{mountFriendRequestDialog}=await load('friend-request.mjs'),controller=store(state()),nativeOpen=h.runtime.openForm;
  let closes=0,retained=[];const pending=deferred();controller.mutate=()=>pending.promise;
  h.runtime.openForm=options=>{if(afterMount){nativeOpen(options);retained=h.form.querySelectorAll('button');const accept=h.named('Accept request',h.form);h.click(accept);}return null;};
  const owner=h.own(mountFriendRequestDialog(h.host,h.runtime,{controller,requestRef:'request:one',onClose:()=>closes++}));
  assert.equal(controller.listenerCount(),0,'failed opening retires the view subscription before fallback closure');
  assert.equal(h.document.querySelectorAll('.home-friend-request').length,0);assert.match(h.host.textContent,/not available right now/);
  controller.set(state());retained.forEach(button=>h.click(button));pending.resolve({status:'ready',action:'acceptRequest',target:'request:one'});await settle();assert.equal(closes,0,'late mutation cannot close or reactivate fallback');
  const close=h.named('Close',h.host);assert.ok(close);h.click(close);assert.equal(closes,1);assert.equal(h.host.childNodes.length,0);owner.dispose();assert.equal(controller.listenerCount(),0);
});

for(const kind of ['request','profile','directory'])test(`unreturned ${kind} constructor unwinds actual children and subscriptions`,async t=>{
  const h=fixture(t),controller=store(state()),baseline=h.listeners().length,failure=new Error(`${kind} initial render failed`);
  let retained=[],factory,props,seen=0;
  const fail=()=>{retained=h.host.querySelectorAll('button');throw failure;};
  if(kind==='request'){
    factory=(await load('friend-request.mjs')).mountFriendRequestContent;props={state:controller.getSnapshot(),requestRef:'request:one'};
    const render=h.runtime.buttonHtml;h.runtime.buttonHtml=value=>value.label==='Close'?fail():render(value);
  }else if(kind==='profile'){
    factory=(await load('profile.mjs')).mountProfileEditor;props={controller,profile:controller.getSnapshot().friends.data.profile};
    const render=h.runtime.artboxHtml;h.runtime.artboxHtml=value=>++seen===2?fail():render(value);
    // Cleanup failure must not strand children or mask the renderer's cause.
    const subscribe=controller.subscribe;controller.subscribe=fn=>{const release=subscribe(fn);return ()=>{release();throw new Error('secondary unsubscribe failure');};};
  }else{
    factory=(await load('friends-directory.mjs')).mountFriendsDirectory;const value=state();value.friends.data.friends=[person('friend:one')];controller.set(value);props={controller,value:value.friends};
    h.runtime.navigationItemHtml=fail;
  }
  assert.throws(()=>factory(h.host,h.runtime,props),error=>error===failure);
  assert.equal(controller.listenerCount(),0);assert.equal(h.host.childNodes.length,0);
  assert.equal(h.listeners().length,baseline,'detached actual control listeners are all removed');
  retained.forEach(button=>h.click(button));controller.set(state());assert.equal(h.host.childNodes.length,0);
});

for(const failureMode of ['null','undefined','no-close','throw','after-mount'])test(`actual notification producer retires ${failureMode} native opening and permits deliberate retry`,async t=>{
  const h=fixture(t),{createHomeFriendsController}=await load('model.mjs'),{createFriendNotifications}=await load('friend-notifications.mjs'),{mountFriendNotifications}=await load('friend-notifications-ui.mjs');
  const readFriends=async()=>state().friends,canonical=createHomeFriendsController({providers:{readFriends}});canonical.setScope('scope:one');await canonical.loadFriends();
  assert.equal(canonical.getSnapshot().friends.status,'ready','request fixture passed canonical normalization');
  let subscriptions=0;const controller={...canonical,subscribe(fn){subscriptions++;const release=canonical.subscribe(fn);let active=true;return ()=>{if(active){active=false;subscriptions--;release();}};}};
  let registration,mode=failureMode,opens=0;const runtimeListeners=new Set(),nativeOpen=h.runtime.openForm;
  const runtime={...h.runtime,snapshot:()=>({authenticated:true,visible:true,scopeKey:'scope:one'}),subscribe(fn){runtimeListeners.add(fn);return ()=>runtimeListeners.delete(fn);},
    openFriendRequestForm(options){opens++;if(mode==='success')return nativeOpen(options);if(mode==='after-mount'){nativeOpen(options);return null;}if(mode==='throw')throw new Error('native opening threw');if(mode==='no-close')return {};return mode==='null'?null:undefined;}};
  const notifications={registerSource(options){registration=options;return {replace(){},dispose(){}};}};
  const producer=h.own(createFriendNotifications({runtime,notifications,providers:{readFriends}})),releaseHome=producer.useHome(controller),view=h.own(mountFriendNotifications({producer}));
  t.after(()=>{releaseHome();canonical.dispose();});
  assert.equal(subscriptions,1,'only canonical producer subscription before opening');
  assert.equal(registration.onOpen('request:one',{parentSurface:'#cover-lookup-drawer'}),true);await settle();
  assert.equal(opens,1);assert.equal(producer.getSnapshot().dialog,null,'failed hostless dialog explicitly dismissed');assert.equal(subscriptions,1,'failed view subscription retired without disposing root controller');
  assert.equal(h.document.querySelectorAll('.home-friend-request').length,0);assert.equal(h.form.hidden,true);
  mode='success';assert.equal(registration.onOpen('request:one',{parentSurface:'#cover-lookup-drawer'}),true);await settle();
  assert.equal(opens,2);assert.ok(producer.getSnapshot().dialog);assert.equal(subscriptions,2);assert.equal(h.form.hidden,false);
  h.click(h.named('Close',h.form));await settle();assert.equal(producer.getSnapshot().dialog,null);assert.equal(subscriptions,1);
  view.dispose();releaseHome();producer.dispose();assert.equal(subscriptions,0);assert.equal(runtimeListeners.size,0);
});
