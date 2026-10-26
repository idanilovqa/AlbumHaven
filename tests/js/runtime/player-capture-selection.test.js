'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/player-capture-telemetry.js'),'utf8');
const V1='app-rendered-position-v1',V2='app-rendered-position-v2';
const ID='11111111-1111-4111-8111-111111111111',REF='22222222-2222-4222-8222-222222222222';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
function fixture(protocol) {
  const context=vm.createContext({ArrayBuffer,Float64Array,Uint8Array,TextEncoder,AbortController});
  vm.runInContext(source+'\nthis.api=PlaybackCaptureTelemetry;',context);
  const commands=[],posted=[];let completePost,resolvePosted;
  const postedOnce=new Promise(resolve=>{resolvePosted=resolve;});
  const owner=context.api.createOwner({getContext:async()=>({ok:true,protocol:V1,source_rate:48000,output_rate:48000,
      expected_scope:'v1:'+'a'.repeat(64),supported_protocols:[protocol]}),
    postCheckpoint:body=>{posted.push(JSON.parse(body));resolvePosted();return new Promise(resolve=>{completePost=resolve;});},
    clock:{now:()=>0,utc:()=>1800000000000,setTimeout:()=>1,clearTimeout:()=>{}},
    crypto:{randomUUID:()=>ID,subtle:webcrypto.subtle},generation:()=>1,sendCommand:c=>commands.push(c)});
  function send(parent,extra={}) {
    const binding=owner.linkStream(parent,{generation:1,streamId:1,sourceBase48:0,sourceRate:48000,outputRate:48000,...extra});
    if(!binding)return null;
    const enabled=commands.find(c=>c.type==='capture-enable');
    const buffer=new ArrayBuffer(16384),data=new Float64Array(buffer);
    data.set([1094927184,protocol===V2?2:1,enabled.ownerSerial,1,1,48000,48000,1,0,0,0,128,1]);
    data.set([binding.bindingSerial,1,0,1,0,0,protocol===V2?1:0],256);
    owner.acceptPacket(buffer);
  }
  async function dispose(){owner.onScopeLost();owner.onContextState('closed');completePost?.({status:409,data:{error:'stopped'}});await settle();}
  return {owner,posted,postedOnce,send,dispose};
}
for(const version of [V1,V2])test('selection lookup key is emitted only for negotiated '+version,{timeout:2000},async()=>{
  const f=fixture(version);await f.owner.enable();
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,editionSelectionRef:REF});
  assert.ok(parent);f.send(parent);await f.postedOnce;
  assert.equal(f.posted.length,1);
  if(version===V2)assert.equal(f.posted[0].edition_selection_ref,REF);
  else assert.equal(Object.hasOwn(f.posted[0],'edition_selection_ref'),false);
  assert.equal(Object.hasOwn(f.posted[0].evidence,'members'),false);
  await f.dispose();
});
for(const ref of ['',{},'00000000-0000-0000-0000-000000000000'])test('invalid selection key cannot bind a parent: '+JSON.stringify(ref),async()=>{
  const f=fixture(V2);await f.owner.enable();
  assert.equal(f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,editionSelectionRef:ref}),null);
  assert.equal(f.posted.length,0);await f.dispose();
});


test('first private-v2 seal can use a selection settled after bind without waiting for audio',{timeout:2000},async()=>{
  const f=fixture(V2);await f.owner.enable();let ready=null,calls=0;
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,
    editionSelectionResolver:()=>{calls++;return ready;}});
  assert.ok(parent);assert.equal(calls,0);
  ready=REF;f.send(parent);await f.postedOnce;
  assert.equal(f.posted[0].edition_selection_ref,REF);assert.equal(calls,1);
  assert.equal(f.owner.selectionRefFor(parent),REF);
  await f.dispose();
});

test('a delayed selection after first seal cannot relabel frozen first-track history',{timeout:2000},async()=>{
  const f=fixture(V2);await f.owner.enable();let ready=null,calls=0;
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,
    editionSelectionResolver:()=>{calls++;return ready;}});
  f.send(parent);ready=REF;await f.postedOnce;
  assert.equal(Object.hasOwn(f.posted[0],'edition_selection_ref'),false);
  assert.equal(calls,1);await f.dispose();assert.equal(calls,1);
});

test('public-v1 never invokes the optional selection resolver',{timeout:2000},async()=>{
  const f=fixture(V1);await f.owner.enable();let calls=0;
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,
    editionSelectionResolver:()=>{calls++;return REF;}});
  f.send(parent);await f.postedOnce;assert.equal(calls,0);
  assert.equal(Object.hasOwn(f.posted[0],'edition_selection_ref'),false);await f.dispose();
});


test('first-seal resolver reentrancy cannot reserve a second digest or duplicate request',{timeout:2000},async()=>{
  const f=fixture(V2);await f.owner.enable();let calls=0;
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID,
    editionSelectionResolver:()=>{calls++;f.owner.tick();return REF;}});
  f.send(parent);await f.postedOnce;assert.equal(calls,1);assert.equal(f.posted.length,1);
  assert.equal(f.owner.selectionRefFor(parent),REF);await f.dispose();
});

for(const version of [V1,V2])test('server observation reference stays private per rendered run '+version,{timeout:2000},async t=>{
  const f=fixture(version);t.after(()=>f.dispose());await f.owner.enable();
  const parent=f.owner.bindTrack({trackPath:'/synthetic/a.flac',deviceId:ID});
  if(version===V1){assert.equal(f.send(parent,{sourceObservationRef:REF}),null);assert.equal(f.posted.length,0);return;}
  f.send(parent,{sourceObservationRef:REF});await f.postedOnce;
  assert.equal(f.posted[0].evidence.runs[0].source_observation_ref,REF);
  assert.equal(f.posted[0].evidence.runs[0].frames,1);
  assert.equal(Object.hasOwn(f.posted[0].evidence.runs[0],'extent_frames48'),false);
});
