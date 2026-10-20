const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const F=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let createDraft,createController;test.before(async()=>{({createAlbumTopDraft:createDraft}=await F.load('album-tops/draft.mjs'));({createAlbumTopController:createController}=await F.load('album-tops/model.mjs'));});
const scope={root_artist_id:'3',mode:'artist'},tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function fixture(t,{admit,execute}={}){
  const api=F.service();let serial=100;
  api.control.list=()=>({tops:[],next_cursor:null,allowed_actions:{[F.BROWSE]:true,[F.CREATE]:true,can_create:true}});
  api.providers.listScopedAlbums=async()=>({albums:[F.album(11,{album_ref:null}),F.album(12)],next_cursor:null});
  api.control.acquireRemoteAlbum=body=>({...api.acquisition(body),artist_scope_preview:{artist_scope:F.clone(body.artist_scope),evidence_version:F.VERSION,main_artist_match:true}});
  api.control.admitAlbum=admit||(()=>({album_ref:F.B}));if(execute)api.control.execute=execute;
  const controller=createController({providers:api.providers,requestKey:()=>F.id(++serial)});controller.setScope(F.SCOPE);await controller.load();
  const draft=createDraft({controller,providers:api.providers,artistScope:scope});t.after(()=>{draft.dispose();controller.dispose();});await tick();
  draft.edit({title:'Mixed scope',description:'Captured'});draft.setRemoteTitle('Remote');await draft.searchRemote();await draft.selectRemote(draft.getSnapshot().remote.search.candidates[0]);
  assert.equal(draft.getSnapshot().items.length,3);return {api,controller,draft};
}
const commands=h=>h.api.calls.filter(call=>call.method==='execute');
function assertCommand(h,command){
  assert.deepEqual(command,{title:'Mixed scope',description:'Captured',artist_scope:scope,draft_ref:h.api.last('beginRemotePreparation').args[0].form_ref,
    selections:[{kind:'local_catalog',album_ref:F.B},{kind:'remote_acquisition',acquisition_ref:F.ACQUISITION,evidence_version:F.VERSION}],request_key:F.id(101)});
}

test('genuine controller sends one frozen mixed Create only after local mapping and canonical deduplication',async t=>{
  const gate=F.deferred(),h=await fixture(t,{admit:()=>gate.promise});const pending=h.draft.submit();await tick();assert.equal(commands(h).length,0);
  assert.equal(h.api.count('admitAlbum'),1);assert.equal(await h.draft.submit(),false);assert.equal(h.draft.edit({title:'Late'}),false);
  gate.resolve({album_ref:F.B});await pending;assert.equal(commands(h).length,1);assert.equal(commands(h)[0].args[0],'create');assertCommand(h,commands(h)[0].args[1]);
  assert.equal(h.api.count('acquireRemoteAlbum'),1);assert.equal(h.api.count('beginRemotePreparation'),1);
});

test('uncertain mixed Create retries actual original command without mapping or remote reacquisition',async t=>{
  let lost=true;const h=await fixture(t,{execute:(action,command)=>{if(lost)throw new Error('response lost');return F.receipt(action,command);}});
  assert.equal(await h.draft.submit(),false);assert.equal(h.controller.getSnapshot().mutation.status,'uncertain');const original=F.clone(commands(h)[0].args[1]);assertCommand(h,original);
  assert.equal(await h.draft.submit(),false);assert.equal(commands(h).length,1);assert.equal(h.api.count('admitAlbum'),1);assert.equal(h.api.count('acquireRemoteAlbum'),1);
  lost=false;assert.equal(h.controller.canRetryMutation(),true);await h.controller.retryMutation();assert.equal(commands(h).length,2);assert.deepEqual(commands(h)[1].args[1],original);
  assert.equal(h.api.count('admitAlbum'),1);assert.equal(h.api.count('acquireRemoteAlbum'),1);assert.equal(h.api.count('beginRemotePreparation'),1);
});

test('scope retirement during deferred mixed mapping cannot dispatch the captured remote selector',async t=>{
  const gate=F.deferred(),h=await fixture(t,{admit:()=>gate.promise});const pending=h.draft.submit();await tick();h.controller.setScope('retired-session');
  gate.resolve({album_ref:F.B});assert.equal(await pending,false);assert.equal(commands(h).length,0);assert.equal(h.api.count('acquireRemoteAlbum'),1);
});
