'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const {readRepo}=require('./native-home-harness.cjs');
const {pathToFileURL}=require('node:url');
const {entryEnvironment,nativeShell,deferred,drain,load}=require('./native-entry-fixtures/actual-native-runtime.cjs');
let sequence=0;
const friends=()=>({friends:[{account_ref:'friend:one',display_name:'Friend',relationship:'accepted',allowed_actions:{can_view_activity:true,can_remove:true}}],requests:[],profile:null});
async function bootstrap(t,{withNotifications=false,visible=true,playtable=false}={}) {
  const h=entryEnvironment(t),home=nativeShell(h,{visible:false,scopeKey:'account/library'}),host=h.add('home-friends-root');
  const sources=[],recentOwners=[];let mounts=0;
  vm.runInContext(readRepo('music_app/static/js/unfolding-action-button.js'),h.context);
  Object.assign(home.runtime,{viewChooserHtml:options=>h.context.UnfoldingActionButton.render(options),mountViewChooser:(node,options)=>h.context.UnfoldingActionButton.mount(node,options),viewIconHtml:value=>{const node=h.document.createElement('div');node.innerHTML=h.owner('buildGalleryBarHtml')({});return node.querySelector(`[data-gallery-view-choice="${value}"] svg`)?.outerHTML||'';}});
  const realMount=home.runtime.mountRecent;
  home.runtime.mountRecent=(node,options)=>{mounts++;const real=realMount(node,options),record={real,node,options,disposals:0};recentOwners.push(record);return {...real,dispose(){record.disposals++;real.dispose();}};};
  home.runtime.openFriendRequestForm=options=>home.runtime.openForm(options);
  const registry={registerSource(options){const record={...options,records:[],disposed:false};sources.push(record);return {replace(rows){record.records=rows;},dispose(){record.disposed=true;record.records=[];}};}};
  h.context.AlbumHavenHomeRuntime=home.runtime;
  if(withNotifications)h.context.AlbumHavenNotifications=registry;
  const native=nativeShell(h,{visible:false,scopeKey:'scope'});
  Object.assign(native.runtime,{canOpenPlaytableForm:()=>true,configurePlaybackPreferences(){},playtableFormRuntime:()=>h.runtime});
  if(playtable)h.context.AlbumHavenPlaylistRuntime=native.runtime;
  await import(`${pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/index-native.mjs')).href}?bootstrap-migration=${++sequence}`);
  const api=h.context.AlbumHavenHomeUI;
  let started=false;
  const start=async()=>{if(!started){started=true;home.change({visible});}await drain();};
  t.after(()=>home.change({visible:false,authenticated:false,scopeKey:null}));
  return {...h,host,home,native,api,runtime:home.runtime,sources,recentOwners,start,
    playlistApi:h.context.AlbumHavenPlaylistUI,playtableApi:h.context.AlbumHavenPlaytableUI,
    flushFrames(){let turns=0;while(h.frames.size){assert.ok(turns++<40,'native frame work settles');const callbacks=[...h.frames.values()];h.frames.clear();for(const fn of callbacks)fn(0);}},
    setShell:home.change,get recentReads(){return home.calls.recent.length;},get mounts(){return mounts;},
    installNotifications(){h.context.AlbumHavenNotifications=registry;h.context.dispatchEvent(new h.context.Event('albumhaven:notifications-ready'));},
  };
}
function selection(){const abort=new AbortController(),instance={};let disposed=0;return {
  packet:{scopeKey:'scope',row_keys:['row'],origin:{tableKey:'album',target:'selection'}},
  lifetime:{signal:abort.signal,isCurrent:()=>!abort.signal.aborted,dispose(){disposed++;abort.abort();},subscribeInvalidation:()=>()=>{}},
  source:{snapshot:()=>({scopeKey:'scope',instance,revision:'one',rows:[{rowKey:'row',readable:true,selectable:true}]}),resolveRows:()=>[{rowKey:'row',track_ref:'track:one'}],subscribe:()=>()=>{}},
  disposed:()=>disposed,
};}
const destinations=({scopeKey})=>({status:'empty',data:{scopeKey,destinations:[],allowed_actions:{}}});

test('shared picker bootstrap admits one exact source receipt and retires it synchronously on provider replacement',async t=>{
  const h=await bootstrap(t,{playtable:true}),s=selection(),pinned=[];let admitted,released=0;
  h.native.runtime.playtableFormRuntime=current=>{admitted=current;return h.runtime;};
  h.runtime.retainPlaytablePresentation=scope=>{pinned.push(scope);return()=>released++;};
  await h.start();h.playlistApi.configureProviders({readPlaylistDestinations:destinations});const before=new Set(h.document.body.childNodes);
  assert.equal(h.playtableApi.open(s.packet,s.lifetime,s.source),true);assert.equal(admitted(),true);assert.equal(h.modal().hidden,false);
  const hosts=h.document.body.childNodes.filter(node=>!before.has(node));assert.equal(hosts.length,1);
  assert.deepEqual(pinned,['account/library']);assert.equal(h.playtableApi.open(s.packet,s.lifetime,s.source),false);
  h.playlistApi.configureProviders({readPlaylistDestinations:destinations});assert.equal(s.disposed(),1);assert.equal(admitted(),false);assert.equal(released,1);
  await drain();assert.equal(h.modal().hidden,true);assert.equal(hosts[0].isConnected,false);
});
test('shared picker bootstrap refuses expired, foreign-scope and already-owned native forms before acquiring a native owner',async t=>{
  const h=await bootstrap(t,{playtable:true}),s=selection(),before=new Set(h.document.body.childNodes);
  assert.equal(h.playtableApi.open(s.packet,{isCurrent:()=>false},s.source),false);
  assert.equal(h.playtableApi.open(s.packet,s.lifetime,{snapshot:()=>({scopeKey:'other'})}),false);
  h.native.runtime.canOpenPlaytableForm=()=>false;assert.equal(h.playtableApi.open(s.packet,s.lifetime,s.source),false);
  assert.deepEqual(h.document.body.childNodes.filter(node=>!before.has(node)),[]);assert.equal(h.modal().hidden,true);
});
test('public provider replacement retires active reads and writes before replacement acquisition',async t=>{
  const h=await bootstrap(t),oldRead=deferred(),oldWrite=deferred(),signals=[];let oldReads=0,newReads=0;
  h.api.configureProviders({readFriends:()=>{oldReads++;return friends();},readActivity:args=>{assert.equal(args.account_ref,'friend:one');signals.push(args.signal);return oldRead.promise;},removeFriend:args=>{signals.push(args.signal);return oldWrite.promise;}});
  await h.start();
  // Acquire the genuine mutation through the directory confirmation, then
  // select private friend activity while that write is still pending.
  h.click(h.host.querySelector('[data-home-open-friends]'));await drain();h.click(h.button(h.content(),'Unfriend'));await drain();
  h.click(h.document.getElementById('app-confirm-accept'));await drain();
  h.setShell({section:'friends',friendRef:'friend:one'});await drain();
  assert.equal(signals.length,2);assert.ok(signals.every(signal=>!signal.aborted));
  const previous=h.recentOwners.at(-1),header=h.host.querySelector('[data-shared-header]'),oldCount=oldReads,recent=h.recentReads;
  h.api.configureProviders({readFriends:request=>{assert.equal(request.scopeKey,'account/library');assert.ok(signals.every(signal=>signal.aborted));assert.equal(previous.disposals,1);newReads++;return friends();}});
  assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));assert.equal(header.isConnected,false);assert.equal(newReads,1);
  assert.equal(oldReads,oldCount);assert.equal(h.recentReads,recent+1);
  const current=h.host.querySelector('[data-shared-header]');assert.equal(h.home.listeners.size,1,'one current shell owner');h.api.refresh();assert.equal(newReads,2);assert.equal(oldReads,oldCount);
  oldRead.resolve({rows:[{id:'private-old',kind:'album',title:'Old account data'}]});oldWrite.resolve({ok:true});await drain();
  assert.doesNotMatch(h.host.textContent,/Old account data/);assert.equal(oldReads,oldCount);assert.equal(newReads,2);assert.equal(h.host.querySelector('[data-shared-header]'),current);
  previous.real.dispose();h.api.refresh();assert.equal(newReads,3);assert.equal(h.host.querySelector('[data-shared-header]'),current);
});
test('the visible Home controller forwards normalized Friends authority to the native retirement owner',async t=>{
  const h=await bootstrap(t),records=[];h.runtime.retireFriendActivity=packet=>records.push(packet);
  h.api.configureProviders({readFriends:friends});await h.start();const record=records.at(-1);
  assert.equal(record.scopeKey,'account/library');assert.equal(record.friends.status,'ready');assert.equal(record.friends.data.friends[0].account_ref,'friend:one');
  assert.equal(record.friends.data.friends[0].allowed_actions.can_view_activity,true);const count=records.length;
  h.setShell({visible:false});assert.equal(records.length,count);
});
test('invalid provider configuration leaves the active controller usable and mount stays idempotent',async t=>{
  const h=await bootstrap(t);let reads=0;h.api.configureProviders({readFriends:()=>{reads++;return friends();}});await h.start();
  const header=h.host.querySelector('[data-shared-header]'),mounts=h.mounts,html=h.host.innerHTML;
  for(const value of [null,[],1,'providers'])assert.throws(()=>h.api.configureProviders(value),/must be an object/);
  assert.equal(h.host.querySelector('[data-shared-header]'),header);assert.equal(h.host.innerHTML,html);assert.equal(h.mounts,mounts);assert.equal(h.home.listeners.size,1);
  const before=reads;h.api.refresh();assert.equal(reads,before+1);h.context.dispatchEvent(new h.context.Event('albumhaven:home-runtime-ready'));assert.equal(h.mounts,1);
});
test('the public bootstrap sends activity authority only through the native sanitized reader',async t=>{
  const h=await bootstrap(t),rawReader=()=>assert.fail('Raw reader must remain behind native boundary.'),resolveActivityTrack=()=>assert.fail('Presentation cannot resolve private media authority.');let safeReads=0;
  h.runtime.configureActivityProvider=input=>{assert.equal(input.readActivity,rawReader);assert.equal(input.resolveActivityTrack,resolveActivityTrack);return()=>{safeReads++;return {rows:[{id:'public:one',kind:'track',title:'Safe projection'}]};};};
  h.api.configureProviders({readActivity:rawReader,resolveActivityTrack});h.setShell({presentation:{kind:'tracks',kindExplicit:true,period:'week'}});await h.start();
  assert.equal(safeReads,1);assert.match(h.host.textContent,/Safe projection/);
});
test('a runtime without the native activity boundary leaves activity unavailable',async t=>{
  const h=await bootstrap(t);delete h.runtime.configureActivityProvider;
  h.api.configureProviders({readActivity:()=>assert.fail('Raw authority cannot bypass a missing boundary.')});h.setShell({presentation:{kind:'tracks',kindExplicit:true,period:'week'}});await h.start();
  assert.match(h.host.textContent,/unavailable|not available|not connected/i);assert.equal(h.host.querySelector('.home-activity'),null);
});
test('the notification portal stays mounted outside Home without retaining its controller',async t=>{
  const h=await bootstrap(t,{withNotifications:true});let reads=0;h.api.configureProviders({readFriends:()=>{reads++;return friends();}});await h.start();
  const source=h.sources.at(-1),recent=h.recentReads,before=reads;await source.onShow();assert.equal(reads,before);
  h.setShell({visible:false});assert.equal(h.host.childNodes.length,0);assert.equal(source.disposed,false);assert.equal(reads,before+1);
  await source.onShow();assert.equal(reads,before+1);assert.equal(h.recentReads,recent);h.api.refresh();assert.equal(reads,before+2);assert.equal(h.recentReads,recent);
  h.setShell({authenticated:false});assert.equal(source.disposed,true);
});
test('a late native registry installation reuses the mounted Home controller and snapshot',async t=>{
  const h=await bootstrap(t);let reads=0;h.api.configureProviders({readFriends:()=>{reads++;return friends();}});await h.start();
  const header=h.host.querySelector('[data-shared-header]'),count=reads,recent=h.recentReads;
  h.installNotifications();assert.equal(h.host.querySelector('[data-shared-header]'),header);assert.equal(reads,count);assert.equal(h.recentReads,recent);assert.equal(h.sources.length,1);assert.equal(h.home.listeners.size,2,'one Home and one notification shell owner');
  await h.sources[0].onShow();assert.equal(reads,count);h.installNotifications();assert.equal(h.sources.length,1);
});
test('outside-Home provider replacement retires notification reads before replacement acquisition',async t=>{
  const h=await bootstrap(t,{withNotifications:true,visible:false}),pending=deferred();let signal,replacements=0;
  h.api.configureProviders({readFriends:args=>{signal=args.signal;return pending.promise;},readActivity:()=>assert.fail('Notification cannot start private activity read.')});
  const old=h.sources.at(-1);await h.start();assert.equal(h.host.childNodes.length,0);assert.equal(h.recentReads,0);
  h.api.configureProviders({readFriends:()=>{assert.equal(signal.aborted,true);assert.equal(old.disposed,true);replacements++;return friends();}});
  assert.equal(signal.aborted,true);assert.equal(old.isCurrent(),false);assert.equal(old.disposed,true);assert.equal(replacements,1);
  pending.resolve(friends());await drain();assert.equal(old.records.length,0);assert.equal(h.recentReads,0);h.setShell({authenticated:false});
});
test('Home history entries preserve member profile authority and retire prior private reads through route selection',async t=>{
  const h=await bootstrap(t),pending=deferred();let signal,profiles=0,reads=0;
  h.api.configureProviders({readFriends:()=>{reads++;return {...friends(),allowed_actions:{can_discover_members:true}};},
    readMembers:()=>({members:[{account_ref:'member:one',display_name:'Member',relationship:'none',allowed_actions:{can_view_profile:true}}],next_cursor:null}),
    readActivity:args=>{signal=args.signal;return pending.promise;},readProfile:({account_ref})=>{assert.equal(account_ref,'member:one');profiles++;return {account_ref,display_name:'Member',relationship:'none',allowed_actions:{can_view_profile:true}};}});
  await h.start();h.click(h.host.querySelector('[data-home-open-friends]'));await drain();
  h.click(h.content().querySelector('[data-in-page-tab="people"]'));h.flushFrames();await drain();const form=h.content().querySelector('form[aria-label="Search people"]');assert.ok(form);
  h.input(form.querySelector('input'),'Member');form.dispatchEvent(new h.context.Event('submit',{bubbles:true}));await drain();
  h.click(h.document.getElementById('app-form-cancel'));await drain();assert.equal(h.modal().hidden,true,'actual native directory dismissal completes before routing');h.setShell({section:'friends',friendRef:'friend:one'});await drain();
  const old=h.host.querySelector('[data-shared-header]'),count=reads;assert.equal(signal.aborted,false);
  h.setShell({entryKey:'entry:two',section:'friends',profileRef:'member:one',friendRef:''});await drain();
  assert.equal(old.isConnected,false);assert.notEqual(h.host.querySelector('[data-shared-header]'),old);assert.equal(reads,count);assert.equal(signal.aborted,true);assert.equal(profiles,1);
  assert.match(h.host.querySelector('.home-member-profile').textContent,/Member/);pending.resolve({rows:[{id:'stale',kind:'track',title:'Old friend history'}]});await drain();assert.doesNotMatch(h.host.textContent,/Old friend history/);
});

// Split the old combined React-prop observation across the actual authority
// owner and the public native entry wiring. No private entry capture seam.
test('the actual Friends authority owner publishes its exact snapshot resource and remains silent on disposal',async t=>{
  const {createHomeFriendsController}=await load('home-friends/model.mjs'),records=[];
  const controller=createHomeFriendsController({providers:{readFriends:friends},onFriendsAuthority:packet=>records.push(packet)});
  t.after(()=>controller.dispose());controller.setScope('account/library');
  await controller.loadFriends();
  assert.ok(records.length>0);assert.equal(records.at(-1).scopeKey,'account/library');
  assert.equal(records.at(-1).friends,controller.getSnapshot().friends);
  assert.equal(controller.getSnapshot().friends.status,'ready');
  const count=records.length;controller.dispose();assert.equal(records.length,count);
});
