'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {entryEnvironment,nativeShell,friendsPayload,playlistPayload,registry,load,deferred,drain} = require('./native-entry-fixtures/actual-native-runtime.cjs');
let entrySequence=0;
const boot = async env => import(`${pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/index-native.mjs')).href}?entry-test=${++entrySequence}`);
function home(t, patch={}) {
  const env=entryEnvironment(t), shell=nativeShell(env,patch), host=env.add('home-friends-root');
  env.context.AlbumHavenHomeRuntime=shell.runtime;
  t.after(()=>shell.change({visible:false,authenticated:false,scopeKey:null}));
  return {...env,...shell,host};
}
function hasHeader(host) {return Boolean(host.querySelector('[data-shared-header]'));}

// Every import below is the actual assembled native entry/owner. Tests supply
// only platform geometry, native bridge inputs and external DTO responses.
test('Home entry keeps notifications alive while hidden and transfers authority without duplicate sources',async t=>{
  const h=home(t), notifications=registry(), reads=[];
  h.context.AlbumHavenNotifications=notifications;
  h.runtime.openFriendRequestForm=options=>h.runtime.openForm(options);
  await boot(h);
  h.context.AlbumHavenHomeUI.configureProviders({readFriends:request=>{reads.push(request);return Promise.resolve(friendsPayload());}});
  await drain();
  assert.equal(h.calls.recent.length,0); assert.equal(h.host.childNodes.length,0);
  assert.equal(notifications.sources.filter(source=>!source.disposed).length,1);
  assert.ok(reads.length>0,'background producer performs a genuine controller read');
  h.change({visible:true});await drain();
  assert.ok(hasHeader(h.host));assert.equal(notifications.sources.filter(source=>!source.disposed).length,1);
  const before=reads.length;h.change({visible:false});await drain();
  assert.equal(h.host.childNodes.length,0);assert.ok(reads.length>before,'hidden producer resumes bounded background authority');
  h.change({authenticated:false,scopeKey:null});await drain();
  assert.ok(notifications.sources.every(source=>source.disposed));
});

test('Home history entry remounts view but preserves same-account controller reads',async t=>{
  const h=home(t);let friends=0;
  await boot(h);h.context.AlbumHavenHomeUI.configureProviders({readFriends:async()=>{friends++;return friendsPayload('History owner');}});
  h.change({visible:true});await drain();
  const first=h.host.querySelector('[data-shared-header]'),reads=friends;
  assert.ok(first);h.change({entryKey:'entry:two'});await drain();
  assert.equal(first.isConnected,false);assert.notEqual(h.host.querySelector('[data-shared-header]'),first);
  assert.equal(friends,reads,'history entry must not recreate account controller');
  h.change({visible:false});await drain();h.change({visible:true});await drain();
  assert.equal(friends,reads+1,'leaving Home retires account session');
});

test('Home account/provider changes abort old reads and reject late profile content',async t=>{
  const h=home(t),old=deferred(),requests=[];
  await boot(h);h.context.AlbumHavenHomeUI.configureProviders({readFriends:request=>{requests.push(request);return old.promise;}});
  h.change({visible:true});await drain();assert.equal(requests.length,1);
  h.context.AlbumHavenHomeUI.configureProviders({readFriends:async()=>friendsPayload('New provider')});await drain();
  assert.equal(requests[0].signal.aborted,true);
  old.resolve(friendsPayload('Retired provider'));await drain();
  assert.match(h.host.textContent,/New provider/);assert.doesNotMatch(h.host.textContent,/Retired provider/);
  const previous=h.host.querySelector('[data-shared-header]');h.change({scopeKey:'account:two:library'});await drain();
  assert.equal(previous.isConnected,false);assert.ok(hasHeader(h.host));
});

test('Home rejects a synchronous hide during actual Recent owner mount',async t=>{
  const h=home(t),mount=h.runtime.mountRecent;let disposed=0,mounts=0;
  h.runtime.mountRecent=(host,options)=>{const owner=mount(host,options);mounts++;h.change({visible:false});return {...owner,dispose(){disposed++;owner.dispose();}};};
  await boot(h);h.change({visible:true});await drain();
  assert.equal(mounts,1);assert.equal(disposed,1);assert.equal(h.host.childNodes.length,0);
  assert.equal(h.calls.recent.length,0,'retired mount cannot start bootstrap reads');
});

test('Home rejects a newer history entry emitted while retiring actual Recent owner',async t=>{
  const h=home(t),mount=h.runtime.mountRecent;let once=true,disposals=0;
  h.runtime.mountRecent=(host,options)=>{const owner=mount(host,options);return {...owner,dispose(){disposals++;owner.dispose();if(once){once=false;h.change({entryKey:'newer-entry'});}}};};
  await boot(h);h.change({visible:true});await drain();
  h.change({entryKey:'superseded-entry'});await drain();
  assert.equal(h.runtime.snapshot().entryKey,'newer-entry');assert.ok(hasHeader(h.host));
  assert.equal(h.host.querySelectorAll('[data-shared-header]').length,5,'one coherent Home view owns all five headers');
  assert.ok(disposals>=1);
});

async function playlists(t, patch={}, providers={}) {
  const h=entryEnvironment(t), shell=nativeShell(h,{visible:true,playlistId:'one',payload:playlistPayload('one'),...patch});
  const {mountPlaylists}=await load('playlists/native.mjs');
  const owner=mountPlaylists({host:h.host,runtime:shell.runtime,providers});t.after(()=>owner.dispose());await drain();
  return {...h,...shell,owner};
}

test('Playlist root suspends hidden/account reads and ignores retired provider results',async t=>{
  const requests=[],pending=deferred();
  const h=await playlists(t,{}, {readPlaylists:request=>{requests.push(request);return pending.promise;}});
  assert.equal(requests.length,1);h.change({visible:false});await drain();
  assert.equal(requests[0].signal.aborted,true);assert.equal(h.host.childNodes.length,0);
  h.owner.configureProviders({readPlaylists:async request=>playlistPayload(request.playlist_id,{title:'New provider'})});
  h.change({visible:true,scopeKey:'account:two:library'});await drain();
  pending.resolve(playlistPayload('one',{title:'Retired provider'}));await drain();
  assert.doesNotMatch(h.host.textContent,/Retired provider/);assert.match(h.host.textContent,/New provider/);
});

test('Playlist root abandons mounting after old view disposal synchronously hides the shell',async t=>{
  const h=await playlists(t);let fire=true,unsubscribed=0,mounted=0;
  // Canonical table preferences call this native subscription seam. The
  // callback models a shell transition caused by releasing native authority.
  h.runtime.subscribeTrackPreferences=()=>{mounted++;return()=>{unsubscribed++;if(fire){fire=false;h.change({visible:false});}};};
  h.owner.configureProviders({});await drain();
  const before=mounted;assert.ok(before>0,'actual table owns preference subscription');
  h.owner.configureProviders({readPlaylists:async request=>playlistPayload(request.playlist_id)});await drain();
  assert.ok(unsubscribed>0);assert.equal(h.runtime.snapshot().visible,false);assert.equal(h.host.childNodes.length,0);
  assert.equal(mounted,before,'superseded shell must not mount replacement table');
});

test('Playlist copy acknowledgement navigates once before synchronous native shell replacement',async t=>{
  let copies=0,reads=0;
  const h=await playlists(t,{}, {readPlaylists:async request=>{reads++;return playlistPayload(request.playlist_id);},copyPlaylist:async()=>{copies++;return {status:'ready',playlist_id:'two'};}});
  h.runtime.navigate=options=>{h.calls.navigate.push(options);h.change({playlistId:options.playlist_id,payload:playlistPayload(options.playlist_id)});return Promise.resolve(true);};
  const copy=h.host.querySelector('[data-playlists-action="copy"]');assert.ok(copy);h.click(copy);await drain();
  assert.equal(copies,1);assert.deepEqual(h.calls.navigate,[{playlist_id:'two'}]);
  assert.equal(h.runtime.snapshot().playlistId,'two');assert.equal(h.host.querySelector('[aria-label="Playlist title"]').value,'two');
  const before=reads;h.change({entryKey:'same-playlist-history'});await drain();
  assert.equal(h.calls.navigate.length,1);assert.equal(reads,before,'history repaint cannot replay an acknowledged copy');
});

function playtableSource(scopeKey) {
  const abort=new AbortController(),listeners=new Set(),instance={};let disposed=0,receipts=0;
  const lifetime={signal:abort.signal,isCurrent:()=>!abort.signal.aborted,dispose(){if(!abort.signal.aborted){disposed++;abort.abort();}},subscribeInvalidation(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const source={snapshot:()=>({scopeKey,instance,revision:'one',rows:[{rowKey:'row:one',readable:true,selectable:true}]}),resolveRows:()=>[{rowKey:'row:one',track_ref:'track:one'}],subscribe:()=>()=>{},retainNavigation(){receipts++;let active=true;return{isCurrent:()=>active,dispose(){active=false;}};}};
  return {packet:{scopeKey,row_keys:['row:one'],origin:{tableKey:'native-test',target:'selection'}},lifetime,source,disposed:()=>disposed,receipts:()=>receipts};
}

test('Entry playlist action synchronous native close retires owner and allows a fresh opening',async t=>{
  const h=home(t),native=nativeShell(h),actual=h.runtime.openForm;let closes=0;
  Object.assign(native.runtime,{canOpenPlaytableForm:()=>true,configurePlaybackPreferences(){},playtableFormRuntime:()=>({...h.runtime,openForm(options){const owner=actual(options);owner.close(false,{force:true,restoreFocus:false});closes++;return owner;}})});
  h.context.AlbumHavenPlaylistRuntime=native.runtime;await boot(h);
  h.context.AlbumHavenPlaylistUI.configureProviders({readPlaylistDestinations:async({scopeKey})=>({status:'empty',data:{scopeKey,destinations:[],allowed_actions:{}}})});
  const anchor=h.add('action-anchor'),first=playtableSource(native.runtime.snapshot().scopeKey);
  assert.equal(h.context.AlbumHavenPlaytableUI.open(first.packet,first.lifetime,first.source,anchor),false);await drain();
  assert.equal(first.disposed(),1);assert.equal(h.modal().hidden,true);
  const second=playtableSource(native.runtime.snapshot().scopeKey);
  assert.equal(h.context.AlbumHavenPlaytableUI.open(second.packet,second.lifetime,second.source,anchor),false);await drain();
  assert.equal(second.disposed(),1);assert.equal(closes,2);
});

test('Entry creation closes actual native form before navigating without prematurely retiring source lifetime',async t=>{
  const h=home(t),native=nativeShell(h),scopeKey=native.runtime.snapshot().scopeKey,selected=playtableSource(scopeKey),writes=[],navigation=[];
  Object.assign(native.runtime,{canOpenPlaytableForm:()=>true,configurePlaybackPreferences(){},playtableFormRuntime:()=>h.runtime,
    navigateFromPlaytable:async options=>{assert.equal(h.modal().hidden,true,'native form closes before navigation');assert.equal(selected.lifetime.isCurrent(),true,'source lives through navigation receipt capture');assert.equal(options.sourceReceipt.isCurrent(),true);navigation.push(options);native.change({visible:false,entryKey:'created-destination'});return true;}});
  h.context.AlbumHavenPlaylistRuntime=native.runtime;await boot(h);
  const source={kind:'library',ref:'source:selection',revision:'r1',allowed_actions:{can_read:true,can_use_for_playlist:true}};
  h.context.AlbumHavenPlaylistUI.configureProviders({
    readPlaylistDestinations:async()=>({status:'ready',data:{scopeKey,destinations:[{playlist_id:'created',title:'Created',revision:'r1',allowed_actions:{can_add:true,can_open:true}}],allowed_actions:{can_create:true}}}),
    beginPlaylistSelectionSource:async()=>({source,entry_refs:['entry:one']}),
    readPlaylistCreationSource:async()=>({status:'ready',data:{scopeKey,mode:'ordinary',source,entries_complete:true,allowed_actions:{can_read:true,can_use_for_playlist:true},entries:[{entry_ref:'entry:one',canonical_track_ref:'canonical:one',title:'Track',artist:'Artist',availability:'local',allowed_actions:{can_read:true,can_select:true}}]}}),
    createPlaylistFromSelection:async request=>{writes.push(request);return{status:'ready',data:{scopeKey,request_key:request.request_key,playlist_id:'created',revision:'r1'}};},
  });
  const anchor=h.add('creation-anchor');
  assert.equal(h.context.AlbumHavenPlaytableUI.open(selected.packet,selected.lifetime,selected.source,anchor,{mode:'create'}),true);await drain();await drain();
  const name=h.content().querySelector('[aria-label="Playlist name"]');assert.ok(name,'actual creation owner is mounted');h.input(name,'Created from selection');
  const form=h.content().querySelector('form[aria-label="Create playlist"]');assert.ok(form);form.dispatchEvent(new h.context.Event('submit'));await drain();await drain();
  assert.equal(writes.length,1);assert.equal(navigation.length,1);assert.equal(navigation[0].playlist_id,'created');
  assert.equal(navigation[0].sourceReceipt.isCurrent(),false,'receipt releases after navigation');assert.equal(selected.disposed(),1);
});

test('Home provider replacement batches reentrant shell emission until the new provider owns the session',async t=>{
  const h=home(t),mount=h.runtime.mountRecent;let replacing=false,mounts=0,oldReads=0,newReads=0;
  h.runtime.mountRecent=(host,options)=>{mounts++;const owner=mount(host,options);return {...owner,dispose(){owner.dispose();if(replacing){replacing=false;h.change({entryKey:'during-provider-retirement'});}}};};
  await boot(h);h.context.AlbumHavenHomeUI.configureProviders({readFriends:async()=>{oldReads++;return friendsPayload('Old owner');}});
  h.change({visible:true});await drain();const before=mounts,reads=oldReads;
  replacing=true;h.context.AlbumHavenHomeUI.configureProviders({readFriends:async()=>{newReads++;return friendsPayload('New owner');}});await drain();
  assert.equal(mounts,before+1,'only the final configuration mounts');assert.equal(oldReads,reads,'retirement cannot restart the old provider');assert.equal(newReads,1);
});

test('Playlist nested provider replacement during actual view disposal preserves the newest generation',async t=>{
  const h=await playlists(t);let replace=false,obsoleteReads=0,currentReads=0;
  const newest={readPlaylists:async request=>{currentReads++;return playlistPayload(request.playlist_id,{title:'Newest generation'});}};
  h.runtime.subscribeTrackPreferences=()=>()=>{if(replace){replace=false;h.owner.configureProviders(newest);}};
  h.owner.configureProviders({});await drain();replace=true;
  h.owner.configureProviders({readPlaylists:async request=>{obsoleteReads++;return playlistPayload(request.playlist_id,{title:'Superseded generation'});}});await drain();
  assert.equal(replace,false,'real table disposal triggers nested configuration');assert.equal(obsoleteReads,0);assert.equal(currentReads,1);
  assert.match(h.host.textContent,/Newest generation/);assert.doesNotMatch(h.host.textContent,/Superseded generation/);
});
