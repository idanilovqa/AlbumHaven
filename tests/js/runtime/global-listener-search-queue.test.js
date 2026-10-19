'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:playbackFixture,frame:playbackFrame}=require('./search-native-fixtures/ownership-platform.cjs');
const {queueFixture,listenerReady,listenerTrack,submitListener,bindingReply,source,beginListenerQueue,settleListenerQueue,
  listenerBatchCommand,listenerBatchReply,singleCommand,listenerNativeReply,fullAlbum,outcome,plain,ordinary,
  ROW,ROW2,TOKEN,A,B,assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
async function enqueueListener(h){const snapshot=await submitListener(h),request=await beginListenerQueue(h,snapshot),result=await settleListenerQueue(h,request);
  assert.equal(result.error,undefined,result.error?.stack);assert.equal(result.value.length,2);return {...request,ids:result.value,snapshot};}
test('actual native multiselection and Queue menu reauthorize exact listener rows in ordered batches',async t=>{
  const h=await queueFixture(t,{entry:true});await submitListener(h);const rows=[...h.host.querySelectorAll('[data-cdt-row-key]')];
  for(const row of rows)h.dispatch(row,'keydown',{key:' ',ctrlKey:true});assert.ok(rows.every(row=>row.getAttribute('aria-selected')==='true'));
  h.dispatch(rows[0],'contextmenu',{button:2});await h.flush();
  assert.deepEqual(listenerBatchCommand(h,2),{result_token:TOKEN,row_refs:[ROW,ROW2],intent:'metadata'});
  h.reply(2,listenerBatchReply(h,2));await h.flush();const menu=h.document.querySelector('.settings-foobar-format-menu');assert.ok(menu);
  h.click([...menu.querySelectorAll('button')].find(node=>node.textContent.trim()==='At end of queue'));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,3),{result_token:TOKEN,row_refs:[ROW,ROW2],intent:'metadata'});
  h.reply(3,listenerBatchReply(h,3));await h.flush();assert.deepEqual(listenerBatchCommand(h,4),{result_token:TOKEN,row_refs:[ROW,ROW2],intent:'play'});
  h.reply(4,listenerBatchReply(h,4));await h.flush();const entries=h.queue.getSnapshot().entries;assert.equal(entries.length,2);
  assert.deepEqual(plain(entries.map(row=>row.title)),['Current title 101','Current title 102']);assert.equal(h.streams.length,0);assertListenerPrivate(h);
});
test('Queue capture rejects duplicate and foreign UI keys and retains ordered private receipt closures',async t=>{
  const h=await queueFixture(t),snapshot=await submitListener(h),lease=source(h,snapshot),keys=snapshot.result.tracks.map(row=>row.rowKey);
  assert.equal(lease.canQueue([keys[0],keys[0]]),false);assert.equal(await lease.captureQueue([ROW]),null);
  assert.equal(await lease.captureQueue([keys[0],'foreign-row']),null);const captures=await lease.captureQueue([keys[1],keys[0]]);
  assert.equal(captures.length,2);assert.ok(Object.isFrozen(captures)&&captures.every(Object.isFrozen));
  assert.ok(captures.every(capture=>['resolveMetadata','resolve','resolveDetails','resolvePlaylistItem','isCurrent'].every(name=>typeof capture[name]==='function')));
  assert.equal(h.requests.length,2);assert.equal(h.queue.getSnapshot().entries.length,0);assertListenerPrivate(h);
});
for(const [name,mutate]of [['own Love dialect',p=>{p.contract_version='own-love-native-batch-v1';}],['wrong token',p=>{p.result_token='foreign-result';}],
  ['wrong context',p=>{p.context_ref=B;}],['wrong purpose',p=>{p.data.intent='play';}],['wrong batch property',p=>{p.data.results=p.data.items;delete p.data.items;}],
  ['missing row',p=>{p.data.items.pop();}],['duplicate row',p=>{p.data.items[1]=p.data.items[0];}],['reordered rows',p=>{p.data.items.reverse();}],
  ['foreign row',p=>{p.data.items[1].row_ref='activity_'+'e'.repeat(64);}],['non-null unavailable',p=>{p.data.items[1].status='unavailable';}],
  ['omitted unavailable target',p=>{p.data.items[1]={row_ref:ROW2,status:'unavailable'};}],
  ['wrong inventory',p=>{p.data.items[1].native_target.inventory_track_ref='inventory-track:9:999';}],
  ['metadata path injection',p=>{p.data.items[1].native_target.path='/private/media';}],
  ['borrowed Home origin',p=>{p.data.items[0].origin={source:'activity'};}]])test(`Queue metadata rejects complete malformed ${name} before append`,async t=>{
    const h=await queueFixture(t),snapshot=await submitListener(h),request=await beginListenerQueue(h,snapshot);
    h.reply(request.start,listenerBatchReply(h,request.start,{mutate}));assert.ok((await request.work).error);await h.flush();
    assert.equal(h.queue.getSnapshot().entries.length,0);assert.equal(h.requests.length,3);assert.equal(h.streams.length,0);assertListenerPrivate(h);
  });
for(const intent of ['metadata','play'])test(`explicit unavailable ${intent} null target never becomes a partial initial append`,async t=>{
  const h=await queueFixture(t),snapshot=await submitListener(h),request=await beginListenerQueue(h,snapshot);
  if(intent==='play'){h.reply(request.start,listenerBatchReply(h,request.start));await h.flush();}
  const index=h.requests.length-1;h.reply(index,listenerBatchReply(h,index,{unavailable:[ROW2]}));await h.flush();
  if(intent==='metadata'){assert.deepEqual(listenerBatchCommand(h,index+1).row_refs,[ROW]);h.reply(index+1,listenerBatchReply(h,index+1));}
  assert.ok((await request.work).error);assert.equal(h.queue.getSnapshot().entries.length,0);assert.equal(h.streams.length,0);assertListenerPrivate(h);
});
test('Queue Play obtains fresh media after admission and uses actual streaming owner',async t=>{
  const h=await playbackFixture(t),queued=await enqueueListener(h),index=h.requests.length,work=outcome(h.queue.play(queued.ids[0]));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,index),{result_token:TOKEN,row_refs:[ROW],intent:'play'});
  h.reply(index,listenerBatchReply(h,index,{targetPatch:{path:'/library/current.flac',track_ref:'/library/current.flac'}}));await work;await h.flush();
  assert.equal(h.streams.length,1);assert.equal(h.streams[0][0].path,'/library/current.flac');assert.equal(h.platform.contexts.length,1);
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();
  assert.ok(h.engine().roles.current,'real engine admitted a current native role');playbackFrame(h);await h.flush();
  assertListenerPrivate(h,['/library/current.flac'],{ownershipTab:h.ownershipTabWitness(),playbackDevice:h.playbackDeviceWitness(),actorNative:{inventoryTrackRef:'inventory-track:9:101',path:'/library/current.flac',src:'/track?path=%2Flibrary%2Fcurrent.flac'}});
});
test('retained Queue source survives ordinary Search navigation but still rechecks listener metadata',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),index=h.requests.length,nav=h.read('/view-data?surface=albums');h.reply(index,ordinary());await nav;
  assert.equal(queued.lease.snapshot(),null);assert.equal(h.queue.getSnapshot().entries.length,2);
  const start=h.requests.length,work=outcome(h.queue.refresh());await h.flush();assert.deepEqual(listenerBatchCommand(h,start),{result_token:TOKEN,row_refs:[ROW,ROW2],intent:'metadata'});
  h.reply(start,listenerBatchReply(h,start));assert.equal((await work).error,undefined);assertListenerPrivate(h);
});
test('new Listener result cannot replace the token captured by retained Queue entries',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h);await submitListener(h,listenerReady({query:'@maya :loved',include:['loved'],patch:{native:{result_token:'listener-result-B'}}}));
  const index=h.requests.length,work=outcome(h.queue.refresh());await h.flush();assert.equal(listenerBatchCommand(h,index).result_token,TOKEN);
  h.reply(index,listenerBatchReply(h,index));await work;assertListenerPrivate(h,['listener-result-B']);
});
for(const status of [401,403,409])test(`retained source HTTP ${status} cannot revoke newer unrelated result`,async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),next=await submitListener(h,listenerReady({query:'@maya :loved',include:['loved'],patch:{native:{result_token:'next-result'}}}));
  const index=h.requests.length,work=outcome(h.queue.refresh());await h.flush();h.reply(index,{error:'search_cursor_restart_required'},status);await work;await h.flush();
  assert.equal(h.runtime().isCurrent(next),true);assert.ok(next.result.tracks.every(row=>h.runtime().canPlayTrack(next,row)));
  assert.ok(h.queue.getSnapshot().entries.every(row=>!row.canPlay||!row.sourceReadable));assertListenerPrivate(h,['next-result']);
});
test('Queue admission abort during held JSON cannot append or start a late Play batch',async t=>{
  const h=await queueFixture(t),snapshot=await submitListener(h),controller=new AbortController(),request=await beginListenerQueue(h,snapshot,{signal:controller.signal});
  const reply=listenerBatchReply(h,request.start),body=h.requests[request.start].holdJson();await h.requests[request.start].jsonStarted;controller.abort();body.resolve(reply);
  await request.work;await h.flush();assert.equal(h.queue.getSnapshot().entries.length,0);assert.equal(h.requests.length,3);assertListenerPrivate(h);
});
test('context change disables retained Queue captures and cannot start another listener request',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h);h.change('context',B);await h.flush();const index=h.requests.length;
  await outcome(h.queue.play(queued.ids[0]));await h.flush();assert.equal(h.requests.length,index);assert.equal(h.streams.length,0);assertListenerPrivate(h);
});
test('Queue playlist selection reauthorizes metadata then returns genuine inventory provenance only',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),index=h.requests.length,work=outcome(h.queue.playlistSelection(queued.ids,{signal:new AbortController().signal}));
  await h.flush();assert.deepEqual(listenerBatchCommand(h,index),{result_token:TOKEN,row_refs:[ROW,ROW2],intent:'metadata'});h.reply(index,listenerBatchReply(h,index));
  const result=await work;assert.equal(result.error,undefined);assert.equal(result.value.isCurrent(),true);
  assert.deepEqual(plain(result.value.rows),plain(queued.ids).map((rowKey,index)=>({rowKey,track_ref:`inventory-track:9:${101+index}`,
    source_provenance:{kind:'inventory',track_ref:`inventory-track:9:${101+index}`}})));assertListenerPrivate(h);
});
for(const kind of ['album','artist'])test(`Queue ${kind} detail keeps receipt row and explicit target kind`,async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),index=h.requests.length;
  const work=outcome(h.queue.details(queued.ids[0],kind,{signal:new AbortController().signal}));await h.flush();
  assert.deepEqual(singleCommand(h,index),{result_token:TOKEN,row_ref:ROW,intent:'details',target_kind:kind});
  h.reply(index,listenerNativeReply(h,index));const result=await work;assert.equal(result.error,undefined);assert.ok(result.value);assertListenerPrivate(h);
});
test('actual Queue ResourceSelection reauthorizes Album then hydrates without fabricated Home origin',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),scopeKey=h.c.AlbumHavenHomeRuntime.snapshot().scopeKey;
  const selection=h.c.AlbumHavenQueueResourceSelection.create({queue:h.queue,scopeKey,isCurrent:()=>true});t.after(()=>selection.dispose());
  let index=h.requests.length;const selected=outcome(selection.select([queued.ids[0]]));await h.flush();
  assert.equal(h.requests.length,index+2,'actual ResourceSelection resolves both admitted parent kinds');
  const detailCommands=h.requests.slice(index).map((_,offset)=>singleCommand(h,index+offset));
  assert.deepEqual(detailCommands.map(command=>command.target_kind).sort(),['album','artist']);
  for(let offset=0;offset<2;offset++){
    assert.deepEqual(detailCommands[offset],{result_token:TOKEN,row_ref:ROW,intent:'details',target_kind:detailCommands[offset].target_kind});
    h.reply(index+offset,listenerNativeReply(h,index+offset));
  }
  assert.equal((await selected).error,undefined);const target=selection.getSnapshot().album;
  assert.deepEqual(plain(target.origin),{source:'queue',occurrence_refs:[queued.ids[0]]});index=h.requests.length;
  const opened=outcome(selection.resourceIntent('open',target,{scopeKey}));await h.flush();h.reply(index,listenerNativeReply(h,index));await h.flush();
  assert.equal(h.requests[index+1].url,'/album-details?album_key=native-album-eleven');h.reply(index+1,{ok:true,album:fullAlbum()});
  assert.equal((await opened).error,undefined);assert.equal(h.hydrations.length,1);assert.equal(h.modal.hidden,false);assertListenerPrivate(h);
});


test('100-row page uses one exact bounded binding read and one ordered metadata/Play batch per Queue operation',async t=>{
  const h=await queueFixture(t),refs=Array.from({length:100},(_,index)=>'activity_'+(index+1).toString(16).padStart(64,'0'));
  const snapshot=await submitListener(h,listenerReady({tracks:refs.map(ref=>listenerTrack(ref))}));
  const request=await beginListenerQueue(h,snapshot);assert.deepEqual(listenerBatchCommand(h,request.start).row_refs,refs);
  assert.equal((await settleListenerQueue(h,request)).error,undefined);assert.equal(h.requests.length,4);
  assert.deepEqual(listenerBatchCommand(h,request.start+1).row_refs,refs);assert.equal(h.queue.getSnapshot().entries.length,100);assertListenerPrivate(h,refs);
});
test('different result tokens never coalesce into one operation even with the same signal',async t=>{
  const h=await queueFixture(t),first=await enqueueListener(h);
  const next=await submitListener(h,listenerReady({query:'@maya :loved',include:['loved'],patch:{native:{result_token:'second-token'}}})),lease=source(h,next);
  const [second]=await lease.captureQueue([next.result.tracks[0].rowKey]),signal=new AbortController().signal,index=h.requests.length;
  const one=outcome(first.captures[0].resolveMetadata({signal})),two=outcome(second.resolveMetadata({signal}));await h.flush();
  assert.equal(h.requests.length,index+2);assert.deepEqual([listenerBatchCommand(h,index).result_token,listenerBatchCommand(h,index+1).result_token],[TOKEN,'second-token']);
  h.reply(index,listenerBatchReply(h,index));h.reply(index+1,listenerBatchReply(h,index+1));
  assert.equal((await one).error,undefined);assert.equal((await two).error,undefined);assertListenerPrivate(h,['second-token']);
});
test('different signals and later calls cannot reuse a settled listener batch',async t=>{
  const h=await queueFixture(t),queued=await enqueueListener(h),oneController=new AbortController(),twoController=new AbortController();
  const index=h.requests.length,one=outcome(queued.captures[0].resolveMetadata({signal:oneController.signal})),two=outcome(queued.captures[0].resolveMetadata({signal:twoController.signal}));
  await h.flush();assert.equal(h.requests.length,index+2);oneController.abort();assert.equal((await one).error.name,'AbortError');
  h.reply(index,{error:'private_search_forbidden'},403);h.reply(index+1,listenerBatchReply(h,index+1));assert.equal((await two).error,undefined);
  const laterIndex=h.requests.length,later=outcome(queued.captures[0].resolveMetadata({signal:twoController.signal}));await h.flush();
  assert.equal(h.requests.length,laterIndex+1);h.reply(laterIndex,listenerBatchReply(h,laterIndex));assert.equal((await later).error,undefined);assertListenerPrivate(h);
});


for(const detailKind of ['album','artist'])test(`Play-only shared selection admits Queue with independent ${detailKind}-only detail binding`,async t=>{
  const h=await queueFixture(t,{entry:true}),snapshot=await submitListener(h,listenerReady({tracks:[listenerTrack()]}),
    {bindingOptions:{rows:{[ROW]:{play:true,playlist:false,album:detailKind==='album',artist:detailKind==='artist'}}}});
  const track=snapshot.result.tracks[0],row=h.host.querySelector('[data-cdt-row-key]'),lease=source(h,snapshot),unsupported=detailKind==='album'?'artist':'album';
  assert.equal(track.selectable,true);assert.equal(lease.canQueue([track.rowKey]),true);
  assert.equal(h.runtime().canOpenAlbum(snapshot,track),detailKind==='album');assert.equal(row.querySelector('[data-search-track-details]').disabled,detailKind!=='album');
  if(detailKind==='artist'){const count=h.requests.length;assert.ok((await outcome(h.runtime().openAlbum(snapshot,track))).error);assert.equal(h.requests.length,count);}
  h.dispatch(row,'keydown',{key:' ',ctrlKey:true});assert.equal(row.getAttribute('aria-selected'),'true');
  h.dispatch(row,'contextmenu',{button:2});await h.flush();assert.deepEqual(listenerBatchCommand(h,2),{result_token:TOKEN,row_refs:[ROW],intent:'metadata'});
  h.reply(2,listenerBatchReply(h,2));await h.flush();const menu=h.document.querySelector('.settings-foobar-format-menu');assert.ok(menu);
  h.click([...menu.querySelectorAll('button')].find(node=>node.textContent.trim()==='At end of queue'));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,3),{result_token:TOKEN,row_refs:[ROW],intent:'metadata'});h.reply(3,listenerBatchReply(h,3));await h.flush();
  assert.deepEqual(listenerBatchCommand(h,4),{result_token:TOKEN,row_refs:[ROW],intent:'play'});h.reply(4,listenerBatchReply(h,4));await h.flush();
  const entries=h.queue.getSnapshot().entries;assert.equal(entries.length,1);assert.equal(entries[0].canPlay,true);assert.equal(h.streams.length,0);
  const [capture]=await lease.captureQueue([track.rowKey]),before=h.requests.length;
  assert.ok((await outcome(capture.resolveDetails(unsupported,{signal:new AbortController().signal}))).error);assert.equal(h.requests.length,before,'absent detail target never emits a command');
  const work=outcome(h.queue.details(entries[0].id,detailKind,{signal:new AbortController().signal}));await h.flush();
  assert.deepEqual(singleCommand(h,before),{result_token:TOKEN,row_ref:ROW,intent:'details',target_kind:detailKind});
  h.reply(before,listenerNativeReply(h,before));assert.equal((await work).error,undefined);
  assert.equal(h.requests.some(request=>request.url==='/playlists/destinations'),false);assert.equal(h.hydrations.length,0);assertListenerPrivate(h);
});
