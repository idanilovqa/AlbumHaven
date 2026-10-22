const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const F=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let create;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));});
const scope={root_artist_id:'3',mode:'artist'};
const rows=(count,start=100)=>Array.from({length:count},(_,i)=>F.album(start+i));
const tick=async()=>{for(let i=0;i<800;i++)await Promise.resolve();};
async function fixture(t,initial){
  const c=F.controllerFixture(),api=F.service();let vector=initial;const pages=[];
  api.providers.listScopedAlbums=async options=>{pages.push(options);const offset=options.cursor===undefined||options.cursor===null?0:Number(options.cursor);
    return {albums:vector.slice(offset,offset+100),next_cursor:offset+100<vector.length?String(offset+100):null};};
  api.control.acquireRemoteAlbum=async body=>({...api.acquisition(body),album:F.summary(body.release_group_id),artist_scope_preview:{artist_scope:F.clone(body.artist_scope),evidence_version:F.VERSION,main_artist_match:true}});
  const draft=create({controller:c.controller,providers:api.providers,artistScope:scope});t.after(()=>draft.dispose());await tick();
  return {...c,api,draft,pages,mutations:c.calls,setRows(value){vector=value;}};
}
const ids=h=>h.draft.getSnapshot().items.map(row=>row.album_ref||row.selection_key);
async function selectRemote(h){h.draft.setRemoteTitle('Remote');await h.draft.searchRemote();const candidate=h.draft.getSnapshot().remote.search.candidates[0];assert.ok(candidate);await h.draft.selectRemote(candidate);}

test('exact 5000 local identities commit complete and unchanged refresh does not double charge',async t=>{
  const h=await fixture(t,rows(5000));assert.equal(h.draft.getSnapshot().population.status,'ready');assert.equal(ids(h).length,5000);assert.equal(h.pages.length,50);
  const before=ids(h);assert.equal(await h.draft.refreshArtistPopulation(),true);assert.deepEqual(ids(h),before);assert.equal(h.pages.length,100);
  assert.equal(h.api.count('admitAlbum'),0);assert.equal(h.mutations.length,0);
});

test('initial 5001-row pagination fails without partial selection or Create',async t=>{
  const h=await fixture(t,rows(5001));assert.notEqual(h.draft.getSnapshot().population.status,'ready');assert.equal(ids(h).length,0);
  h.draft.edit({title:'Over bound'});await h.draft.submit();assert.equal(h.mutations.length,0);assert.equal(h.api.count('admitAlbum'),0);
});

test('retained historical order counts even when authoritative population becomes empty',async t=>{
  const h=await fixture(t,rows(5000));h.setRows([]);assert.equal(await h.draft.refreshArtistPopulation(),true);assert.deepEqual(ids(h),[]);
  h.setRows(rows(1,9000));assert.equal(await h.draft.refreshArtistPopulation(),false);assert.notEqual(h.draft.getSnapshot().population.status,'ready');assert.deepEqual(ids(h),[]);
  h.draft.edit({title:'No historical eviction'});await h.draft.submit();assert.equal(h.mutations.length,0);
});

test('overbound refresh cannot evict exclusions or order and a later valid vector restores both',async t=>{
  const original=rows(5000),h=await fixture(t,original),first=F.id(100),second=F.id(101);
  assert.equal(h.draft.remove(first),true);const reversed=ids(h).slice().reverse();assert.equal(h.draft.reorder(reversed),true);
  h.setRows(rows(1,9000));assert.equal(await h.draft.refreshArtistPopulation(),false);assert.notEqual(h.draft.getSnapshot().population.status,'ready');
  h.draft.edit({title:'Failed refresh'});await h.draft.submit();assert.equal(h.mutations.length,0);
  h.setRows(original);assert.equal(await h.draft.refreshArtistPopulation(),true);assert.deepEqual(ids(h),reversed);assert.equal(ids(h).includes(first),false);assert.equal(ids(h).at(-1),second);
  h.draft.resetArtistFilters();assert.deepEqual(ids(h),reversed);
});

test('the retained union may reach exactly 5000 across disjoint generations',async t=>{
  const h=await fixture(t,rows(2500));h.setRows(rows(2500,4000));assert.equal(await h.draft.refreshArtistPopulation(),true);assert.equal(ids(h).length,2500);
  h.setRows(rows(1,9000));assert.equal(await h.draft.refreshArtistPopulation(),false);
  h.setRows(rows(2500));assert.equal(await h.draft.refreshArtistPopulation(),true);assert.deepEqual(ids(h),rows(2500).map(row=>row.album_ref));
});

test('filter-hidden and explicitly excluded identities remain charged to the lifetime ceiling',async t=>{
  const h=await fixture(t,rows(5000));h.draft.remove(F.id(100));h.draft.setArtistFilters({releaseTypes:[]});assert.deepEqual(ids(h),[]);
  h.setRows(rows(1,9000));assert.equal(await h.draft.refreshArtistPopulation(),false);assert.notEqual(h.draft.getSnapshot().population.status,'ready');
  h.setRows(rows(5000));assert.equal(await h.draft.refreshArtistPopulation(),true);h.draft.resetArtistFilters();assert.equal(ids(h).length,4999);assert.equal(ids(h).includes(F.id(100)),false);
});

test('remote acquisition can fill the last universe slot without another local mapping',async t=>{
  const h=await fixture(t,rows(4999));await selectRemote(h);assert.equal(ids(h).length,5000);assert.equal(h.draft.getSnapshot().items.filter(row=>row.source_kind==='remote_summary').length,1);
  assert.equal(h.api.count('acquireRemoteAlbum'),1);assert.equal(h.api.count('admitAlbum'),0);assert.equal(h.mutations.length,0);
});

test('remote acquisition beyond lifetime bound cannot truncate or replace current local selection',async t=>{
  const h=await fixture(t,rows(5000)),before=ids(h);await selectRemote(h);assert.deepEqual(ids(h),before);
  assert.equal(h.draft.getSnapshot().items.filter(row=>row.source_kind==='remote_summary').length,0);assert.ok(h.draft.getSnapshot().error||h.draft.getSnapshot().remote.error);
  assert.equal(h.api.count('acquireRemoteAlbum'),1);assert.equal(h.mutations.length,0);
});

test('a retained remote identity and exclusion remain charged after authoritative local replacement',async t=>{
  const h=await fixture(t,rows(4999));await selectRemote(h);const remote=h.draft.getSnapshot().items.find(row=>row.source_kind==='remote_summary');assert.ok(remote);
  assert.equal(h.draft.remove(remote.selection_key),true);h.setRows(rows(1,9000));assert.equal(await h.draft.refreshArtistPopulation(),false);
  h.setRows(rows(4999));assert.equal(await h.draft.refreshArtistPopulation(),true);h.draft.resetArtistFilters();assert.equal(ids(h).length,4999);
  assert.equal(h.draft.getSnapshot().items.some(row=>row.source_kind==='remote_summary'),false);assert.equal(h.api.count('acquireRemoteAlbum'),1);
});
