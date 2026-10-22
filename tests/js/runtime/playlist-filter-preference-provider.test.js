'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('actual Playlist provider sends bounded existing-context requests and exact applied state',async()=>{
  const {createPlaylistBackendProviders}=await import('../../../music_app/static/js/playlists/backend-providers.mjs');
  const {DEFAULT_SAVED_FILTERS}=await import('../../../music_app/static/js/playlists/filter-preferences.mjs');
  const context='a'.repeat(64),calls=[];
  const transport={context:()=>context,subscribe:()=>()=>{},request:async(path,options)=>{
    calls.push({path,options});return options.method==='PUT'?{context_ref:context,ok:true,action:'playlist_filter_preferences',
      request_key:options.body.request_key,playlist_ref:id(1),revision:'2',changed:true}:
      {context_ref:context,playlist_ref:id(1),revision:'1',filters:null,expires_at:null,server_time:'2026-10-19T00:00:00Z'};}};
  const providers=createPlaylistBackendProviders({transport,runtime:{acceptsPrivateScope:scope=>scope==='scope'}});
  try{
    const read=await providers.readFilterPreferences({scopeKey:'scope',playlist_id:id(1)});assert.equal(read.filters,null);
    await providers.saveFilterPreferences({scopeKey:'scope',playlist_id:id(1),revision:'1',request_key:id(2),filters:DEFAULT_SAVED_FILTERS});
    assert.equal(calls.length,2);assert.equal(calls[0].options.expected,context);assert.equal(calls[1].options.expected,context);
    assert.deepEqual(Object.keys(calls[1].options.body).sort(),['filters','request_key','revision']);
    assert.equal(calls[1].path,`/playlists/${id(1)}/filter-preferences`);
    await assert.rejects(providers.readFilterPreferences({scopeKey:'scope',playlist_id:'ABCDEF00-0000-4000-8000-000000000001'}));
    await assert.rejects(providers.saveFilterPreferences({scopeKey:'scope',playlist_id:id(1),revision:'1',
      request_key:'ABCDEF00-0000-4000-8000-000000000002',filters:null}));
    assert.equal(calls.length,2,'noncanonical identities never reach transport');
  }finally{providers.dispose();}
});

test('actual provider rejects late scope/context, malformed evidence and foreign acknowledgements',async()=>{
  const {createPlaylistBackendProviders}=await import('../../../music_app/static/js/playlists/backend-providers.mjs');
  let context='a'.repeat(64),active=true,finish;
  const transport={context:()=>context,subscribe:()=>()=>{},request:()=>new Promise(resolve=>{finish=resolve;})};
  const providers=createPlaylistBackendProviders({transport,runtime:{acceptsPrivateScope:()=>active}});
  try{
    const pending=providers.readFilterPreferences({scopeKey:'scope',playlist_id:id(1)});
    context='b'.repeat(64);finish({context_ref:'a'.repeat(64),playlist_ref:id(1),revision:'1',filters:null,expires_at:null,server_time:'2026-10-19T00:00:00Z'});
    await assert.rejects(pending,error=>error.name==='AbortError');
    active=false;await assert.rejects(providers.readFilterPreferences({scopeKey:'scope',playlist_id:id(1)}),error=>error.status===403);
  }finally{providers.dispose();}
});
