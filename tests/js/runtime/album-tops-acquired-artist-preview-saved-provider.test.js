const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create;
test.before(async()=>{({createAlbumTopBackendProviders:create}=await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT='a'.repeat(64),VERSION='c'.repeat(64);
const scope=()=>({root_artist_id:'3',mode:'family'});
const payload=()=>({version:2,preparation_ref:F.id(102),request_key:F.id(103),destination:{kind:'create',draft_ref:F.id(101)},release_group_id:F.id(104),artist_scope:scope()});
const preview=()=>({artist_scope:scope(),evidence_version:VERSION,main_artist_match:true});
const reply=()=>({version:2,context_ref:CONTEXT,preparation_ref:F.id(102),request_key:F.id(103),destination:{kind:'create',draft_ref:F.id(101)},state:'pending',acquisition_ref:F.id(105),evidence_version:VERSION,expires_at:'2099-01-01T00:35:00Z',artist_scope_preview:preview(),album:{source_kind:'remote_summary',provider:'musicbrainz',entity_kind:'release-group',release_group_id:F.id(104),title:'Exact acquired album',artist_display:'Acquired artist',first_release_date:null,primary_type:'Album',metadata_coverage:'album_summary_only',track_metadata_status:'unavailable',track_count:null}});
function fixture(t,data,respond){
  let context=CONTEXT,generation=1,allowed=true;const calls=[],abort=new AbortController();
  const providers=create({acceptsScope:key=>allowed&&key===F.SCOPE,transport:{context:()=>context,generation:()=>generation,
    async requestAlbumTopRemote(path,options){calls.push({path,options});return {status:'ready',context_ref:CONTEXT,data:respond?await respond():data};}}});
  const options={scopeKey:F.SCOPE,signal:abort.signal,remoteContext:providers.remoteContext()};
  t.after(()=>providers.dispose());
  return {providers,options,calls,retire(kind){if(kind==='context')context='b'.repeat(64);else if(kind==='generation')generation++;else if(kind==='scope')allowed=false;else if(kind==='abort')abort.abort();else providers.dispose();}};
}

for(const positive of [true,false])test('saved Top derived preview without client override '+positive,async t=>{
  const body=payload(),data=reply();delete body.artist_scope;
  body.destination={kind:'top',top_ref:F.TOP,revision:'7'};data.destination={...body.destination};
  data.artist_scope_preview=positive?preview():null;
  const f=fixture(t,data),result=await f.providers.acquireRemoteAlbum(body,f.options);
  assert.deepEqual(result.artist_scope_preview,positive?preview():null);
  assert.deepEqual(result.destination,body.destination);assert.equal(result.evidence_version,VERSION);
  assert.equal(result.acquisition_ref,data.acquisition_ref);assert.equal(result.expires_at,data.expires_at);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].options.body,body);
  assert.equal(Object.hasOwn(f.calls[0].options.body,'artist_scope'),false);
});
for(const mismatch of ['revision','evidence'])test('saved preview binds exact '+mismatch,async t=>{
  const body=payload(),data=reply();delete body.artist_scope;
  body.destination={kind:'top',top_ref:F.TOP,revision:'7'};data.destination={...body.destination};
  if(mismatch==='revision')data.destination.revision='8';else data.artist_scope_preview.evidence_version='d'.repeat(64);
  const f=fixture(t,data);await assert.rejects(()=>f.providers.acquireRemoteAlbum(body,f.options));assert.equal(f.calls.length,1);
});
