const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const F=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let create;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));});
const scope=mode=>({root_artist_id:'3',mode:mode||'artist'}),tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function fixture(t,{main=true,preview=true,albumPatch={},rows=[],acquire}={}){
  const c=F.controllerFixture(),api=F.service();api.providers.listScopedAlbums=async()=>({albums:rows,next_cursor:null});
  let valid=preview;
  api.control.acquireRemoteAlbum=async body=>acquire?acquire(body,api):({...api.acquisition(body),album:F.summary(body.release_group_id,albumPatch),
    artist_scope_preview:valid?{artist_scope:F.clone(body.artist_scope),evidence_version:F.VERSION,main_artist_match:main}:null});
  const draft=create({controller:c.controller,providers:api.providers,artistScope:scope()});t.after(()=>draft.dispose());await tick();
  return {...c,api,draft,mutations:c.calls,setPreview(value){valid=value;}};
}
async function select(h){assert.equal(h.draft.setRemoteTitle('Remote album'),true);await h.draft.searchRemote();const candidate=h.draft.getSnapshot().remote.search.candidates[0];assert.ok(candidate);return h.draft.selectRemote(candidate);}
const remoteItems=h=>h.draft.getSnapshot().items.filter(row=>row.source_kind==='remote_summary');

test('scoped remote search/acquisition forward the exact captured descriptor',async t=>{
  const h=await fixture(t);await select(h);assert.equal(remoteItems(h).length,1);
  assert.deepEqual(h.api.last('searchRemoteAlbums').args[0].artist_scope,scope());assert.deepEqual(h.api.last('acquireRemoteAlbum').args[0].artist_scope,scope());
  assert.equal(h.api.count('beginRemotePreparation'),1);assert.equal(h.api.count('acquireRemoteAlbum'),1);assert.equal(h.mutations.length,0);
});

for(const main of [false,null])test('Family-only or unknown-main acquisition is removed and restored by actual mode '+main,async t=>{
  const h=await fixture(t,{main});await h.draft.setArtistFamily(true);await select(h);assert.equal(remoteItems(h).length,1);
  const selector=F.clone(remoteItems(h)[0].source);await h.draft.setArtistFamily(false);assert.equal(remoteItems(h).length,0);
  await h.draft.setArtistFamily(true);assert.equal(remoteItems(h).length,1);assert.deepEqual(remoteItems(h)[0].source,selector);assert.equal(h.api.count('acquireRemoteAlbum'),1);
});

test('explicit remote exclusion survives mode and filter Reset',async t=>{
  const h=await fixture(t,{main:false});await h.draft.setArtistFamily(true);await select(h);const key=remoteItems(h)[0].selection_key;
  h.draft.remove(key);await h.draft.setArtistFamily(false);await h.draft.setArtistFamily(true);h.draft.resetArtistFilters();assert.equal(remoteItems(h).length,0);assert.equal(h.api.count('acquireRemoteAlbum'),1);
});

test('null acquired preview stays outside Selected and retries exact owned preparation/key',async t=>{
  const h=await fixture(t,{preview:false});await select(h);assert.equal(remoteItems(h).length,0);assert.ok(h.draft.getSnapshot().error||h.draft.getSnapshot().remote.error);
  const first=F.clone(h.api.last('acquireRemoteAlbum').args[0]);h.setPreview(true);await h.draft.retryRemoteAcquisition();
  assert.equal(remoteItems(h).length,1);assert.equal(h.api.count('beginRemotePreparation'),1);assert.equal(h.api.count('acquireRemoteAlbum'),2);
  assert.deepEqual(h.api.last('acquireRemoteAlbum').args[0],first);
});

for(const [primary,type] of [['EP','ep'],['Single','single'],['Album',null],['Broadcast',null],['Other',null],[null,null]])test('remote type does not infer local studio '+primary,async t=>{
  const h=await fixture(t,{albumPatch:{primary_type:primary}});await select(h);assert.equal(remoteItems(h).length,1);
  h.draft.setArtistFilters({releaseTypes:[type||'studio']});assert.equal(remoteItems(h).length,type?1:0);
  h.draft.resetArtistFilters();assert.equal(remoteItems(h).length,1);h.draft.setArtistFilters({includeRated:false});assert.equal(remoteItems(h).length,0);
});

for(const date of ['2001','2001-03','2001-03-05',null])test('validated date supplies only known year '+date,async t=>{
  const h=await fixture(t,{albumPatch:{first_release_date:date}});await select(h);h.draft.setArtistFilters({minYear:2001,maxYear:2001});assert.equal(remoteItems(h).length,date?1:0);
});

for(const patch of [{primary_type:'Live'},{first_release_date:'2001-02-30'},{first_release_date:'0000'},{first_release_date:'2001-13'}])test('defensive malformed remote summary cannot become eligible '+JSON.stringify(patch),async t=>{
  const h=await fixture(t,{albumPatch:patch});await select(h);assert.equal(remoteItems(h).length,0);
});

for(const change of ['mode','context','dispose'])test('pending acquisition cannot enter a retired generation '+change,async t=>{
  const gate=F.deferred();let body;const h=await fixture(t,{acquire:(payload,api)=>{body=payload;return gate.promise;}});
  const pending=select(h);await tick();assert.ok(body);
  if(change==='mode')await h.draft.setArtistFamily(true);else if(change==='context')h.api.setIdentity(Object.freeze({context:'b'.repeat(64),generation:2}));else h.draft.dispose();
  gate.resolve({...h.api.acquisition(body),artist_scope_preview:{artist_scope:scope(),evidence_version:F.VERSION,main_artist_match:true}});
  await pending;assert.equal(remoteItems(h).length,0);assert.equal(h.mutations.length,0);
});

test('active type predicate cannot be bypassed by a later acquired valid preview',async t=>{
  const h=await fixture(t,{albumPatch:{primary_type:'Single'}});h.draft.setArtistFilters({releaseTypes:['ep']});await select(h);assert.equal(remoteItems(h).length,0);
  h.draft.resetArtistFilters();assert.equal(remoteItems(h).length,1);assert.equal(h.api.count('acquireRemoteAlbum'),1);
});
