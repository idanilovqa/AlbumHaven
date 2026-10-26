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

function workletFixture() {
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
  send({ type: 'capture-enable', ownerSerial: 1, sourceRate: 48000, outputRate: 48000,
    packetVersion: 2, buffers: Array.from({ length: 4 }, () => new ArrayBuffer(16384)) });
  return {
    send, messages, packets,
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
        return { source: packet[offset + 2], frames: packet[offset + 3], output: packet[offset + 4] };
      }));
    },
  };
}

function fixture() {
  const worklet = workletFixture(), events = [], controls = [];
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
      const binding = { slot: ++serial, bindingSerial: serial, ...value };
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

test('ordinary metadata binds source zero before any PCM, never the duration estimate', () => {
  const f = fixture();
  f.handleStreamingControl(metadata());
  assert.equal(links(f).length, 1);
  assert.equal(links(f)[0].value.sourceBase48, 0);
  assert.equal(links(f)[0].value.generation, 7);
  assert.equal(links(f)[0].value.streamId, 11);
  assert.equal(f.role.captureReceivedFrames, 0);
  assert.equal(f.role.captureSource.extentFrames48, null);
  assert.equal(Object.isFrozen(f.role.captureSource), true);
  f.handleStreamingPcm(pcm(4));
  assert.ok(f.events.findIndex(event => event.type === 'capture-bind')
    < f.events.findIndex(event => event.type === 'enqueue'));
  assert.equal(f.role.captureReceivedFrames, 4);
  assert.equal(f.role.captureSource.extentFrames48, null);
});

for (const [name, patch] of [
  ['missing', null], ['unknown basis', source({ coordinateBasis: 'unknown' })],
  ['forged version', source({ version: 'catalog-duration-v1' })],
  ['display-timeline base', source({ sourceBase48: 123456 })],
  ['preclaimed extent', source({ extentFrames48: 43_200_000 })],
  ['missing extent', { version: 'decoded-pcm-observation-v1', observationId: OBSERVATION,
    coordinateBasis: 'decoded-output-zero', sourceBase48: 0 }],
  ['non-UUID ID', source({ observationId: 'track-path-or-catalog-id' })],
  ['non-v4 ID', source({ observationId: '11111111-1111-1111-8111-111111111111' })],
]) {
  test(name + ' capture metadata is skipped without blocking ordinary PCM', () => {
    const f = fixture();
    f.handleStreamingControl(metadata({ captureSource: patch }));
    assert.equal(links(f).length, 0);
    assert.equal(f.role.captureSkipped, true);
    f.handleStreamingPcm(pcm(2));
    assert.equal(f.role.nextSequence, 1);
    assert.equal(f.engine.diagnostics.pcmEvidence.frames, 2);
    assert.equal(f.role.captureSource, undefined);
    f.worklet.send({ type: 'play' });
    assert.deepEqual(f.worklet.render(2), [0.25, 0.25]);
    f.worklet.send({ type: 'pause' });
    assert.deepEqual(f.worklet.runs(), []);
  });
}

test('nonzero seek cannot turn its display timeline into a capture base', () => {
  const f = fixture(); f.role.startFrame = 48000;
  f.handleStreamingControl(metadata({ requestedStartFrame: 48000, timelineStartFrame: 48000 }));
  assert.equal(f.role.metadataAccepted, true);
  assert.equal(f.role.captureSkipped, true);
  assert.equal(links(f).length, 0);
  f.handleStreamingPcm(pcm(2));
  assert.equal(f.engine.diagnostics.pcmEvidence.frames, 2);
});

test('actual output rate mismatch suppresses capture without replacing the playback role', () => {
  const f = fixture(); f.engine.context.sampleRate = 44100;
  f.handleStreamingControl(metadata());
  assert.equal(links(f).length, 0);
  assert.equal(f.role.captureSkipped, true);
  assert.equal(f.engine.roles.current, f.role);
  assert.equal(f.role.metadataAccepted, true);
});

test('stale generation and unowned stream controls never bind or complete another observation', () => {
  const f = fixture();
  f.handleStreamingControl(metadata({ generation: 6 }));
  f.handleStreamingControl(metadata({ streamId: 12 }));
  assert.equal(links(f).length, 0);
  assert.equal(f.role.metadataAccepted, false);
  f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2));
  const pending = f.role.captureSource;
  f.handleStreamingControl(eof(2, { generation: 6 }));
  f.handleStreamingControl(eof(2, { streamId: 12 }));
  assert.equal(f.role.captureSource, pending);
  assert.equal(f.role.eosReceived, undefined);
  assert.equal(f.engine.diagnostics.staleMessages, 4);
});

test('context not ready at metadata is never bound retroactively after PCM', () => {
  const f = fixture(); f.bridge.owner.bindTrack = () => null;
  f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2));
  f.bridge.owner.bindTrack = () => f.parent;
  f.handleStreamingControl(metadata());
  assert.equal(links(f).length, 0);
  assert.equal(f.role.captureSkipped, true);
  assert.equal(f.role.captureSource, undefined);
});

test('late installation of capture owner cannot adopt previously accepted PCM', () => {
  const f = fixture(); f.streamingCaptureOwners.delete(f.node);
  f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2));
  f.streamingCaptureOwners.set(f.node, f.bridge);
  f.handleStreamingControl(metadata());
  assert.equal(links(f).length, 0);
  assert.equal(f.role.captureSkipped, true);
});

test('replayed metadata and PCM do not reset or inflate the accepted-frame count', () => {
  const f = fixture(); f.handleStreamingControl(metadata());
  f.handleStreamingPcm(pcm(2));
  f.handleStreamingControl(metadata({ captureSource: source({ observationId: OTHER_OBSERVATION }) }));
  f.handleStreamingPcm(pcm(2));
  f.handleStreamingPcm(pcm(8, { generation: 6, sequence: 1 }));
  f.handleStreamingPcm(pcm(8, { streamId: 12, sequence: 1 }));
  f.handleStreamingPcm(pcm(3, { sequence: 1 }));
  assert.equal(links(f).length, 1);
  assert.equal(f.role.captureSource.observationId, OBSERVATION);
  assert.equal(f.role.captureReceivedFrames, 5);
  assert.equal(f.role.nextSequence, 2);
  f.handleStreamingControl(eof(5));
  assert.equal(f.role.captureSource.extentFrames48, 5);
  const completed = f.role.captureSource;
  f.handleStreamingControl(eof(43_200_000));
  assert.equal(f.role.captureSource, completed);
  assert.equal(f.events.filter(event => event.type === 'eos').length, 1);
});

for (const [name, changes] of [
  ['missing source', { captureSource: null }],
  ['other observation', { captureSource: source({ observationId: OTHER_OBSERVATION, extentFrames48: 2 }) }],
  ['other basis', { captureSource: source({ coordinateBasis: 'unknown', extentFrames48: 2 }) }],
  ['other base', { captureSource: source({ sourceBase48: 1, extentFrames48: 2 }) }],
  ['provisional duration', { captureSource: source({ extentFrames48: 43_200_000 }) }],
  ['fractional extent', { captureSource: source({ extentFrames48: 2.5 }) }],
  ['unsafe extent', { captureSource: source({ extentFrames48: Number.MAX_SAFE_INTEGER + 1 }) }],
  ['wrong authoritative total', { authoritativeTotalFrames: 3 }],
  ['missing accepted PCM', { emittedFrames: 3, authoritativeTotalFrames: 3,
    captureSource: source({ extentFrames48: 3 }) }],
]) {
  test(name + ' EOF clears the local source observation but does not invent rendered evidence', () => {
    const f = fixture(); f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2));
    f.handleStreamingControl(eof(2, changes));
    assert.equal(f.role.eosReceived, true);
    assert.equal(f.role.captureSource, null);
    assert.equal(f.bridge.diagnostic, 'capture_extent_unavailable');
    assert.equal(f.engine.diagnostics.renderedPcmEvidence.frames, 0);
    assert.deepEqual(f.worklet.runs(), []);
  });
}

test('exact EOF extent stays distinct from actual rendered source spans', () => {
  const f = fixture(); f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(4));
  f.handleStreamingControl(eof(4));
  assert.equal(f.role.captureSource.extentFrames48, 4);
  assert.equal(f.engine.diagnostics.pcmEvidence.frames, 4);
  assert.equal(f.engine.diagnostics.renderedPcmEvidence.frames, 0);
  assert.deepEqual(f.worklet.runs(), []);
  f.worklet.send({ type: 'play' });
  assert.deepEqual(f.worklet.render(2), [0.25, 0.25]);
  for (const message of f.worklet.messages) {
    if (message.type === 'consumed') f.handleStreamingWorkletMessage(message);
  }
  f.worklet.send({ type: 'pause' });
  assert.deepEqual(f.worklet.runs(), [{ source: 0, frames: 2, output: 0 }]);
  assert.equal(f.engine.diagnostics.renderedPcmEvidence.frames, 2);
  assert.equal(f.role.captureSource.extentFrames48, 4, 'decoded extent is not a heard-frame count');
});

for (const missing of [false, true]) {
  test((missing ? 'missing owner' : 'lost scope') + ' clears the local EOF observation', () => {
    const f = fixture(); f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2));
    if (missing) f.streamingCaptureOwners.delete(f.node);
    else f.bridge.guard = () => false;
    f.handleStreamingControl(eof(2));
    assert.equal(f.role.captureSource, null);
    assert.equal(f.engine.diagnostics.renderedPcmEvidence.frames, 0);
  });
  test((missing ? 'missing owner' : 'lost scope') + ' retirement clears the detached local source', () => {
    const f = fixture(); f.handleStreamingControl(metadata());
    if (missing) f.streamingCaptureOwners.delete(f.node);
    else f.bridge.guard = () => false;
    f.retireStreamingCapture(f.role);
    assert.equal(f.role.captureSource, null);
    assert.equal(f.events.filter(event => event.type === 'close-parent').length, 0);
  });
}

test('same-parent retirement unlinks only the source and cannot rebind retired metadata', () => {
  const f = fixture(); f.handleStreamingControl(metadata());
  const successor = { captureParent: f.role.captureParent };
  f.retireStreamingCapture(f.role, successor);
  assert.equal(f.role.captureSource, null);
  assert.equal(f.events.filter(event => event.type === 'unlink').length, 1);
  assert.equal(f.events.filter(event => event.type === 'close-parent').length, 0);
  f.bindStreamingCapture(f.role, metadata());
  assert.equal(links(f).length, 1);
  assert.equal(f.role.captureSource, null);
});

test('real owner scope guard invalidates an already completed EOF observation', () => {
  const f = fixture(), scope = installActualScopeGuard(f);
  f.handleStreamingControl(metadata()); f.handleStreamingPcm(pcm(2)); f.handleStreamingControl(eof(2));
  assert.equal(f.role.captureSource.extentFrames48, 2);
  const continuity = { captureSource: Object.freeze(source()) };
  f.engine.roles.continuity = continuity;
  scope.loseScope();
  assert.equal(scope.bridge.guard(), false);
  assert.equal(f.role.captureSource, null);
  assert.equal(continuity.captureSource, null);
  assert.equal(f.events.filter(event => event.type === 'scope-lost').length, 1);
});

test('old owner scope guard cannot clear the successor node observation', () => {
  const f = fixture(), scope = installActualScopeGuard(f);
  f.handleStreamingControl(metadata());
  const successorSource = Object.freeze(source({ observationId: OTHER_OBSERVATION }));
  const successor = { captureSource: successorSource };
  f.engine.node = { port: { postMessage() {} } };
  f.engine.roles.current = successor;
  scope.loseScope();
  assert.equal(scope.bridge.guard(), false);
  assert.equal(successor.captureSource, successorSource);
});

test('cleanup invalidates detached role snapshots even after the owner map is absent', async () => {
  const f = fixture(); f.handleStreamingControl(metadata());
  const outcome = {};
  f.engine.roles.current = null;
  await f.cleanupStreamingResources({ reason: 'stopped', roles: [f.role],
    node: null, socket: null, context: null, generation: 7,
    preparation: null, options: {}, outcome });
  assert.equal(f.role.captureSource, null);
  assert.equal(outcome.completed, true);
});


// Whole genuine Album owner plus the existing genuine engine/worklet fixture.
// Only HTTP and browser ownership facts are platform boundaries here.
function ordinaryAlbumIntent(f) {
  // This suite keeps its declared telemetry spy; actual negotiation is tested
  // with the genuine telemetry owner in player-position-transport.test.js.
  f.bridge.positionReady=true;f.bridge.selectionReady=true;
  let reply,current=true;const calls=[];
  Object.assign(f.sandbox,{PLAYBACK_CAPTURE_ENABLED:true,AbortController,
    document:{getElementById:()=>({dataset:{listeningSelectionsEnabled:"true"}})},
    setTimeout:()=>1,clearTimeout:()=>{},capturePlaybackOwnershipScope:()=>({}),
    isPlaybackOwnershipScopeCurrent:()=>current,
    PrivateUITransport:{request:(path,options)=>{calls.push({path,options});return new Promise(resolve=>{reply=resolve;});}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'),'utf8'),f.sandbox);
  const intent=f.sandbox.createAlbumListeningIntent({key:'ordinary-album'});
  f.sandbox.bindAlbumListeningIntent(f.role.track,intent);
  return {intent,calls,resolve:()=>reply({listening_selection:{version:'local-edition-selection-v1',
    selection_ref:OTHER_OBSERVATION,membership_revision:'a'.repeat(64)}}),retire:()=>{current=false;}};
}
const settleAlbumIntent=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};

test('delayed optional Album selection never waits for or interrupts real PCM rendering',async()=>{
  const f=fixture(),selection=ordinaryAlbumIntent(f);
  assert.equal(f.sandbox.beginOrdinaryAlbumListening(f.role.track,()=>true),undefined);
  assert.equal(selection.calls.length,1);assert.equal(selection.calls[0].options.method,'POST');
  f.handleStreamingControl(metadata());f.handleStreamingPcm(pcm(2));
  assert.equal(f.events.find(event=>event.type==='parent').value.editionSelectionRef,null);
  f.worklet.send({type:'play'});
  assert.deepEqual(f.worklet.render(2),[0.25,0.25]);
  selection.resolve();await settleAlbumIntent();
  assert.equal(f.role.captureEditionSelectionRef,null,'admitted role is not retroactively changed');
  assert.equal(f.events.filter(event=>event.type==='parent').length,1);
});

test('fast optional Album response qualifies the genuine first-track metadata bind',async()=>{
  const f=fixture(),selection=ordinaryAlbumIntent(f);
  f.sandbox.beginOrdinaryAlbumListening(f.role.track,()=>true);
  selection.resolve();await settleAlbumIntent();f.handleStreamingControl(metadata());
  const binding=f.events.find(event=>event.type==='parent').value;
  assert.equal(binding.editionSelectionRef,OTHER_OBSERVATION);
  assert.equal(f.role.captureEditionSelectionRef,OTHER_OBSERVATION);
});

test('retired Album scope cannot attach a late optional response or start another role',async()=>{
  const f=fixture(),selection=ordinaryAlbumIntent(f);
  f.sandbox.beginOrdinaryAlbumListening(f.role.track,()=>true);
  selection.retire();selection.resolve();await settleAlbumIntent();
  assert.equal(selection.intent.ready(),null);
  assert.equal(f.events.filter(event=>event.type==='parent').length,0);
  assert.equal(f.controls.length,0);
});


test('actual start intent starts optional selection without awaiting its unresolved response',async()=>{
  const f=fixture(),intent=ordinaryAlbumIntent(f);let release;
  f.engine.stopPromise=new Promise(resolve=>{release=resolve;});
  const pending=f.sandbox.startStreamingTrack(f.role.track);
  assert.equal(intent.calls.length,1);
  // Retire while the pre-existing physical cleanup barrier is pending.
  f.engine.startRequestId++;release();assert.equal(await pending,null);
  intent.resolve();await settleAlbumIntent();
  assert.equal(f.sandbox.settledOrdinaryAlbumListeningSelection(f.role.track),null);
});

test('stale actual continuity intent cannot overwrite pending state or close a live role',async()=>{
  const f=fixture();const retained={marker:'pending'},live={marker:'live'};
  f.engine.pendingContinuityTrack=retained;f.engine.roles.continuity=live;
  f.engine.pendingPromotion={kind:'existing'};
  const before=f.events.length;
  assert.equal(await f.sandbox.scheduleStreamingContinuity({path:'/other'},{isCurrent:()=>false}),null);
  assert.equal(f.engine.pendingContinuityTrack,retained);assert.equal(f.engine.roles.continuity,live);
  assert.equal(f.events.length,before);
});

test('actual resume does not wait for optional album selection',async()=>{
  const f=fixture(),intent=ordinaryAlbumIntent(f);let resumes=0;
  Object.assign(f.engine.context,{state:'running',resume:async()=>{resumes++;}});
  // Already playing returns immediately after the real AudioContext resume.
  assert.equal(await f.sandbox.resumeStreamingPlayback(),true);
  assert.equal(resumes,1);assert.equal(intent.calls.length,1);
  assert.equal(f.sandbox.settledOrdinaryAlbumListeningSelection(f.role.track),null);
});

for(const capturedRef of [null,OTHER_OBSERVATION])test('same Album intent repeat retains original parent when first seal chose '+String(capturedRef),async()=>{
  const f=fixture(),intent=ordinaryAlbumIntent(f);
  f.sandbox.beginOrdinaryAlbumListening(f.role.track,()=>true);
  f.handleStreamingControl(metadata());
  intent.resolve();await settleAlbumIntent();
  f.bridge.owner.selectionRefFor=handle=>{assert.equal(handle,f.parent);return capturedRef;};
  const incoming={generation:7,streamId:12,role:'continuity',startFrame:0,nextSequence:0,
    track:f.role.track,backingCapacityFrames:64,targetBufferFrames:64,
    continuityOptions:{kind:'whole-track-repeat'}};
  f.engine.roles.continuity=incoming;f.resetStreamingPcmEvidence(incoming);
  f.bindStreamingCapture(incoming,metadata({streamId:12,role:'continuity'}));
  assert.equal(incoming.captureParent,f.parent);
  assert.equal(incoming.captureEditionSelectionRef,capturedRef);
  assert.equal(f.events.filter(event=>event.type==='parent').length,1);
});

for(const ready of [false,true])test('actual source binding carries optional durable observation only when context admitted '+ready,()=>{
  const f=fixture();f.bridge.observationReady=ready;
  f.handleStreamingControl(metadata());
  const link=f.events.find(event=>event.type==='link');assert.ok(link);
  assert.equal(link.value.sourceObservationRef,ready?OBSERVATION:undefined);
});

function localSource(start = 48000, changes = {}) {
  return source({ coordinateBasis: 'decoded-output-local', requestedStart48: start, ...changes });
}
function localFixture(start = 48000) {
  const f = fixture(); f.role.startFrame = start; f.bridge.observationReady = true;
  return f;
}
function localMetadata(start = 48000, changes = {}) {
  return metadata({ requestedStartFrame: start, timelineStartFrame: start,
    captureSource: localSource(start), ...changes });
}

test('admitted nonzero decoder local zero records only actual rendering, never requested offset', () => {
  const f = localFixture(); f.handleStreamingControl(localMetadata());
  assert.equal(links(f).length, 1);
  assert.equal(links(f)[0].value.sourceBase48, 0);
  assert.equal(links(f)[0].value.sourceObservationRef, OBSERVATION);
  f.handleStreamingPcm(pcm(4));
  f.handleStreamingControl(eof(4, { authoritativeTotalFrames: 48004,
    captureSource: localSource(48000, { extentFrames48: 4 }) }));
  assert.equal(f.role.captureSource.coordinateBasis, 'decoded-output-local');
  assert.equal(f.role.captureSource.extentFrames48, 4);
  assert.deepEqual(f.worklet.runs(), []);
  f.worklet.send({ type: 'play' });
  assert.deepEqual(f.worklet.render(2), [0.25, 0.25]);
  f.worklet.send({ type: 'pause' });
  assert.deepEqual(f.worklet.runs(), [{ source: 0, frames: 2, output: 0 }]);
});

for (const [name, setup, update] of [
  ['storage absent', f => { f.bridge.observationReady = false; }, {}],
  ['request mismatch', () => {}, { captureSource: localSource(48001) }],
  ['unproved offset', () => {}, { captureSource: localSource(48000, { sourceBase48: 48000 }) }],
  ['local at zero', f => { f.role.startFrame = 0; }, localMetadata(0)],
  ['missing request', () => {}, { captureSource: source({ coordinateBasis: 'decoded-output-local' }) }],
]) test('nonzero capture rejects ' + name + ' while retaining ordinary audio', () => {
  const f = localFixture(); setup(f); f.handleStreamingControl(localMetadata(48000, update));
  assert.equal(links(f).length, 0);
  f.handleStreamingPcm(pcm(2)); f.worklet.send({ type: 'play' });
  assert.deepEqual(f.worklet.render(2), [0.25, 0.25]);
  f.worklet.send({ type: 'pause' }); assert.deepEqual(f.worklet.runs(), []);
});

test('local EOF cannot upgrade itself to absolute zero or a different seek', () => {
  for (const value of [source({ extentFrames48: 2 }), localSource(96000, { extentFrames48: 2 })]) {
    const f = localFixture(); f.handleStreamingControl(localMetadata()); f.handleStreamingPcm(pcm(2));
    f.handleStreamingControl(eof(2, { authoritativeTotalFrames: 48002, captureSource: value }));
    assert.equal(f.role.captureSource, null);
    assert.equal(f.bridge.diagnostic, 'capture_extent_unavailable');
  }
});

test('local observations never survive old generation replay or an account guard loss', () => {
  const g = localFixture(); g.handleStreamingControl(localMetadata());
  g.handleStreamingControl(localMetadata(48000, { generation: 6 }));
  assert.equal(links(g).length, 1);
  g.bridge.guard = () => false;
  g.handleStreamingControl(eof(2, { authoritativeTotalFrames: 48002,
    captureSource: localSource(48000, { extentFrames48: 2 }) }));
  assert.equal(g.role.captureSource, null);
});
