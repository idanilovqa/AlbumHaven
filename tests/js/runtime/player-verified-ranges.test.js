const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Load complete production files, not extracted or reimplemented helpers. The
// telemetry owner below is a boundary spy; the renderer is the unchanged worklet.
const engineSource = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-streaming-engine.js'), 'utf8');
const workletSource = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/audio-worklets/gapless-playback-processor.js'), 'utf8');
const OBSERVATION = '11111111-1111-4111-8111-111111111111';
const OTHER_OBSERVATION = '22222222-2222-4222-8222-222222222222';

function source(changes = {}) {
  return { version: 'decoded-pcm-observation-v1', observationId: OBSERVATION,
    coordinateBasis: 'decoded-output-zero', sourceBase48: 0, extentFrames48: null, ...changes };
}
function metadata(changes = {}) {
  return { type: 'metadata', generation: 7, streamId: 11, role: 'current',
    sampleRate: 48000, channels: 2, provisionalTotalFrames: 43_200_000,
    requestedStartFrame: 0, timelineStartFrame: 0, captureSource: source(), ...changes };
}
function eof(frames, changes = {}) {
  return { type: 'eos', generation: 7, streamId: 11, role: 'current',
    emittedFrames: frames, authoritativeTotalFrames: frames,
    captureSource: source({ extentFrames48: frames }), ...changes };
}
function pcm(frames, { generation = 7, streamId = 11, sequence = 0 } = {}) {
  const buffer = new ArrayBuffer(24 + frames * 8), view = new DataView(buffer);
  [65, 72, 80, 67, 1, 0, 0, 0].forEach((value, index) => view.setUint8(index, value));
  [generation, streamId, sequence, frames].forEach((value, index) => view.setUint32(8 + index * 4, value, false));
  for (let index = 0; index < frames * 2; index++) view.setFloat32(24 + index * 4, 0.25, true);
  return buffer;
}

function workletFixture(enable = true) {
  let Processor;
  const packets = [], messages = [];
  const context = vm.createContext({ ArrayBuffer, Float32Array, Float64Array,
    sampleRate: 48000, currentFrame: 0, currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage(message) {
          if (message.type === 'capture-packet') packets.push(new Float64Array(message.buffer.slice(0)));
          else messages.push(message);
        } };
      }
    },
    registerProcessor(name, value) { assert.equal(name, 'album-haven-gapless-playback'); Processor = value; },
  });
  vm.runInContext(workletSource, context);
  const processor = new Processor();
  const send = message => processor.port.onmessage({ data: { generation: 7, ...message } });
  send({ type: 'configure', sampleRate: 48000, currentCapacityFrames: 64,
    continuityCapacityFrames: 64, startupBufferFrames: 1 });
  if (enable) send({ type: 'capture-enable', ownerSerial: 1, sourceRate: 48000, outputRate: 48000,
    packetVersion: 2, buffers: Array.from({ length: 4 }, () => new ArrayBuffer(16384)) });
  return {
    send, messages, packets, processor,
    render(frames) {
      const output = [new Float32Array(frames), new Float32Array(frames)];
      assert.equal(processor.process([], [output]), true);
      context.currentFrame += frames;
      context.currentTime = context.currentFrame / 48000;
      assert.equal(messages.some(message => message.type === 'protocol-reject'), false);
      return Array.from(output[0]);
    },
    runs() {
      return packets.flatMap(packet => Array.from({ length: packet[4] }, (_, index) => {
        const offset = 256 + index * 7;
        return { serial: packet[offset], source: packet[offset + 2], frames: packet[offset + 3], output: packet[offset + 4] };
      }));
    },
  };
}

function fixture(enable = true) {
  const worklet = workletFixture(enable), events = [], controls = [];
  const role = { generation: 7, streamId: 11, role: 'current', startFrame: 0,
    nextSequence: 0, metadataAccepted: false, backingCapacityFrames: 64,
    targetBufferFrames: 64, track: { path: '/synthetic/capture-source.flac' } };
  const node = { port: { postMessage(message) {
    events.push({ type: message.type, message }); worklet.send(message);
  } } };
  const engine = {
    generation: 7, node, context: { sampleRate: 48000 },
    roles: { current: role, continuity: null },
    limits: { currentSeconds: 1, continuitySeconds: 1 },
    backingCapacityFrames: { current: 64, continuity: 64 },
    snapshot: { paused: false, currentTime: 0, renderedFrame: 0 },
    socket: { readyState: 1, send: value => controls.push(JSON.parse(value)) },
    diagnostics: { staleMessages: 0, underruns: 0,
      bufferedFrames: { current: 0, continuity: 0 }, inFlightFrames: { current: 0, continuity: 0 } },
  };
  const sandbox = vm.createContext({ ArrayBuffer, DataView, Float32Array,
    window: {}, performance: { now: () => 1 }, WebSocket: { OPEN: 1, CONNECTING: 0 },
    state: { player: { streaming: engine } },
    getMeasuredPlaybackDeviceId: () => '33333333-3333-4333-8333-333333333333' });
  vm.runInContext(engineSource + '\nthis.api = { bindStreamingCapture, retireStreamingCapture, '
    + 'handleStreamingControl, handleStreamingPcm, handleStreamingWorkletMessage, '
    + 'resetStreamingPcmEvidence, streamingCaptureOwners, prepareStreamingCapture, '
    + 'cleanupStreamingResources, startStreamingTrack, resumeStreamingPlayback, scheduleStreamingContinuity };', sandbox);
  let serial = 0;
  const parent = {};
  const bridge = { guard: () => true, owner: {
    bindTrack(value) { events.push({ type: 'parent', value }); return parent; },
    linkStream(handle, value) {
      const binding = { slot: value.mapped ? role.captureBinding.slot : serial + 1, bindingSerial: ++serial, ...value };
      events.push({ type: 'link', handle, value });
      node.port.postMessage({ type: 'capture-bind', ownerSerial: 1, ...binding });
      return binding;
    },
    unlinkStream(binding) {
      events.push({ type: 'unlink', binding });
      node.port.postMessage({ type: 'capture-unbind', generation: 7, ownerSerial: 1,
        bindingSerial: binding.bindingSerial });
    },
    requestClose(handle, reason) { events.push({ type: 'close-parent', handle, reason }); },
  } };
  sandbox.api.streamingCaptureOwners.set(node, bridge);
  sandbox.api.resetStreamingPcmEvidence(role);
  return { ...sandbox.api, role, engine, node, bridge, parent, events, controls, worklet, sandbox };
}

function links(f) { return f.events.filter(event => event.type === 'link'); }

function installActualScopeGuard(f) {
  let current = true;
  f.sandbox.PLAYBACK_CAPTURE_ENABLED = true;
  f.sandbox.isPlaybackOwnershipScopeCurrent = () => current;
  Object.assign(f.engine.context, { state: 'running', addEventListener() {}, removeEventListener() {} });
  Object.assign(f.sandbox.window, { addEventListener() {}, removeEventListener() {} });
  const owner = Object.assign(f.bridge.owner, { enable: async () => false,
    onScopeLost() { f.events.push({ type: 'scope-lost' }); } });
  f.sandbox.PlaybackCaptureTelemetry = { createOwner: () => owner };
  f.prepareStreamingCapture(f.engine, f.engine.context, f.node,
    { scope: {}, promise: Promise.resolve(null), discard() {} });
  return { bridge: f.streamingCaptureOwners.get(f.node), loseScope: () => { current = false; } };
}

function localFixture() {
  const f = fixture();
  f.role.startFrame = 12;
  f.bridge.observationReady = true;
  f.handleStreamingControl(metadata({requestedStartFrame:12,timelineStartFrame:12,
    captureSource:source({coordinateBasis:'decoded-output-local',requestedStart48:12})}));
  return f;
}
function mapping(sequence=0, changes={}) {
  return {type:'capture-positions',generation:7,streamId:11,sequence,frameCount:4,
    observationId:OTHER_OBSERVATION,ranges:[[1,100,2]],...changes};
}
function flush(f, frames) {
  f.worklet.send({type:'play'}); f.worklet.render(frames); f.worklet.send({type:'pause'});
  return f.worklet.runs();
}

test('late mapped alias changes new verified frames only, local gaps count once',()=>{
 const f=localFixture();f.handleStreamingPcm(pcm(4));
 f.handleStreamingControl(mapping(1));f.handleStreamingPcm(pcm(4,{sequence:1}));
 assert.deepEqual(flush(f,8),[{serial:1,source:0,frames:5,output:0},
   {serial:2,source:100,frames:2,output:5},{serial:1,source:7,frames:1,output:7}]);
 assert.equal(links(f).length,2);assert.equal(links(f)[1].value.baseBindingSerial,1);
});

test('mapping consumed once never leaks to following PCM',()=>{
 const f=localFixture();f.handleStreamingControl(mapping());f.handleStreamingPcm(pcm(4));
 f.handleStreamingPcm(pcm(4,{sequence:1}));
 assert.deepEqual(flush(f,8),[{serial:1,source:0,frames:1,output:0},
  {serial:2,source:100,frames:2,output:1},{serial:1,source:3,frames:5,output:3}]);
});

test('duplicate optional control discards mapping without stopping audio',()=>{
 const f=localFixture();f.handleStreamingControl(mapping());f.handleStreamingControl(mapping());
 f.handleStreamingPcm(pcm(4));assert.deepEqual(flush(f,4),[{serial:1,source:0,frames:4,output:0}]);
});

test('mismatching frame count discards mapping without leakage',()=>{
 const f=localFixture();f.handleStreamingControl(mapping(0,{frameCount:5}));
 f.handleStreamingPcm(pcm(4));f.handleStreamingPcm(pcm(4,{sequence:1}));
 assert.deepEqual(flush(f,8),[{serial:1,source:0,frames:8,output:0}]);
});

for(const [name,change] of [
 ['wrong generation',{generation:6}],['wrong stream',{streamId:12}],['future sequence',{sequence:1}],
 ['invalid uuid',{observationId:'bad'}],['same local observation',{observationId:OBSERVATION}],
 ['empty ranges',{ranges:[]}],['too many ranges',{ranges:Array.from({length:33},()=>[0,1,1])}],
 ['negative offset',{ranges:[[-1,100,1]]}],['negative source',{ranges:[[0,-1,1]]}],
 ['empty range',{ranges:[[0,100,0]]}],['out of chunk',{ranges:[[3,100,2]]}],
 ['overlap',{ranges:[[0,100,3],[2,200,1]]}],['unsorted',{ranges:[[2,100,1],[0,200,1]]}],
 ['unsafe source end',{ranges:[[0,Number.MAX_SAFE_INTEGER,1]]}],['fractional',{ranges:[[0,1.5,1]]}],
 ['negative zero',{ranges:[[-0,1,1]]}],['extra tuple field',{ranges:[[0,1,1,9]]}],
]) test('invalid '+name+' keeps local rendering',()=>{
 const f=localFixture();f.handleStreamingControl(mapping(0,change));f.handleStreamingPcm(pcm(4));
 assert.deepEqual(flush(f,4),[{serial:1,source:0,frames:4,output:0}]);
});

test('changed absolute observation cannot rebind same stream alias',()=>{
 const f=localFixture();f.handleStreamingControl(mapping());f.handleStreamingPcm(pcm(4));
 f.handleStreamingControl(mapping(1,{observationId:'44444444-4444-4444-8444-444444444444'}));
 f.handleStreamingPcm(pcm(4,{sequence:1}));assert.equal(links(f).length,2);
 assert.equal(flush(f,8).filter(x=>x.serial===2).reduce((n,x)=>n+x.frames,0),2);
});

test('scope loss between mapping and enqueue drops optional positions',()=>{
 const f=localFixture();f.handleStreamingControl(mapping());f.bridge.guard=()=>false;
 f.handleStreamingPcm(pcm(4));assert.deepEqual(flush(f,4),[{serial:1,source:0,frames:4,output:0}]);
});

test('ordinary source zero never accepts late absolute sideband',()=>{
 const f=fixture();f.bridge.observationReady=true;f.handleStreamingControl(metadata());
 f.handleStreamingControl(mapping());f.handleStreamingPcm(pcm(4));
 assert.deepEqual(flush(f,4),[{serial:1,source:0,frames:4,output:0}]);
});

function directWorklet(capacity=64) {
 const f=workletFixture();
 f.send({type:'capture-bind',ownerSerial:1,slot:1,bindingSerial:1,streamId:11,sourceBase48:0});
 const enqueue=(sequence,frames,positions=null,role='current',streamId=11)=>f.send({type:'enqueue',role,streamId,sequence,
  frameCount:frames,pcm:new Float32Array(frames*2).fill(.25),...(positions?{capturePositions:positions}:{})});
 const alias=()=>f.send({type:'capture-bind',ownerSerial:1,slot:1,bindingSerial:2,streamId:11,sourceBase48:0,mapped:true,baseBindingSerial:1});
 return {...f,enqueue,alias};
}

test('all eight ordinary slots remain available after mapped aliases',()=>{
 const f=workletFixture();
 for(let n=0;n<8;n++){
  const base=n*2+1;
  f.send({type:'capture-bind',ownerSerial:1,slot:n+1,bindingSerial:base,streamId:n+1,sourceBase48:0});
  f.send({type:'capture-bind',ownerSerial:1,slot:n+1,bindingSerial:base+1,streamId:n+1,sourceBase48:0,mapped:true,baseBindingSerial:base});
 }
 assert.equal(f.processor.positionCapture.slots.filter(s=>s.serial).length,8);
 assert.equal(f.processor.positionCapture.slots.filter(s=>s.mappedSerial).length,8);
});

test('alias binding rejects wrong base or stream without changing ordinary slot',()=>{
 const f=directWorklet();
 for(const change of [{baseBindingSerial:7},{streamId:12},{sourceBase48:3},{generation:6}])
  f.send({type:'capture-bind',ownerSerial:1,slot:1,bindingSerial:2,streamId:11,sourceBase48:0,mapped:true,baseBindingSerial:1,...change});
 assert.equal(f.processor.positionCapture.slots[0].mappedSerial,0);
 f.enqueue(0,4);f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:1,source:0,frames:4,output:0}]);
});

test('invalid worklet optional range cannot reject ordinary PCM',()=>{
 const f=directWorklet();f.alias();f.enqueue(0,4,{bindingSerial:2,ranges:[[3,100,2]]});
 f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:1,source:0,frames:4,output:0}]);
});

test('fixed range storage is independent of configured audio capacity',()=>{
 const f=directWorklet();
 assert.equal(f.processor.current.captureRanges.data.byteLength,8192);
 assert.equal(f.processor.continuity.captureRanges.data.byteLength,8192);
 assert.equal(f.processor.retainedCaptureRanges.data.byteLength,8192);
});

test('full optional range queue preserves existing mappings and falls back locally',()=>{
 const f=directWorklet();f.alias();
 // Fill bounded future-only queue, as many fine-grained queued chunks can do.
 const queue=f.processor.current.captureRanges;
 for(let n=0;n<256;n++)assert.equal(queue.add(1000+n*2,1001+n*2,2000+n,2),true);
 f.enqueue(0,4,{bindingSerial:2,ranges:[[0,100,4]]});
 f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:1,source:0,frames:4,output:0}]);
 assert.equal(queue.count,256);
});

test('unbinding retains ordinary and alias until mapped buffered audio renders',()=>{
 const f=directWorklet();f.alias();f.enqueue(0,4,{bindingSerial:2,ranges:[[0,100,4]]});
 f.send({type:'capture-unbind',ownerSerial:1,bindingSerial:1});
 assert.equal(f.processor.positionCapture.slots[0].serial,1);
 f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:2,source:100,frames:4,output:0}]);
 assert.equal(f.processor.positionCapture.slots[0].serial,0);
 assert.equal(f.processor.positionCapture.slots[0].mappedSerial,0);
});

test('slot reuse does not accept old alias serial',()=>{
 const f=directWorklet();f.alias();f.send({type:'capture-unbind',ownerSerial:1,bindingSerial:1});
 f.send({type:'capture-bind',ownerSerial:1,slot:1,bindingSerial:3,streamId:12,sourceBase48:0});
 f.send({type:'enqueue',role:'current',streamId:12,sequence:0,frameCount:4,pcm:new Float32Array(8),capturePositions:{bindingSerial:2,ranges:[[0,100,4]]}});
 f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:3,source:0,frames:4,output:0}]);
});

test('pause and underrun never fabricate mapped frames',()=>{
 const f=directWorklet();f.alias();f.enqueue(0,2,{bindingSerial:2,ranges:[[0,100,2]]});
 f.render(4);assert.equal(f.runs().length,0);
 f.send({type:'play'});f.render(4);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:2,source:100,frames:2,output:4}]);
});

for(const prepared of [false,true]) test('retained loop copies verified ranges and local gaps, queued first '+prepared,()=>{
 const f=directWorklet();
 f.send({type:'capture-bind',ownerSerial:1,slot:2,bindingSerial:3,streamId:12,sourceBase48:0});
 f.send({type:'capture-bind',ownerSerial:1,slot:2,bindingSerial:4,streamId:12,sourceBase48:0,mapped:true,baseBindingSerial:3});
 f.enqueue(0,2);
 const enqueue=()=>f.enqueue(0,2,{bindingSerial:4,ranges:[[1,101,1]]},'continuity',12);
 if(prepared)enqueue();
 f.send({type:'set-loop',active:true,kind:'short-loop',startFrame:0,endFrame:2,retainedStreamId:12});
 if(!prepared)enqueue();
 f.send({type:'play'});f.render(6);f.send({type:'pause'});
 assert.deepEqual(f.runs().map(r=>[r.serial,r.source,r.frames]),[[1,0,2],[3,0,1],[4,101,1],[3,0,1],[4,101,1]]);
 assert.equal(f.runs().reduce((n,r)=>n+r.frames,0),6);
});

test('generation reset clears old mappings and rejects stale alias controls',()=>{
 const f=directWorklet();f.alias();f.enqueue(0,4,{bindingSerial:2,ranges:[[0,100,4]]});
 f.send({type:'seek-reset',generation:8,streamId:12,timelineStartFrame:200});
 f.send({type:'capture-bind',generation:8,ownerSerial:1,slot:2,bindingSerial:3,streamId:12,sourceBase48:0});
 f.send({type:'enqueue',generation:8,role:'current',streamId:12,sequence:0,frameCount:4,pcm:new Float32Array(8),capturePositions:{bindingSerial:2,ranges:[[0,100,4]]}});
 f.send({type:'play',generation:8});f.render(4);f.send({type:'pause',generation:8});
 assert.deepEqual(f.runs(),[{serial:3,source:0,frames:4,output:0}]);
});

test('actual engine, telemetry and worklet persist exactly local and mapped rendered runs',async()=>{
 const f=fixture(false),bodies=[];
 const c=vm.createContext({ArrayBuffer,Float64Array,Uint8Array,TextEncoder,AbortController});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/player-capture-telemetry.js'),'utf8')+'\nthis.api=PlaybackCaptureTelemetry;',c);
 const owner=c.api.createOwner({getContext:async()=>({ok:true,protocol:'app-rendered-position-v1',supported_protocols:['app-rendered-position-v2'],expected_scope:'v1:'+'a'.repeat(64),source_rate:48000,output_rate:48000}),
  postCheckpoint:body=>{bodies.push(JSON.parse(body));return new Promise(()=>{});},
  clock:{now:()=>0,utc:()=>1800000000000,setTimeout:()=>1,clearTimeout:()=>{}},
  crypto:{randomUUID:()=>OBSERVATION,subtle:{digest:async()=>new ArrayBuffer(32)}},generation:()=>7,
  sendCommand:message=>f.node.port.postMessage(message)});
 f.bridge.owner=owner;f.bridge.observationReady=true;assert.equal(await owner.enable(),true);
 f.role.startFrame=12;
 f.handleStreamingControl(metadata({requestedStartFrame:12,timelineStartFrame:12,captureSource:source({coordinateBasis:'decoded-output-local',requestedStart48:12})}));
 f.handleStreamingControl(mapping());f.handleStreamingPcm(pcm(4));flush(f,4);
 for(const packet of f.worklet.packets)owner.acceptPacket(packet.buffer);
 for(let n=0;n<8;n++)await new Promise(setImmediate);
 assert.equal(bodies.length,1);
 assert.deepEqual(bodies[0].evidence.runs.map(r=>[r.source_observation_ref,r.source_start48,r.frames]),
  [[OBSERVATION,0,1],[OTHER_OBSERVATION,100,2],[OBSERVATION,3,1]]);
 owner.onScopeLost();owner.onContextState('closed');
});

test('safe-integer source endpoint is accepted but overflow remains local',()=>{
 const f=directWorklet();f.alias();
 f.enqueue(0,2,{bindingSerial:2,ranges:[[0,Number.MAX_SAFE_INTEGER-2,2]]});
 f.enqueue(1,2,{bindingSerial:2,ranges:[[0,Number.MAX_SAFE_INTEGER-1,2]]});
 f.send({type:'play'});assert.deepEqual(f.render(4),[.25,.25,.25,.25]);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:2,source:Number.MAX_SAFE_INTEGER-2,frames:2,output:0},
   {serial:1,source:2,frames:2,output:2}]);
});

test('unsafe accumulated output index discards optional ranges without rejecting PCM',()=>{
 const f=directWorklet();f.alias();const ring=f.processor.current;
 ring.streamId=11;ring.receivedFrames=Number.MAX_SAFE_INTEGER-1;ring.captureSerial=1;ring.captureSource=0;
 f.enqueue(0,4,{bindingSerial:2,ranges:[[0,100,4]]});
 assert.equal(ring.captureRanges.count,0);assert.equal(ring.bufferedFrames,4);
 f.send({type:'play'});assert.deepEqual(f.render(4),[.25,.25,.25,.25]);f.send({type:'pause'});
 assert.deepEqual(f.runs(),[{serial:1,source:0,frames:4,output:0}]);
});

test('mapped credit loss reports one base-slot gap and retirement final ordinal',()=>{
 const f=directWorklet();f.alias();
 for(let n=0;n<4;n++){
  f.enqueue(n,1,{bindingSerial:2,ranges:[[0,100+n,1]]});
  f.send({type:'play'});f.render(1);f.send({type:'pause'});
 }
 assert.equal(f.packets.length,4);
 f.enqueue(4,1,{bindingSerial:2,ranges:[[0,104,1]]});
 f.send({type:'play'});f.render(1);f.send({type:'pause'});
 f.send({type:'capture-unbind',ownerSerial:1,bindingSerial:1});
 assert.equal(f.processor.positionCapture.slots[0].serial,1);
 f.send({type:'capture-credit',ownerSerial:1,bufferId:f.packets[0][12],buffer:f.packets[0].buffer.slice(0)});
 const last=f.packets.at(-1);
 assert.equal(last[8],1);assert.equal(last[32],1);assert.equal(last[36],1);
 assert.equal(last[9],1);assert.equal(last[96],1);assert.equal(last[98],5);
 assert.equal(f.processor.positionCapture.slots[0].serial,0);
 assert.equal(f.processor.positionCapture.slots[0].mappedSerial,0);
 assert.equal(f.runs().reduce((n,r)=>n+r.frames,0)+last[36],5);
});

test('retained slice with nonzero read index preserves its actual local base',()=>{
 const f=directWorklet();
 f.send({type:'capture-bind',ownerSerial:1,slot:2,bindingSerial:3,streamId:12,sourceBase48:0});
 f.send({type:'capture-bind',ownerSerial:1,slot:2,bindingSerial:4,streamId:12,sourceBase48:0,mapped:true,baseBindingSerial:3});
 f.enqueue(0,2);
 f.enqueue(0,3,{bindingSerial:4,ranges:[[0,100,1],[2,102,1]]},'continuity',12);
 // A consistent already-consumed prefix at this ring-owner boundary. The test
 // exercises genuine setLoop/copy/render, not an alternative range algorithm.
 const ring=f.processor.continuity;
 ring.readFrame=1;ring.bufferedFrames=2;ring.captureReadFrame=1;ring.captureSource=1;
 f.send({type:'set-loop',active:true,kind:'short-loop',startFrame:0,endFrame:2,retainedStreamId:12});
 f.send({type:'play'});f.render(6);f.send({type:'pause'});
 assert.deepEqual(f.runs().map(r=>[r.serial,r.source,r.frames]),[[1,0,2],[3,1,1],[4,102,1],[3,1,1],[4,102,1]]);
});

test('serialized Python producer wire renders through actual engine, telemetry and worklet',async()=>{
 const wire=JSON.parse(fs.readFileSync(path.join(__dirname,'producer-wire.json'),'utf8'));
 const f=fixture(false),bodies=[];
 const c=vm.createContext({ArrayBuffer,Float64Array,Uint8Array,TextEncoder,AbortController});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/player-capture-telemetry.js'),'utf8')+'\nthis.api=PlaybackCaptureTelemetry;',c);
 const owner=c.api.createOwner({getContext:async()=>({ok:true,protocol:'app-rendered-position-v1',supported_protocols:['app-rendered-position-v2'],expected_scope:'v1:'+'a'.repeat(64),source_rate:48000,output_rate:48000}),
  postCheckpoint:body=>{bodies.push(JSON.parse(body));return new Promise(()=>{});},
  clock:{now:()=>0,utc:()=>1800000000000,setTimeout:()=>1,clearTimeout:()=>{}},
  crypto:{randomUUID:()=>OBSERVATION,subtle:{digest:async()=>new ArrayBuffer(32)}},generation:()=>7,
  sendCommand:message=>f.node.port.postMessage(message)});
 f.bridge.owner=owner;f.bridge.observationReady=true;assert.equal(await owner.enable(),true);
 f.role.startFrame=wire.metadata.requestedStartFrame;
 f.handleStreamingControl(wire.metadata);f.handleStreamingControl(wire.control);
 const bytes=Uint8Array.from(Buffer.from(wire.pcm_hex,'hex'));
 f.handleStreamingPcm(bytes.buffer);
 // Decode/enqueue more PCM but do not render it: it must not enter listening evidence.
 f.handleStreamingPcm(pcm(8,{sequence:1}));flush(f,wire.control.frameCount);
 for(const packet of f.worklet.packets)owner.acceptPacket(packet.buffer);
 for(let n=0;n<8;n++)await new Promise(setImmediate);
 assert.equal(bodies.length,1);
 assert.deepEqual(bodies[0].evidence.runs.map(r=>[r.source_observation_ref,r.source_start48,r.frames]),
  [[wire.metadata.captureSource.observationId,0,2],[wire.control.observationId,12003,4],[wire.metadata.captureSource.observationId,6,2]]);
 console.log('PRODUCER_BRIDGE_CHECKPOINT='+JSON.stringify(bodies[0]));
 owner.onScopeLost();owner.onContextState('closed');
});
