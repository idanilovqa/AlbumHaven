'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:playbackFixture,frame:playbackFrame}=require('./search-native-fixtures/ownership-platform.cjs');
const {actionFixture,listenerReady,listenerTrack,submitListener,bindingCommand,bindingReply,singleCommand,listenerNativeReply,listenerBatchCommand,listenerBatchReply,finishListenerDetails,
  source,outcome,plain,ROW,ROW2,TOKEN,A,B,assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
test('initial readable rows have no actions until exact bounded binding child publishes a new revision',async t=>{
  const h=await actionFixture(t),before=await submitListener(h,listenerReady(),{bindings:false});
  assert.deepEqual(bindingCommand(h,1),{result_token:TOKEN,row_refs:[ROW,ROW2]});
  assert.ok([...h.host.querySelectorAll('[data-search-track-play]')].every(node=>node.disabled));
  assert.ok(before.result.tracks.every(row=>!h.runtime().canPlayTrack(before,row)&&!h.runtime().canOpenAlbum(before,row)));
  const oldSource=source(h,before);h.reply(1,bindingReply(h,1));await h.flush();const after=h.runtime().snapshot();
  assert.equal(oldSource.snapshot(),null);assert.notEqual(after.sourceIdentity,before.sourceIdentity);
  assert.ok(after.result.tracks.every(row=>h.runtime().canPlayTrack(after,row)));assertListenerPrivate(h);
});
for(const [name,mutate]of [['wrong token',p=>{p.result_token='other';}],['wrong context',p=>{p.context_ref=B;}],
  ['own Love dialect',p=>{p.contract_version='own-love-native-v1';}],['reordered rows',p=>{p.data.bindings.reverse();}],
  ['duplicate rows',p=>{p.data.bindings[1]=p.data.bindings[0];}],['missing row',p=>{p.data.bindings.pop();}],
  ['foreign row',p=>{p.data.bindings[0].row_ref='activity_'+'e'.repeat(64);}],['nonboolean action',p=>{p.data.bindings[0].allowed_actions.can_resolve_native_play='true';}],
  ['foreign inventory',p=>{p.data.bindings[0].inventory_track_ref='inventory-track:10:101';}],
  ['invented Home origin',p=>{p.data.bindings[0].album_target.origin={source:'activity'};}],
  ['wrong target row',p=>{p.data.bindings[0].album_target.row_ref=ROW2;}],['invalid target identity',p=>{p.data.bindings[0].album_target.identity_ref='inventory-album:9:11';}]])
  test(`binding child rejects ${name} without partial grants`,async t=>{
    const h=await actionFixture(t);await submitListener(h,listenerReady(),{bindings:false});h.reply(1,bindingReply(h,1,{mutate}));await h.flush();
    const snapshot=h.runtime().snapshot();assert.ok(!snapshot.result||snapshot.result.tracks.every(row=>!h.runtime().canPlayTrack(snapshot,row)));
    assert.equal(h.activations.length,0);assert.equal(h.hydrations.length,0);assert.equal(h.requests.length,2);assertListenerPrivate(h);
  });
test('real native Play sends fresh purpose-bound command and reaches real TrackActions audio boundary',async t=>{
  const h=await playbackFixture(t);await submitListener(h);h.click(h.host.querySelector('[data-search-track-play]'));
  assert.deepEqual(singleCommand(h,2),{result_token:TOKEN,row_ref:ROW,intent:'play'});assert.equal(h.activations.length,0);
  h.reply(2,listenerNativeReply(h,2));await h.flush();assert.equal(h.activations.length,1);assert.equal(h.streams.length,1);
  assert.equal(h.streams[0][0].inventory_track_ref,'inventory-track:9:101');assert.equal(h.streams[0][0].path,'/library/queue/101.flac');
  assert.equal(h.platform.contexts.length,1,'bounded audio primitive; no physical sound output');
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();
  assert.ok(h.engine().roles.current,'real engine admitted a current native role');playbackFrame(h);await h.flush();
  assertListenerPrivate(h,[],{ownershipTab:h.ownershipTabWitness(),playbackDevice:h.playbackDeviceWitness(),actorNative:{inventoryTrackRef:'inventory-track:9:101',path:'/library/queue/101.flac',src:'/track?path=%2Flibrary%2Fqueue%2F101.flac'}});
});
for(const [name,mutate]of [['wrong row',p=>{p.data.row_ref=ROW2;}],['wrong token',p=>{p.result_token='cursor-purpose-token';}],
  ['wrong purpose',p=>{p.data.intent='metadata';}],['wrong context',p=>{p.context_ref=B;}],
  ['raw history dialect',p=>{p.contract_version='listener-history-v1';}],['Home origin',p=>{p.data.origin={source:'activity'};}],
  ['wrong inventory',p=>{p.data.native_target.inventory_track_ref='inventory-track:9:999';}],['mismatched path',p=>{p.data.native_target.track_ref='/other';}],
  ['extra grant',p=>{p.data.native_target.allowed_actions={can_play:true};}],['missing target',p=>{p.data.native_target=null;}]])
  test(`listener native Play rejects ${name} before downstream handoff`,async t=>{
    const h=await actionFixture(t),snapshot=await submitListener(h),work=outcome(h.runtime().playTrack(snapshot,snapshot.result.tracks[0]));
    h.reply(2,listenerNativeReply(h,2,{mutate}));assert.ok((await work).error);assert.equal(h.activations.length,0);assert.equal(h.streams.length,0);assertListenerPrivate(h);
  });
test('actual Album ResourceSelection independently reauthorizes the receipt row and hydrates native Album',async t=>{
  const h=await actionFixture(t);await submitListener(h);h.click(h.host.querySelector('[data-search-track-details]'));
  assert.deepEqual(singleCommand(h,2),{result_token:TOKEN,row_ref:ROW,intent:'details',target_kind:'album'});
  await finishListenerDetails(h,2);assert.equal(h.opens.length,1);assert.equal(h.hydrations.length,1);assert.equal(h.modal.hidden,false);
  assert.match(h.modal.textContent,/Full native Album/);assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(),true);assertListenerPrivate(h,['native-album-eleven']);
});
for(const [name,mutate]of [['null target',p=>{p.data.native_target=null;}],['wrong kind',p=>{p.data.native_target={artist_ref:'native-artist',title:'Artist',allowed_actions:{can_view_details:true}};}],
  ['Home target origin',p=>{p.data.native_target.origin={source:'activity'};}],['false detail grant',p=>{p.data.native_target.allowed_actions.can_view_details=false;}],
  ['subject taste',p=>{p.data.native_target.subject_taste={rating:5};}]])test(`Album rejects ${name} before hydration`,async t=>{
    const h=await actionFixture(t),snapshot=await submitListener(h),work=outcome(h.runtime().openAlbum(snapshot,snapshot.result.tracks[0]));
    assert.equal(singleCommand(h,2).target_kind,'album');h.reply(2,listenerNativeReply(h,2,{mutate}));assert.ok((await work).error);
    assert.equal(h.hydrations.length,0);assert.equal(h.opens.length,0);assertListenerPrivate(h);
  });
test('selection handoff obtains fresh exact-row metadata before opening actual Playlist destination UI',async t=>{
  const h=await actionFixture(t,{entry:true});await submitListener(h);const row=h.host.querySelector('[data-cdt-row-key]');
  h.dispatch(row,'keydown',{key:' ',ctrlKey:true});h.dispatch(row,'contextmenu',{button:2});
  await h.flush();assert.deepEqual(listenerBatchCommand(h,2),{result_token:TOKEN,row_refs:[ROW],intent:'metadata'});
  assert.equal(h.requests.some(request=>request.url==='/playlists/destinations'),false);
  h.reply(2,listenerBatchReply(h,2));await h.flush();
  const menu=h.document.querySelector('.settings-foobar-format-menu');assert.ok(menu);h.click([...menu.querySelectorAll('button')].find(node=>node.textContent.trim()==='Add to playlist'));
  await h.flush();assert.equal(h.requests[3].url,'/playlists/destinations');
  h.reply(3,{status:'empty',context_ref:A,data:{actor_scope:{account_id:7,library_id:9},destinations:[],allowed_actions:{can_create:false}}});await h.flush();
  assert.ok(h.document.querySelector('[role="dialog"]'));assert.equal(h.requests.filter(request=>request.options.method==='POST').length,2);
  assert.doesNotMatch(h.host.textContent,/loved|obsessed/i,'actor metadata does not become listener preference evidence');assertListenerPrivate(h);
});
test('disabled binding cannot become an unresolved playlist record through native selection',async t=>{
  const h=await actionFixture(t,{entry:true}),snapshot=await submitListener(h,listenerReady(),{bindingOptions:{disabled:[ROW]}}),lease=source(h,snapshot);
  assert.equal(lease.resolveRows([snapshot.result.tracks[0].rowKey]),null);assert.equal(await lease.captureQueue([snapshot.result.tracks[0].rowKey]),null);
  const row=h.host.querySelector('[data-cdt-row-key]');h.dispatch(row,'keydown',{key:' ',ctrlKey:true});assert.equal(row.getAttribute('aria-selected'),null);
  assert.equal(h.requests.length,2);assertListenerPrivate(h);
});
for(const status of [401,403,409,503])test(`current native HTTP ${status} disables actions without an empty successful result`,async t=>{
  const h=await actionFixture(t),snapshot=await submitListener(h),work=outcome(h.runtime().playTrack(snapshot,snapshot.result.tracks[0]));
  h.reply(2,{error:'private_search_unavailable'},status);assert.equal((await work).error.status,status);await h.flush();
  assert.equal(h.runtime().canPlayTrack(snapshot,snapshot.result.tracks[0]),false);assert.equal(h.activations.length,0);assertListenerPrivate(h);
});


for(const media of [true,false])for(const availability of ['local','unresolved'])test(`independent Playlist and Album grants survive Play denial: media=${media}, history=${availability}`,async t=>{
  const h=await actionFixture(t,{entry:true,media}),payload=listenerReady({tracks:[listenerTrack(ROW,{availability})]});
  const snapshot=await submitListener(h,payload,{bindingOptions:{rows:{[ROW]:{play:false,playlist:true,album:true,artist:false,inventoryTrackRef:'inventory-track:9:101'}}}});
  const track=snapshot.result.tracks[0],lease=source(h,snapshot),row=h.host.querySelector('[data-cdt-row-key]');
  assert.equal(track.selectable,true);assert.equal(row.tabIndex,0);assert.equal(h.runtime().canPlayTrack(snapshot,track),false);
  assert.equal(h.runtime().canOpenAlbum(snapshot,track),true);assert.equal(row.querySelector('[data-search-track-play]').disabled,true);
  assert.equal(row.querySelector('[data-search-track-details]').disabled,false);assert.equal(lease.canQueue([track.rowKey]),false);
  assert.equal(await lease.captureQueue([track.rowKey]),null);const count=h.requests.length;
  assert.ok((await outcome(h.runtime().playTrack(snapshot,track))).error);assert.equal(h.requests.length,count);
  if(availability==='unresolved'){assert.match(row.textContent,/Local audio unavailable/);assert.doesNotMatch(row.textContent,/Not in this library/);}
  h.click(row.querySelector('[data-search-track-details]'));assert.deepEqual(singleCommand(h,count),{result_token:TOKEN,row_ref:ROW,intent:'details',target_kind:'album'});
  await finishListenerDetails(h,count,{targetPatch:{allowed_actions:{can_view_details:true,can_play_album:false}}});
  assert.equal(h.hydrations.length,1);assert.equal(h.opens.length,1);assert.equal(h.modal.hidden,false);
  assert.equal(h.opens[0][1].presentationRestrictions.can_play_album,false);h.click(h.document.getElementById('track-modal-close'));await h.flush();
  h.dispatch(row,'keydown',{key:' ',ctrlKey:true});assert.equal(row.getAttribute('aria-selected'),'true');
  const index=h.requests.length;h.click(h.button(/^Add to playlist$/));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,index),{result_token:TOKEN,row_refs:[ROW],intent:'metadata'});
  assert.equal(h.requests.some(request=>request.url==='/playlists/destinations'),false);
  h.reply(index,listenerBatchReply(h,index,{targetPatch:{availability,allowed_actions:{can_read:true,can_play:false},playback_state:{can_start_here:false}}}));await h.flush();
  assert.equal(h.requests[index+1].url,'/playlists/destinations');
  h.reply(index+1,{status:'empty',context_ref:A,data:{actor_scope:{account_id:7,library_id:9},destinations:[],allowed_actions:{can_create:false}}});await h.flush();
  assert.ok(h.document.querySelector('[role="dialog"]'));assert.equal(h.streams.length,0);assert.equal(h.activations.length,0);
  assert.equal(h.requests.some(request=>request.options.method==='POST'&&new URL(request.url,h.location).pathname.startsWith('/playlists')),false);assertListenerPrivate(h);
});

test('Play-only binding permits shared row selection but fresh Playlist authority can independently deny handoff',async t=>{
  const h=await actionFixture(t,{entry:true}),snapshot=await submitListener(h,listenerReady({tracks:[listenerTrack()]}),
    {bindingOptions:{rows:{[ROW]:{play:true,playlist:false,album:false,artist:false}}}}),track=snapshot.result.tracks[0],row=h.host.querySelector('[data-cdt-row-key]');
  assert.equal(track.selectable,true,'selection intentionally uses Play OR Playlist');assert.equal(h.runtime().canPlayTrack(snapshot,track),true);
  assert.equal(h.runtime().canOpenAlbum(snapshot,track),false);assert.equal(row.querySelector('[data-search-track-details]').disabled,true);
  assert.equal(source(h,snapshot).resolveRows([track.rowKey]),null,'binding inventory alone cannot provide Playlist metadata');
  h.dispatch(row,'keydown',{key:' ',ctrlKey:true});h.click(h.button(/^Add to playlist$/));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,2),{result_token:TOKEN,row_refs:[ROW],intent:'metadata'});
  assert.equal(h.requests.some(request=>request.url==='/playlists/destinations'),false);h.reply(2,listenerBatchReply(h,2));await h.flush();
  assert.equal(h.requests[3].url,'/playlists/destinations');h.reply(3,{error:'forbidden'},403);await h.flush();
  assert.ok(h.document.querySelector('[role="dialog"]'));assert.match(h.document.body.textContent,/permission|denied/i);
  assert.equal(h.requests.filter(request=>request.options.method==='POST').length,2,'only bindings and fresh metadata; no Playlist mutation');
  assert.equal(h.hydrations.length,0);assertListenerPrivate(h);
});
