const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,settle,F}=require('./shared-request-unit-fixture.cjs').topRequest();
test('a queued own success retains the native drawer close options and does not restore stale sidebar focus',{timeout:2000},async t=>{
  const h=fixture(t),closed=[],settled=[];
  h.context.closeArtistsDrawer=options=>closed.push({...options});
  const saved=h.context.AbortController;h.context.AbortController=undefined;
  const blocker=h.read(`/view-data?surface=album_tops&top_ref=${F.TOP}`,{shouldApplyResponse:()=>false});
  h.context.AbortController=saved;
  assert.equal(await h.navigate({top_ref:F.OTHER,onSettled:value=>settled.push(value)}),false);
  assert.deepEqual(closed,[]);assert.deepEqual(settled,[]);
  h.respond(0);await blocker;await settle();assert.equal(h.requests.length,2);
  h.respond(1);await settle();
  assert.deepEqual(closed,[{restoreFocus:false}]);
  assert.equal(settled.length,1);assert.equal(settled[0].opened,true);assert.equal(settled[0].error,null);
  assert.equal(h.context.state.view.top_ref,F.OTHER);
  await settle();assert.deepEqual(closed,[{restoreFocus:false}]);
});
