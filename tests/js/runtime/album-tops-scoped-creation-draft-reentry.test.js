'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const F=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let create;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));});
const scope={root_artist_id:'3',mode:'artist'},tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};

test('population abort listener admits the newest Family generation ahead of the interrupted refresh',async t=>{
  const c=F.controllerFixture(),api=F.service(),old=F.deferred(),requests=[];let draft,newest;
  api.providers.listScopedAlbums=options=>{requests.push(options);if(requests.length===1){options.signal.addEventListener('abort',()=>{newest=draft.setArtistFamily(true);},{once:true});return old.promise;}
    return Promise.resolve({albums:[F.album(options.artistScope.mode==='family'?12:11)],next_cursor:null});};
  draft=create({controller:c.controller,providers:api.providers,artistScope:scope});t.after(()=>draft.dispose());await tick();assert.equal(requests.length,1);
  const interrupted=draft.refreshArtistPopulation();assert.ok(newest);assert.equal(await newest,true);assert.equal(await interrupted,false);
  assert.equal(draft.getSnapshot().artistScope.mode,'family');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.B]);
  old.resolve({albums:[F.album(13)],next_cursor:null});await tick();assert.equal(draft.getSnapshot().artistScope.mode,'family');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.B]);
  assert.deepEqual(c.calls,[]);
});

test('remote abort listener can replace a Family-on intent with a newer Artist-only intent',async t=>{
  const c=F.controllerFixture(),api=F.service(),gate=F.deferred();let draft,newest,captured;
  api.providers.listScopedAlbums=async options=>({albums:[F.album(options.artistScope.mode==='family'?12:11)],next_cursor:null});
  api.control.acquireRemoteAlbum=(body,options)=>{captured=F.clone(body);options.signal.addEventListener('abort',()=>{newest=draft.setArtistFamily(false);},{once:true});return gate.promise;};
  draft=create({controller:c.controller,providers:api.providers,artistScope:scope});t.after(()=>draft.dispose());await tick();
  draft.setRemoteTitle('Remote');await draft.searchRemote();const acquisition=draft.selectRemote(draft.getSnapshot().remote.search.candidates[0]);await tick();assert.ok(captured);
  const interrupted=draft.setArtistFamily(true);assert.ok(newest);assert.equal(await newest,true);assert.equal(await interrupted,false);
  assert.equal(draft.getSnapshot().artistScope.mode,'artist');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A]);
  gate.resolve({...api.acquisition(captured),artist_scope_preview:{artist_scope:scope,evidence_version:F.VERSION,main_artist_match:true}});await acquisition;await tick();
  assert.equal(draft.getSnapshot().artistScope.mode,'artist');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A]);assert.deepEqual(c.calls,[]);
});

for(const emptyPages of [1,49])test('legitimate empty continuation pages can complete inside the 50-page budget: '+emptyPages,async t=>{
  const c=F.controllerFixture(),api=F.service();let pages=0;
  api.providers.listScopedAlbums=async()=>{pages++;return pages<=emptyPages?{albums:[],next_cursor:'cursor-'+pages}:{albums:[F.album(11)],next_cursor:null};};
  const draft=create({controller:c.controller,providers:api.providers,artistScope:scope});t.after(()=>draft.dispose());
  for(let i=0;i<800;i++)await Promise.resolve();assert.equal(pages,emptyPages+1);assert.equal(draft.getSnapshot().population.status,'ready');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A]);assert.deepEqual(c.calls,[]);
});

test('50 distinct empty continuation pages fail atomically without a 51st request or Create',async t=>{
  const c=F.controllerFixture(),api=F.service();let pages=0;
  api.providers.listScopedAlbums=async()=>{pages++;if(pages>50)throw new Error('Forbidden 51st page request');return {albums:[],next_cursor:'unique-'+pages};};
  const draft=create({controller:c.controller,providers:api.providers,artistScope:scope});t.after(()=>draft.dispose());
  for(let i=0;i<800;i++)await Promise.resolve();assert.equal(pages,50);assert.notEqual(draft.getSnapshot().population.status,'ready');assert.deepEqual(draft.getSnapshot().items,[]);
  assert.ok(draft.getSnapshot().error);draft.edit({title:'Incomplete'});assert.equal(await draft.submit(),false);assert.deepEqual(c.calls,[]);assert.equal(api.count('admitAlbum'),0);
});
