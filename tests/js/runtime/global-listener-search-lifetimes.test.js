'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:playbackFixture,frame:playbackFrame}=require('./search-native-fixtures/ownership-platform.cjs');
const {actionFixture,listenerReady,listenerUrl,deferred,submitListener,bindingReply,listenerNativeReply,listenerBatchReply,singleCommand,source,outcome,ordinary,
  A,B,ROW,TOKEN,CURSOR,assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
async function replace(h,kind){
  if(kind==='query'){h.submit('@maya :loved');return;}
  if(kind==='clear'){h.click(h.form.querySelector('[data-search-clear]'));h.dispatch(h.form,'submit');return;}
  if(kind==='context'){h.change('context',B);return;}
  if(kind==='actor'){h.change('actor');return;}
  if(kind==='library'){h.change('library');return;}
  if(kind==='runtime'){h.replaceRuntime();return;}
  if(kind==='unmount'){const consumer=await h.mount();consumer.dispose();return;}
  if(kind==='page'){h.runtime().continueResults(h.runtime().snapshot());return;}
  throw new Error('unknown test transition');
}
function continuing(){const p=listenerReady();p.page={...p.page,has_more:true,next_cursor:CURSOR,total_matches:null};return p;}
for(const kind of ['query','clear','context','actor','library','runtime','unmount','page'])for(const phase of ['http','json'])
  test(`held binding ${phase} cannot grant after ${kind}`,async t=>{
    const h=await actionFixture(t),old=await submitListener(h,continuing(),{bindings:false}),request=h.requests[1];
    const reply=bindingReply(h,1),body=phase==='json'?request.holdJson():null;if(body)await request.jsonStarted;
    await replace(h,kind);await h.flush();assert.equal(h.runtime().isCurrent(old),false);assert.equal(request.options.signal.aborted,true);
    if(body)body.resolve(reply);else h.reply(1,reply);await h.flush();
    const now=h.runtime().snapshot();assert.ok(!now.result||now.result.tracks.every(row=>!h.runtime().canPlayTrack(now,row)));
    assert.equal(h.activations.length,0);assert.equal(h.hydrations.length,0);assertListenerPrivate(h);
  });
for(const kind of ['query','clear','context','runtime','unmount','page'])for(const status of [200,403,409,503])
  test(`old Play HTTP ${status} after ${kind} cannot activate or clear successor ownership`,async t=>{
    const h=await actionFixture(t),old=await submitListener(h,continuing()),work=outcome(h.runtime().playTrack(old,old.result.tracks[0]));
    const reply=listenerNativeReply(h,2);await replace(h,kind);const before={id:h.state.ui.activeViewRequestId,controller:h.state.ui.activeViewRequestController,busy:h.state.busy};
    h.reply(2,status===200?reply:{error:'private_search_forbidden'},status);await work;await h.flush();
    assert.equal(h.activations.length,0);assert.equal(h.streams.length,0);assert.equal(h.runtime().isCurrent(old),false);
    assert.equal(h.state.ui.activeViewRequestId,before.id);assert.equal(h.state.ui.activeViewRequestController,before.controller);assert.equal(h.state.busy,before.busy);assertListenerPrivate(h);
  });
test('held Play JSON is checked after parse and cannot affect fresh bound successor',async t=>{
  const h=await actionFixture(t),old=await submitListener(h),work=outcome(h.runtime().playTrack(old,old.result.tracks[0]));
  const reply=listenerNativeReply(h,2),body=h.requests[2].holdJson();await h.requests[2].jsonStarted;
  const next=await submitListener(h,listenerReady({query:'@maya :loved',include:['loved'],patch:{native:{result_token:'result-next'}}}));
  body.resolve(reply);await work;await h.flush();assert.equal(h.runtime().isCurrent(next),true);
  assert.ok(next.result.tracks.every(row=>h.runtime().canPlayTrack(next,row)));assert.equal(h.activations.length,0);assertListenerPrivate(h,['result-next']);
});
test('binding publication detaches the previous source before synchronous observer reentry',async t=>{
  const h=await actionFixture(t),old=await submitListener(h,listenerReady(),{bindings:false}),lease=source(h,old);let reentered=false;
  const stop=h.runtime().subscribe(()=>{const snapshot=h.runtime().snapshot();if(reentered||snapshot.sourceIdentity===old.sourceIdentity||!snapshot.result)return;
    reentered=true;assert.equal(lease.snapshot(),null);h.submit('@maya :loved');});t.after(stop);
  h.reply(1,bindingReply(h,1));await h.flush();assert.equal(reentered,true);assert.equal(h.runtime().isCurrent(old),false);
  assert.equal(h.requests.length,3);assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.activations.length,0);
});
test('failed successor request never restores a previous listener lease or binding actions',async t=>{
  const h=await actionFixture(t),old=await submitListener(h),lease=source(h,old),work=h.submit('@maya :loved');
  assert.equal(lease.snapshot(),null);h.requests[2].reject(new Error('temporary network outage'));await work;await h.flush();
  assert.equal(h.runtime().isCurrent(old),false);assert.equal(lease.snapshot(),null);assert.equal(h.runtime().snapshot().actionable,false);
  assert.equal(h.host.querySelectorAll('[data-cdt-row-key]').length,0);assertListenerPrivate(h);
});
test('binding 503 remains readable disabled and explicit retry stays a bounded child',async t=>{
  const h=await actionFixture(t);await submitListener(h,listenerReady(),{bindings:false});const viewId=h.state.ui.activeViewRequestId;
  h.reply(1,{error:'private_search_unavailable'},503);await h.flush();const failed=h.runtime().snapshot();
  assert.equal(failed.result.tracks.length,2);assert.equal(failed.bindings.status,'error');assert.ok(failed.result.tracks.every(row=>!h.runtime().canPlayTrack(failed,row)));
  const work=outcome(h.runtime().retryBindings(failed));await h.flush();assert.equal(h.requests.length,3);assert.equal(h.state.ui.activeViewRequestId,viewId);
  h.reply(2,bindingReply(h,2));await work;await h.flush();const after=h.runtime().snapshot();assert.ok(after.result.tracks.every(row=>h.runtime().canPlayTrack(after,row)));
  assert.equal(h.requests.length,3);assertListenerPrivate(h);
});
test('repeated Play clicks cannot let the older response win the native player selection',async t=>{
  const h=await playbackFixture(t),snapshot=await submitListener(h),first=outcome(h.runtime().playTrack(snapshot,snapshot.result.tracks[0]));
  const firstReply=listenerNativeReply(h,2);const second=outcome(h.runtime().playTrack(snapshot,snapshot.result.tracks[1]));
  h.reply(3,listenerNativeReply(h,3));await second;h.reply(2,firstReply);await first;await h.flush();
  assert.equal(h.activations.length,1);assert.equal(h.streams[0][0].inventory_track_ref,'inventory-track:9:102');
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();
  assert.ok(h.engine().roles.current,'real engine admitted a current native role');playbackFrame(h);await h.flush();
  assertListenerPrivate(h,[],{ownershipTab:h.ownershipTabWitness(),playbackDevice:h.playbackDeviceWitness(),actorNative:{inventoryTrackRef:'inventory-track:9:102',path:'/library/queue/102.flac',src:'/track?path=%2Flibrary%2Fqueue%2F102.flac'}});
});
test('Album replay must retain exact admitted canonical target before hydration',async t=>{
  const h=await actionFixture(t),snapshot=await submitListener(h),work=outcome(h.runtime().openAlbum(snapshot,snapshot.result.tracks[0]));
  h.reply(2,listenerNativeReply(h,2));await h.flush();assert.equal(singleCommand(h,3).target_kind,'album');
  h.reply(3,listenerNativeReply(h,3,{targetPatch:{album_ref:'different-album'}}));assert.ok((await work).error);await h.flush();
  assert.equal(h.hydrations.length,0);assert.equal(h.opens.length,0);assertListenerPrivate(h);
});
test('selection lifetime is rechecked after metadata before Playlist destination request',async t=>{
  const h=await actionFixture(t,{entry:true});await submitListener(h);const row=h.host.querySelector('[data-cdt-row-key]');
  h.dispatch(row,'keydown',{key:' ',ctrlKey:true});h.click(h.button(/^Add to playlist$/));await h.flush();
  const reply=listenerBatchReply(h,2);h.submit('@maya :loved');h.reply(2,reply);await h.flush();
  assert.equal(h.requests.some(request=>request.url==='/playlists/destinations'),false);assertListenerPrivate(h);
});
test('Home clear aborts held Album replay without allowing late hydration',async t=>{
  const h=await actionFixture(t),snapshot=await submitListener(h),work=outcome(h.runtime().openAlbum(snapshot,snapshot.result.tracks[0]));
  h.reply(2,listenerNativeReply(h,2));await h.flush();const reply=listenerNativeReply(h,3);await replace(h,'clear');
  h.reply(3,reply);await work;await h.flush();assert.equal(h.hydrations.length,0);assert.equal(h.opens.length,0);assertListenerPrivate(h);
});

for(const decision of [true,false])test(`real app-form ${decision?'deferral':'refusal'} cannot prematurely retire listener actions`,async t=>{
  const h=await actionFixture(t),snapshot=await submitListener(h),lease=source(h,snapshot),choice=deferred(),starts=[];
  const form=h.c.openReactFormDialog({title:'Unsaved form',pageId:'listener-test-form',beforeDismiss:()=>choice.promise});
  const payload=listenerReady({query:'@maya :loved',include:['loved']}),options={onStart(info,origin){starts.push(origin);return true;}};
  const work=h.read(listenerUrl(payload),options,true);await h.flush();assert.equal(starts.length,0);assert.equal(h.requests.length,2);
  assert.equal(h.runtime().isCurrent(snapshot),true);assert.ok(lease.snapshot());choice.resolve(decision);await h.flush();
  if(decision){assert.deepEqual(starts,[options]);assert.equal(lease.snapshot(),null);assert.equal(h.requests.length,3);
    h.reply(2,payload);await work;await h.flush();h.reply(3,bindingReply(h,3));await h.flush();await form.promise;}
  else{assert.equal((await work).value,false);assert.equal(h.runtime().isCurrent(snapshot),true);assert.equal(h.requests.length,2);
    form.close(null,{force:true});await form.promise;}
});
