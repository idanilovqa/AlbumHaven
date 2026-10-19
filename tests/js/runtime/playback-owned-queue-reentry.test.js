'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,track,start,frame}=require('./search-native-fixtures/ownership-platform.cjs');
const {submitListener,beginListenerQueue,settleListenerQueue,listenerBatchReply,listenerReady}=require('./search-native-fixtures/listener-search.cjs');
const outcome=p=>Promise.resolve(p).then(value=>({value}),error=>({error}));
async function enqueue(h,options={}){const snapshot=await submitListener(h,undefined,options),request=await beginListenerQueue(h,snapshot),result=await settleListenerQueue(h,request);assert.equal(result.error,undefined);assert.equal(result.value.length,2);return result.value;}
async function finishPlayReply(h,index){h.reply(index,listenerBatchReply(h,index));await h.flush();for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();await h.flush();}
test('stopped detaches old pending-start before abort; nested B Queue start survives before B reaches engine',async t=>{
  const h=await fixture(t),ids=await enqueue(h),q=h.queueOwner(),oldIndex=h.requests.length,oldWork=outcome(h.queue.play(ids[0]));await h.flush();
  const captured=q.captureStop();assert.ok(captured.start);let newer,newIndex,newCapture;
  captured.start.signal.addEventListener('abort',()=>{newIndex=h.requests.length;newer=outcome(h.queue.play(ids[1]));newCapture=q.captureStop();},{once:true});
  q.stopped();await h.flush();assert.ok(newCapture?.start);assert.notEqual(newCapture.start,captured.start);assert.equal(newCapture.start.signal.aborted,false);assert.equal(q.isStopCurrent(newCapture),true);
  h.reply(oldIndex,listenerBatchReply(h,oldIndex));await h.flush();assert.ok((await oldWork).error,'old late read rejected');
  await finishPlayReply(h,newIndex);assert.equal((await newer).value,true);assert.equal(h.state.player.current.path,'/library/queue/102.flac');
  assert.equal(h.engine().roles.current.track.path,'/library/queue/102.flac');assert.equal(h.c.isPlaybackOwnershipHandleCurrent(h.c.getActivePlaybackOwnershipHandle()),true);
});
test('scope transition commits new empty Queue before old pending-start abort; nested engine B survives retirement',async t=>{
  const h=await fixture(t),ids=await enqueue(h),q=h.queueOwner(),oldIndex=h.requests.length,oldWork=outcome(h.queue.play(ids[0]));await h.flush();
  const old=q.captureStop();assert.ok(old.start);let observed,b,bAttempt,newCapture;
  old.start.signal.addEventListener('abort',()=>{observed=h.queue.getSnapshot();b=outcome(h.c.startStreamingTrack(track('B'),{onStartAttempt:handle=>{bAttempt=handle;}}));newCapture=q.captureStop();},{once:true});
  h.change('context','b'.repeat(64));h.queue.getSnapshot();await h.flush();assert.deepEqual(Array.from(observed.entries),[],'new scope is committed before abort');
  assert.notEqual(newCapture.scope.token,old.scope.token);assert.equal(q.isStopCurrent(newCapture),true);
  h.reply(oldIndex,listenerBatchReply(h,oldIndex));await h.flush();assert.ok((await oldWork).error);
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();const result=await b;assert.equal(result.error,undefined);assert.equal(result.value.track.path,track('B').path);assert.equal(h.c.isStreamingPlaybackAttemptCurrent(bAttempt),true);
});
async function pendingRefresh(h){
  const x=await start(h);assert.equal(await x.work,true);frame(h,x.role);await h.flush();await enqueue(h,{resumedWaveform:true});
  const capture=h.queueOwner().captureStop();assert.ok(capture.refresh,'real Queue authorizes upcoming entry through a pending refresh');return capture;
}
for(const entry of ['selectionStarted','stopped'])test(`${entry} refresh abort cannot clear nested successor Queue controller`,async t=>{
  const h=await fixture(t),q=h.queueOwner(),old=await pendingRefresh(h);let newer,captured;
  old.refresh.signal.addEventListener('abort',()=>{
    // Actual Queue reads/refreshes create B's controller; no test-owned planner,
    // source resolver, cancellation or cleanup implementation is substituted.
    newer=outcome(q.prepareNext());captured=q.captureStop();
  },{once:true});
  q[entry]();await h.flush();assert.ok(captured);assert.equal(captured.refresh===old.refresh,false);
  if(captured.refresh){assert.equal(captured.refresh.signal.aborted,false);assert.equal(q.isStopCurrent(captured),true);}
  else assert.equal(entry,'stopped','only halted Queue may have no next request');
  // Finish the old network delivery after B registered, exercising late result
  // cleanup without changing B's current controller/planner/session identity.
  for(const request of h.requests)if(!request.settled&&request.options.signal?.aborted)request.reject(Object.assign(new Error('captured request aborted'),{name:'AbortError'}));
  await h.flush();if(captured.refresh)assert.equal(q.isStopCurrent(captured),true);
  void newer;
});
