'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const F=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let create;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));});
const tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};

test('Family supersession drains every captured old handle while preserving the newly admitted population',async t=>{
  const c=F.controllerFixture(),api=F.service(),oldPopulation=F.deferred(),oldAcquisition=F.deferred(),newPopulation=F.deferred();
  const populationSignals=[];let draft,newest,acquisitionSignal,acquisitionBody;
  api.providers.listScopedAlbums=options=>{populationSignals.push(options.signal);
    if(populationSignals.length===1){options.signal.addEventListener('abort',()=>{newest=draft.setArtistFamily(false);},{once:true});return oldPopulation.promise;}
    return newPopulation.promise;};
  api.control.acquireRemoteAlbum=(body,options)=>{acquisitionBody=F.clone(body);acquisitionSignal=options.signal;return oldAcquisition.promise;};
  draft=create({controller:c.controller,providers:api.providers,artistScope:{root_artist_id:'3',mode:'artist'}});t.after(()=>draft.dispose());await tick();
  assert.equal(draft.getSnapshot().population.status,'loading');assert.equal(populationSignals.length,1);
  draft.setRemoteTitle('Remote');await draft.searchRemote();const acquisition=draft.selectRemote(draft.getSnapshot().remote.search.candidates[0]);await tick();
  assert.ok(acquisitionSignal);assert.equal(acquisitionSignal.aborted,false);assert.equal(populationSignals[0].aborted,false);
  const superseded=draft.setArtistFamily(true);await tick();assert.ok(newest);assert.equal(await superseded,false);
  assert.equal(populationSignals[0].aborted,true);assert.equal(acquisitionSignal.aborted,true,'supersession must not skip the second captured old owner');
  assert.equal(populationSignals.length,2);assert.equal(populationSignals[1].aborted,false);assert.equal(draft.getSnapshot().artistScope.mode,'artist');
  oldPopulation.resolve({albums:[F.album(13)],next_cursor:null});oldAcquisition.resolve({...api.acquisition(acquisitionBody),artist_scope_preview:{artist_scope:{root_artist_id:'3',mode:'artist'},evidence_version:F.VERSION,main_artist_match:true}});
  await acquisition;await tick();assert.equal(draft.getSnapshot().population.status,'loading');assert.deepEqual(draft.getSnapshot().items,[]);assert.equal(populationSignals[1].aborted,false);
  newPopulation.resolve({albums:[F.album(11)],next_cursor:null});assert.equal(await newest,true);assert.equal(populationSignals[1].aborted,false);
  assert.equal(draft.getSnapshot().artistScope.mode,'artist');assert.deepEqual(draft.getSnapshot().items.map(row=>row.album_ref),[F.A]);assert.deepEqual(c.calls,[]);
});
