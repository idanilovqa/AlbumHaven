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
for(const main of [true,false,null])test('strict detached acquired preview '+main,async t=>{
  const data=reply();data.artist_scope_preview.main_artist_match=main;const f=fixture(t,data),body=payload();
  const result=await f.providers.acquireRemoteAlbum(body,f.options);
  assert.deepEqual(result.artist_scope_preview,{artist_scope:scope(),evidence_version:VERSION,main_artist_match:main});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/album-top-catalog/remote-acquisitions');
  assert.deepEqual(f.calls[0].options.body,body);assert.equal(f.calls[0].options.expected,CONTEXT);
  assert.equal(f.calls[0].options.expectedGeneration,1);assert.equal(f.calls[0].options.signal,f.options.signal);
  data.artist_scope_preview.artist_scope.mode='artist';data.artist_scope_preview.main_artist_match=!main;body.artist_scope.root_artist_id='4';
  assert.deepEqual(result.artist_scope_preview,{artist_scope:scope(),evidence_version:VERSION,main_artist_match:main});
});
test('null optional preview preserves exact pending selector',async t=>{
  const data=reply();data.artist_scope_preview=null;const f=fixture(t,data);const result=await f.providers.acquireRemoteAlbum(payload(),f.options);
  assert.equal(result.artist_scope_preview,null);assert.equal(result.acquisition_ref,data.acquisition_ref);assert.equal(result.evidence_version,VERSION);assert.equal(result.expires_at,data.expires_at);assert.equal(f.calls.length,1);
});
const invalid=[undefined,false,[],{}, {...preview(),extra:true},{...preview(),main_artist_match:0},
  {...preview(),main_artist_match:'true'},{...preview(),evidence_version:'d'.repeat(64)},
  {...preview(),artist_scope:{root_artist_id:'4',mode:'family'}},{...preview(),artist_scope:{root_artist_id:'3',mode:'artist'}},
  {...preview(),artist_scope:{root_artist_id:'03',mode:'family'}},{...preview(),artist_scope:null}];
for(const [i,value] of invalid.entries())test('malformed or mismatched preview rejects whole response '+i,async t=>{
  const data=reply();if(value===undefined)delete data.artist_scope_preview;else data.artist_scope_preview=value;
  const f=fixture(t,data);await assert.rejects(()=>f.providers.acquireRemoteAlbum(payload(),f.options));assert.equal(f.calls.length,1);
});
for(const value of [null,undefined,{},false,{root_artist_id:'0',mode:'family'}])test('explicit invalid request scope never dispatches '+String(value),async t=>{
  const f=fixture(t,reply()),body=payload();body.artist_scope=value;
  await assert.rejects(()=>f.providers.acquireRemoteAlbum(body,f.options));assert.equal(f.calls.length,0);
});
test('saved destination rejects explicit scope',async t=>{
  const f=fixture(t,reply()),body=payload();body.destination={kind:'top',top_ref:F.TOP,revision:'1'};
  await assert.rejects(()=>f.providers.acquireRemoteAlbum(body,f.options));assert.equal(f.calls.length,0);
});
test('ordinary omitted scope retains exact legacy shape',async t=>{
  const data=reply(),body=payload();delete data.artist_scope_preview;delete body.artist_scope;
  const f=fixture(t,data),result=await f.providers.acquireRemoteAlbum(body,f.options);
  assert.equal(Object.hasOwn(result,'artist_scope_preview'),false);assert.deepEqual(f.calls[0].options.body,body);
});
for(const state of ['in_flight','failed'])test('nonpending scoped reply gains no preview '+state,async t=>{
  const data=reply();data.state=state;delete data.artist_scope_preview;delete data.album;delete data.acquisition_ref;delete data.evidence_version;delete data.expires_at;
  if(state==='in_flight')data.retry_after_seconds=1;else data.error='provider_unavailable';
  const f=fixture(t,data),result=await f.providers.acquireRemoteAlbum(payload(),f.options);
  assert.equal(result.state,state);assert.equal(Object.hasOwn(result,'artist_scope_preview'),false);
});
for(const kind of ['scope','context','generation','abort','dispose'])test('late acquired preview cannot survive '+kind,async t=>{
  let resolve;const held=new Promise(r=>resolve=r),f=fixture(t,null,()=>held);
  const pending=f.providers.acquireRemoteAlbum(payload(),f.options);assert.equal(f.calls.length,1);
  f.retire(kind);resolve(reply());await assert.rejects(()=>pending);
});
test('request descriptor mutation cannot rebind delayed acquired evidence',async t=>{
  let resolve;const held=new Promise(r=>resolve=r),f=fixture(t,null,()=>held),body=payload();
  const pending=f.providers.acquireRemoteAlbum(body,f.options);assert.equal(f.calls.length,1);
  body.artist_scope.root_artist_id='4';body.artist_scope.mode='artist';
  assert.deepEqual(f.calls[0].options.body.artist_scope,scope());resolve(reply());
  assert.deepEqual((await pending).artist_scope_preview.artist_scope,scope());
});
