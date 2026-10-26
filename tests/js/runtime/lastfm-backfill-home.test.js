'use strict';
// Source authored, UNRUN. Actual provider with explicit transport/runtime doubles.
const test=require('node:test'),assert=require('node:assert/strict');
const {load,deferred}=require('./home-friends-native-app-fixture.cjs');
const PLAN='11111111-1111-4111-8111-111111111111',REF='b'.repeat(64);
const context={scopeKey:'own:1',account_ref:null,kind:'listens',period:'all'};
const status=patch=>({id:PLAN,state:'active',revision:1,upper_cut:1700000000,cursor_end:1700000000,
 window_seconds:2678400,completed_windows:0,next_allowed_at:'2023-11-14T22:13:20+00:00',...patch});
async function setup(t){
 const {createHomeBackendProviders}=await load('backend-providers.mjs'),wait=deferred(),calls=[];
 const transport={context:()=>REF,subscribe:()=>()=>{},request(path,options){calls.push({path,options});return wait.promise;}};
 const provider=createHomeBackendProviders(transport,{runtime:{snapshot:()=>({scopeKey:context.scopeKey})}});
 t.after(()=>provider.dispose());return {provider,wait,calls};
}
test('All Time start is explicit and strips all client account and range claims',async t=>{
 const h=await setup(t),pending=h.provider.lastfmHistoryCommand({...context,command:'backfill_begin',username:'foreign',upper_cut:99});
 assert.deepEqual(h.calls[0].options.body,{command:'backfill_begin'});
 assert.equal(h.calls[0].path,'/home/activity/lastfm/import');
 h.wait.resolve({status:'ready',data:status({raw_xml:'private',provider_username:'private',complete_history:true})});
 const result=await pending;assert.equal(result.plan,PLAN);assert.equal(result.complete_history,false);
 assert.equal(result.raw_xml,undefined);assert.equal(h.calls.length,1);
});
test('All Time advance sends only exact plan revision and never loops pages',async t=>{
 const h=await setup(t),pending=h.provider.lastfmHistoryCommand({...context,command:'backfill_advance',plan:PLAN,revision:2,page:99});
 assert.deepEqual(h.calls[0].options.body,{command:'backfill_advance',plan:PLAN,revision:2});
 h.wait.resolve({status:'ready',data:status({revision:3})});await pending;assert.equal(h.calls.length,1);
});
test('All Time invalid plans and revisions cannot dispatch',async t=>{
 const h=await setup(t);
 for(const bad of [{plan:'bad',revision:1},{plan:PLAN,revision:0},{plan:PLAN,revision:1.5}])
  await assert.rejects(h.provider.lastfmHistoryCommand({...context,command:'backfill_advance',...bad}));
 assert.equal(h.calls.length,0);
});
test('All Time recovery is bounded and hides account lineage',async t=>{
 const h=await setup(t),pending=h.provider.lastfmHistoryCommand({...context,command:'backfill_pending'});
 h.wait.resolve({status:'ready',data:{plans:[status({connection_started_at:'private'})]}});
 const result=await pending;assert.equal(result.plans.length,1);assert.equal(result.plans[0].connection_started_at,undefined);
});
test('All Time malformed cursor response cannot claim observed completeness',async t=>{
 const h=await setup(t),pending=h.provider.lastfmHistoryCommand({...context,command:'backfill_begin'});
 h.wait.resolve({status:'ready',data:status({cursor_end:1700000001,state:'observed'})});
 await assert.rejects(pending);
});
test('actual All Time controls resume exact revision and never advance automatically',async t=>{
 const {fixture,settle}=require('./home-friends-native-app-fixture.cjs');
 const ui=fixture(t),{mountLastfmHistoryControls}=await load('lastfm-history-controls.mjs'),calls=[],wait=deferred();
 const saved={...status(),plan:PLAN,state:'paused',revision:7};delete saved.id;
 const runtime={...ui.runtime,canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[saved],
  importLastfmHistory(command,_context,signal){calls.push({command,signal});return wait.promise;}};
 const controls=ui.own(mountLastfmHistoryControls(ui.host,runtime));
 controls.update({context,coverage:{enabled:true,connected:true,observation_state:'partial'}});
 const resume=[...ui.host.querySelectorAll('button')].find(x=>x.textContent==='Resume same All Time range');
 resume.dispatchEvent(new ui.c.Event('click',{bubbles:true}));
 assert.deepEqual(calls[0].command,{command:'backfill_resume',plan:PLAN,revision:7});
 wait.resolve({...saved,state:'active',revision:8});await settle();
 assert.equal(calls.length,1,'resuming never starts a provider page implicitly');
 assert.match(ui.host.textContent,/Each click reads at most one page/);
 assert.match(ui.host.textContent,/Provider history may change/);
});
test('actual All Time recovery progress is removed on owner read revocation',async t=>{
 const {fixture}=require('./home-friends-native-app-fixture.cjs');
 const ui=fixture(t),{mountLastfmHistoryControls}=await load('lastfm-history-controls.mjs');
 const saved={...status(),plan:PLAN};delete saved.id;
 const runtime={...ui.runtime,canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[saved]};
 const controls=ui.own(mountLastfmHistoryControls(ui.host,runtime));
 controls.update({context,coverage:{enabled:true,connected:true}});
 assert.match(ui.host.textContent,/All Time plan 11111111/);
 controls.update({context,coverage:null});
 assert.equal(ui.host.hidden,true);assert.doesNotMatch(ui.host.textContent,/All Time plan 11111111/);
});
