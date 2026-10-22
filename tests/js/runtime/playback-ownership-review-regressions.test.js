'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,world,track,start,frame,displayMessages}=require('./search-native-fixtures/ownership-platform.cjs');
const {submitListener,beginListenerQueue,settleListenerQueue,listenerBatchReply}=require('./search-native-fixtures/listener-search.cjs');
const KEY='albumhaven.playbackOwnership.v1';
const outcome=p=>Promise.resolve(p).then(value=>({fulfilled:true,value}),error=>({fulfilled:false,error}));
async function openSockets(h){await h.flush();for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();await h.flush();}
async function rendered(h,payload=track('A')){const a=await start(h,payload);assert.equal(await a.work,true);frame(h,a.role);await h.flush();return a;}
function nativeStart(h,payload){let attempt;const work=outcome(h.c.startStreamingTrack(payload,{onStartAttempt:value=>{attempt=value;}}));return {work,attempt};}

test('manual A retiring restored R cannot overwrite B registered by real Queue cancellation dispatch',async t=>{
  const h=await fixture(t,world(),{holds:{module:true},readyState:'complete',savedPlayerState:{track:track('R'),playbackQueue:null,currentTime:0,paused:true,loop:{active:false,start:0,end:90}}});
  await h.flush();
  const restored=h.owner('playerRestoreAttempt'),old=h.platform.contexts[0];assert.ok(restored?.engineAttempt);assert.ok(old);
  let b,bSelection,seen=false;const off=h.queue.subscribe(()=>{if(seen)return;seen=true;b=start(h,track('B'));bSelection=h.owner('playerSelectionOwnership');});
  h.platform.holds.module=false;const outer=outcome(h.c.playTrackFromPayload(track('OuterA')));await h.flush();
  assert.equal(seen,true,'real retirement dispatched Queue notification');assert.ok(bSelection);assert.equal(h.owner('playerSelectionOwnership'),bSelection,'older manual frame cannot replace nested selection');
  old.module.resolve();await openSockets(h);const next=await b;await openSockets(h);assert.equal(await next.work,true);assert.equal((await outer).value,false);
  assert.equal(h.state.player.current.path,track('B').path);assert.equal(h.engine().roles.current.track.path,track('B').path);assert.equal(old.closeCount,1);assert.equal(h.engine().context.closeCount,0);off();
});

for(const reenter of [false,true])test(`failed replacement lease write retires captured A ${reenter?'while preserving reentrant B':'without leaving unleased audio'}`,async t=>{
  const h=await fixture(t),a=await rendered(h),old={context:h.engine().context,node:h.engine().node,socket:h.engine().socket},oldAttempt=h.c.captureStreamingPlaybackAttempt();let b,bHandle,failed=0;
  h.platform.beforeStorageWrite=({kind,key})=>{if(kind!=='local'||key!==KEY)return;h.platform.beforeStorageWrite=null;failed++;
    if(reenter){b=start(h,track('B'));bHandle=h.c.getActivePlaybackOwnershipHandle();}
    throw new Error('bounded Storage quota failure before mutation');
  };
  const outer=await start(h,track('OuterA'));assert.equal(await outer.work,false);await openSockets(h);assert.equal(failed,1);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt),false);
  if(reenter){const next=await b;h.world.advance(1000);await openSockets(h);assert.equal(await next.work,true);assert.ok(bHandle);assert.equal(h.c.getActivePlaybackOwnershipHandle(),bHandle);assert.equal(h.engine().roles.current.track.path,track('B').path);assert.equal(h.engine().context.closeCount,0);frame(h,h.engine().roles.current);await h.flush();assert.equal(displayMessages(h.world).at(-1).data.display.title,track('B').title);}
  else {assert.equal(old.context.closeCount,1);assert.equal(old.node.disconnectCount,1);assert.equal(old.socket.closeCount,1);assert.equal(h.engine().roles.current,null);assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);assert.equal(h.world.local.has(KEY),false);}
});

test('pending same-path replacement reservation cannot adopt old committed continuity evidence',async t=>{
  const h=await fixture(t),a=await rendered(h),nextTrack=track('Next');
  h.platform.nodes.at(-1).emit({type:'consumed',generation:a.role.generation,streamId:a.role.streamId,role:'current',frames:0,bufferedFrames:48000});
  await h.c.scheduleStreamingContinuity(nextTrack);const continuity=h.engine().roles.continuity;assert.ok(continuity);
  const pending=h.c.claimPlaybackOwnership({...a.payload});assert.ok(pending);const before=displayMessages(h.world).length;
  h.platform.nodes.at(-1).emit({type:'boundary',generation:a.role.generation,outgoingStreamId:a.role.streamId,incomingStreamId:continuity.streamId,renderedFrame:48000});await h.flush();
  assert.equal(h.engine().roles.current,continuity,'real engine boundary was delivered');assert.equal(displayMessages(h.world).length,before,'pending claim cannot publish old role evidence');
  assert.equal(h.state.player.current.path,a.payload.path);assert.equal(h.c.getActivePlaybackOwnershipHandle(),pending);
});

test('ended facade rejection belongs to A captured before Queue abort synchronously registers B',async t=>{
  const h=await fixture(t),a=await rendered(h),snapshot=await submitListener(h,undefined,{resumedWaveform:true}),request=await beginListenerQueue(h,snapshot);assert.equal((await settleListenerQueue(h,request)).error,undefined);
  const capture=h.queueOwner().captureStop();assert.ok(capture.refresh,'actual Queue refresh is pending');assert.ok(h.state.player.listenSession,'actual rendered A owns listen session');
  let b,isoFailures=0;const Clock=h.c.Date,original=Clock.prototype.toISOString;
  capture.refresh.signal.addEventListener('abort',()=>{
    b=nativeStart(h,track('B'));assert.ok(b.attempt,'B registers synchronously before facade returns');
    Clock.prototype.toISOString=function(){Clock.prototype.toISOString=original;isoFailures++;throw new Error('bounded Date primitive failure during A finalization');};
  },{once:true});
  t.after(()=>{Clock.prototype.toISOString=original;});
  h.platform.nodes.at(-1).emit({type:'ended',generation:a.role.generation,streamId:a.role.streamId,timelineFrame:48000});
  assert.ok(b);assert.equal(isoFailures,1,'actual A finalization threw, becoming an asynchronous facade rejection');await openSockets(h);
  const result=await b.work;assert.equal(result.fulfilled,true);assert.equal(result.value.track.path,track('B').path);assert.equal(h.c.isStreamingPlaybackAttemptCurrent(b.attempt),true);assert.notEqual(h.engine().mode,'error');frame(h,result.value);await h.flush();assert.equal(h.engine().mode,'playing');assert.equal(h.engine().context.closeCount,0);
});

test('failed replacement release storage callback cannot stop successor reservation and Queue pending before engine registration',async t=>{
  const h=await fixture(t),a=await rendered(h),snapshot=await submitListener(h,undefined,{resumedWaveform:true}),request=await beginListenerQueue(h,snapshot),queued=await settleListenerQueue(h,request);assert.equal(queued.error,undefined);
  const oldAttempt=h.c.captureStreamingPlaybackAttempt(),oldContext=h.engine().context;let bHandle,bQueue,bCapture,bIndex,callbackError,entered=false;
  h.platform.beforeStorageWrite=({kind,key})=>{if(kind!=='local'||key!==KEY)return;h.platform.beforeStorageWrite=null;
    h.platform.storageHook=({op,key})=>{
      if(op!=='get'||key!==KEY||h.c.getActivePlaybackOwnershipHandle()!==null)return;
      h.platform.storageHook=null;entered=true;
      try {
        // A live current track cannot be started through Queue.play. Preserve
        // its exact attempt in a reservation while the real ended event makes
        // queued entries ready; replace that reservation during Queue notify.
        const endingHandle=h.c.claimPlaybackOwnership(track('EndingA'));assert.ok(endingHandle);
        const off=h.queue.subscribe(()=>{
          off();
          try {
            bHandle=h.c.claimPlaybackOwnership(track('ReservedB'));assert.ok(bHandle);
            bIndex=h.requests.length;bQueue=outcome(h.queue.play(queued.value[1]));bCapture=h.queueOwner().captureStop();
            assert.ok(bCapture.start);assert.equal(h.c.captureStreamingPlaybackAttempt(),oldAttempt,'B has not registered a new engine attempt yet');
          } catch(error){callbackError=error;}
        });
        t.after(off);
        h.platform.nodes.at(-1).emit({type:'ended',generation:a.role.generation,streamId:a.role.streamId,timelineFrame:48000});
      } catch(error){callbackError=error;}
    };
    throw new Error('bounded failed replacement storage write');
  };
  const outer=await start(h,track('OuterA'));assert.equal(await outer.work,false);assert.equal(entered,true);assert.equal(callbackError,undefined,callbackError?.stack);assert.ok(bHandle);assert.ok(bCapture?.start);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(),bHandle);assert.equal(bCapture.start.signal.aborted,false,'old release cannot halt successor Queue');assert.equal(h.queueOwner().isStopCurrent(bCapture),true);
  assert.equal(oldContext.closeCount,0,'B reservation adopted responsibility for the prior native attempt');assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt),true);
  h.reply(bIndex,listenerBatchReply(h,bIndex));await openSockets(h);h.world.advance(1000);await openSockets(h);assert.equal((await bQueue).value,true);assert.equal(h.engine().roles.current.track.path,'/library/queue/102.flac');assert.equal(h.engine().context.closeCount,0);assert.equal(h.platform.sockets.flatMap(socket=>socket.sent).filter(message=>message.type==='close'&&message.generation===a.role.generation&&message.streamId===a.role.streamId).length,1,'adopted predecessor role retires exactly once when B binds');
});

for(const reenter of [false,true])test(`actual facade invoker synchronous failure ${reenter?'preserves nested B':'still fails current A'}`,async t=>{
  const h=await fixture(t),a=await rendered(h),old=h.engine().context;let b;
  // Supplemental invoker contract: callback is an injected failure input, not a
  // replacement for a production facade. The ended test above covers the real
  // worklet→facade→Queue path with the full actual handler.
  h.c.invokeStreamingFacadeCallback(()=>{if(reenter)b=nativeStart(h,track('B'));throw Object.freeze(new Error('synchronous facade input failure'));},'independent-sync-input',a.role,a.role.generation);
  await openSockets(h);
  if(reenter){h.world.advance(1000);await openSockets(h);const result=await b.work;assert.equal(result.fulfilled,true);assert.equal(h.c.isStreamingPlaybackAttemptCurrent(b.attempt),true);assert.equal(result.value.track.path,track('B').path);assert.equal(h.engine().context.closeCount,0);}
  else {assert.equal(h.engine().roles.current,null);assert.equal(old.closeCount,1);assert.equal(h.engine().mode,'error');}
});

test('unrelated active reservation cannot suppress exact cancellation of a paused prior attempt',async t=>{
  const h=await fixture(t);await rendered(h);const oldAttempt=h.c.captureStreamingPlaybackAttempt(),old=h.engine().context;
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(),true);assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);
  const unrelated=h.c.claimPlaybackOwnership(track('Unrelated'));assert.ok(unrelated,'paused predecessor is not adopted by new reservation');
  h.c.cancelPlaybackAttempt(oldAttempt,'independent-unrelated-lease');await h.flush();
  assert.equal(old.closeCount,1,'an arbitrary active lease does not suppress cancellation');assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt),false);assert.equal(h.engine().roles.current,null);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(),unrelated,'cancellation does not clear unrelated reservation');
  const b=nativeStart(h,track('Unrelated'));assert.equal(h.c.bindPlaybackOwnershipAttempt(unrelated,b.attempt),true);await openSockets(h);assert.equal((await b.work).value.track.path,track('Unrelated').path);assert.equal(h.engine().context.closeCount,0);
});

test('exact adopted pending reservation takes responsibility for predecessor expiry and closes it once',async t=>{
  const h=await fixture(t);await rendered(h);const oldAttempt=h.c.captureStreamingPlaybackAttempt(),old={context:h.engine().context,node:h.engine().node,socket:h.engine().socket};
  const adopter=h.c.claimPlaybackOwnership(track('PendingAdopter'));assert.ok(adopter);h.c.cancelPlaybackAttempt(oldAttempt,'old-release-continuation');await h.flush();
  assert.equal(old.context.closeCount,0);assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt),true);assert.equal(h.c.getActivePlaybackOwnershipHandle(),adopter);
  h.world.advance(15000);await h.flush();assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt),false);
  assert.equal(old.context.closeCount,1);assert.equal(old.node.disconnectCount,1);assert.equal(old.socket.closeCount,1);
  h.c.cancelPlaybackAttempt(oldAttempt,'duplicate-old-release');await h.flush();assert.equal(old.context.closeCount,1);
});
