const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const V1 = 'app-rendered-position-v1', V2 = 'app-rendered-position-v2';
const UUID = '22222222-2222-4222-8222-222222222222';
const TRACK = '/synthetic/track.flac';
async function settle() {
  for (let index = 0; index < 4; index++) await new Promise(setImmediate);
}
function fixture(supported = [V2], uuid = UUID) {
  const context = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array, TextEncoder, AbortController });
  vm.runInContext(source + '\nthis.api = PlaybackCaptureTelemetry;', context);
  const commands = [], hashes = [], diagnostics = [];
  let generation = 7, resolveHash, timer = 0;
  const hash = new Promise(resolve => { resolveHash = resolve; });
  const owner = context.api.createOwner({
    getContext: async () => ({ ok: true, protocol: V1, source_rate: 48000, output_rate: 48000,
      expected_scope: 'v1:' + 'a'.repeat(64), ...(supported === undefined ? {} : { supported_protocols: supported }) }),
    postCheckpoint: () => new Promise(() => {}),
    clock: { now: () => 0, utc: () => 1800000000000, setTimeout: () => ++timer, clearTimeout: () => {} },
    crypto: { randomUUID: () => uuid, subtle: { digest: (algorithm, input) => {
      hashes.push({ algorithm, input: new TextDecoder().decode(input) }); return hash;
    } } },
    generation: () => generation, sendCommand: command => commands.push(command),
    diagnostic: reason => diagnostics.push(reason),
  });
  function bind({ streamId = 1, base = 100 } = {}) {
    const parent = owner.bindTrack({ trackPath: TRACK, deviceId: UUID });
    assert.ok(parent);
    const binding = owner.linkStream(parent, { generation, streamId, sourceBase48: base,
      sourceRate: 48000, outputRate: 48000, sourceObservationRef: UUID });
    assert.ok(binding); return {...binding,parent};
  }
  function send(binding, { version = 2, continuity = 3, packet = 1, bufferId = 1,
    sourceStart = binding.sourceBase48, ordinal = 0, output = 0, count = 1 } = {}) {
    const enabled = commands.find(command => command.type === 'capture-enable');
    const buffer = new ArrayBuffer(16384), data = new Float64Array(buffer);
    data.set([1094927184, version, enabled.ownerSerial, packet, count, 48000, 48000, 1, 0, 0, 0, 128, bufferId]);
    for (let index = 0; index < count; index++) data.set([
      binding.bindingSerial, 1, sourceStart + index, 1, output + index, ordinal + index,
      version === 1 ? 0 : continuity,
    ], 256 + index * 7);
    owner.acceptPacket(buffer);
  }
  async function dispose() {
    owner.onScopeLost(); owner.onContextState('closed'); resolveHash(new ArrayBuffer(32)); await settle();
  }
  return { owner, commands, hashes, diagnostics, bind, send, dispose, resolveHash,
    setGeneration: value => { generation = value; } };
}

const OBS='33333333-3333-4333-8333-333333333333';
function alias(f,b,change={}) {return f.owner.linkStream(b.parent,{generation:7,streamId:b.streamId,
 sourceBase48:0,sourceRate:48000,outputRate:48000,mapped:true,baseBindingSerial:b.bindingSerial,
 sourceObservationRef:OBS,...change});}

test('mapped alias keeps all eight ordinary slots available',async()=>{
 const f=fixture();await f.owner.enable();
 for(let n=0;n<8;n++) {const b=f.bind({streamId:n+1,base:0});const a=alias(f,b);assert.ok(a);assert.equal(a.slot,b.slot);}
 assert.equal(f.commands.filter(c=>c.type==='capture-bind'&&!c.mapped).length,8);
 assert.equal(f.commands.filter(c=>c.type==='capture-bind'&&c.mapped).length,8);
 await f.dispose();
});

test('mapped run persists its own observation and binding while preserving parent',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0}),a=alias(f,b);assert.ok(a);
 f.send(a,{sourceStart:100});await settle();
 assert.equal(f.diagnostics.includes('invalid_capture_packet'),false);
 assert.equal(f.hashes.length,1);
 const e=JSON.parse(f.hashes[0].input.split('\n')[2]);
 assert.equal(e.runs[0].binding_serial,a.bindingSerial);
 assert.equal(e.runs[0].source_observation_ref,OBS);
 assert.equal(e.runs[0].source_start48,100);
 await f.dispose();
});

test('ordinary run retains local observation after alias attached',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0});assert.ok(alias(f,b));
 f.send(b);await settle();const e=JSON.parse(f.hashes[0].input.split('\n')[2]);
 assert.equal(e.runs[0].binding_serial,b.bindingSerial);assert.equal(e.runs[0].source_observation_ref,UUID);
 await f.dispose();
});

for(const [name,change] of [ ['wrong stream',{streamId:7}],['wrong generation',{generation:8}],
 ['wrong base binding',{baseBindingSerial:999}],['nonzero base',{sourceBase48:1}],
 ['same observation',{sourceObservationRef:UUID}],['missing observation',{sourceObservationRef:undefined}],
 ['invalid observation',{sourceObservationRef:'bad'}] ]) test('alias rejects '+name,async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0});assert.equal(alias(f,b,change),null);
 f.send(b);await settle();assert.equal(f.diagnostics.includes('invalid_capture_packet'),false);await f.dispose();
});

test('a second alias cannot replace first observation',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0});const a=alias(f,b);assert.ok(a);
 assert.equal(alias(f,b,{sourceObservationRef:'44444444-4444-4444-8444-444444444444'}),null);
 f.send(a,{sourceStart:100});await settle();assert.equal(JSON.parse(f.hashes[0].input.split('\n')[2]).runs[0].source_observation_ref,OBS);
 await f.dispose();
});

test('alias cannot attach after ordinary binding starts retirement',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0});f.owner.unlinkStream(b);assert.equal(alias(f,b),null);await f.dispose();
});

test('alias cannot attach through another parent handle',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0}),other=f.bind({base:0,streamId:2});
 assert.equal(f.owner.linkStream(other.parent,{generation:7,streamId:b.streamId,sourceBase48:0,
  sourceRate:48000,outputRate:48000,mapped:true,baseBindingSerial:b.bindingSerial,sourceObservationRef:OBS}),null);
 await f.dispose();
});

test('base retirement acknowledgement includes alias final ordinal and frees slot once',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0}),a=alias(f,b);f.owner.unlinkStream(b);
 const enabled=f.commands.find(c=>c.type==='capture-enable');
 const buffer=new ArrayBuffer(16384),data=new Float64Array(buffer);
 data.set([1094927184,2,enabled.ownerSerial,1,1,48000,48000,1,0,1,0,128,1]);
 data.set([a.bindingSerial,1,100,1,0,0,3],256);
 data.set([b.bindingSerial,1,1,1],96);
 f.owner.acceptPacket(buffer);await settle();
 assert.equal(f.diagnostics.includes('invalid_capture_packet'),false);
 const next=f.owner.linkStream(b.parent,{generation:7,streamId:2,sourceBase48:0,sourceRate:48000,outputRate:48000,sourceObservationRef:UUID});
 assert.ok(next);assert.equal(next.slot,b.slot);assert.notEqual(next.bindingSerial,b.bindingSerial);
 await f.dispose();
});

test('mixed local mapped and credit-loss packet retires one slot without double counting',async()=>{
 const f=fixture();await f.owner.enable();const b=f.bind({base:0}),a=alias(f,b);f.owner.unlinkStream(b);
 const enabled=f.commands.find(c=>c.type==='capture-enable');const buffer=new ArrayBuffer(16384),data=new Float64Array(buffer);
 data.set([1094927184,2,enabled.ownerSerial,1,2,48000,48000,1,1,1,0,128,1]);
 data.set([b.bindingSerial,1,0,1,0,0,3],256);data.set([a.bindingSerial,1,100,1,1,1,3],263);
 data.set([b.bindingSerial,1,2,3,1,2,3,1],32);data.set([b.bindingSerial,1,3,1],96);
 f.owner.acceptPacket(buffer);await settle();assert.equal(f.diagnostics.includes('invalid_capture_packet'),false);
 const e=JSON.parse(f.hashes[0].input.split('\n')[2]);
 assert.deepEqual(e.runs.map(r=>[r.source_observation_ref,r.frames]),[[UUID,1],[OBS,1]]);
 assert.equal(e.gaps.reduce((n,g)=>n+g.positive_frames,0),1);
 const next=f.owner.linkStream(b.parent,{generation:7,streamId:2,sourceBase48:0,sourceRate:48000,outputRate:48000,sourceObservationRef:UUID});
 assert.ok(next);assert.equal(next.slot,b.slot);await f.dispose();
});
