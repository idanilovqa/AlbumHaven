// The browser listen session must produce exactly the listen writes recorded in
// tests/fixtures/listen-sessions-v1.json; Android's ListenSessions.kt is held to the same file
// (ListenSessionsParityTest.kt), so the APK's background writes match the browser's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'listen-sessions-v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const EFFECTS = {
  '/playback/session/now-playing': 'now-playing',
  '/playback/session/scrobble': 'scrobble',
  '/playback/session/complete': 'complete',
};
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
};

function createBrowserPlayer() {
  const writes = [];
  const failures = [];
  let now = fixture.startEpochMs;
  let owner = true;
  let ids = 0;
  const snapshot = { currentTime: 0, duration: 0, paused: true, ended: false, src: '', mode: 'stopped' };
  const queue = { next: null };
  const context = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, setImmediate, AbortController, URL, Blob,
    window: { addEventListener() {}, crypto: require('node:crypto') },
    document: { querySelectorAll: () => [], addEventListener() {} },
    navigator: {},
    state: {
      player: {
        current: null, listenSession: null, loopActive: false, loopStart: 0, loopEnd: 30,
        waveform: { renderToken: 0 }, streaming: { generation: 1 },
      },
      utility: {},
    },
    getPlayerPlaybackSnapshot: () => ({ ...snapshot }),
    getPlayerElements: () => ({}),
    updatePlayerUi() {},
    persistPlayerState() {},
    clearWaveformCanvas() {},
    showToast() {},
    resolveAlbumForPlayerTrack: () => null,
    loopEditSessionExpiryController: { stop() {}, noteUntouchedWholeRangeWrap() {} },
    pauseStreamingPlayback: async () => { snapshot.paused = true; },
    seekStreamingPlayback: async seconds => { snapshot.currentTime = seconds; },
    stopStreamingPlayback: async () => {},
    getNextQueuedTrack: () => queue.next,
    peekNextQueuedTrack: () => null,
    fetch: async (url, init) => {
      const effect = EFFECTS[url];
      const failed = failures.includes(effect);
      if (failed) failures.splice(failures.indexOf(effect), 1);
      writes.push({ effect, body: JSON.parse(init.body) });
      return { ok: !failed, json: async () => (failed ? { ok: false, error: 'refused' } : { ok: true }) };
    },
  };
  vm.createContext(context);
  for (const file of ['player-loop-playback.js', 'player-listen-session-helpers.js', 'playback-ownership-helpers.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), context, { filename: file });
  }
  Object.assign(context, {
    // Rendering is not part of the listen contract.
    updatePlayerUi() {},
    isoNow: () => new Date(now).toISOString(),
    unixNowSeconds: () => Math.floor(now / 1000),
    newMeasuredPlaybackId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    getMeasuredPlaybackDeviceId: () => fixture.deviceId,
    getPlaybackOwnershipTabId: () => fixture.originId,
    canEmitPlaybackSessionSideEffects: () => owner,
    getPlaybackClaimContext: () => ({}),
    releasePlaybackOwnership: async () => true,
  });

  let role = null;
  let streamId = 0;
  const track = key => ({ ...fixture.tracks[key], src: `/track?fixture=${key}` });
  const select = key => {
    snapshot.duration = fixture.tracks[key].durationSeconds;
    snapshot.currentTime = 0;
    role = { role: 'current', track: context.state.player.current };
  };
  const run = {
    select(step) {
      const previousPlaybackSnapshot = { currentTime: step.position, duration: step.duration };
      context.setCurrentPlayerTrack(track(step.track), { previousPlaybackSnapshot, persist: false });
      select(step.track);
    },
    begin(step) {
      snapshot.currentTime = step.position;
      snapshot.paused = false;
      context.beginStreamingPlayerListenSession(context.state.player.current, step.position);
    },
    heard(step) {
      context.recordMeasuredStreamingFrames(role, { frames: Math.round(step.seconds * fixture.sampleRate) }, fixture.sampleRate);
    },
    underrun() { context.breakMeasuredListenSegment(role.measuredListenSession); },
    position(step) {
      snapshot.currentTime = step.position;
      return context.handleStreamingPlaybackPosition({ trackPath: context.state.player.current.path, currentTime: step.position });
    },
    pause(step) {
      snapshot.currentTime = step.position;
      return context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: false });
    },
    seek(step) {
      snapshot.currentTime = step.from;
      context.setPlayerPlaybackHead(step.to);
    },
    advance(step) {
      const outgoing = context.state.player.current;
      const outgoingPlaybackSnapshot = { ...snapshot, currentTime: outgoing.durationSeconds, duration: outgoing.durationSeconds };
      queue.next = track(step.track);
      // As on Android, the playback snapshot already names the incoming item.
      snapshot.duration = queue.next.durationSeconds;
      snapshot.currentTime = 0;
      const promise = context.handleStreamingPlaybackBoundary({
        generation: 1, outgoingStreamId: ++streamId, incomingStreamId: ++streamId,
        outgoingTrackPath: outgoing.path, incomingTrackPath: queue.next.path, continuityKind: 'queued-next',
        outgoingPlaybackSnapshot,
      });
      role = { role: 'current', track: context.state.player.current };
      return promise;
    },
    ended() {
      const current = context.state.player.current;
      snapshot.currentTime = current.durationSeconds;
      const promise = context.handleStreamingPlaybackEnded({
        generation: 1, streamId: ++streamId, trackPath: current.path, currentTime: current.durationSeconds,
      });
      snapshot.paused = true;
      return promise;
    },
    lost(step) {
      snapshot.currentTime = step.position;
      context.losePlaybackOwnership('ownership-takeover', false);
    },
    owner(step) { owner = step.value; },
    fail(step) { failures.push(step.effect); },
  };
  return {
    writes,
    async step(step) {
      now = fixture.startEpochMs + step.at;
      await run[step.do](step);
      await settle();
    },
  };
}

/** A browser body as the server stores it from a reference: the path becomes the reference. */
function byReference({ effect, body }) {
  const named = Object.values(fixture.tracks).find(item => item.path === body.path);
  assert.ok(named, `write names an unknown track: ${body.path}`);
  const { path: _path, cover_path: _cover, ...rest } = body;
  return { effect, body: { ...rest, playbackRef: named.playbackRef } };
}

/** Writes in order within each listen session, sessions in the order they first wrote. */
function bySession(writes) {
  const sessions = [...new Set(writes.map(write => write.body.session_id))];
  return sessions.flatMap(id => writes.filter(write => write.body.session_id === id));
}

async function browserWrites(scenario) {
  const player = createBrowserPlayer();
  for (const step of scenario.steps) await player.step(step);
  return bySession(player.writes.map(byReference));
}

for (const scenario of fixture.scenarios) {
  test(`browser listen writes match the shared fixture: ${scenario.name}`, async () => {
    const writes = await browserWrites(scenario);
    if (process.env.ALBUM_HAVEN_WRITE_LISTEN_FIXTURE === '1') {
      scenario.writes = writes;
      fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
      return;
    }
    assert.deepEqual(writes, scenario.writes);
  });
}

test('every listen fixture scenario records writes and names no path', () => {
  for (const scenario of fixture.scenarios) {
    assert.ok(Array.isArray(scenario.writes) && scenario.writes.length > 0, scenario.name);
    for (const { body } of scenario.writes) {
      assert.equal('path' in body || 'cover_path' in body, false, scenario.name);
      assert.equal(typeof body.playbackRef, 'string');
    }
  }
});
