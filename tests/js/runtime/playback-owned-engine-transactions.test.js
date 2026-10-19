'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,track,frame}=require('./search-native-fixtures/ownership-platform.cjs');
const settle=promise=>Promise.resolve(promise).then(value=>({value}),error=>({error}));
async function engineStart(h,payload=track(),options={}){
  let handle;const work=settle(h.c.startStreamingTrack(payload,{...options,onStartAttempt(value){handle=value;options.onStartAttempt?.(value);}}));
  await h.flush();
  // Only the currently installed socket can need opening. A retired socket may
  // intentionally have a throwing readyState getter: only product cleanup reads it.
  const socket=h.engine().socket;if(socket?.readyState===0)socket.open();
  await h.flush();return {work,handle,payload,role:h.engine().roles.current};
}
function stop(h,handle){return h.c.stopStreamingPlayback('independent-transaction-test',{expectedAttempt:handle});}
function assertClosedExactly(resource){assert.equal(resource.context.closeCount,1);assert.equal(resource.node.disconnectCount,1);assert.equal(resource.socket.closeCount,1);}
function resources(h){return {context:h.engine().context,node:h.engine().node,socket:h.engine().socket};}
test('forged or stale conditional stop has zero Queue or engine effects',async t=>{
  const h=await fixture(t),a=await engineStart(h);assert.equal((await a.work).value,a.role);let notifications=0;h.queue.subscribe(()=>notifications++);
  const current=resources(h),before=h.queueOwner().captureStop();assert.equal(await stop(h,Object.freeze({})),false);
  assert.equal(h.engine().roles.current,a.role);assert.equal(h.queueOwner().isStopCurrent(before),true);assert.equal(notifications,0);assert.equal(current.context.closeCount,0);
  await stop(h,a.handle);const b=await engineStart(h,track('B'));assert.equal((await b.work).value,b.role);const count=notifications;
  assert.equal(await stop(h,a.handle),false);assert.equal(notifications,count);assert.equal(h.engine().roles.current,b.role);
});
test('Queue final stopped subscriber registers B; owned cleanup closes only A and B proceeds afterward',async t=>{
  const h=await fixture(t),a=await engineStart(h),old=resources(h);await a.work;h.platform.holds.close=true;
  let b,called=false;const unsubscribe=h.queue.subscribe(()=>{if(called)return;called=true;b=engineStart(h,track('B'));});
  const stopped=stop(h,a.handle);await h.flush();assert.equal(called,true);assert.equal(h.engine().roles.current,null);assert.equal(h.platform.contexts.length,1,'B cannot allocate around A cleanup');
  h.platform.holds.close=false;old.context.closeGate.resolve();assert.equal(await stopped,true);const next=await b,result=await next.work;assert.equal(result.value,h.engine().roles.current);assert.equal(result.value.track.path,track('B').path);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.handle),true);assertClosedExactly(old);assert.equal(h.engine().context.closeCount,0);unsubscribe();
});
test('pending B canceled behind A cannot adopt A resources; C is still admitted after A',async t=>{
  const h=await fixture(t),a=await engineStart(h),old=resources(h);await a.work;h.platform.holds.close=true;const stopped=stop(h,a.handle);
  const b=await engineStart(h,track('B'));assert.equal(h.platform.contexts.length,1);assert.equal(await stop(h,b.handle),true);assert.equal(h.engine().stopPromise!==null,true);
  const c=await engineStart(h,track('C'));h.platform.holds.close=false;old.context.closeGate.resolve();await stopped;
  assert.equal((await b.work).value,null);const result=await c.work;assert.equal(result.error,undefined);assert.equal(result.value.track.path,track('C').path);assertClosedExactly(old);
});
for(const rejectPreparation of [false,true])test(`role-less preparation retirement handles late ${rejectPreparation?'rejection':'resolution'} without publishing old resources`,async t=>{
  const h=await fixture(t);h.platform.holds.module=true;const a=await engineStart(h),old=h.platform.contexts[0];assert.equal(a.role,null);
  const stopping=settle(stop(h,a.handle)),b=await engineStart(h,track('B'));assert.equal(h.platform.contexts.length,1);
  h.platform.holds.module=false;if(rejectPreparation)old.module.reject(new Error('old addModule failed'));else old.module.resolve();
  await h.flush();const stopped=await stopping;const result=await b.work;assert.equal((await a.work).value??null,null);assert.equal(result.error,undefined,'A cleanup failure must not fail B');
  assert.equal(result.value.track.path,track('B').path);assert.equal(old.closeCount,1);assert.equal(h.engine().context.closeCount,0);assert.equal(stopped.error!==undefined,rejectPreparation);
});
test('unresolved physical close rejection blocks B allocation even when a primitive reports closed',async t=>{
  const h=await fixture(t),a=await engineStart(h),old=resources(h);await a.work;h.platform.holds.close=true;const stopping=settle(stop(h,a.handle));const b=await engineStart(h,track('B'));
  h.platform.holds.close=false;old.context.closeGate.reject(new Error('A close rejected'));const failure=(await stopping).error;assert.ok(failure);const result=await b.work;
  assert.ok(result.error);assert.equal(h.platform.contexts.length,1,'unknown physical teardown cannot allocate a successor');assert.equal(h.engine().roles.current,null);assertClosedExactly(old);
  const c=await engineStart(h,track('C'));assert.ok((await c.work).error,'later retry remains blocked without engine recreation');assert.equal(h.platform.contexts.length,1);
});
test('throwing start-attempt callback retires only its own registration',async t=>{
  const h=await fixture(t);let a;const outcome=await settle(h.c.startStreamingTrack(track(),{onStartAttempt(handle){a=handle;throw new Error('callback failed');}}));
  assert.match(outcome.error.message,/callback failed/);await h.flush();assert.equal(h.c.isStreamingPlaybackAttemptCurrent(a),false);assert.equal(h.platform.contexts.length,0);
  const b=await engineStart(h,track('B'));assert.equal((await b.work).value.track.path,track('B').path);
});
test('reentrant start-attempt callback admits B and A never allocates',async t=>{
  const h=await fixture(t);let b;const a=await engineStart(h,track(),{onStartAttempt(){b=engineStart(h,track('B'));}});
  assert.equal((await a.work).value,null);const next=await b;assert.equal((await next.work).value.track.path,track('B').path);assert.equal(h.platform.contexts.length,1);
});
test('legacy unconditional stop with nested notification is bounded; explicit later stop of B works',async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;let nested,seen=0;const off=h.queue.subscribe(()=>{if(++seen===1)nested=h.c.stopStreamingPlayback('nested-legacy');});
  assert.equal(await h.c.stopStreamingPlayback('legacy'),true);assert.equal(await nested,true);assert.equal(seen,1);off();
  const b=await engineStart(h,track('B'));await b.work;assert.equal(await h.c.stopStreamingPlayback('explicit-later'),true);assert.equal(h.engine().roles.current,null);
});
for(const stage of ['cushion','replacement'])test(`pending ${stage} cancellation settles captured work and preserves a later successor`,async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;frame(h,a.role);await h.flush();
  if(stage==='replacement')h.platform.nodes.at(-1).emit({type:'consumed',generation:a.role.generation,streamId:a.role.streamId,role:'current',frames:0,bufferedFrames:48000});
  const pending=await engineStart(h,track('Pending'));assert.ok(stage==='cushion'?h.engine().replacementCushionWaiter:h.engine().pendingSeek,'real engine owns pending transaction');
  const old=resources(h);h.platform.holds.close=true;let successor;pending.work.then(()=>{successor=engineStart(h,track('B'));});const stopping=stop(h,pending.handle);await h.flush();assert.ok(successor,'captured waiter settlement can register B during A cleanup');assert.equal(h.platform.contexts.length,1);h.platform.holds.close=false;old.context.closeGate.resolve();assert.equal(await stopping,true);const ended=await pending.work;assert.ok(ended.error||ended.value===null);assertClosedExactly(old);
  const b=await successor;assert.equal((await b.work).value.track.path,track('B').path);assert.equal(h.engine().pendingSeek,null);assert.equal(h.engine().replacementCushionWaiter,null);
});
test('real waveform-load abort callback registers B behind already committed A cleanup',async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;const peaks=settle(h.c.loadWaveformPeaks(a.payload.path,280,a.role.generation));await h.flush();
  const controller=h.owner('playerWaveformPeakController');assert.ok(controller?.signal);let successor;controller.signal.addEventListener('abort',()=>{successor=engineStart(h,track('B'));},{once:true});
  const old=resources(h);assert.equal(await stop(h,a.handle),true);const b=await successor;assert.equal((await b.work).value.track.path,track('B').path);assertClosedExactly(old);
  for(const request of h.requests)if(!request.settled&&request.options.signal?.aborted)request.reject(Object.assign(new Error('old waveform aborted'),{name:'AbortError'}));await peaks;assert.equal(h.engine().roles.current.track.path,track('B').path);
});
test('physical stop port callback cannot retarget remaining cleanup messages to B',async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;const old=resources(h);let successor;h.platform.onPortPost=(node,data)=>{if(node===old.node&&data.type==='stop'&&!successor)successor=engineStart(h,track('B'));};
  assert.equal(await stop(h,a.handle),true);const b=await successor;assert.equal((await b.work).value.track.path,track('B').path);assertClosedExactly(old);
  assert.equal(h.engine().node.disconnectCount,0);assert.equal(h.engine().socket.closeCount,0);assert.equal(h.engine().context.closeCount,0);
  assert.deepEqual(old.node.sent.filter(x=>x.type==='stop').map(x=>x.generation),[a.role.generation]);
});
test('constructor reentry sees published preparation barrier and retired A cannot install resources',async t=>{
  const h=await fixture(t);let attempt,stopped;h.platform.onContextCreate=()=>{h.platform.onContextCreate=null;stopped=stop(h,attempt);};
  const work=settle(h.c.startStreamingTrack(track(),{onStartAttempt:handle=>{attempt=handle;}}));await h.flush();assert.ok(stopped);assert.equal(await stopped,true);await work;
  assert.equal(h.engine().roles.current,null);assert.equal(h.engine().preparePromise,null);assert.equal(h.platform.contexts[0].closeCount,1);
  const b=await engineStart(h,track('B'));assert.equal((await b.work).value.track.path,track('B').path);
});
for(const rejection of ['frozen-error','primitive'])test(`late ${rejection} preparation error cannot conceal failed staged physical cleanup`,async t=>{
  const h=await fixture(t);h.platform.holds.module=true;const a=await engineStart(h),old=h.platform.contexts[0];h.platform.holds.close=true;
  const stopping=settle(stop(h,a.handle)),b=await engineStart(h,track('B'));
  old.module.reject(rejection==='frozen-error'?Object.freeze(new Error('frozen addModule rejection')):'primitive addModule rejection');await h.flush();assert.ok(old.closeGate,'real preparer attempted partial-resource cleanup');
  h.platform.holds.module=false;h.platform.holds.close=false;old.closeGate.reject(new Error('staged context failed to close'));
  const result=await stopping;assert.ok(result.error);assert.ok(Object.prototype.hasOwnProperty.call(result,'error'),'failure is observed independently of public safety labels');
  assert.ok((await b.work).error);await a.work;assert.equal(h.platform.contexts.length,1,'unsafe old resource prevents B allocation');assert.equal(h.engine().roles.current,null);
});
test('untrusted safeToStartSuccessor property on escaping primitive error cannot authorize new allocation',async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;const old=resources(h),forged=Object.assign(new Error('resource getter failed'),{safeToStartSuccessor:true});
  Object.defineProperty(old.socket,'readyState',{configurable:true,get(){throw forged;}});
  const stopping=settle(stop(h,a.handle)),b=await engineStart(h,track('B'));const result=await stopping;assert.ok(result.error);
  assert.ok((await b.work).error,'only internal cleanup result can classify physical completion');assert.equal(h.platform.contexts.length,1);assert.equal(old.context.closeCount,1,'cleanup continues through captured resources despite getter failure');
});
for(const rejection of [null,undefined,false,0,''])test(`falsy escaping physical failure (${String(rejection)}) remains rejected and allocation-blocking`,async t=>{
  const h=await fixture(t),a=await engineStart(h);await a.work;const old=resources(h);
  Object.defineProperty(old.socket,'readyState',{configurable:true,get(){throw rejection;}});
  // Do not use truthiness to observe rejection: undefined/null are valid reasons.
  const stopping=stop(h,a.handle).then(value=>({fulfilled:true,value}),error=>({fulfilled:false,error}));
  const b=await engineStart(h,track('B'));const result=await stopping;assert.equal(result.fulfilled,false);
  assert.equal(h.platform.contexts.length,1);assert.equal(h.engine().roles.current,null);
  const bResult=await b.work;assert.equal(bResult.value,undefined);assert.ok(Object.prototype.hasOwnProperty.call(bResult,'error'),'B must reject even when original reason is falsy');
});
for(const reason of [null,undefined,false,0,''])test(`falsy preparer rejection (${String(reason)}) cannot conceal staged close rejection`,async t=>{
  const h=await fixture(t);h.platform.holds.module=true;const a=await engineStart(h),old=h.platform.contexts[0];h.platform.holds.close=true;
  const stopping=stop(h,a.handle).then(value=>({fulfilled:true,value}),error=>({fulfilled:false,error})),b=await engineStart(h,track('B'));
  old.module.reject(reason);await h.flush();assert.ok(old.closeGate);h.platform.holds.module=false;h.platform.holds.close=false;old.closeGate.reject(Object.freeze(new Error('staged close failed')));
  assert.equal((await stopping).fulfilled,false);await a.work;assert.ok(Object.prototype.hasOwnProperty.call(await b.work,'error'));assert.equal(h.platform.contexts.length,1);assert.equal(h.engine().roles.current,null);
});
for(const closeFails of [false,true])test(`preparation exception getters cannot forge private cleanup outcome (close fails: ${closeFails})`,async t=>{
  const h=await fixture(t);h.platform.holds.module=true;const a=await engineStart(h),old=h.platform.contexts[0];let reads=0;
  const original=Object.preventExtensions(Object.defineProperties(new Error('original preparation failure'),{
    cleanupErrors:{get(){reads++;throw new Error('untrusted cleanupErrors getter');}},
    safeToStartSuccessor:{get(){reads++;return !closeFails;}}
  }));
  h.platform.holds.close=true;const stopping=settle(stop(h,a.handle)),b=await engineStart(h,track('B'));old.module.reject(original);await h.flush();assert.ok(old.closeGate);
  h.platform.holds.module=false;h.platform.holds.close=false;if(closeFails)old.closeGate.reject(null);else old.closeGate.resolve();
  assert.ok((await stopping).error,'A observes original failure even when physical cleanup succeeds');await a.work;const result=await b.work;
  assert.equal(reads,0,'engine must not read arbitrary cleanup-classification getters');assert.equal(Object.isExtensible(original),false);
  if(closeFails){assert.ok(Object.prototype.hasOwnProperty.call(result,'error'));assert.equal(h.platform.contexts.length,1);}
  else {assert.equal(result.error,undefined);assert.equal(result.value.track.path,track('B').path);assert.equal(h.engine().context.closeCount,0);}
});
