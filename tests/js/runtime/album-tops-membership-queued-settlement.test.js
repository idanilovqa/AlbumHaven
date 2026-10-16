const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,topPayload,settle,F,outcome}=require('./shared-request-unit-fixture.cjs').topRequest();
const source=`/view-data?surface=album_tops&top_ref=${F.TOP}`,target=`/view-data?surface=album_tops&top_ref=${F.OTHER}`;
function blocker(h){
  const saved=h.context.AbortController;h.context.AbortController=undefined;
  const pending=h.read(source,{shouldApplyResponse:()=>false});h.context.AbortController=saved;
  assert.equal(h.requests.length,1);return pending;
}
async function startQueued(h,active){h.respond(0);assert.equal((await active).value,false);await settle();assert.equal(h.requests.length,2);assert.equal(h.requests[1].url,target);}
function complete(h,index,mode){
  if(mode==='network')h.requests[index].reject(new TypeError('Queued destination unavailable'));
  else h.respond(index,mode==='http'?{error:'Queued destination unavailable'}:topPayload(mode==='wrong-resource'?F.TOP:F.OTHER),mode==='http'?503:200);
}
function terminal(value,mode,resultKey){
  assert.equal(value[resultKey],mode==='success');
  if(mode==='http'||mode==='network')assert.match(value.error?.message||'',/Queued destination unavailable/);
  else assert.equal(value.error,null);
}

for(const mode of ['http','network','wrong-resource'])test(`native queued ${mode} has one observed terminal result after its initial false`,{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h),settled=[];
  const queued=await h.read(target,{interruptCurrent:false,shouldApplyResponse:payload=>payload.top_ref===F.OTHER,onSettled:value=>settled.push(value)});
  assert.ifError(queued.error);assert.equal(queued.value,false);assert.deepEqual(settled,[]);assert.equal(h.requests.length,1);
  await startQueued(h,active);assert.deepEqual(settled,[]);complete(h,1,mode);await settle();
  assert.equal(settled.length,1);terminal(settled[0],mode,'applied');assert.equal(settled[0].requestId,h.requests[1].requestId);
  assert.equal(h.context.state.busy,false);assert.equal(h.applied.length,0);await settle();assert.equal(settled.length,1);
});

for(const mode of ['success','http','network','wrong-resource'])test(`Top queued ${mode} settles once for the original intent and keeps exact-target Retry ownership`,{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h),settled=[];let starts=0;
  assert.equal(await h.navigate({top_ref:F.OTHER,onStart(){starts++;},onSettled:value=>settled.push(value)}),false);
  assert.equal(starts,0);assert.deepEqual(settled,[]);
  await startQueued(h,active);assert.equal(starts,1);assert.deepEqual(settled,[]);
  complete(h,1,mode);await settle();assert.equal(settled.length,1);terminal(settled[0],mode,'opened');
  assert.equal(h.events.filter(value=>value==='drawer').length,mode==='success'?1:0,'Successful own completion closes its drawer exactly once');
  if(mode==='success')assert.equal(h.context.state.view.top_ref,F.OTHER);
  else{
    assert.equal(h.applied.length,0);
    const retrySettled=[],retry=h.navigate({top_ref:F.OTHER,onSettled:value=>retrySettled.push(value)});
    assert.equal(h.requests.length,3);assert.equal(h.requests[2].url,h.requests[1].url);h.respond(2);
    assert.equal(await retry,true);await settle();assert.equal(retrySettled.length,1);terminal(retrySettled[0],'success','opened');
    assert.equal(h.events.filter(value=>value==='drawer').length,1);
  }
  await settle();assert.equal(settled.length,1);
});

for(const mode of ['success','http','wrong-resource'])test(`native terminal observer throwing on ${mode} cannot alter the actual return or escape`,{timeout:2000},async t=>{
  const h=fixture(t);let observed=0;
  const pending=h.read(target,{shouldApplyResponse:payload=>payload.top_ref===F.OTHER,onSettled(){observed++;throw new Error('Observer must be contained');}});
  complete(h,0,mode);const result=await pending;await settle();assert.equal(observed,1);
  if(mode==='http')assert.match(result.error?.message||'',/Queued destination unavailable/);
  else{assert.ifError(result.error);assert.equal(result.value,mode==='success');}
});

for(const mode of ['success','http'])test(`Top queued observer throwing on ${mode} is contained without changing view or completion count`,{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h);let observed=0;
  assert.equal(await h.navigate({top_ref:F.OTHER,onSettled(){observed++;throw new Error('Consumer already disposed');}}),false);
  await startQueued(h,active);complete(h,1,mode);await settle();assert.equal(observed,1);
  assert.equal(h.context.state.view.top_ref,mode==='success'?F.OTHER:F.TOP);
  assert.equal(h.events.filter(value=>value==='drawer').length,mode==='success'?1:0);
  assert.equal(h.context.state.busy,false);
});

for(const change of ['scope','context','view','currentness'])test(`already-started queued failure after ${change} retirement is observed internally but silent to the old Top consumer`,{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h),settled=[];let current=true;
  assert.equal(await h.navigate({top_ref:F.OTHER,isCurrent:()=>current,onSettled:value=>settled.push(value)}),false);
  await startQueued(h,active);
  if(change==='scope')h.shell.dataset.nativeAccountId='8';
  else if(change==='context')h.shell.dataset.privateUiContext='b'.repeat(64);
  else if(change==='view')h.context.state.view={...h.context.state.view};else current=false;
  complete(h,1,'http');await settle();assert.deepEqual(settled,[]);assert.equal(h.applied.length,0);
  assert.equal(h.events.filter(value=>value==='drawer').length,0);assert.equal(h.context.state.busy,false);
});

test('newer native intent consumes old queued cancellation and only the current successful intent settles/closes',{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h),oldSettled=[],newSettled=[];
  assert.equal(await h.navigate({top_ref:F.OTHER,onSettled:value=>oldSettled.push(value)}),false);await startQueued(h,active);
  const newer=h.navigate({top_ref:F.TOP,onSettled:value=>newSettled.push(value)});
  assert.equal(h.requests.length,3);assert.equal(h.requests[1].options.signal.aborted,true);
  h.respond(2,topPayload(F.TOP));assert.equal(await newer,true);await settle();
  assert.deepEqual(oldSettled,[]);assert.equal(newSettled.length,1);terminal(newSettled[0],'success','opened');
  assert.equal(h.context.state.view.top_ref,F.TOP);assert.equal(h.events.filter(value=>value==='drawer').length,1);
});

for(const change of ['scope','currentness'])test(`queued ${change} cancellation before genuine dispatch sends no terminal notification`,{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h),settled=[];let current=true,starts=0;
  assert.equal(await h.navigate({top_ref:F.OTHER,isCurrent:()=>current,onStart(){starts++;},onSettled:value=>settled.push(value)}),false);
  if(change==='scope')h.shell.dataset.nativeAccountId='8';else current=false;
  h.respond(0);await active;await settle();assert.equal(h.requests.length,1);assert.equal(starts,0);assert.deepEqual(settled,[]);
});

test('native queued rejection is consumed even when no completion observer was supplied',{timeout:2000},async t=>{
  const h=fixture(t),active=blocker(h);
  assert.equal((await h.read(target,{interruptCurrent:false})).value,false);await startQueued(h,active);
  complete(h,1,'network');await settle();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.context.state.busy,false);assert.equal(h.context.state.ui.pendingViewRequest,null);assert.equal(h.applied.length,0);
  // node:test itself fails unhandledRejection. Deliberately no process listener,
  // catch wrapper around the native queue, or suppressing handler is installed.
});
