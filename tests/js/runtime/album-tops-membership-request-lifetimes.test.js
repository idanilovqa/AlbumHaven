const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopDraft, createAlbumTopBackendProviders;
test.before(async () => {
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
});
function setup(t, {initial, ...overrides} = {}) {
  const c=F.controllerFixture(initial),p=F.providerFixture(overrides),draft=createAlbumTopDraft({controller:c.controller,providers:p.providers});
  t.after(()=>draft.dispose());return {...c,...p,mutations:c.calls,draft};
}
const refs=value=>value.search.items.map(row=>row.album_ref);

for(const nextOutcome of ['error','late-success']) test(`new query ${nextOutcome} cannot display old clickable cards or reuse an old cursor`,async t=>{
  const gate=F.deferred();const {draft,calls}=setup(t,{search:({q})=>q==='old'?{albums:[F.album()],next_cursor:'old-cursor'}:gate.promise});
  await draft.setQuery('old');assert.deepEqual(refs(draft.getSnapshot()),[F.A]);
  const pending=draft.setQuery('new');
  assert.deepEqual(draft.getSnapshot().search.items,[]);assert.equal(draft.getSnapshot().search.next_cursor,null);
  await draft.select(F.album());assert.deepEqual(calls.admit,[]);
  if(nextOutcome==='error')gate.reject(F.error(503));else gate.resolve({albums:[F.album(12)],next_cursor:'new-cursor'});
  await pending;
  if(nextOutcome==='error'){
    assert.equal(draft.getSnapshot().search.status,'error');assert.deepEqual(draft.getSnapshot().search.items,[]);assert.equal(draft.getSnapshot().search.next_cursor,null);
    await draft.loadMore();assert.equal(calls.search.length,2);await draft.select(F.album());assert.deepEqual(calls.admit,[]);
  }else{
    assert.deepEqual(refs(draft.getSnapshot()),[F.B]);assert.equal(draft.getSnapshot().search.next_cursor,'new-cursor');
  }
});

for(const revoke of ['item-capability','add-projection','source-locked','type']) test(`same-revision ${revoke} change during search invalidates late membership metadata`,async t=>{
  const gate=F.deferred(),initial=F.state({editing:true});
  const {draft,replace,calls,mutations}=setup(t,{initial,search:()=>gate.promise});
  const pending=draft.setQuery('Album');
  const data={...initial.detail.data,allowed_actions:{...initial.detail.data.allowed_actions}};
  if(revoke==='item-capability')data.allowed_actions[F.ITEMS]=false;
  else if(revoke==='add-projection')data.allowed_actions.can_add=false;
  else if(revoke==='source-locked')data.source_locked=true;
  else data.type='imported';
  replace({...initial,detail:{status:'ready',data}});
  gate.resolve({albums:[F.album(13)],next_cursor:'must-not-escape'});await pending;
  assert.deepEqual(draft.getSnapshot().search.items,[]);assert.equal(draft.getSnapshot().search.next_cursor,null);
  await draft.select(F.album(13));draft.remove(F.A);draft.reorder([F.B,F.A]);await draft.submit();
  assert.deepEqual(calls.admit,[]);assert.deepEqual(mutations,[]);assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A,F.B]);
});

test('same-revision item grant revocation during publication preview blocks the already-edited membership Save',async t=>{
  const data=F.detail();data.edit_draft.publication_preview_required=true;
  data.edit_draft.items[1]={...data.edit_draft.items[1],selected_local_album_id:12,selected_source_ref:F.id(32)};
  const initial=F.state({editing:true,data}),gate=F.deferred();
  const {draft,replace,calls,mutations}=setup(t,{initial,preview:()=>gate.promise});
  draft.reorder([F.B,F.A]);const pending=draft.submit();
  assert.equal(calls.preview.length,1);
  replace({...initial,detail:{status:'ready',data:{...data,allowed_actions:{...data.allowed_actions,[F.ITEMS]:false}}}});
  gate.resolve({top_ref:F.TOP,revision:'7',evidence_revision:'a'.repeat(64),items:calls.preview[0].payload.items.map(item=>({...item,title:'Album',artist:'Artist',year:null,track_count:1}))});
  await pending;
  assert.deepEqual(mutations,[]);assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.B,F.A]);
});

function wireDetail(patch={}){
  return {top_ref:F.TOP,revision:'7',title:'Top',description:'',visibility:'private',
    allowed_actions:{[F.BROWSE]:true,[F.MANAGE]:true,[F.ITEMS]:true,can_read:true,can_edit:true,can_add:true,can_remove:true,can_reorder:true},
    items:[{ref:F.IA,catalog_ref:F.A,title:'Album',artist_display:'Artist',release_year:2001,original_position:1,curator_position:1}],
    edit_draft:{items:[{item_ref:F.IA,album_ref:F.A}],publication_preview_required:false},...patch};
}
function provider(t,reply){const result=createAlbumTopBackendProviders({transport:{context:()=> 'a'.repeat(64),request:async()=>({status:'ready',context_ref:'a'.repeat(64),data:reply})},acceptsScope:scope=>scope===F.SCOPE});t.after(()=>result.dispose());return result;}

for(const patch of [{type:'imported'},{type:'automatic'},{source_locked:true}])test(`received ${JSON.stringify(patch)} survives provider projection and fail-closes draft authoring`,async t=>{
  const projected=await provider(t,wireDetail(patch)).read(F.TOP,{scopeKey:F.SCOPE});
  for(const [key,value] of Object.entries(patch))assert.equal(projected[key],value);
  const {draft,calls,mutations}=setup(t,{initial:F.state({editing:true,data:projected})});
  draft.edit({title:'Unauthorized conversion'});draft.remove(F.A);await draft.setQuery('Album');await draft.submit();
  assert.equal(draft.getSnapshot().title,'Top');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A]);assert.deepEqual(calls.search,[]);assert.deepEqual(mutations,[]);
});

test('conditional manual/unlocked flags survive safely, and absent flags are not invented',async t=>{
  const explicit=await provider(t,wireDetail({type:'manual',source_locked:false})).read(F.TOP,{scopeKey:F.SCOPE});
  assert.equal(explicit.type,'manual');assert.equal(explicit.source_locked,false);
  const absent=await provider(t,wireDetail()).read(F.TOP,{scopeKey:F.SCOPE});
  assert.equal(Object.hasOwn(absent,'type'),false);assert.equal(Object.hasOwn(absent,'source_locked'),false);
});

for(const patch of [{type:{value:'manual'}},{type:null},{source_locked:'false'},{source_locked:0}])test('malformed conditional type/lock evidence cannot be erased into an apparently manual DTO',async t=>{
  await assert.rejects(provider(t,wireDetail(patch)).read(F.TOP,{scopeKey:F.SCOPE}));
});
