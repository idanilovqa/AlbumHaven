'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {filterFixture}=require('./playlist-filter-native-fixture.cjs');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const payload=ref=>({playlist_sidebar:{items:[1,2].map(n=>({playlist_id:id(n),title:`Playlist ${n}`,allowed_actions:{can_open:true}}))},
  playlist_detail:{playlist_id:ref,title:'Playlist',revision:'1',description:'',track_rows:[],items_complete:true,
    active_sort:{key:'playlist_position',direction:'asc'},allowed_actions:{can_open:true,can_edit:true,can_rename:true}}});

test('actual controller restores saved state, applies filters, serializes Reset and returns server defaults',async()=>{
  const model=await import('../../../music_app/static/js/playlists/model.mjs');
  const {createFilterPreferenceProviders,DEFAULT_SAVED_FILTERS}=await import('../../../music_app/static/js/playlists/filter-preferences.mjs');
  const calls=[];let revision=1,filters={...DEFAULT_SAVED_FILTERS,query:'saved'},counter=10;
  const providers=createFilterPreferenceProviders({request:async(path,options,method,body)=>{
    calls.push({path,options,method,body});
    if(method==='PUT'){revision++;filters=body.filters;return {ok:true,action:'playlist_filter_preferences',
      playlist_ref:options.playlist_id,request_key:body.request_key,revision:String(revision),changed:true};}
    return {playlist_ref:options.playlist_id,revision:String(revision),filters,
      server_time:'2026-10-19T00:00:00Z',expires_at:filters?'2026-10-26T00:00:00Z':null};
  }});
  const original=globalThis.crypto;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>id(++counter)}});
  const controller=model.createPlaylistController({providers});
  try{
    controller.setScope('account/library');controller.accept(payload(id(1)),id(1));await settle();
    assert.equal(model.playlistFilters(controller.getSnapshot()).query,'saved');
    controller.filter({query:'edited'});await settle();
    assert.equal(filters.query,'edited');assert.equal(controller.getSnapshot().filterSync,'saved');
    controller.filter(model.defaultFilters);await settle();
    assert.equal(filters,null);assert.equal(model.playlistFilters(controller.getSnapshot()).query,'');
    assert.equal(calls.filter(c=>c.method==='PUT').length,2);
  }finally{controller.dispose();Object.defineProperty(globalThis,'crypto',{configurable:true,value:original});}
});

test('late restore and subscriber-driven resource switch cannot apply filters to another Playlist',async()=>{
  const model=await import('../../../music_app/static/js/playlists/model.mjs');
  const {DEFAULT_SAVED_FILTERS}=await import('../../../music_app/static/js/playlists/filter-preferences.mjs');
  const gate=deferred(),writes=[];
  const providers={readFilterPreferences:async options=>options.playlist_id===id(1)?gate.promise:
    {playlist_ref:id(2),revision:'1',filters:null,remainingMs:null},saveFilterPreferences:async value=>{writes.push(value);return {revision:'2'};}};
  const controller=model.createPlaylistController({providers});
  try{
    controller.setScope('scope');controller.accept(payload(id(1)),id(1));
    controller.accept(payload(id(2)),id(2));
    gate.resolve({playlist_ref:id(1),revision:'1',filters:{...DEFAULT_SAVED_FILTERS,query:'private A'},remainingMs:null});await settle();
    assert.equal(model.playlistFilters(controller.getSnapshot()).query,'');
    let switched=false;const unsubscribe=controller.subscribe(()=>{if(!switched&&model.playlistFilters(controller.getSnapshot()).query==='new'){
      switched=true;controller.accept(payload(id(1)),id(1));}});
    controller.filter({query:'new'});await settle();unsubscribe();
    assert.equal(writes.length,0);
  }finally{controller.dispose();}
});

test('actual native view exposes unsaved preference status and guarded retry through shared Button',async()=>{
  const model=await import('../../../music_app/static/js/playlists/model.mjs');
  const {mountPlaylistsView}=await import('../../../music_app/static/js/playlists/native-app.mjs');
  const env=filterFixture(),host=env.document.createElement('div');env.document.body.append(host);
  let attempts=0;
  const controller=model.createPlaylistController({providers:{readFilterPreferences:async options=>{
    attempts++;if(attempts===1)throw Error('offline');return {playlist_ref:options.playlist_id,revision:'1',filters:null,remainingMs:null};},
    saveFilterPreferences:async()=>{throw Error('unexpected write');}}});
  controller.setScope('scope');controller.accept(payload(id(1)),id(1));
  const props=()=>({controller,state:controller.getSnapshot(),integrationProviders:{},onSelect(){}});
  const view=mountPlaylistsView(host,env.runtime,props()),unsubscribe=controller.subscribe(()=>view.update(props()));
  try{
    await settle();assert.equal(controller.getSnapshot().filterSync,'unsaved');
    const button=host.querySelectorAll('button').find(node=>node.textContent.trim()==='Retry saving filters');
    assert.ok(button);assert.equal(button.disabled,false);
    button.dispatchEvent(new env.context.Event('click',{bubbles:true}));await settle();
    assert.equal(attempts,2);assert.equal(controller.getSnapshot().filterSync,'saved');
    controller.suspend();button.dispatchEvent(new env.context.Event('click',{bubbles:true}));await settle();
    assert.equal(attempts,2);
  }finally{unsubscribe();view.dispose();controller.dispose();host.remove();}
});

async function controllerHarness(overrides={}) {
  const model=await import('../../../music_app/static/js/playlists/model.mjs');
  const {DEFAULT_SAVED_FILTERS}=await import('../../../music_app/static/js/playlists/filter-preferences.mjs');
  let filters=null,revision=1,counter=100;const writes=[],reads=[];
  const oldCrypto=globalThis.crypto;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>id(++counter)}});
  const providers={readFilterPreferences:async options=>{reads.push(options);if(overrides.read)return overrides.read(options);
    return {playlist_ref:options.playlist_id,revision:String(revision),filters,remainingMs:null};},
    saveFilterPreferences:async options=>{writes.push(options);if(overrides.write)await overrides.write(options);
      revision++;filters=options.filters;return {revision:String(revision),changed:true};},
    ...(overrides.readPlaylists?{readPlaylists:overrides.readPlaylists}:{})};
  const controller=model.createPlaylistController({providers});controller.setScope('scope');
  return {model,controller,DEFAULT_SAVED_FILTERS,writes,reads,
    close(){controller.dispose();Object.defineProperty(globalThis,'crypto',{configurable:true,value:oldCrypto});}};
}

test('nested actual controller filter publication persists only the newer edit',async()=>{
  const h=await controllerHarness();
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();let nested=false;
    const unsubscribe=h.controller.subscribe(()=>{if(!nested&&h.model.playlistFilters(h.controller.getSnapshot()).query==='older'){
      nested=true;h.controller.filter({query:'newer'});}});
    h.controller.filter({query:'older'});await settle();unsubscribe();
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].filters.query,'newer');
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'newer');
  }finally{h.close();}
});

test('ready-publication subscriber edit is staged before the initial server restoration',async()=>{
  const h=await controllerHarness();
  try{
    let changed=false;const unsubscribe=h.controller.subscribe(()=>{if(!changed&&h.controller.getSnapshot().resource.status==='ready'){
      changed=true;h.controller.filter({query:'ready edit'});}});
    h.controller.accept(payload(id(1)),id(1));await settle();unsubscribe();
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].filters.query,'ready edit');
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'ready edit');
  }finally{h.close();}
});

test('invalid newer controller text is not replaced by an older delayed write or reload',async()=>{
  const gate=deferred();const h=await controllerHarness({write:()=>gate.promise});
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();h.controller.filter({query:'older'});await settle();
    h.controller.filter({query:'\ud800'});gate.resolve();await settle();
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'\ud800');
    assert.equal(h.controller.getSnapshot().filterSync,'unsaved');
    h.controller.accept(payload(id(1)),id(1));await settle();
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'\ud800');
    h.controller.filter({query:'a'.repeat(199)+'😀'});await settle();
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'a'.repeat(199));
    assert.equal(h.writes.at(-1).filters.query,'a'.repeat(199));
  }finally{h.close();}
});

test('expiry completing during ordinary Playlist reload is retired and reread on readiness',async()=>{
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout,timers=new Map();let serial=0;
  globalThis.setTimeout=(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;};globalThis.clearTimeout=id=>timers.delete(id);
  const expiry=deferred(),reload=deferred();let reads=0;
  const h=await controllerHarness({readPlaylists:()=>reload.promise,read:async options=>{
    reads++;if(reads===2)return expiry.promise;
    return {playlist_ref:options.playlist_id,revision:'1',filters:reads===1?{...h.DEFAULT_SAVED_FILTERS,query:'expiring'}:null,
      remainingMs:reads===1?1:null};}});
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();assert.equal(reads,1);
    [...timers.values()][0].fn();await settle();assert.equal(reads,2);
    const loading=h.controller.load();assert.equal(h.controller.getSnapshot().resource.status,'loading');
    expiry.resolve({playlist_ref:id(1),revision:'1',filters:null,remainingMs:null});await settle();
    reload.resolve(payload(id(1)));await loading;await settle();
    assert.equal(reads,3);assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'');
  }finally{h.close();globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});

test('actual controller rejects filter mutation while its same-resource reload is pending',async()=>{
  const reload=deferred(),h=await controllerHarness({readPlaylists:()=>reload.promise});
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();
    h.controller.filter({query:'saved before reload'});await settle();
    const loading=h.controller.load();assert.equal(h.controller.getSnapshot().resource.status,'loading');
    const before=h.controller.getSnapshot(),writeCount=h.writes.length;
    h.controller.filter({query:'not admitted during reload'});
    assert.equal(h.controller.getSnapshot(),before,'non-ready filter calls publish no state');
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'saved before reload');
    reload.resolve(payload(id(1)));await loading;await settle();
    assert.equal(h.writes.length,writeCount);
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'saved before reload');
    h.controller.filter({query:'admitted after readiness'});await settle();
    assert.equal(h.writes.at(-1).filters.query,'admitted after readiness');
  }finally{h.close();}
});

test('accept never advertises ready for a new selection before its filter owner is attached',async()=>{
  const h=await controllerHarness();
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();let attempted=false;
    const unsubscribe=h.controller.subscribe(()=>{
      const snapshot=h.controller.getSnapshot();
      if(!attempted&&snapshot.selectedPlaylistId===id(2)){
        attempted=true;assert.equal(snapshot.resource.status,'loading');
        h.controller.filter({query:'not admitted between projections'});
        assert.equal(h.controller.getSnapshot(),snapshot);
      }
    });
    h.controller.accept(payload(id(2)),id(2));await settle();unsubscribe();
    assert.equal(attempted,true);assert.equal(h.writes.length,0);
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'');
    h.controller.filter({query:'new selection ready'});await settle();
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].playlist_id,id(2));
    assert.equal(h.writes[0].filters.query,'new selection ready');
  }finally{h.close();}
});

test('admitted filter survives a subscriber-triggered reload before post-publication dispatch',async()=>{
  const reload=deferred(),h=await controllerHarness({readPlaylists:()=>reload.promise});
  try{
    h.controller.accept(payload(id(1)),id(1));await settle();let loading;
    const unsubscribe=h.controller.subscribe(()=>{
      if(!loading&&h.model.playlistFilters(h.controller.getSnapshot()).query==='retained edit'){
        loading=true;loading=h.controller.load();
      }
    });
    h.controller.filter({query:'retained edit'});await settle();unsubscribe();
    assert.equal(h.controller.getSnapshot().resource.status,'loading');assert.equal(h.writes.length,0);
    reload.resolve(payload(id(1)));await loading;await settle();
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].filters.query,'retained edit');
    assert.equal(h.model.playlistFilters(h.controller.getSnapshot()).query,'retained edit');
    assert.equal(h.controller.getSnapshot().filterSync,'saved');
  }finally{h.close();}
});
