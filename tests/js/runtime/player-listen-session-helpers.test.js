const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

async function run() {
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

    assert.equal(fetchCalls[fetchCalls.length - 1][0], '/playback/session/complete');
    const splitPayload = JSON.parse(fetchCalls[fetchCalls.length - 1][1].body);
    assert.equal(splitPayload.completion_reason, 'long-pause-timeout');
    assert.equal(splitPayload.ended_at, '2026-05-14T00:00:30Z');
    assert.equal(splitPayload.max_contiguous_seconds, 30);
    assert.equal(context.state.player.listenSession.started_at, '2026-05-14T02:00:00Z');
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
