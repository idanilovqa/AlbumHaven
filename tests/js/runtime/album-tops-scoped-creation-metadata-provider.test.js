// Contract-first whole provider; only existing transport response is supplied.
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create;
test.before(async()=>{({createAlbumTopBackendProviders:create}=await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT='a'.repeat(64),SCOPE=JSON.stringify(['1','2',CONTEXT,1]);
const artistScope={root_artist_id:'3',mode:'artist'};
const metadata=patch=>({release_type:null,rating_state:'available',rating:null,
  artwork_url:'/library/album-artwork/inventory-album:2:11',...patch});
function fixture(t,rows,{scope=SCOPE,reply=null}={}){
  let context=CONTEXT,allowed=true;const calls=[],abort=new AbortController();
  const providers=create({acceptsScope:key=>allowed&&key===scope,transport:{context:()=>context,
    async request(path,options){calls.push({path,options});return {status:'ready',context_ref:CONTEXT,
      data:reply?await reply():{albums:rows,next_cursor:null}};}}});
  const options={scopeKey:scope,artistScope,signal:abort.signal};
  t.after(()=>{providers.dispose();assert.equal(calls.length,1);});
  return {providers,options,calls,abort,retire:kind=>{if(kind==='scope')allowed=false;
    else if(kind==='context')context='b'.repeat(64);else if(kind==='abort')abort.abort();else providers.dispose();}};
}
for(const type of [null,'studio','ep','live','demo','compilation','single'])for(const rating of [null,1,10])
 test('exact frozen metadata '+type+'/'+rating,async t=>{
  const value=metadata({release_type:type,rating}),row=F.album(11,{creation_metadata:value}),h=fixture(t,[row]);
  const result=(await h.providers.listScopedAlbums(h.options)).albums[0];
  assert.deepEqual(result.creation_metadata,value);assert.ok(Object.isFrozen(result.creation_metadata));
  assert.notStrictEqual(result.creation_metadata,value);value.rating=7;value.release_type='wrong';
  assert.equal(result.creation_metadata.rating,rating);assert.equal(result.creation_metadata.release_type,type);
  assert.equal(result.local_album_id,11);
 });
for(const scope of [SCOPE,F.SCOPE])test('absent metadata retains legacy projection '+scope,async t=>{
  const row=F.album(11),h=fixture(t,[row],{scope});
  const result=(await h.providers.listScopedAlbums(h.options)).albums[0];
  assert.deepEqual(result,row);assert.equal(Object.hasOwn(result,'creation_metadata'),false);
});
for(const rating_state of ['available','unavailable'])test('null rating preserves '+rating_state+' distinction',async t=>{
  const value=metadata({rating_state,rating:null,artwork_url:null}),h=fixture(t,[F.album(11,{creation_metadata:value})]);
  assert.deepEqual((await h.providers.listScopedAlbums(h.options)).albums[0].creation_metadata,value);
});
const bad=[null,undefined,[],false,{},...Object.keys(metadata()).map(key=>{const value=metadata();delete value[key];return value;}),
 {...metadata(),extra:true},...['Album','Other','Studio','',false,3].map(release_type=>metadata({release_type})),
 ...['unknown','Available',null,1].map(rating_state=>metadata({rating_state})),
 ...[0,11,-1,1.5,'5',true,NaN,Infinity].map(rating=>metadata({rating})),metadata({rating_state:'unavailable',rating:1}),
 ...['','https://example.test/cover.jpg','/library/album-artwork/inventory-album:3:11',
 '/library/album-artwork/inventory-album:2:12','/library/album-artwork/inventory-album:02:11',
 '/library/album-artwork/inventory-album:2:11?x=1','/library/album-artwork/inventory-album:2:11\n',
 '/library/album-artwork/inventory-track:2:11','C:/private/cover.jpg',false,2].map(artwork_url=>metadata({artwork_url}))];
for(const [index,value]of bad.entries())test('malformed present metadata rejects entire page '+index,async t=>{
  const h=fixture(t,[F.album(12),F.album(11,{creation_metadata:value})]);
  await assert.rejects(h.providers.listScopedAlbums(h.options));
});
for(const artwork_url of [null,'/library/album-artwork/inventory-album:2:11'])test('present caller-bound metadata rejects opaque scope '+artwork_url,async t=>{
  const h=fixture(t,[F.album(11,{creation_metadata:metadata({artwork_url})})],{scope:F.SCOPE});
  await assert.rejects(h.providers.listScopedAlbums(h.options));
});
for(const kind of ['scope','context','abort','dispose'])test('pending metadata rejects retired '+kind,async t=>{
  let resolve;const gate=new Promise(r=>resolve=r),h=fixture(t,[],{reply:()=>gate});
  const work=h.providers.listScopedAlbums(h.options);h.retire(kind);
  resolve({albums:[F.album(11,{creation_metadata:metadata()})],next_cursor:null});await assert.rejects(work);
});
test('ordinary search continues its existing row projection',async t=>{
  const row=F.album(11),h=fixture(t,[{...row,creation_metadata:metadata()}]);
  const result=await h.providers.searchAlbums({...h.options,q:'Album'});
  assert.deepEqual(result.albums,[row]);
});
