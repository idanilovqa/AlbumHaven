'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'),'utf8');
const REF='22222222-2222-4222-8222-222222222222';
const selection={version:'local-edition-selection-v1',selection_ref:REF,membership_revision:'a'.repeat(64)};
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
function fixture(enabled=true,selectionEnabled=true,privateReady=true){
  const calls=[],timers=new Map();let current=true,serial=0;
  const c=vm.createContext({AbortController,PLAYBACK_CAPTURE_ENABLED:enabled,
    canStartOrdinaryAlbumListening:()=>privateReady,
    document:{getElementById:()=>({dataset:{listeningSelectionsEnabled:String(selectionEnabled)}})},
    state:{player:{},view:{}},capturePlaybackOwnershipScope:()=>({}),isPlaybackOwnershipScopeCurrent:()=>current,
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),
    PrivateUITransport:{request:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}))}});
  vm.runInContext(source,c);
  return {c,calls,timers,retire(){current=false;}};
}
function album(key='album-a') {return {key,tracks:[1,2].map(number=>({path:'/synthetic/'+key+'/'+number+'.flac',
  title:'Track '+number,track_number:number,disc_number:1,duration_seconds:60}))};}

test('ordinary queue siblings share one session-only lookup with no render-time write',async()=>{
  const f=fixture(),queue=f.c.buildAlbumPlaybackQueueState(album());
  assert.equal(f.calls.length,0);assert.equal(queue.tracks.length,2);
  assert.equal(queue.tracks[0].albumListeningIntent,queue.tracks[1].albumListeningIntent);
  assert.equal(JSON.stringify(queue).includes('albumListeningIntent'),false);
  assert.equal(f.c.beginOrdinaryAlbumListening(queue.tracks[0],()=>true),undefined);
  f.c.beginOrdinaryAlbumListening(queue.tracks[1],()=>true);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'/playback/capture/album-selection');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].options.body)),{album_key:'album-a'});
  f.calls[0].resolve({listening_selection:selection});await flush();
  assert.equal(f.c.settledOrdinaryAlbumListeningSelection(queue.tracks[0]).selection_ref,REF);
  assert.equal(f.c.settledOrdinaryAlbumListeningSelection(queue.tracks[1]).selection_ref,REF);
  assert.equal(f.timers.size,0);
});

test('default-off ordinary play creates no request and no fabricated selection',()=>{
  const f=fixture(false),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];
  f.c.beginOrdinaryAlbumListening(track,()=>true);
  assert.equal(f.calls.length,0);assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
});

test('arbitrary playlist or unscoped track never becomes a complete-edition selection',()=>{
  const f=fixture(),track={path:'/synthetic/playlist.flac',album:'Display album'};
  f.c.beginOrdinaryAlbumListening(track,()=>true);
  assert.equal(f.calls.length,0);assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
});

test('late result for a retired play intent never becomes a ready selection',async()=>{
  const f=fixture(),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];let live=true;
  f.c.beginOrdinaryAlbumListening(track,()=>live);live=false;
  f.calls[0].resolve({listening_selection:selection});await flush();
  assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
});

test('actor or library scope replacement invalidates an already settled selection',async()=>{
  const f=fixture(),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];
  f.c.beginOrdinaryAlbumListening(track,()=>true);f.calls[0].resolve({listening_selection:selection});await flush();
  f.retire();assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
});

for(const status of [401,403,409,503])test('optional selection rejection '+status+' yields no qualification or media grant',async()=>{
  const f=fixture(),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];
  f.c.beginOrdinaryAlbumListening(track,()=>true);f.calls[0].reject(Object.assign(Error('Rejected'),{status}));await flush();
  assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
  assert.equal(Object.hasOwn(track,'allowed_actions'),false);assert.equal(f.timers.size,0);
});

test('background deadline aborts only selection lookup and never rewrites the ordinary queue',async()=>{
  const f=fixture(),queue=f.c.buildAlbumPlaybackQueueState(album()),track=queue.tracks[0];
  const before=JSON.stringify(queue);f.c.beginOrdinaryAlbumListening(track,()=>true);
  Array.from(f.timers.values())[0]();assert.equal(f.calls[0].options.signal.aborted,true);
  assert.equal(JSON.stringify(queue),before);assert.equal(f.c.settledOrdinaryAlbumListeningSelection(track),null);
  f.calls[0].reject(Object.assign(Error('Aborted'),{name:'AbortError'}));await flush();
});

test('separate album queue constructions do not reuse a prior selection request',()=>{
  const f=fixture(),first=f.c.buildAlbumPlaybackQueueState(album()),second=f.c.buildAlbumPlaybackQueueState(album());
  assert.notEqual(first.tracks[0].albumListeningIntent,second.tracks[0].albumListeningIntent);
  assert.equal(f.calls.length,0);
});


test('capture enabled but server selection presentation disabled creates no lookup',()=>{
  const f=fixture(true,false),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];
  f.c.beginOrdinaryAlbumListening(track,()=>true);assert.equal(f.calls.length,0);
});

test('actual explicit Album source resolves fresh authority and carries the shared intent without a metadata write',async()=>{
  const f=fixture(),a=album();a.track_rows=a.tracks.map(track=>({...track,availability:'local',playback_state:{can_start_here:true}}));
  Object.assign(f.c,{TrackActionsRuntime:{scope:()=>({actor:'a',library:'l',token:'same'})},
    fetchTrackModalAlbumDetails:async()=>a});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/explicit-queue-sources.js'),'utf8'),f.c);
  const sources=f.c.captureNativeAlbumQueueSources(a,a.track_rows);
  const first=await sources[0].resolve(),second=await sources[1].resolve();
  assert.ok(first.albumListeningIntent);assert.equal(first.albumListeningIntent,second.albumListeningIntent);
  assert.equal(f.calls.length,0);f.c.beginOrdinaryAlbumListening(first,()=>true);assert.equal(f.calls.length,1);
});

for(const persisted of [false,true])test('actual restore '+(persisted?'retains genuine Album intent':'does not infer intent from an unscoped track'),()=>{
  const f=fixture(),a=album(),queue=f.c.buildAlbumPlaybackQueueState(a),started=[];
  const parsed={track:{...queue.tracks[0]},paused:true,...(persisted?{playbackQueue:JSON.parse(JSON.stringify(queue))}:{})};
  Object.assign(f.c,{window:{},playerTrackSelectionToken:0,PLAYER_STATE_STORAGE_KEY:'synthetic',
    getLocalStorageItem:()=>JSON.stringify(parsed),getAlbumIdentity:value=>value.key,
    resolveAlbumForPlayerTrack:()=>a,
    startStreamingTrack:(track,options)=>{started.push({track,options});return new Promise(()=>{});}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/player-state-persistence-helpers.js'),'utf8'),f.c);
  f.c.restorePlayerState();assert.equal(started.length,1);assert.equal(started[0].options.autoplay,false);
  assert.equal(Boolean(started[0].track.albumListeningIntent),persisted);
  assert.equal(f.c.state.player.playbackQueue.tracks.some(track=>Boolean(track.albumListeningIntent)),persisted);
  assert.equal(f.calls.length,0);
});


test('ordinary selection requires actual private owner readiness beyond both display flags',()=>{
  const f=fixture(true,true,false),track=f.c.buildAlbumPlaybackQueueState(album()).tracks[0];
  f.c.beginOrdinaryAlbumListening(track,()=>true);assert.equal(f.calls.length,0);
});
