const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const engineSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/player-streaming-engine.js'), 'utf8');
function fixture() {
  const events = [], node = {}, parent = {}, context = { sampleRate: 48000 };
  const engine = { generation: 7, node, context, roles: { current: null, continuity: null } };
  const sandbox = vm.createContext({ window: {}, state: { player: { streaming: engine } },
    getMeasuredPlaybackDeviceId: () => '11111111-1111-4111-8111-111111111111' });
  vm.runInContext(`${engineSource}\nthis.api = { bindStreamingCapture, retireStreamingCapture, prepareStreamingCapture, streamingCaptureOwners };`, sandbox);
  const bridge = { guard: () => true, owner: {
    bindTrack(value) { events.push(['parent', value]); return parent; },
    linkStream(handle, value) { events.push(['bind', handle, value]); return { slot: 1, bindingSerial: events.length }; },
    unlinkStream(value) { events.push(['unbind', value]); }, requestClose(handle, reason) { events.push(['close', handle, reason]); },
  } };
  sandbox.api.streamingCaptureOwners.set(node, bridge);
  return { ...sandbox.api, engine, events, parent, bridge, context, node };
}
function role(kind = null, path = '/fixture.flac') {
  return { generation: 7, streamId: 41, track: { path }, continuityOptions: kind ? { kind } : null };
}
const metadata = { sampleRate: 48000, timelineStartFrame: 123456 };

test('metadata bind uses its validated absolute source base and actual context rate', () => {
  const f = fixture(), current = role(); f.engine.roles.current = current;
  f.bindStreamingCapture(current, metadata);
  const bind = f.events.find(event => event[0] === 'bind');
  assert.equal(bind[2].sourceBase48, 123456);
  assert.equal(bind[2].outputRate, 48000);
  assert.equal(f.events[0][1].v1SessionId, null);
  f.bindStreamingCapture(current, metadata);
  assert.equal(f.events.filter(event => event[0] === 'bind').length, 1);
});
for (const kind of ['seek', 'short-loop', 'long-loop', 'whole-track-repeat']) {
  test(`${kind} stream shares the existing track occurrence parent`, () => {
    const f = fixture(), current = role(), next = role(kind);
    current.captureParent = f.parent; f.engine.roles.current = current;
    f.bindStreamingCapture(next, metadata);
    assert.equal(next.captureParent, f.parent);
    assert.equal(f.events.filter(event => event[0] === 'parent').length, 0);
  });
}
for (const kind of ['queued-next', 'replacement']) {
  test(`${kind} creates a new occurrence even for the same path`, () => {
    const f = fixture(), current = role(), next = role(kind === 'replacement' ? 'seek' : kind);
    if (kind === 'replacement') f.engine.pendingSeek = { kind: 'replacement', streamId: next.streamId };
    current.captureParent = {}; f.engine.roles.current = current;
    f.bindStreamingCapture(next, metadata);
    assert.equal(f.events.filter(event => event[0] === 'parent').length, 1);
    assert.notEqual(next.captureParent, current.captureParent);
  });
}
test('actual context-rate mismatch suppresses telemetry without changing playback role', () => {
  const f = fixture(), current = role(); f.context.sampleRate = 44100; f.engine.roles.current = current;
  f.bindStreamingCapture(current, metadata);
  assert.deepEqual(f.events, []);
  assert.equal(f.engine.roles.current, current);
  assert.equal(current.captureSkipped, true);
});
test('same-parent cutover retires binding without closing the parent', () => {
  const f = fixture(), current = role(), next = role('seek');
  current.captureParent = next.captureParent = f.parent; current.captureBinding = { slot: 1, bindingSerial: 1 };
  f.retireStreamingCapture(current, next);
  assert.equal(f.events.length, 1); assert.equal(f.events[0][0], 'unbind');
});
test('scope rejection stops binding before any path reaches capture transport', () => {
  const f = fixture(); f.bridge.guard = () => false;
  f.bindStreamingCapture(role(), metadata);
  assert.deepEqual(f.events, []);
});
test('temporary staged gate cannot create requests, timers or ports', () => {
  const f = fixture();
  assert.doesNotThrow(() => f.prepareStreamingCapture(f.engine, f.context, f.node));
  assert.deepEqual(f.events, []);
});

test('context-not-ready metadata is explicitly skipped and never retroactively bound after PCM', () => {
  const f = fixture(), current = role(); f.engine.roles.current = current;
  f.bridge.owner.bindTrack = () => null;
  f.bindStreamingCapture(current, metadata);
  assert.equal(current.captureSkipped, true);
  assert.equal(f.bridge.diagnostic, 'capture_binding_unavailable_before_pcm');
  f.bridge.owner.bindTrack = () => f.parent;
  f.bindStreamingCapture(current, metadata);
  assert.equal(f.events.length, 0);
  assert.equal(current.captureBinding, undefined);
});

test('401/403 response headers settle capture transport without reading an unsettled error body', async () => {
  for (const status of [401, 403]) {
    let transport, reads = 0;
    const scope = {}, node = { port: { postMessage() {} } };
    const context = { sampleRate: 48000, state: 'running', addEventListener() {}, removeEventListener() {} };
    const engine = { generation: 7, node, context };
    const sandbox = vm.createContext({
      AbortController,
      PLAYBACK_CAPTURE_ENABLED: true,
      PlaybackCaptureTelemetry: { createOwner(options) {
        transport = options;
        return { enable: async () => false, onScopeLost() {}, onContextState() {}, pagehide() {} };
      } },
      window: { crypto: {}, addEventListener() {}, removeEventListener() {} },
      state: { player: { streaming: engine } },
      capturePlaybackOwnershipScope: () => scope, isPlaybackOwnershipScopeCurrent: value => value === scope,
      fetch: async () => ({ status, json() { reads++; return new Promise(() => {}); } }),
    });
    vm.runInContext(`${engineSource}\nthis.prepare = prepareStreamingCapture;`, sandbox);
    sandbox.prepare(engine, context, node);
    const result = await transport.postCheckpoint('{}', 'scope', { signal: undefined, keepalive: false });
    assert.equal(result.status, status); assert.equal(result.data, null); assert.equal(reads, 0);
  }
});

test('early-click/restore preparation reuses one nonblocking context request and discards stale scope', async () => {
  let resolveFetch, calls = 0, capturedOptions, current = true;
  const scope = {}, pending = new Promise(resolve => { resolveFetch = resolve; });
  const node = { port: { postMessage() {} } }, context = {
    sampleRate: 48000, state: 'running', addEventListener() {}, removeEventListener() {},
  };
  const engine = { generation: 7, context, node };
  const sandbox = vm.createContext({
    AbortController, PLAYBACK_CAPTURE_ENABLED: true,
    PlaybackCaptureTelemetry: { createOwner(options) {
      capturedOptions = options;
      return { enable: async () => false, onScopeLost() {}, onContextState() {}, pagehide() {} };
    } },
    window: { crypto: {}, addEventListener() {}, removeEventListener() {} },
    state: { player: { streaming: engine } }, capturePlaybackOwnershipScope: () => scope,
    isPlaybackOwnershipScopeCurrent: value => current && value === scope,
    fetch: () => { calls++; return pending; },
  });
  vm.runInContext(`${engineSource}\nthis.begin = beginStreamingCaptureContext; this.prepare = prepareStreamingCapture;`, sandbox);
  const prefetched = sandbox.begin(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(sandbox.prepare(engine, context, node, prefetched), undefined,
    'preparation never waits for the context endpoint');
  const consumed = capturedOptions.getContext();
  resolveFetch({ ok: true, json: async () => ({ ok: true, protocol: 'app-rendered-position-v1' }) });
  assert.equal((await consumed).ok, true); assert.equal(calls, 1);
  current = false;
  await assert.rejects(capturedOptions.getContext(), /scope retired/);
  prefetched.discard();
});
