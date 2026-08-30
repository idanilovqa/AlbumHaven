const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function track(number) {
  return {
    path: `C:/Music/Fixture/Album/${number.toString().padStart(2, '0')} Track.mp3`,
    src: `/track?fixture=${number}`,
    title: `Track ${number}`,
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    coverPath: '',
    trackNumber: String(number),
  };
}

function loadHelper() {
  const fetchCalls = [];
  const pendingScrobbles = [];
  let clock = 0;
  const context = {
    state: {
      player: {
        current: null,
        listenSession: null,
      },
    },
    async fetch(url, options = {}) {
      fetchCalls.push([url, options]);
      if (url === '/playback/session/scrobble') {
        const pending = createDeferred();
        pendingScrobbles.push(pending);
        const outcome = await pending.promise;
        if (outcome?.ok === false) {
          return {
            ok: false,
            async json() {
              return {
                ok: false,
                error: outcome.error || 'Fixture scrobble rejected',
              };
            },
          };
        }
      }
      return {
        ok: true,
        async json() {
          return { ok: true };
        },
      };
    },
    navigator: {
      sendBeacon() {
        return true;
      },
    },
    Blob,
    getPlayerPlaybackSnapshot() {
      return { currentTime: 130, duration: 240 };
    },
    isoNow() {
      clock += 1;
      return `2026-07-22T00:00:${clock.toString().padStart(2, '0')}Z`;
    },
    unixNowSeconds() {
      return 1784678400 + clock;
    },
    console: {
      error() {},
      log() {},
      warn() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, fetchCalls, pendingScrobbles };
}

function beginEligibleSession(context, selectedTrack) {
  context.state.player.current = selectedTrack;
  context.startListenSession(selectedTrack);
  context.beginListenSegment(0);
  context.state.player.listenSession.duration_seconds = 240;
  return context.state.player.listenSession;
}

function finishEligibleSession(context, session) {
  return context.finalizeListenSession('ended', {
    session,
    currentTime: 130,
    duration: 240,
    finishedFully: true,
  });
}

test('finalization detaches the captured listen session before awaiting scrobble persistence', async () => {
  const { context, pendingScrobbles } = loadHelper();
  const firstSession = beginEligibleSession(context, track(1));

  const finalization = finishEligibleSession(context, firstSession);
  const activeSessionWhileScrobblePending = context.state.player.listenSession;

  assert.equal(pendingScrobbles.length, 1, 'the regression requires scrobble persistence to be pending');
  pendingScrobbles[0].resolve();
  await finalization;

  assert.equal(
    activeSessionWhileScrobblePending,
    null,
    'the finishing session must relinquish the active slot synchronously before the first await',
  );
  assert.equal(firstSession.completionState, 'done');
});

test('three automatic track transitions allocate distinct sessions while prior scrobbles are pending', async () => {
  const { context, fetchCalls, pendingScrobbles } = loadHelper();
  const firstTrack = track(1);
  const secondTrack = track(2);
  const thirdTrack = track(3);
  const firstSession = beginEligibleSession(context, firstTrack);
  await context.maybeSendNowPlaying(firstTrack, firstSession);

  const firstFinalization = finishEligibleSession(context, firstSession);
  context.state.player.current = secondTrack;
  const secondSession = await context.resumeListenSessionPlayback(secondTrack, 0);
  secondSession.duration_seconds = 240;
  await context.maybeSendNowPlaying(secondTrack, secondSession);

  const secondFinalization = finishEligibleSession(context, secondSession);
  context.state.player.current = thirdTrack;
  const thirdSession = await context.resumeListenSessionPlayback(thirdTrack, 0);
  await context.maybeSendNowPlaying(thirdTrack, thirdSession);

  const observedPaths = [firstSession, secondSession, thirdSession]
    .map((session) => String(session?.track?.path || ''));
  const activeBeforeOldCompletionsSettle = context.state.player.listenSession;
  const thirdSessionBeforeOldCompletionsSettle = JSON.parse(JSON.stringify(thirdSession));
  const nowPlayingCalls = fetchCalls
    .filter(([url]) => url === '/playback/session/now-playing')
    .map(([, options]) => JSON.parse(options.body));
  const scrobbleCallsBeforeSettlement = fetchCalls
    .filter(([url]) => url === '/playback/session/scrobble')
    .map(([, options]) => JSON.parse(options.body));

  assert.deepEqual(
    nowPlayingCalls.map(({ path, title }) => ({ path, title })),
    [firstTrack, secondTrack, thirdTrack].map(({ path, title }) => ({ path, title })),
    'each automatic transition must publish now-playing exactly once in track order',
  );
  assert.deepEqual(
    scrobbleCallsBeforeSettlement.map(({ path, title }) => ({ path, title })),
    [firstTrack, secondTrack].map(({ path, title }) => ({ path, title })),
    'only the two closed sessions may start scrobble persistence',
  );
  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/complete').length,
    0,
    'completion must remain behind each pending scrobble',
  );

  pendingScrobbles.forEach((pending) => pending.resolve());
  await Promise.all([firstFinalization, secondFinalization]);
  const scrobbleCalls = fetchCalls
    .filter(([url]) => url === '/playback/session/scrobble')
    .map(([, options]) => JSON.parse(options.body));
  const completionCalls = fetchCalls
    .filter(([url]) => url === '/playback/session/complete')
    .map(([, options]) => JSON.parse(options.body));

  assert.deepEqual(observedPaths, [firstTrack.path, secondTrack.path, thirdTrack.path]);
  assert.equal(new Set([firstSession, secondSession, thirdSession]).size, 3);
  assert.equal(
    activeBeforeOldCompletionsSettle,
    thirdSession,
    'the third track must own the active slot before older network work completes',
  );
  assert.equal(
    context.state.player.listenSession,
    thirdSession,
    'late completion of either prior track must not clear the current track session',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(thirdSession)),
    thirdSessionBeforeOldCompletionsSettle,
    'late prior completions must not mutate the third active session',
  );
  assert.deepEqual(
    scrobbleCalls.map(({ path, title }) => ({ path, title })),
    [firstTrack, secondTrack].map(({ path, title }) => ({ path, title })),
    'each closed track must scrobble once and the active third track must not scrobble',
  );
  assert.deepEqual(
    completionCalls.map(({ path, title, segments, scrobbled }) => ({
      path,
      title,
      segments,
      scrobbled,
    })),
    [firstTrack, secondTrack].map(({ path, title }) => ({
      path,
      title,
      segments: [{ start_seconds: 0, end_seconds: 130 }],
      scrobbled: true,
    })),
    'completion payloads must retain the closed track identity, segment, and scrobble result',
  );
});

test('a rejected scrobble is retried once by finalization without concurrent duplicates', async () => {
  const { context, fetchCalls, pendingScrobbles } = loadHelper();
  const firstTrack = track(1);
  const firstSession = beginEligibleSession(context, firstTrack);
  context.closeListenSegment(130, firstSession);

  const rejectedScrobble = context.maybeScrobbleListenSession(firstSession);
  const concurrentRejectedScrobble = context.maybeScrobbleListenSession(firstSession);

  assert.equal(pendingScrobbles.length, 1);
  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length,
    1,
    'concurrent callers must share the first in-flight scrobble',
  );
  pendingScrobbles[0].resolve({
    ok: false,
    error: 'Deterministic provider rejection',
  });
  assert.equal(await rejectedScrobble, false);
  assert.equal(await concurrentRejectedScrobble, false);
  assert.equal(firstSession.scrobbled, false);
  assert.equal(firstSession.scrobblePending, false);

  const finalization = finishEligibleSession(context, firstSession);
  const concurrentRetry = context.maybeScrobbleListenSession(firstSession);

  assert.equal(pendingScrobbles.length, 2);
  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length,
    2,
    'finalization must intentionally retry the rejected scrobble exactly once',
  );
  pendingScrobbles[1].resolve({ ok: true });
  assert.equal(await concurrentRetry, true);
  await finalization;

  const scrobbleCalls = fetchCalls
    .filter(([url]) => url === '/playback/session/scrobble')
    .map(([, options]) => JSON.parse(options.body));
  const completionCalls = fetchCalls
    .filter(([url]) => url === '/playback/session/complete')
    .map(([, options]) => JSON.parse(options.body));
  assert.deepEqual(
    scrobbleCalls.map(({ path, title }) => ({ path, title })),
    [
      { path: firstTrack.path, title: firstTrack.title },
      { path: firstTrack.path, title: firstTrack.title },
    ],
  );
  assert.deepEqual(
    completionCalls.map(({ path, title, segments, scrobbled }) => ({
      path,
      title,
      segments,
      scrobbled,
    })),
    [{
      path: firstTrack.path,
      title: firstTrack.title,
      segments: [{ start_seconds: 0, end_seconds: 130 }],
      scrobbled: true,
    }],
  );
  assert.equal(firstSession.scrobbled, true);
  assert.equal(firstSession.scrobblePending, false);
  assert.equal(firstSession.completionState, 'done');
  assert.equal(context.state.player.listenSession, null);
});

test('duplicate boundary finalization cannot complete or scrobble the captured session twice', async () => {
  const { context, fetchCalls, pendingScrobbles } = loadHelper();
  const outgoingTrack = track(1);
  const outgoingSession = beginEligibleSession(context, outgoingTrack);

  const firstBoundary = finishEligibleSession(context, outgoingSession);
  const duplicateBoundary = finishEligibleSession(context, outgoingSession);

  assert.equal(pendingScrobbles.length, 1);
  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length,
    1,
  );
  pendingScrobbles[0].resolve({ ok: true });
  await Promise.all([firstBoundary, duplicateBoundary]);

  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/scrobble').length,
    1,
  );
  assert.equal(
    fetchCalls.filter(([url]) => url === '/playback/session/complete').length,
    1,
  );
  assert.equal(outgoingSession.completionState, 'done');
});
