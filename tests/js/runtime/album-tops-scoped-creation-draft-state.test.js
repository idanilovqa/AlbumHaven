const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create;
test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));});
const scope=mode=>({root_artist_id:'3',mode:mode||'artist'});
const meta=(release_type=null,rating=null,rating_state='available')=>({release_type,rating,rating_state,artwork_url:null});
const row=(n,patch={})=>F.album(n,{creation_metadata:meta(),...patch});
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const keys=draft=>draft.getSnapshot().items.map(item=>item.album_ref||item.selection_key);
function setup(t,{rows=[row(11),row(12),row(13)],population,initial=F.state(),artistScope=scope(),options={}}={}){
  const c=F.controllerFixture(initial),p=F.providerFixture(),calls=[];
  p.providers.listScopedAlbums=async request=>{calls.push(request);return population?population(request):{albums:rows,next_cursor:null};};
  const draft=create({controller:c.controller,providers:p.providers,artistScope,...options});
  t.after(()=>draft.dispose());return {...c,...p,draft,populationCalls:calls,mutations:c.calls,rows};
}

test('initial Artist population is selected only after complete pagination and never maps on open',async t=>{
  const gate=F.deferred(),h=setup(t,{population:request=>request.cursor?gate.promise:{albums:[row(11)],next_cursor:'second'}});
  await tick();assert.deepEqual(keys(h.draft),[]);assert.equal(h.populationCalls.length,2);
  assert.equal(h.draft.getSnapshot().tab,'selected');h.draft.edit({title:'Captured Artist'});await h.draft.submit();assert.deepEqual(h.mutations,[]);
  gate.resolve({albums:[row(12)],next_cursor:null});await tick();assert.deepEqual(keys(h.draft),[F.A,F.B]);
  assert.deepEqual(h.calls.admit,[]);assert.deepEqual(h.calls.search,[]);
  for(const options of h.populationCalls){assert.equal(options.q,'');assert.deepEqual(options.artistScope,scope());assert.equal(options.scopeKey,F.SCOPE);assert.ok(options.signal instanceof AbortSignal);}
});

test('unrestricted initial population keeps unknown metadata and detached rows',async t=>{
  const rows=[row(11,{year:null,creation_metadata:undefined}),row(12,{creation_metadata:meta('ep',10)}),row(13,{creation_metadata:meta(null,null,'unavailable')})];
  delete rows[0].creation_metadata;const h=setup(t,{rows});await tick();assert.deepEqual(keys(h.draft),[F.A,F.B,F.C]);
  assert.deepEqual(h.draft.getSnapshot().artistScope,scope());rows[1].creation_metadata.rating=1;rows[1].title='mutated';
  assert.equal(h.draft.getSnapshot().items[1].creation_metadata.rating,10);assert.notEqual(h.draft.getSnapshot().items[1].title,'mutated');
});

test('canonical aliases deduplicate while unmapped local identities remain distinct',async t=>{
  const h=setup(t,{rows:[row(11),row(12,{album_ref:F.A}),row(13,{album_ref:null}),row(14,{album_ref:null})]});await tick();
  assert.equal(h.draft.getSnapshot().items.length,3);const items=h.draft.getSnapshot().items;
  assert.equal(items[0].album_ref,F.A);assert.equal(items[1].album_ref,null);assert.equal(items[2].album_ref,null);
  assert.notEqual(items[1].selection_key,items[2].selection_key);assert.deepEqual(h.calls.admit,[]);
});

for(const [filter,expected] of [
  [{releaseTypes:['ep']},[F.A]],[{minYear:2000,maxYear:2002},[F.A]],
  [{minRating:5,maxRating:8},[F.A]],[{includeRated:false},[F.B]],
  [{releaseTypes:['ep'],minYear:2000,minRating:5},[F.A]],
  [{releaseTypes:[]},[]],[{releaseTypes:['studio']},[]]])test('known evidence AND filtering '+JSON.stringify(filter),async t=>{
  const h=setup(t,{rows:[row(11,{year:2001,creation_metadata:meta('ep',7)}),row(12,{year:1999,creation_metadata:meta('single',null)}),row(13,{year:null,creation_metadata:meta(null,null,'unavailable')})]});await tick();
  assert.equal(h.draft.setArtistFilters(filter),true);assert.deepEqual(keys(h.draft),expected);assert.equal(h.populationCalls.length,1);assert.deepEqual(h.calls.search,[]);assert.deepEqual(h.calls.admit,[]);
});

const malformed=[{other:true},{listening:true},{includeRated:undefined},{includeRated:1},
  {minYear:0},{maxYear:10000},{minYear:1.5},{minYear:NaN},{minYear:2002,maxYear:2001},
  {minRating:0},{maxRating:11},{minRating:Infinity},{minRating:8,maxRating:2},
  {releaseTypes:['Album']},{releaseTypes:['ep','ep']},{releaseTypes:[,'ep']},{releaseTypes:undefined}];
for(const [i,filter] of malformed.entries())test('invalid filter leaves exact applied selection '+i,async t=>{
  const h=setup(t);await tick();const before=h.draft.getSnapshot();assert.equal(h.draft.setArtistFilters(filter),false);
  assert.deepEqual(h.draft.getSnapshot(),before);assert.equal(h.populationCalls.length,1);
});

test('explicit exclusion survives filters Reset tabs refresh and Family toggles',async t=>{
  const h=setup(t,{population:request=>({albums:request.artistScope.mode==='artist'?[row(11),row(12)]:[row(11),row(12),row(13)],next_cursor:null})});await tick();
  h.draft.remove(F.A);h.draft.setArtistFilters({releaseTypes:[]});h.draft.resetArtistFilters();assert.deepEqual(keys(h.draft),[F.B]);
  h.draft.setTab('all');h.draft.setTab('selected');await h.draft.refreshArtistPopulation();assert.deepEqual(keys(h.draft),[F.B]);
  await h.draft.setArtistFamily(true);assert.deepEqual(keys(h.draft),[F.B,F.C]);await h.draft.setArtistFamily(false);assert.deepEqual(keys(h.draft),[F.B]);
  await h.draft.select(row(11));assert.deepEqual(new Set(keys(h.draft)),new Set([F.A,F.B]));
});

test('stable reorder replaces only selected slots and preserves hidden identities',async t=>{
  const h=setup(t,{rows:[row(11,{creation_metadata:meta('ep')}),row(12,{creation_metadata:meta('single')}),row(13,{creation_metadata:meta('ep')})]});await tick();
  h.draft.setArtistFilters({releaseTypes:['ep']});assert.deepEqual(keys(h.draft),[F.A,F.C]);assert.equal(h.draft.reorder([F.C,F.A]),true);
  h.draft.resetArtistFilters();assert.deepEqual(keys(h.draft),[F.C,F.B,F.A]);
});
for(const order of [[F.A,F.B],[F.A,F.B,F.B],[F.A,,F.C],['unknown',F.B,F.C]])test('bad selected permutation is atomic '+JSON.stringify(order),async t=>{
  const h=setup(t);await tick();const before=h.draft.getSnapshot();assert.equal(h.draft.reorder(order),false);assert.deepEqual(h.draft.getSnapshot(),before);
});

test('scoped local search is presentation only and never invokes unscoped inventory',async t=>{
  const h=setup(t,{rows:[row(11,{title:'Needle'}),row(12,{title:'Other'})]});await tick();h.draft.remove(F.A);await h.draft.setQuery('needle');
  assert.deepEqual(h.draft.getSnapshot().search.items.map(item=>item.album_ref),[F.A]);assert.deepEqual(keys(h.draft),[F.B]);assert.deepEqual(h.calls.search,[]);
  await h.draft.setQuery('');assert.deepEqual(keys(h.draft),[F.B]);assert.deepEqual(h.calls.search,[]);
});

test('Family-off retires old selection until complete Artist refresh',async t=>{
  let hold=false;const gate=F.deferred(),h=setup(t,{population:request=>hold&&request.artistScope.mode==='artist'?gate.promise:{albums:request.artistScope.mode==='family'?[row(11),row(12)]:[row(11)],next_cursor:null}});await tick();
  await h.draft.setArtistFamily(true);assert.deepEqual(keys(h.draft),[F.A,F.B]);hold=true;const pending=h.draft.setArtistFamily(false);await tick();
  assert.equal(keys(h.draft).includes(F.B),false);h.draft.edit({title:'Pending'});await h.draft.submit();assert.deepEqual(h.mutations,[]);
  gate.resolve({albums:[row(11)],next_cursor:null});await pending;assert.deepEqual(keys(h.draft),[F.A]);
});

test('pending population applies latest valid filter only when complete',async t=>{
  const gate=F.deferred(),h=setup(t,{population:()=>gate.promise});assert.equal(h.draft.setArtistFilters({releaseTypes:['ep']}),true);assert.deepEqual(keys(h.draft),[]);
  gate.resolve({albums:[row(11,{creation_metadata:meta('single')}),row(12,{creation_metadata:meta('ep')})],next_cursor:null});await tick();assert.deepEqual(keys(h.draft),[F.B]);
});

test('authoritative refresh removes absent rows but retained exclusions apply on later return',async t=>{
  let rows=[row(11),row(12)];const h=setup(t,{population:()=>({albums:rows,next_cursor:null})});await tick();h.draft.remove(F.B);
  rows=[row(13)];await h.draft.refreshArtistPopulation();assert.deepEqual(keys(h.draft),[F.C]);
  rows=[row(11),row(12),row(13)];await h.draft.refreshArtistPopulation();assert.deepEqual(keys(h.draft),[F.A,F.C]);
});

for(const cause of ['duplicate','sparse','bad-id','repeated-cursor','failure'])test('population '+cause+' cannot install a partial vector',async t=>{
  const h=setup(t,{population:request=>{if(cause==='failure'&&request.cursor)throw F.error(503);
    if(cause==='duplicate')return {albums:[row(11),row(11)],next_cursor:null};
    if(cause==='sparse')return {albums:[row(11),,row(12)],next_cursor:null};
    if(cause==='bad-id')return {albums:[row(11,{local_album_id:0})],next_cursor:null};
    return {albums:request.cursor?[]:[row(11)],next_cursor:'same'};}});await tick();
  assert.deepEqual(keys(h.draft),[]);assert.ok(h.draft.getSnapshot().error);h.draft.edit({title:'No partial Top'});await h.draft.submit();assert.deepEqual(h.mutations,[]);
});

for(const change of ['scope','provider','dispose'])test('late population cannot restore retired '+change,async t=>{
  const gate=F.deferred(),h=setup(t,{population:()=>gate.promise});await tick();
  if(change==='scope')h.replace({...h.controller.getSnapshot(),scopeKey:'other'});
  else if(change==='provider')h.providers.listScopedAlbums=async()=>({albums:[],next_cursor:null});else h.draft.dispose();
  gate.resolve({albums:[row(11)],next_cursor:null});await tick();assert.deepEqual(keys(h.draft),[]);assert.deepEqual(h.mutations,[]);
});

for(const descriptor of [null,undefined,{},false,{root_artist_id:'0',mode:'artist'},{root_artist_id:'3',mode:'family'}])test('invalid explicit initial scope refuses before subscriptions '+JSON.stringify(descriptor),t=>{
  const c=F.controllerFixture(),p=F.providerFixture();let called=0;p.providers.listScopedAlbums=()=>{called++;};
  assert.throws(()=>create({controller:c.controller,providers:p.providers,artistScope:descriptor}));assert.equal(c.listeners.size,0);assert.equal(called,0);
});
for(const mode of ['add','source-match'])test('scoped '+mode+' combination rejects before subscription',t=>{
  const c=F.controllerFixture(),p=F.providerFixture();assert.throws(()=>create({controller:c.controller,providers:p.providers,artistScope:scope(),mode,sourceJobRef:F.TOP}));assert.equal(c.listeners.size,0);
});

test('complete empty population admits ordinary explicit empty Create',async t=>{
  const h=setup(t,{rows:[]});assert.equal(h.draft.getSnapshot().population.status,'loading');await tick();
  assert.equal(h.draft.getSnapshot().population.status,'ready');h.draft.edit({title:'Empty scoped',description:'Allowed'});await h.draft.submit();
  assert.deepEqual(h.mutations,[{action:'create',payload:{title:'Empty scoped',description:'Allowed',album_refs:[],artist_scope:scope()}}]);
});

test('same-mode Family requests never duplicate the in-flight or ready generation',async t=>{
  const gate=F.deferred(),h=setup(t,{population:()=>gate.promise});const generation=h.draft.getSnapshot().population.generation;
  const duplicate=h.draft.setArtistFamily(false);await tick();assert.equal(h.populationCalls.length,1);
  gate.resolve({albums:[row(11)],next_cursor:null});await tick();await duplicate;
  assert.equal(await h.draft.setArtistFamily(false),true);assert.equal(h.populationCalls.length,1);assert.equal(h.draft.getSnapshot().population.generation,generation);
});

test('superseded population aborts and cannot replace a newer complete generation',async t=>{
  const old=F.deferred();let count=0;const h=setup(t,{population:()=>++count===1?old.promise:{albums:[row(12)],next_cursor:null}});
  await tick();assert.equal(await h.draft.refreshArtistPopulation(),true);assert.equal(h.populationCalls[0].signal.aborted,true);
  old.resolve({albums:[row(11)],next_cursor:null});await tick();assert.deepEqual(keys(h.draft),[F.B]);
});

test('root descriptor is captured before reentrant controller subscription',async t=>{
  const c=F.controllerFixture(),p=F.providerFixture(),descriptor=scope(),calls=[];const subscribe=c.controller.subscribe;
  c.controller.subscribe=fn=>{descriptor.root_artist_id='99';descriptor.mode='family';return subscribe(fn);};
  p.providers.listScopedAlbums=async options=>{calls.push(options);return {albums:[row(11)],next_cursor:null};};
  const draft=create({controller:c.controller,providers:p.providers,artistScope:descriptor});t.after(()=>draft.dispose());await tick();
  assert.deepEqual(draft.getSnapshot().artistScope,scope());assert.deepEqual(calls[0].artistScope,scope());
});

test('ordinary unsaved draft remains empty and rejects scoped methods without state changes',async t=>{
  const c=F.controllerFixture(),p=F.providerFixture(),draft=create({controller:c.controller,providers:p.providers});t.after(()=>draft.dispose());const before=draft.getSnapshot();
  assert.equal(await draft.setArtistFamily(true),false);assert.equal(await draft.refreshArtistPopulation(),false);
  assert.equal(draft.setArtistFilters({includeRated:false}),false);assert.equal(draft.resetArtistFilters(),false);
  assert.deepEqual(draft.getSnapshot(),before);assert.deepEqual(keys(draft),[]);assert.deepEqual(p.calls.search,[]);
});

test('existing selected Top cannot enter scoped create',()=>{
  const c=F.controllerFixture(F.state({editing:true})),p=F.providerFixture();
  assert.throws(()=>create({controller:c.controller,providers:p.providers,artistScope:scope()}));assert.equal(c.listeners.size,0);
});
