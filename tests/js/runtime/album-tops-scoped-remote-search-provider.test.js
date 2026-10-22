// Independent contract-first whole-provider tests. Transport is the network boundary.
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create;
test.before(async () => {({createAlbumTopBackendProviders: create} = await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT = 'a'.repeat(64), scope = (mode='artist') => ({root_artist_id:'9223372036854775807', mode});
const target = () => ({kind:'create', draft_ref:F.id(91)});
const saved = () => ({kind:'top', top_ref:F.TOP, revision:'1'});
const command = patch => ({destination:target(), title:'Album', artist:'Artist', ...patch});
const summary = id => ({source_kind:'remote_summary', provider:'musicbrainz', entity_kind:'release-group',
  release_group_id:F.id(id), title:'Album', artist_display:'Artist', first_release_date:'2000', primary_type:'Album',
  metadata_coverage:'album_summary_only', track_metadata_status:'unavailable', track_count:null});
function fixture(t, {reply, count=1}={}) {
  let context=CONTEXT, generation=1, current=true;
  const calls=[], controller=new AbortController();
  const providers=create({acceptsScope:key=>key===F.SCOPE, transport:{context:()=>context, generation:()=>generation,
    requestAlbumTopRemote:async (path, options)=>{calls.push({path,options});
      const data=reply ? await reply(options) : {context_ref:CONTEXT,destination:options.body.destination,limit:10,candidates:[summary(93)]};
      return {status:'ready',context_ref:CONTEXT,data};}}});
  const options={scopeKey:F.SCOPE,remoteContext:providers.remoteContext(),signal:controller.signal,isCurrent:()=>current};
  t.after(()=>{providers.dispose();assert.equal(calls.length,count);});
  return {providers,options,calls,controller,retire:kind=>{if(kind==='context')context='b'.repeat(64);
    else if(kind==='generation')generation++;else if(kind==='form')current=false;else if(kind==='abort')controller.abort();else providers.dispose();}};
}
for(const mode of ['artist','family']) test('unsaved '+mode+' scope is exact and detached before transport',async t=>{
  const h=fixture(t), payload=command({artist_scope:scope(mode)}), before=structuredClone(payload);
  const result=await h.providers.searchRemoteAlbums(payload,h.options);
  assert.equal(h.calls[0].path,'/album-top-catalog/remote-search');
  assert.equal(h.calls[0].options.method,'POST');assert.deepEqual(h.calls[0].options.body,before);
  assert.notStrictEqual(h.calls[0].options.body.artist_scope,payload.artist_scope);
  payload.artist_scope.mode='invalid';assert.deepEqual(h.calls[0].options.body,before);
  assert.deepEqual(result.candidates,[summary(93)]);assert.equal(Object.hasOwn(result,'artist_scope'),false);
});
for(const destination of [target(),saved()]) test('ordinary destination stays unchanged '+destination.kind,async t=>{
  const h=fixture(t),payload=command({destination});await h.providers.searchRemoteAlbums(payload,h.options);
  assert.deepEqual(h.calls[0].options.body,payload);assert.equal(Object.hasOwn(h.calls[0].options.body,'artist_scope'),false);
});
const malformed=[null,undefined,false,[],{}, {root_artist_id:'1'}, {mode:'artist'}, {...scope(),extra:true},
  ...['0','01','1\n','9223372036854775808',1].map(root_artist_id=>({...scope(),root_artist_id})),
  {...scope(),mode:'Artist'}, {...scope(),mode:'all'}];
for(const [index,artist_scope] of malformed.entries())test('malformed present scope rejects before transport '+index,async t=>{
  const h=fixture(t,{count:0});await assert.rejects(h.providers.searchRemoteAlbums(command({artist_scope}),h.options));
});
for(const artist_scope of [scope(),null,undefined])test('saved destination rejects supplied scope '+String(artist_scope),async t=>{
  const h=fixture(t,{count:0});await assert.rejects(h.providers.searchRemoteAlbums(command({destination:saved(),artist_scope}),h.options));
});
for(const kind of ['context','generation','form','abort','dispose'])test('late scoped result cannot survive '+kind,async t=>{
  let resolve;const gate=new Promise(r=>resolve=r),h=fixture(t,{reply:()=>gate});
  const work=h.providers.searchRemoteAlbums(command({artist_scope:scope()}),h.options);
  h.retire(kind);resolve({context_ref:CONTEXT,destination:target(),limit:10,candidates:[summary(93)]});
  await assert.rejects(work);
});
for(const mutation of ['destination','context','duplicates','limit'])test('scoped reply retains strict '+mutation+' guard',async t=>{
  const h=fixture(t,{reply:()=>{const data={context_ref:CONTEXT,destination:target(),limit:10,candidates:[summary(93)]};
    if(mutation==='destination')data.destination.draft_ref=F.id(99);if(mutation==='context')data.context_ref='b'.repeat(64);
    if(mutation==='duplicates')data.candidates.push(summary(93));if(mutation==='limit')data.limit=11;return data;}});
  await assert.rejects(h.providers.searchRemoteAlbums(command({artist_scope:scope()}),h.options));
});
test('empty scoped result stays a truthful empty scalar page',async t=>{
  const data={context_ref:CONTEXT,destination:target(),limit:10,candidates:[]},h=fixture(t,{reply:()=>data});
  assert.deepEqual(await h.providers.searchRemoteAlbums(command({artist_scope:scope()}),h.options),data);
});
