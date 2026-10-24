const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-listen-session-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const fetchCalls = [];
  const beaconCalls = [];
  const context = {
    state: {
      player: {
        listenSession: null,
      },
    },
    fetch: async (url, options) => {
      fetchCalls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    },
    navigator: {
      sendBeacon(url, body) {
        beaconCalls.push([url, body]);
        return true;
      },
    },
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0,
      duration: 0,
    }),
    isoNow: () => '2026-05-14T00:00:00Z',
    unixNowSeconds: () => 1778716800,
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, fetchCalls, beaconCalls };
}

for (const stalledStage of ['headers', 'body']) {
  test(`listen request bounds a stalled ${stalledStage} and releases its claim drain`, async () => {
    const timers = new Map();
    const cleared = [];
    let signal;
    let bodyStarted = false;
    const { context } = loadHelper({
      getPlaybackClaimContext: () => ({ clientId: 'client', claimToken: 'stalled-claim' }),
      setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
      clearTimeout: id => { cleared.push(id); timers.delete(id); },
      fetch: (_url, options) => {
        signal = options.signal;
        const stalled = () => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
        if (stalledStage === 'headers') return stalled();
        return Promise.resolve({ ok: true, json: () => { bodyStarted = true; return stalled(); } });
      },
    });
    let settled = false;
    let failure;
    const request = context.postPlaybackSession('/playback/session/complete', { title: 'Paused' })
      .then(() => { settled = true; }, error => { settled = true; failure = error; });
    let drained = false;
    const drain = context.drainPlaybackSessionRequests('stalled-claim').then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(drained, false);
    if (stalledStage === 'body') assert.equal(bodyStarted, true);
    assert.equal(timers.size, 1, 'listen writes must have a deadline spanning headers and response body');
    const deadline = timers.get(1);
    assert.ok(deadline.delay > 0 && deadline.delay <= 10000, 'listen writes use the bounded ownership request budget');
    deadline.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'a stalled write must not hold Pause or a preview handoff indefinitely');
    assert.ok(failure, 'timeout must reject rather than report a saved listen');
    assert.equal(signal.aborted, true);
    assert.equal(drained, true, 'claim release must be able to finish after the failed write');
    assert.deepEqual(cleared, [1]);
    assert.equal(timers.size, 0);
    assert.equal(vm.runInContext('pendingPlaybackSessionRequests.size', context), 0);
    await Promise.all([request, drain]);
  });
}

test('successful listen request clears its deadline and pending claim entry', async () => {
  const timers = new Map();
  const cleared = [];
  const { context } = loadHelper({
    setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
  });
  await context.postPlaybackSession('/playback/session/complete', { title: 'Saved' });
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.size, 0);
  assert.equal(vm.runInContext('pendingPlaybackSessionRequests.size', context), 0);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('authorized pause leaves a durable checkpoint when unowned unload discards local state', async () => {
  let authorized = true;
  const track = { path: 'C:/Music/closed.flac', title: 'Closed', artist: 'Artist', album: 'Album' };
  const { context, fetchCalls, beaconCalls } = loadHelper({
    crypto: require('node:crypto'),
    getPlayerPlaybackSnapshot: () => ({ currentTime: 30, duration: 120 }),
    canEmitPlaybackSessionSideEffects: () => authorized,
    getPlaybackClaimContext: () => ({ clientId: 'client', claimToken: 'claim' }),
  });
  context.state.player.current = track;
  context.startListenSession(track);
  const session = context.state.player.listenSession;
  session.duration_seconds = 120;
  session.segments = [{ start_seconds: 0, end_seconds: 30 }];
  Object.assign(session.measurement, { total: 30, contiguous: 30, longest: 30 });
  context.markListenSessionPaused(30);
  assert.equal(await context.persistPausedListenSession(session), true);
  authorized = false;
  assert.equal(context.flushListenSessionOnUnload('pagehide'), false);
  assert.equal(context.state.player.listenSession, null);
  assert.equal(beaconCalls.length, 0);
  assert.equal(fetchCalls.length, 1);
  const checkpoint = JSON.parse(fetchCalls[0][1].body);
  assert.equal(checkpoint.finalized, true, 'closing a paused tab must not strand an invisible unfinished ledger row');
  assert.equal(checkpoint.measured_listened_seconds, 30);
});

for (const heardBeforePause of [30, 70]) {
  test(`same-track two-hour resume preserves one scrobble after ${heardBeforePause}s before pause`, async () => {
    let now = Date.parse('2026-05-14T00:01:10Z');
    let offset = heardBeforePause;
    let authorized = true;
    const track = { path: 'C:/Music/continued.flac', title: 'Continued', artist: 'Artist', album: 'Album' };
    const { context, fetchCalls, beaconCalls } = loadHelper({
      crypto: require('node:crypto'),
      Date: { now: () => now },
      isoNow: () => new Date(now).toISOString(),
      getPlayerPlaybackSnapshot: () => ({ currentTime: offset, duration: 120 }),
      canEmitPlaybackSessionSideEffects: () => authorized,
      getPlaybackClaimContext: () => ({ clientId: 'client', claimToken: 'claim' }),
    });
    context.state.player.current = track;
    context.startListenSession(track);
    const session = context.state.player.listenSession;
    session.duration_seconds = 120;
    session.segments = [{ start_seconds: 0, end_seconds: heardBeforePause }];
    Object.assign(session.measurement, { total: heardBeforePause, contiguous: heardBeforePause, longest: heardBeforePause });
    await context.maybeScrobbleListenSession(session);
    context.markListenSessionPaused(offset);
    assert.equal(await context.persistPausedListenSession(session), true);
    authorized = false;
    const writesAtPause = fetchCalls.length;
    assert.equal(await context.maybeScrobbleListenSession(session), false);
    assert.equal(fetchCalls.length, writesAtPause, 'released ownership cannot authorize another write');
    assert.equal(beaconCalls.length, 0);
    now += 2 * 60 * 60 * 1000;
    authorized = true;
    const resumed = await context.resumeListenSessionPlayback(track, offset);
    assert.strictEqual(resumed, session, 'time-only pauses must preserve the measured and provider identity');
    offset += 40;
    context.closeListenSegment(offset);
    Object.assign(session.measurement, { total: heardBeforePause + 40, contiguous: 0,
      longest: Math.max(heardBeforePause, 40) });
    await context.maybeScrobbleListenSession(session);
    await context.maybeScrobbleListenSession(session);
    context.markListenSessionPaused(offset);
    await context.persistPausedListenSession(session);
    assert.equal(fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length, 1);
    assert.equal(session.scrobbled, true);
    const checkpoints = fetchCalls.filter(([url]) => url === '/playback/session/complete')
      .map(([, options]) => JSON.parse(options.body));
    assert.ok(checkpoints.every(payload => payload.finalized === true));
    assert.ok(checkpoints.every(payload => payload.session_id === session.measurement.sessionId));
  });
}

for (const change of ['session', 'claim']) {
  test(`pause checkpoint does not borrow a new ${change} after its pending scrobble drains`, async () => {
    const pending = deferred();
    let claim = { clientId: 'client', claimToken: 'old-claim' };
    const track = { path: 'old.flac', title: 'Old', artist: 'Artist', album: 'Album' };
    const { context, fetchCalls } = loadHelper({
      crypto: require('node:crypto'),
      getPlayerPlaybackSnapshot: () => ({ currentTime: 30, duration: 120 }),
      canEmitPlaybackSessionSideEffects: () => true,
      getPlaybackClaimContext: () => claim,
    });
    context.state.player.current = track;
    context.startListenSession(track);
    const session = context.state.player.listenSession;
    session.duration_seconds = 120;
    session.segments = [{ start_seconds: 0, end_seconds: 30 }];
    Object.assign(session.measurement, { total: 30, contiguous: 30, longest: 30 });
    context.markListenSessionPaused(30);
    session.scrobblePromise = pending.promise;
    const checkpoint = context.persistPausedListenSession(session);
    if (change === 'claim') claim = { clientId: 'client', claimToken: 'new-claim' };
    else context.state.player.listenSession = { id: 'new-session', segmentActive: true };
    pending.resolve(true);
    assert.equal(await checkpoint, false);
    assert.equal(fetchCalls.length, 0, 'the old paused payload cannot use a replacement playback authority');
  });
}

test('pause checkpoint exposes a genuine persistence rejection instead of a benign no-op', async () => {
  const track = { path: 'failed.flac', title: 'Failed', artist: 'Artist', album: 'Album' };
  const { context } = loadHelper({
    crypto: require('node:crypto'),
    getPlayerPlaybackSnapshot: () => ({ currentTime: 30, duration: 120 }),
    canEmitPlaybackSessionSideEffects: () => true,
    getPlaybackClaimContext: () => ({ clientId: 'client', claimToken: 'claim' }),
    fetch: async () => { throw new Error('checkpoint unavailable'); },
  });
  context.state.player.current = track;
  context.startListenSession(track);
  const session = context.state.player.listenSession;
  session.duration_seconds = 120;
  session.segments = [{ start_seconds: 0, end_seconds: 30 }];
  Object.assign(session.measurement, { total: 30, contiguous: 30, longest: 30 });
  context.markListenSessionPaused(30);
  await assert.rejects(context.persistPausedListenSession(session), /checkpoint unavailable/);
  assert.strictEqual(context.state.player.listenSession, session);
});

async function run() {
  {
    const pending = deferred();
    const { context } = loadHelper({
      getPlaybackClaimContext: () => ({ clientId: 'browser-client', claimToken: 'claim-token' }),
      fetch: () => pending.promise,
    });
    const request = context.postPlaybackSession('/playback/session/now-playing', { title: 'Song' });
    let drained = false;
    const drain = context.drainPlaybackSessionRequests('claim-token').then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);

    pending.resolve({ ok: true, json: async () => ({ ok: true }) });
    await request;
    await drain;
    assert.equal(drained, true);
  }
  {
    const pending = deferred();
    const { context } = loadHelper({
      getPlaybackClaimContext: () => ({ clientId: 'browser-client', claimToken: 'claim-token' }),
      fetch: () => pending.promise,
    });
    const request = context.postPlaybackSession('/playback/session/complete', { title: 'Song' });
    const drain = context.drainPlaybackSessionRequests('claim-token');
    pending.reject(new Error('network unavailable'));

    await assert.rejects(request, /network unavailable/);
    await assert.doesNotReject(drain);
  }
  {
    const rawTitle = 'Track Two (feat. Guest Singer)';
    const scrobbleSession = {
      track: {
        path: 'C:/Music/Artist Alpha/Album Alpha/02 Track.flac',
        title: rawTitle,
        displayTitle: 'Track Two',
        artist: 'Artist Alpha feat. Guest Singer',
        album: 'Album Alpha',
        coverPath: '',
        trackNumber: '2',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      duration_seconds: 240,
      segments: [{ start_seconds: 0, end_seconds: 120 }],
      segmentActive: false,
      scrobbled: false,
      scrobblePending: false,
    };
    const { context, fetchCalls } = loadHelper({
      state: { player: { listenSession: scrobbleSession } },
      getPlayerPlaybackSnapshot: () => ({ currentTime: 120, duration: 240 }),
    });

    assert.equal(context.buildNowPlayingPayload(scrobbleSession.track, scrobbleSession).title, rawTitle);
    assert.equal(await context.maybeScrobbleListenSession(scrobbleSession), true);
    assert.equal(JSON.parse(fetchCalls[0][1].body).title, rawTitle);
  }

  {
    const { context } = loadHelper();
    assert.equal(context.getListenScrobbleThreshold(0), 0);
    assert.equal(context.getListenScrobbleThreshold(240), 120);
    assert.equal(context.getListenScrobbleThreshold(1200), 300);
    assert.equal(context.canScrobbleListenSession({
      duration_seconds: 240,
      segments: [{ start_seconds: 0, end_seconds: 121 }],
    }), true);
  }

  {
    const { context } = loadHelper({
      getPlaybackOwnershipTabId: () => 'tab-123',
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 14.4444,
        duration: 240.111,
      }),
    });
    context.startListenSession({
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: 'C:/Music/cover.jpg',
      trackNumber: '3',
    });
    context.beginListenSegment(10.1111);
    context.closeListenSegment();

    assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.listenSession)), {
      measurement: { deviceId: '', sessionId: '', total: 0, contiguous: 0, longest: 0 },
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: 'C:/Music/cover.jpg',
        trackNumber: '3',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 0,
      segments: [{
        start_seconds: 10.111,
        end_seconds: 14.444,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      scrobblePending: false,
      completionState: '',
      nowPlayingSent: false,
      nowPlayingPromise: null,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(context.buildNowPlayingPayload({
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: 'C:/Music/cover.jpg',
      trackNumber: '3',
    }))), {
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      album_artist: 'Artist',
      cover_path: 'C:/Music/cover.jpg',
      duration_seconds: 240.111,
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      track_number: '3',
      request_origin: {
        client_kind: 'private_web',
        origin_type: 'browser_tab',
        origin_id: 'tab-123',
      },
    });
  }

  const session = {
    track: {
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: '',
      trackNumber: '1',
    },
    started_at: '2026-05-14T00:00:00Z',
    started_at_unix: 1778716800,
    ended_at: '',
    duration_seconds: 0,
    segments: [],
    segmentActive: true,
    activeSegmentStartSeconds: 0,
    paused_at: '',
    paused_at_unix_ms: 0,
    pause_offset_seconds: 0,
    scrobbled: false,
    completionState: '',
  };
  const { context, fetchCalls } = loadHelper({
    state: {
      player: {
        listenSession: session,
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 130,
      duration: 240,
    }),
  });

  await context.finalizeListenSession('ended', {
    currentTime: 130,
    duration: 240,
    finishedFully: true,
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0][0], '/playback/session/scrobble');
  assert.equal(fetchCalls[1][0], '/playback/session/complete');
  assert.equal(session.scrobbled, true);
  assert.equal(context.state.player.listenSession, null);
  const completePayload = JSON.parse(fetchCalls[1][1].body);
  assert.equal(completePayload.total_listened_seconds, 130);
  assert.equal(completePayload.max_contiguous_seconds, 130);
  assert.equal(completePayload.finished_fully, true);
  assert.equal(completePayload.scrobble_eligible, true);
  assert.equal(session.completionState, 'done');
  {
    let resolveFetch;
    const pendingFetch = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const scrobbleSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 240,
      segments: [{
        start_seconds: 0,
        end_seconds: 130,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      completionState: '',
    };
    const { context, fetchCalls } = loadHelper({
      state: {
        player: {
          current: scrobbleSession.track,
          listenSession: scrobbleSession,
        },
      },
      fetch: async (url, options) => {
        fetchCalls.push([url, options]);
        await pendingFetch;
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      },
    });

    const firstScrobble = context.maybeScrobbleListenSession(scrobbleSession);
    const secondScrobble = context.maybeScrobbleListenSession(scrobbleSession);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], '/playback/session/scrobble');
    resolveFetch();
    assert.equal(await firstScrobble, true);
    assert.equal(await secondScrobble, true);
    assert.equal(scrobbleSession.scrobbled, true);
    assert.equal(fetchCalls.length, 1);
  }
  {
    let resolveScrobble;
    const pendingScrobble = new Promise((resolve) => {
      resolveScrobble = resolve;
    });
    const scrobbleSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 240,
      segments: [{
        start_seconds: 0,
        end_seconds: 130,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      scrobblePending: false,
      completionState: '',
    };
    const { context, fetchCalls } = loadHelper({
      state: {
        player: {
          current: scrobbleSession.track,
          listenSession: scrobbleSession,
        },
      },
      fetch: async (url, options) => {
        fetchCalls.push([url, options]);
        if (url === '/playback/session/scrobble') {
          await pendingScrobble;
        }
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      },
    });

    const firstScrobble = context.maybeScrobbleListenSession(scrobbleSession);
    const finalize = context.finalizeListenSession('ended', {
      session: scrobbleSession,
      currentTime: 130,
      duration: 240,
      finishedFully: true,
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], '/playback/session/scrobble');
    resolveScrobble();
    assert.equal(await firstScrobble, true);
    await finalize;
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length, 1);
    assert.equal(fetchCalls[1][0], '/playback/session/complete');
    assert.equal(JSON.parse(fetchCalls[1][1].body).scrobbled, true);
  }
  {
    const flushSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 0,
      segments: [],
      segmentActive: true,
      activeSegmentStartSeconds: 10,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      completionState: '',
    };
    const { context, beaconCalls } = loadHelper({
      getPlaybackClaimContext: () => ({ clientId: 'unload-client', claimToken: 'unload-claim' }),
      state: {
        player: {
          listenSession: flushSession,
        },
      },
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 130,
        duration: 240,
      }),
    });

    assert.equal(context.flushListenSessionOnUnload('pagehide'), true);
    assert.equal(beaconCalls.length, 2);
    assert.equal(beaconCalls[0][0], '/playback/session/complete');
    assert.equal(beaconCalls[1][0], '/playback/session/scrobble');
    for (const [, body] of beaconCalls) {
      const payload = JSON.parse(await body.text());
      assert.equal(payload.clientId, 'unload-client');
      assert.equal(payload.claimToken, 'unload-claim');
    }
    assert.equal(context.state.player.listenSession, null);
  }
  {
    const shortSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 0,
      segments: [],
      segmentActive: true,
      activeSegmentStartSeconds: 0,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      completionState: '',
    };
    const { context, fetchCalls } = loadHelper({
      state: {
        player: {
          current: shortSession.track,
          listenSession: shortSession,
        },
      },
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 8,
        duration: 240,
      }),
    });

    await context.finalizeListenSession('track-change', {
      currentTime: 8,
      duration: 240,
      finishedFully: false,
    });

    assert.equal(fetchCalls.length, 0);
    assert.equal(shortSession.completionState, 'done');
    assert.equal(context.state.player.listenSession, null);
  }
  {
    const session = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 240,
      segments: [{
        start_seconds: 0,
        end_seconds: 130,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '',
      paused_at_unix_ms: 0,
      pause_offset_seconds: 0,
      scrobbled: false,
      completionState: '',
    };
    const { context, fetchCalls, beaconCalls } = loadHelper({
      state: {
        player: {
          current: session.track,
          listenSession: session,
        },
      },
      canEmitPlaybackSessionSideEffects: () => false,
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 130,
        duration: 240,
      }),
    });

    await context.maybeSendNowPlaying(session.track, session);
    await context.maybeScrobbleListenSession(session);
    await context.finalizeListenSession('ended', {
      currentTime: 130,
      duration: 240,
      finishedFully: true,
    });
    assert.equal(context.flushListenSessionOnUnload('pagehide'), false);

    assert.equal(fetchCalls.length, 0);
    assert.equal(beaconCalls.length, 0);
    assert.equal(session.scrobbled, false);
    assert.equal(session.completionState, 'done');
    assert.equal(context.state.player.listenSession, null);
  }
  {
    let nowValue = 1000;
    let isoValue = '2026-05-14T00:05:00Z';
    const pausedSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 240,
      segments: [{
        start_seconds: 0,
        end_seconds: 25,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '2026-05-14T00:00:25Z',
      paused_at_unix_ms: nowValue,
      pause_offset_seconds: 25,
      scrobbled: false,
      completionState: '',
    };
    const { context, fetchCalls } = loadHelper({
      state: {
        player: {
          current: pausedSession.track,
          listenSession: pausedSession,
        },
      },
      Date: {
        now: () => nowValue,
      },
      isoNow: () => isoValue,
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 25,
        duration: 240,
      }),
    });

    await context.finalizeListenSession('track-change', {
      session: pausedSession,
      currentTime: 25,
      duration: 240,
      finishedFully: false,
    });

    assert.equal(fetchCalls[fetchCalls.length - 1][0], '/playback/session/complete');
    const pausedPayload = JSON.parse(fetchCalls[fetchCalls.length - 1][1].body);
    assert.equal(pausedPayload.ended_at, '2026-05-14T00:00:25Z');
  }
  {
    let currentTime = 30;
    const track = {
      path: 'C:/Music/song.flac', title: 'Song', artist: 'Artist', album: 'Album',
      coverPath: '', trackNumber: '1',
    };
    const session = {
      track,
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 120,
      segments: [{ start_seconds: 0, end_seconds: 30 }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '2026-05-14T00:00:30Z',
      paused_at_unix_ms: 1000,
      pause_offset_seconds: 30,
      scrobbled: false,
      completionState: '',
      measurement: {
        deviceId: 'browser-device',
        sessionId: 'measured-session',
        sequence: 0,
        total: 30,
        contiguous: 30,
        longest: 30,
      },
    };
    const { context, fetchCalls } = loadHelper({
      state: { player: { current: track, listenSession: session } },
      Date: { now: () => 1001 },
      getPlayerPlaybackSnapshot: () => ({ currentTime, duration: 120 }),
      getPlaybackClaimContext: () => ({ clientId: 'browser-client', claimToken: 'claim-token' }),
    });

    assert.equal(await context.persistPausedListenSession(session), true);
    const pausedPayload = JSON.parse(fetchCalls.at(-1)[1].body);
    assert.equal(pausedPayload.session_id, 'measured-session');
    assert.equal(pausedPayload.sequence, 1);
    assert.equal(pausedPayload.finalized, true);

    const resumed = await context.resumeListenSessionPlayback(track, 30);
    assert.strictEqual(resumed, session, 'short pause resumes the same measured listen');
    currentTime = 60;
    session.measurement.total = 60;
    session.measurement.contiguous = 60;
    session.measurement.longest = 60;
    await context.finalizeListenSession('ended', {
      session,
      currentTime,
      duration: 120,
      finishedFully: true,
    });
    const finalPayload = JSON.parse(fetchCalls.at(-1)[1].body);
    assert.equal(finalPayload.session_id, pausedPayload.session_id);
    assert.equal(finalPayload.sequence, 3);
    assert.equal(finalPayload.finalized, true);
    assert.equal(finalPayload.completion_reason, 'ended');
  }
  {
    let nowValue = 0;
    let isoIndex = 0;
    const isoValues = [
      '2026-05-14T02:00:00Z',
    ];
    const splitSession = {
      track: {
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
        trackNumber: '1',
      },
      started_at: '2026-05-14T00:00:00Z',
      started_at_unix: 1778716800,
      ended_at: '',
      duration_seconds: 240,
      segments: [{
        start_seconds: 0,
        end_seconds: 30,
      }],
      segmentActive: false,
      activeSegmentStartSeconds: 0,
      paused_at: '2026-05-14T00:00:30Z',
      paused_at_unix_ms: 1,
      pause_offset_seconds: 30,
      scrobbled: false,
      completionState: '',
    };
    const { context, fetchCalls } = loadHelper({
      state: {
        player: {
          current: splitSession.track,
          listenSession: splitSession,
        },
      },
      Date: {
        now: () => nowValue,
      },
      isoNow: () => {
        const value = isoValues[Math.min(isoIndex, isoValues.length - 1)];
        isoIndex += 1;
        return value;
      },
      getPlayerPlaybackSnapshot: () => ({
        currentTime: 40,
        duration: 240,
      }),
    });

    nowValue = (60 * 60 * 1000) + 1;
    const resumedSession = await context.resumeListenSessionPlayback(splitSession.track, 40);

    assert.equal(fetchCalls.length, 0, 'resuming the same track must not finalize a second logical listen');
    assert.strictEqual(resumedSession, splitSession);
    assert.equal(context.state.player.listenSession.started_at, '2026-05-14T00:00:00Z');
    assert.equal(context.state.player.listenSession.segmentActive, true);
    assert.equal(context.state.player.listenSession.activeSegmentStartSeconds, 40);
    assert.equal(resumedSession, context.state.player.listenSession);
  }
  {
    const nextTrack = {
      path: 'C:/Music/next.flac',
      title: 'Next Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: '',
      trackNumber: '2',
    };
    let releaseFirstRequest;
    const firstRequest = new Promise((resolve) => {
      releaseFirstRequest = resolve;
    });
    const requestUrls = [];
    const { context } = loadHelper({
      fetch: async (url) => {
        requestUrls.push(url);
        await firstRequest;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    context.startListenSession(nextTrack);
    const incomingSession = context.state.player.listenSession;

    const firstDelivery = context.maybeSendNowPlaying(nextTrack, incomingSession, {
      boundaryIdentity: '8:81:82',
    });
    const concurrentDelivery = context.maybeSendNowPlaying(nextTrack, incomingSession, {
      boundaryIdentity: '8:81:82',
    });

    assert.equal(
      requestUrls.filter((url) => url === '/playback/session/now-playing').length,
      1,
      'concurrent delivery of one worklet boundary shares one now-playing request',
    );
    releaseFirstRequest();
    await Promise.all([firstDelivery, concurrentDelivery]);

    let rejectedAttempts = 0;
    const { context: retryContext } = loadHelper({
      fetch: async () => {
        rejectedAttempts += 1;
        if (rejectedAttempts === 1) {
          return { ok: false, json: async () => ({ ok: false, error: 'temporary failure' }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    retryContext.startListenSession(nextTrack);
    const retrySession = retryContext.state.player.listenSession;
    await retryContext.maybeSendNowPlaying(nextTrack, retrySession, {
      boundaryIdentity: '9:91:92',
    });
    await retryContext.maybeSendNowPlaying(nextTrack, retrySession, {
      boundaryIdentity: '9:91:92',
    });
    assert.equal(rejectedAttempts, 2, 'a rejected now-playing request remains eligible for one retry');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
