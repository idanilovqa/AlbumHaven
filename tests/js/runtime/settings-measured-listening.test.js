const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('music_app/static/js/runtime/player-listen-session-helpers.js', 'utf8');
function setup(overrides = {}) {
  const storage = new Map(), requests = [], beacons = [];
  const context = { crypto, Blob, console, Date,
    state: { player: { current: {path: '/owned/a', title: 'A', artist: 'Artist'}, listenSession: null } },
    isoNow: () => '2026-09-09T12:00:00Z', unixNowSeconds: () => 1788955200,
    getPlayerPlaybackSnapshot: () => ({currentTime: 5, duration: 200}),
    getLocalStorageItem: key => storage.get(key), setLocalStorageItem: (key,value) => storage.set(key,value),
    fetch: async (url, options) => { requests.push({url, payload: JSON.parse(options.body)}); return {ok:true,json:async()=>({ok:true})}; },
    navigator: {sendBeacon: (url,body) => {beacons.push({url,body});return true;}},
  };
  Object.assign(context, overrides);
  vm.createContext(context); vm.runInContext(source, context);
  context.startListenSession(context.state.player.current);
  return {c:context, requests, beacons};
}
const role = (kind='current',path='/owned/a') => ({role:kind,track:{path,title:path,artist:'Artist'},generation:1,streamId:kind==='current'?1:2,continuityOptions:kind==='continuity'?{kind:'queued-next'}:null});

test('rendered frames measure real duration including silence, independent of media seek distance and speed', () => {
  const {c} = setup(), stream = role();
  c.recordMeasuredStreamingFrames(stream, {frames:480000,audible:false},48000);
  c.recordMeasuredStreamingFrames(stream, {frames:240000,audible:true},48000);
  const measured = c.buildMeasuredCompletionFields(c.state.player.listenSession);
  assert.equal(measured.measured_listened_seconds,15);
  assert.equal(measured.max_measured_contiguous_seconds,15);
  assert.equal(measured.measurement_version,'rendered-pcm-v1');
  assert.equal(c.totalListenedSeconds(c.state.player.listenSession),0);
  assert.equal(c.shouldPersistListenSession(c.state.player.listenSession),true);
});

test('pause, seek and underrun break contiguous measurement without erasing cumulative frames', () => {
  const {c}=setup(), stream=role();
  c.recordMeasuredStreamingFrames(stream,{frames:384000},48000);
  c.closeListenSegment(0);
  c.recordMeasuredStreamingFrames(stream,{frames:288000},48000);
  c.breakMeasuredListenSegment(c.state.player.listenSession);
  c.recordMeasuredStreamingFrames(stream,{frames:0},48000);
  const fields=c.buildMeasuredCompletionFields(c.state.player.listenSession);
  assert.equal(fields.measured_listened_seconds,14);
  assert.equal(fields.max_measured_contiguous_seconds,8);
});

test('queued incoming frames belong to their own session before promotion; loop and seek roles retain the current session', () => {
  const {c}=setup(), current=role(), incoming=role('continuity','/owned/b');
  c.recordMeasuredStreamingFrames(current,{frames:480000},48000);
  c.recordMeasuredStreamingFrames(incoming,{frames:24000},48000);
  assert.notEqual(incoming.measuredListenSession,current.measuredListenSession);
  assert.equal(c.buildMeasuredCompletionFields(current.measuredListenSession).measured_listened_seconds,10);
  assert.equal(c.buildMeasuredCompletionFields(incoming.measuredListenSession).measured_listened_seconds,.5);
  const loop={...role('continuity'),streamId:3,continuityOptions:{kind:'whole-track-repeat'}};
  c.recordMeasuredStreamingFrames(loop,{frames:48000},48000);
  assert.equal(loop.measuredListenSession,current.measuredListenSession);
  assert.equal(c.buildMeasuredCompletionFields(current.measuredListenSession).measured_listened_seconds,11);
});

test('retired stream binding cannot credit a later session, and unrendered prefetch creates no measured play', () => {
  const {c}=setup(), old=role();
  c.recordMeasuredStreamingFrames(old,{frames:48000},48000);
  const first=old.measuredListenSession; first.completionState='done';
  c.startListenSession(c.state.player.current);
  c.recordMeasuredStreamingFrames(old,{frames:48000},48000);
  assert.equal(c.buildMeasuredCompletionFields(c.state.player.listenSession).measured_listened_seconds,0);
  assert.equal(c.buildMeasuredCompletionFields(first).measured_listened_seconds,1);
  const pending=role('continuity','/owned/b');
  c.recordMeasuredStreamingFrames(pending,{frames:0},48000);
  assert.equal(pending.measuredListenSession,undefined);
});

test('completion and unload carry stable device/session identity and measured-only qualifying plays', async () => {
  const {c,requests,beacons}=setup(), stream=role();
  c.recordMeasuredStreamingFrames(stream,{frames:576000},48000);
  const session=c.state.player.listenSession;
  await c.finalizeListenSession('stopped');
  const first=requests.find(item=>item.url.endsWith('/complete')).payload;
  assert.equal(first.measured_listened_seconds,12);
  assert.match(first.session_id,/^[0-9a-f-]{36}$/i);
  assert.equal(first.sequence,1);
  assert.equal(first.total_listened_seconds,0);
  session.completionState='failed';
  await c.finalizeListenSession('stopped',{session});
  assert.equal(requests[1].payload.session_id,first.session_id);
  assert.equal(requests[1].payload.sequence,first.sequence);
  c.startListenSession(c.state.player.current);
  c.recordMeasuredStreamingFrames(role(),{frames:624000},48000);
  assert.equal(c.flushListenSessionOnUnload(),true);
  const unloaded=JSON.parse(await beacons[0].body.text());
  assert.equal(unloaded.device_id,first.device_id);
  assert.notEqual(unloaded.session_id,first.session_id);
  assert.equal(unloaded.measured_listened_seconds,13);
});

test('a long pause starts a new measurement even when the streaming role is reused', async () => {
  const {c}=setup(), stream=role();
  c.recordMeasuredStreamingFrames(stream,{frames:576000},48000);
  const previous=c.state.player.listenSession;
  previous.paused_at_unix_ms=Date.now()-3600001;
  previous.paused_at='2026-09-09T12:00:12Z';
  c.state.player.streaming={roles:{current:stream,continuity:null}};
  await c.resumeListenSessionPlayback(c.state.player.current,5);
  assert.notEqual(c.state.player.listenSession,previous);
  c.recordMeasuredStreamingFrames(stream,{frames:48000},48000);
  assert.equal(c.state.player.listenSession.measurement.total,1);
  assert.equal(previous.measurement.total,12);
});

test('immediate scrobble and completion advance snapshots while retries retain the same final payload', async () => {
  const {c,requests}=setup(), stream=role();
  const session=c.state.player.listenSession;
  session.duration_seconds=200;
  session.segments=[{start_seconds:0,end_seconds:120}];
  c.recordMeasuredStreamingFrames(stream,{frames:5760000},48000);
  assert.equal(await c.maybeScrobbleListenSession(session),true);
  c.recordMeasuredStreamingFrames(stream,{frames:48000},48000);
  await c.finalizeListenSession('stopped');
  assert.equal(requests[0].payload.sequence,1);
  assert.equal(requests[0].payload.finalized,false);
  assert.equal(requests[1].payload.sequence,2);
  assert.equal(requests[1].payload.finalized,true);
  assert.equal(requests[1].payload.measured_listened_seconds,121);
  session.completionState='failed';
  await c.finalizeListenSession('stopped',{session});
  assert.deepEqual(requests[2].payload,requests[1].payload);
});

test('measured unload delegates scrobble receipt handling to its one completion request', () => {
  const {c,beacons}=setup(), session=c.state.player.listenSession;
  session.duration_seconds=200;
  session.segments=[{start_seconds:0,end_seconds:120}];
  c.recordMeasuredStreamingFrames(role(),{frames:5760000},48000);
  c.flushListenSessionOnUnload();
  assert.equal(beacons.length,1);
  assert.equal(beacons[0].url,'/playback/session/complete');
});

test('web contexts without randomUUID use secure random bytes for measured identity', () => {
  const {c}=setup({crypto:{getRandomValues:bytes=>crypto.webcrypto.getRandomValues(bytes)}});
  const fields=c.buildMeasuredCompletionFields(c.state.player.listenSession);
  assert.match(fields.session_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('promoted queued roles bind the active session even without any pre-boundary frames', () => {
  const {c}=setup(), promoted={...role(),continuityOptions:{kind:'queued-next'}};
  c.recordMeasuredStreamingFrames(promoted,{frames:48000},48000);
  assert.equal(promoted.measuredListenSession,c.state.player.listenSession);
  assert.equal(c.state.player.listenSession.measurement.total,1);
});

test('long-pause resume rebinds a promoted current role with historical queued-next options', async () => {
  const {c}=setup(), stream=role();
  c.recordMeasuredStreamingFrames(stream,{frames:576000},48000);
  stream.continuityOptions={kind:'queued-next'};
  const previous=c.state.player.listenSession;
  previous.paused_at_unix_ms=Date.now()-3600001;
  previous.paused_at='2026-09-09T12:00:12Z';
  c.state.player.streaming={roles:{current:stream,continuity:null}};
  await c.resumeListenSessionPlayback(c.state.player.current,5);
  c.recordMeasuredStreamingFrames(stream,{frames:48000},48000);
  assert.equal(c.state.player.listenSession.measurement.total,1);
  assert.equal(previous.measurement.total,12);
});
