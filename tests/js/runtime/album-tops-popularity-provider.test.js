// Whole additive provider wire contract; execute only under root's approved controls.
const test=require('node:test'), assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async()=>({createAlbumTopBackendProviders}=await F.load('album-tops/backend-providers.mjs')));
const CONTEXT='a'.repeat(64), SCOPE=JSON.stringify(['1','2',CONTEXT,4]);
const evidence=(count=0)=>({provider:'lastfm',metric:'overall_scrobbles',count,observed_at:'2001-01-01T00:00:00+00:00'});
function wire() {
  const source={revision:'7',item_ref:F.IA,catalog_ref:F.A,inventory_album_ref:'inventory-album:2:11',inventory_track_ref:'inventory-track:2:101',canonical_track_ref:'recording-101'};
  return {top_ref:F.TOP,revision:'7',albums:[{item_ref:F.IA,catalog_ref:F.A,inventory_album_ref:source.inventory_album_ref,album_ref:'Album',tracks:[{
    queue_item_ref:F.IA+':101',source,native_target:{track_ref:'/synthetic/101',path:'/synthetic/101',title:'Track',artist:null,album_title:'Album',duration_seconds:null,inventory_track_ref:source.inventory_track_ref},popularity:evidence()}]}],unavailable_items:[]};
}
function fixture(t,value) {
  let generation=4; const calls=[];
  const transport={context:()=>CONTEXT,generation:()=>generation,async request(path,options){calls.push({path,options});return {status:'ready',context_ref:CONTEXT,data:value};}};
  const provider=createAlbumTopBackendProviders({transport,acceptsScope:key=>key===SCOPE}); t.after(()=>provider.dispose());
  return {calls,provider,retire(){generation++;},capture:()=>provider.captureNativeQueue({top_ref:F.TOP,revision:'7'},{scopeKey:SCOPE,isCurrent:()=>true})};
}
for(const count of [0,1,9007199254740991]) test('capture keeps exact global scalar evidence including count '+count,async t=>{
  const input=wire(); input.albums[0].tracks[0].popularity=evidence(count); const f=fixture(t,input), result=await f.capture();
  assert.deepEqual(result,input); const projected=result.albums[0].tracks[0].popularity;
  assert.notEqual(projected,input.albums[0].tracks[0].popularity);
  input.albums[0].tracks[0].popularity.count=12; input.albums[0].tracks[0].popularity.observed_at='2099-01-01T00:00:00Z';
  assert.deepEqual(projected,evidence(count)); assert.deepEqual(f.calls[0].options.body,{revision:'7'});
  assert.equal(f.calls[0].path,'/album-tops/'+F.TOP+'/native-queue'); assert.equal(f.calls[0].options.method,'POST');
});
for(const legacy of [true,false]) test((legacy?'legacy omitted':'explicit unknown')+' popularity is preserved without fabricated zero',async t=>{
  const input=wire(), track=input.albums[0].tracks[0]; if(legacy)delete track.popularity; else track.popularity=null;
  const result=await fixture(t,input).capture(); assert.deepEqual(result,input);
  assert.equal(Object.hasOwn(result.albums[0].tracks[0],'popularity'),!legacy);
});
for(const [name,mutate] of [
  ['wrong provider',v=>v.provider='spotify'],['personal metric',v=>v.metric='user_scrobbles'],
  ['listeners metric',v=>v.metric='listeners'],['negative',v=>v.count=-1],['fraction',v=>v.count=1.5],
  ['boolean',v=>v.count=true],['numeric string',v=>v.count='7'],['unsafe',v=>v.count=9007199254740992],
  ['NaN',v=>v.count=NaN],['infinite',v=>v.count=Infinity],['missing count',v=>delete v.count],
  ['non UTC',v=>v.observed_at='2026-01-01T01:00:00+01:00'],['missing zone',v=>v.observed_at='2026-01-01T00:00:00'],
  ['bad date',v=>v.observed_at='invalidZ'],['missing date',v=>delete v.observed_at],
  ['invalid calendar date',v=>v.observed_at='2001-02-30T00:00:00Z'],
  ['invalid time',v=>v.observed_at='2001-01-01T24:00:00Z'],
  ['newline after UTC',v=>v.observed_at='2001-01-01T00:00:00Z\n'],
  ['raw identity',v=>v.source_entity_id='private-recording'],['account data',v=>v.account_id=1],['authority',v=>v.can_play=true],
]) test('whole capture rejects malformed popularity '+name,async t=>{
  const input=wire(); mutate(input.albums[0].tracks[0].popularity);
  await assert.rejects(fixture(t,input).capture(),error=>error.status===502);
});
for(const value of [undefined,[],1,'known']) test('explicit non-object popularity '+String(value)+' fails closed',async t=>{
  const input=wire(); input.albums[0].tracks[0].popularity=value;
  await assert.rejects(fixture(t,input).capture(),error=>error.status===502);
});
test('popularity does not relax exact source binding or authorize another library',async t=>{
  const input=wire(); input.albums[0].tracks[0].source.inventory_track_ref='inventory-track:3:101';
  await assert.rejects(fixture(t,input).capture(),error=>error.status===502);
});
test('a completed capture cannot keep a provider request current after transport generation retirement',async t=>{
  const f=fixture(t,wire()); await f.capture(); assert.equal(f.calls[0].options.isCurrent(),true);
  f.retire(); assert.equal(f.calls[0].options.isCurrent(),false);
});
for (const boundary of ['scope', 'generation', 'callback']) test('pending popular capture fails after '+boundary+' retirement',async t=>{
  let finish, generation=4, live=true, current=true;
  const transport={context:()=>CONTEXT,generation:()=>generation,
    request:()=>new Promise(resolve=>{finish=resolve;})};
  const provider=createAlbumTopBackendProviders({transport,acceptsScope:key=>live&&key===SCOPE});
  t.after(()=>provider.dispose());
  const work=provider.captureNativeQueue({top_ref:F.TOP,revision:'7'},{scopeKey:SCOPE,isCurrent:()=>current});
  assert.equal(typeof finish,'function');
  if(boundary==='scope')live=false;
  if(boundary==='generation')generation++;
  if(boundary==='callback')current=false;
  const rejected=assert.rejects(work,error=>error.name==='AbortError');
  finish({status:'ready',context_ref:CONTEXT,data:wire()}); await rejected;
});
test('popularity preserves distinct Top occurrences sharing one physical recording',async t=>{
  const input=wire(), second=structuredClone(input.albums[0]);
  second.item_ref=F.IB; second.catalog_ref=F.B;
  second.tracks[0].queue_item_ref=F.IB+':101';
  second.tracks[0].source.item_ref=F.IB; second.tracks[0].source.catalog_ref=F.B;
  input.albums.push(second);
  const result=await fixture(t,input).capture();
  assert.deepEqual(result,input);
  assert.deepEqual(result.albums.map(album=>album.tracks[0].queue_item_ref),[F.IA+':101',F.IB+':101']);
  assert.equal(result.albums[0].tracks[0].source.inventory_track_ref,result.albums[1].tracks[0].source.inventory_track_ref);
});
