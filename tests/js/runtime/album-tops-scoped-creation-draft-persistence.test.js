const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createDraft,createController;
test.before(async()=>{({createAlbumTopDraft:createDraft}=await F.load('album-tops/draft.mjs'));({createAlbumTopController:createController}=await F.load('album-tops/model.mjs'));});
const scope={root_artist_id:'3',mode:'artist'},tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function fixture(t,{rows=[F.album(11,{album_ref:null}),F.album(12,{album_ref:null})],admit,execute}={}){
  const calls={admit:[],execute:[]};let serial=100;
  const providers={list:async()=>({tops:[],allowed_actions:{[F.BROWSE]:true,[F.CREATE]:true,can_create:true}}),
    read:async ref=>F.detail({top_ref:ref,items:[]}),listScopedAlbums:async()=>({albums:rows,next_cursor:null}),
    admitAlbum:async(id,options)=>{calls.admit.push({id,options});return admit?admit(id,options):{album_ref:F.id(id)};},
    execute:async(action,command,options)=>{calls.execute.push({action,command:F.clone(command),options});return execute?execute(action,command,options):{action,request_key:command.request_key,top_ref:F.TOP,revision:'1'};}};
  const controller=createController({providers,requestKey:()=>F.id(++serial)});controller.setScope(F.SCOPE);await controller.load();
  const draft=createDraft({controller,providers,artistScope:scope});t.after(()=>{draft.dispose();controller.dispose();});await tick();draft.edit({title:'Captured title',description:'Captured subtitle'});
  return {draft,controller,providers,calls,rows};
}

test('deferred local mapping resolves all then stable-deduplicates one actual Create',async t=>{
  const gate=F.deferred(),h=await fixture(t,{admit:id=>id===11?gate.promise:{album_ref:F.A}});assert.equal(h.calls.admit.length,0);
  const pending=h.draft.submit();await tick();assert.equal(h.calls.admit.length,1);assert.equal(h.calls.execute.length,0);
  assert.equal(await h.draft.submit(),false);gate.resolve({album_ref:F.A});await pending;
  assert.deepEqual(h.calls.admit.map(call=>call.id),[11,12]);assert.equal(h.calls.execute.length,1);
  for(const call of h.calls.admit){assert.deepEqual(call.options.artistScope,scope);assert.equal(call.options.scopeKey,F.SCOPE);assert.ok(call.options.signal instanceof AbortSignal);}
  const command=h.calls.execute[0].command;assert.deepEqual(command,{title:'Captured title',description:'Captured subtitle',album_refs:[F.A],artist_scope:scope,request_key:F.id(101)});
});

test('busy is acquired before reentrant notifications and blocks all captured edits',async t=>{
  const gate=F.deferred(),h=await fixture(t,{admit:()=>gate.promise});let entered=0;const pendingMethods=[];
  const unsubscribe=h.draft.subscribe(()=>{if(!h.draft.getSnapshot().busy||entered)return;entered++;
    assert.equal(h.draft.edit({title:'stolen'}),false);assert.equal(h.draft.remove(h.draft.getSnapshot().items[0].selection_key),false);
    assert.equal(h.draft.reorder([]),false);assert.equal(h.draft.setArtistFilters({releaseTypes:[]}),false);assert.equal(h.draft.resetArtistFilters(),false);
    pendingMethods.push(h.draft.setArtistFamily(true),h.draft.refreshArtistPopulation());});
  const pending=h.draft.submit();await tick();assert.equal(entered,1);assert.deepEqual(await Promise.all(pendingMethods),[false,false]);
  gate.resolve({album_ref:F.A});await pending;unsubscribe();assert.equal(h.calls.execute.length,1);assert.equal(h.calls.execute[0].command.title,'Captured title');assert.deepEqual(h.calls.execute[0].command.artist_scope,scope);
});

test('mapping failure creates no Top command and explicit retry rechecks every unmapped captured row',async t=>{
  let fail=true;const h=await fixture(t,{admit:id=>{if(id===12&&fail)throw F.error(503);return {album_ref:F.id(id)};}});
  const before=F.clone(h.draft.getSnapshot().items);assert.equal(await h.draft.submit(),false);assert.equal(h.calls.execute.length,0);
  assert.deepEqual(h.draft.getSnapshot().items,before);assert.ok(h.draft.getSnapshot().error);fail=false;
  await h.draft.submit();assert.deepEqual(h.calls.admit.map(call=>call.id),[11,12,11,12]);assert.equal(h.calls.execute.length,1);
});

test('uncertain Create uses only actual controller Retry original with frozen key and payload',async t=>{
  let lost=true;const h=await fixture(t,{execute:(action,command)=>{if(lost)throw new Error('lost response');return {action,request_key:command.request_key,top_ref:F.TOP,revision:'1'};}});
  assert.equal(await h.draft.submit(),false);assert.equal(h.controller.getSnapshot().mutation.status,'uncertain');
  const first=F.clone(h.calls.execute[0].command),mappings=h.calls.admit.length;
  assert.equal(await h.draft.submit(),false);assert.equal(h.draft.edit({title:'changed'}),false);assert.equal(h.calls.execute.length,1);assert.equal(h.calls.admit.length,mappings);
  lost=false;assert.equal(h.controller.canRetryMutation(),true);await h.controller.retryMutation();
  assert.equal(h.calls.execute.length,2);assert.deepEqual(h.calls.execute[1].command,first);assert.equal(h.calls.admit.length,mappings);
});

for(const change of ['scope','dispose','provider'])test('late mapping cannot issue Create after '+change,async t=>{
  const gate=F.deferred(),h=await fixture(t,{admit:()=>gate.promise});const pending=h.draft.submit();await tick();
  if(change==='scope')h.controller.setScope('other-session');else if(change==='dispose')h.draft.dispose();else h.providers.admitAlbum=async()=>({album_ref:F.C});
  gate.resolve({album_ref:F.A});assert.equal(await pending,false);assert.equal(h.calls.execute.length,0);
});

test('known catalog rows skip eager mapping but retain scoped final Create admission',async t=>{
  const h=await fixture(t,{rows:[F.album(11),F.album(12)]});await h.draft.submit();assert.equal(h.calls.admit.length,0);
  assert.equal(h.calls.execute.length,1);assert.deepEqual(h.calls.execute[0].command.album_refs,[F.A,F.B]);assert.deepEqual(h.calls.execute[0].command.artist_scope,scope);
});

test('new controller scope during busy notification cannot acquire any mapping or request',async t=>{
  const h=await fixture(t);let once=false;h.draft.subscribe(()=>{if(h.draft.getSnapshot().busy&&!once){once=true;h.controller.setScope('retired');}});
  assert.equal(await h.draft.submit(),false);assert.equal(once,true);assert.equal(h.calls.admit.length,0);assert.equal(h.calls.execute.length,0);
});
