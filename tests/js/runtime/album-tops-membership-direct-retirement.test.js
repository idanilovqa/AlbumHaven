const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,topPayload,settle,F,outcome}=require('./album-tops-membership-fixtures/actual-request-fixture.cjs');
for(const mode of ['abort','success','wrong-resource','http','network'])test(`same-ID local claim silently retires direct ${mode} completion`,{timeout:2000},async t=>{
  const h=fixture(t),settled=[],historyBefore=structuredClone(h.calls.history);let starts=0;
  const saved=h.context.AbortController;
  // The real owner supports absent AbortController. Its late-response path
  // must still respect the actual local view revision, not just request ID.
  if(mode!=='abort')h.context.AbortController=undefined;
  const pending=outcome(h.navigate({top_ref:F.OTHER,onStart(){starts++;},onSettled:value=>settled.push(value)}));
  h.context.AbortController=saved;
  assert.equal(starts,1);assert.equal(h.requests.length,1);
  const id=h.context.state.ui.activeViewRequestId,revision=h.context.readViewStateRevision(),view=h.context.state.view;
  assert.equal(typeof h.context.claimLocalViewStateNavigation,'function');h.context.claimLocalViewStateNavigation();
  assert.equal(h.context.state.ui.activeViewRequestId,id);assert.equal(h.context.readViewStateRevision(),revision+1);
  assert.strictEqual(h.context.state.view,view);assert.equal(h.context.state.ui.pendingViewTransition,false);
  if(mode==='abort')assert.equal(h.requests[0].options.signal.aborted,true);
  else if(mode==='network')h.requests[0].reject(new TypeError('Late obsolete network failure'));
  else h.respond(0,mode==='http'?{error:'Late obsolete HTTP failure'}:topPayload(mode==='wrong-resource'?F.TOP:F.OTHER),mode==='http'?503:200);
  const result=await pending;if(result.error)assert.equal(result.error.name,'AbortError');else assert.equal(result.value,false);
  await settle();assert.deepEqual(settled,[]);assert.equal(h.applied.length,0);assert.deepEqual(h.calls.history,historyBefore);
  assert.equal(h.events.filter(value=>value==='drawer').length,0);assert.equal(h.context.state.busy,false);
});
for(const mode of ['wrong-resource','http','network'])test(`current direct ${mode} still has one actionable terminal settlement`,{timeout:2000},async t=>{
  const h=fixture(t),settled=[];
  const pending=outcome(h.navigate({top_ref:F.OTHER,onSettled:value=>settled.push(value)}));
  assert.equal(h.requests.length,1);
  if(mode==='network')h.requests[0].reject(new TypeError('Current destination unavailable'));
  else h.respond(0,mode==='http'?{error:'Current destination unavailable'}:topPayload(F.TOP),mode==='http'?503:200);
  const result=await pending;await settle();assert.equal(settled.length,1);assert.equal(settled[0].opened,false);
  if(mode==='wrong-resource'){assert.ifError(result.error);assert.equal(result.value,false);assert.equal(settled[0].error,null);}
  else{assert.match(result.error?.message||'',/Current destination unavailable/);assert.match(settled[0].error?.message||'',/Current destination unavailable/);}
});
test('local claim also clears an unstarted native queue without manufacturing a completion',{timeout:2000},async t=>{
  const h=fixture(t),settled=[];let starts=0;
  const original=h.context.AbortController;h.context.AbortController=undefined;
  const blocker=h.read(`/view-data?surface=album_tops&top_ref=${F.TOP}`,{shouldApplyResponse:()=>false});h.context.AbortController=original;
  assert.equal(await h.navigate({top_ref:F.OTHER,onStart(){starts++;},onSettled:value=>settled.push(value)}),false);
  assert.equal(starts,0);assert.deepEqual(settled,[]);
  h.context.claimLocalViewStateNavigation();h.respond(0);await blocker;await settle();
  assert.equal(h.requests.length,1);assert.equal(starts,0);assert.deepEqual(settled,[]);
});
