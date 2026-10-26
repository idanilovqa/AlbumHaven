'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=path.join(__dirname,'../../../music_app/static/js/runtime');
const source=name=>fs.readFileSync(path.join(root,name),'utf8');
const V1='app-rendered-position-v1',V2='app-rendered-position-v2';
const ID='11111111-1111-4111-8111-111111111111';
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(setImmediate);};
function fixture({position=true,advertise=position,selection=true,selectionMarker=true}={}) {
  // Both complete genuine owners execute unchanged. Separate VM globals model
  // the authored feature-on platform without rewriting the production constant.
  const telemetry=vm.createContext({ArrayBuffer,Float64Array,Uint8Array,TextEncoder,AbortController});
  vm.runInContext(source('player-capture-telemetry.js')+'\nthis.ownerApi=PlaybackCaptureTelemetry;',telemetry);
  let current=true,resolvePost,postSeen;
  const posted=new Promise(resolve=>{postSeen=resolve;});
  const calls=[],commands=[];
  const dataset={positionCaptureEnabled:String(position),listeningSelectionsEnabled:'true',privateUiContext:'a'.repeat(64)};
  const contextReply={ok:true,protocol:V1,expected_scope:'v1:'+'a'.repeat(64),source_rate:48000,output_rate:48000,
    ...(advertise?{supported_protocols:[V2],listening_selections_available:selection}:{}),
    checkpoint_path:'/untrusted-endpoint'};
  const platformFetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/playback/capture/album-selection')return {ok:true,status:200,json:async()=>({ok:true,
      ...(selectionMarker?{context_ref:dataset.privateUiContext}:{}),
      listening_selection:{version:'local-edition-selection-v1',selection_ref:ID,membership_revision:'b'.repeat(64)}})};
    if(options.method==='POST'){
      postSeen();return new Promise(resolve=>{resolvePost=resolve;});
    }
    return {ok:true,status:200,json:async()=>contextReply};
  };
  const window={fetch:platformFetch,location:{href:'https://music.test/',origin:'https://music.test'},crypto:webcrypto,
    setTimeout:()=>1,clearTimeout:()=>{},addEventListener(){},removeEventListener(){}};
  const document={cookie:'__Host-album_haven_csrf=synthetic-csrf',getElementById:()=>({dataset})};
  const node={port:{postMessage:value=>commands.push(value)}};
  const context={sampleRate:48000,state:'running',addEventListener(){},removeEventListener(){}};
  const engine={generation:1,node,context,roles:{current:null,continuity:null}};
  const sandbox=vm.createContext({window,document,URL,Headers,AbortController,ArrayBuffer,Float64Array,DataView,
    performance:{now:()=>0},PLAYBACK_CAPTURE_ENABLED:true,PlaybackCaptureTelemetry:telemetry.ownerApi,
    setTimeout:()=>1,clearTimeout:()=>{},state:{player:{streaming:engine},view:{}},capturePlaybackOwnershipScope:()=>({}),isPlaybackOwnershipScopeCurrent:()=>current});
  Object.defineProperty(sandbox,'fetch',{get:()=>window.fetch});
  vm.runInContext(source('session-csrf-fetch.js'),sandbox);
  vm.runInContext(source('private-ui-transport.js'),sandbox);
  vm.runInContext(source('tag-editor-and-optimistic-updates.js'),sandbox);
  vm.runInContext(source('player-streaming-engine.js'),sandbox);
  function owner(){return sandbox.streamingCaptureBridge(node)?.owner;}
  function send(){
    const o=owner(),parent=o.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID});assert.ok(parent);
    const binding=o.linkStream(parent,{generation:1,streamId:1,sourceBase48:0,sourceRate:48000,outputRate:48000});
    const enable=commands.find(c=>c.type==='capture-enable');assert.ok(enable);
    const buffer=new ArrayBuffer(16384),data=new Float64Array(buffer),version=enable.packetVersion === undefined ? 1 : enable.packetVersion;
    data.set([1094927184,version,enable.ownerSerial,1,1,48000,48000,1,0,0,0,128,1]);
    data.set([binding.bindingSerial,1,0,1,0,0,version===2?1:0],256);o.acceptPacket(buffer);
    assert.notEqual(sandbox.streamingCaptureBridge(node)?.diagnostic,'invalid_capture_packet');
    assert.equal(commands.some(c=>c.type==='capture-disable'),false,'valid synthetic packet must remain admitted');
  }
  async function start(){
    const prepared=sandbox.beginStreamingCaptureContext();
    sandbox.prepareStreamingCapture(engine,context,node,prepared);await settle();
  }
  async function dispose(){owner()?.onScopeLost();owner()?.onContextState('closed');
    resolvePost?.({status:409,json:async()=>({error:'stopped'})});await settle();}
  return {sandbox,engine,dataset,calls,commands,contextReply,posted,start,send,owner,dispose,completePost:response=>resolvePost(response),retire(){current=false;}};
}

for(const position of [false,true])test('actual owner uses fixed '+(position?'private-v2':'public-v1')+' context and checkpoint pair with genuine CSRF wrapper',{timeout:5000},async t=>{
  const f=fixture({position});t.after(()=>f.dispose());await f.start();f.send();await f.posted;
  assert.equal(f.calls[0].url,position?'/playback/capture/position/context':'/playback/capture/context');
  const post=f.calls.find(c=>c.options.method==='POST');
  assert.equal(post.url,position?'/playback/capture/position/checkpoint':'/playback/capture/checkpoint');
  assert.equal(JSON.parse(post.options.body).protocol,position?V2:V1);
  assert.equal(post.options.headers.get('X-Album-Haven-CSRF'),'synthetic-csrf');
  assert.equal(post.options.headers.get('X-Playback-Capture-Scope'),'v1:'+'a'.repeat(64));
  assert.equal(f.calls.some(c=>c.url==='/untrusted-endpoint'),false);
  
});

for(const position of [false,true])test('mismatched advertisement never falls back from fixed '+(position?'private':'public')+' pair',{timeout:5000},async t=>{
  const f=fixture({position,advertise:!position});t.after(()=>f.dispose());await f.start();
  assert.equal(f.commands.some(c=>c.type==='capture-enable'),false);assert.equal(f.calls.length,1);
  assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),false);
});

for(const loss of ['flag','scope'])test('actual owner '+loss+' retirement prevents posting on a different endpoint',{timeout:5000},async t=>{
  const f=fixture();t.after(()=>f.dispose());await f.start();
  if(loss==='flag')f.dataset.positionCaptureEnabled='false';else f.retire();
  assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),false);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  assert.equal(f.owner().bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID}),null);
  
});

for(const selection of [false,true])test('selection availability follows the actually accepted private owner: '+selection,{timeout:5000},async t=>{
  const f=fixture({selection});t.after(()=>f.dispose());assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),false);
  await f.start();assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),selection);
});


for(const loss of ['flag','scope'])test('late actual checkpoint response after '+loss+' retirement cannot revive the private owner',{timeout:5000},async t=>{
  const f=fixture();t.after(()=>f.dispose());await f.start();f.send();await f.posted;
  if(loss==='flag')f.dataset.positionCaptureEnabled='false';else f.retire();
  f.completePost({status:200,json:async()=>({ok:true})});await settle();
  assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),false);
  assert.equal(f.owner().bindTrack({trackPath:'/synthetic/late.flac',deviceId:ID}),null);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});

test('actual owner teardown clears selection availability even if display flags stay enabled',{timeout:5000},async t=>{
  const f=fixture();t.after(()=>f.dispose());await f.start();assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),true);
  f.owner().onScopeLost();assert.equal(f.sandbox.canStartOrdinaryAlbumListening(),false);
});

for(const selectionMarker of [false,true])test('genuine ordinary intent and private transport require server response marker: '+selectionMarker,{timeout:5000},async t=>{
  const f=fixture({selectionMarker});t.after(()=>f.dispose());
  const queue=f.sandbox.buildAlbumPlaybackQueueState({key:'album-a',tracks:[{path:'/synthetic/a.flac',title:'Track',track_number:1,disc_number:1,duration_seconds:60}]});
  const track=queue.tracks[0];
  f.sandbox.beginOrdinaryAlbumListening(track,()=>true);
  assert.equal(f.calls.length,0);
  // Genuine engine pending-attempt callback starts lookup after actual owner acceptance.
  f.sandbox.registerStreamingAttempt(f.engine,null,track);
  await f.start();await settle();
  const call=f.calls.find(c=>c.url==='/playback/capture/album-selection');assert.ok(call);
  assert.equal(call.options.headers.get('X-AlbumHaven-Context'),'a'.repeat(64));
  assert.equal(call.options.headers.get('X-Album-Haven-CSRF'),'synthetic-csrf');
  const selected=f.sandbox.settledOrdinaryAlbumListeningSelection(track);
  assert.equal(selected?.selection_ref??null,selectionMarker?ID:null);
  if(selectionMarker)assert.equal(f.sandbox.window.AlbumHavenPrivateUITransport.context(),'a'.repeat(64));
  else assert.throws(()=>f.sandbox.window.AlbumHavenPrivateUITransport.context());
  
});
