// A track shown in the player when the page opens loads its waveform, playing or not.
// The player, its persistence, the waveform loader, the engine contract and the Android page
// bridge are the real sources; the engines' audio, the network and the DOM are fakes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const RUNTIME_FILES = [
  'android-bridge-client.js',
  'playback-engine.js',
  'player-waveform-peaks.js',
  'player-and-waveform.js',
  'player-state-persistence-helpers.js',
  'player-loop-playback.js',
];
const SOURCES = RUNTIME_FILES.map((name) => {
  const filename = path.join(__dirname, '../../../music_app/static/js/runtime', name);
  return { filename, source: fs.readFileSync(filename, 'utf8') };
});
const TRACK = {
  path: 'C:/Music/Album/01.flac',
  src: '/track?path=01.flac',
  title: 'First song',
  artist: 'Artist',
  album: 'Album',
  durationSeconds: 519,
};

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

const OTHER = {
  ...TRACK, path: 'C:/Music/Album/02.flac', src: '/track?path=02.flac', title: 'Second song',
};

function openPage({ paused = true, android = false, adopted = '', streamFails = false, claimed = true } = {}) {
  const requests = [];
  const timers = [];
  const pageShow = [];
  const commands = [];
  let claims = 0;
  let starts = 0;
  let onAutoplayStarted = null;
  const streaming = { generation: 0 };
  const engine = { paused: true, mode: 'stopped' };

  const context = {
    AbortController,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    console: { ...console, error() {}, warn() {} },
    performance,
    PLAYER_STATE_STORAGE_KEY: 'albumhaven.playerState.v1',
    navigator: { userAgent: '' },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener(type, listener) { if (type === 'pageshow') pageShow.push(listener); },
      AlbumHavenCapabilities: { allows: () => true, isAndroidShell: () => android },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
        requests.push({
          url: new URL(url, 'http://album-haven.test'),
          signal: options.signal,
          respond(status, body = {}) {
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: { get: () => 'application/json' },
              json: async () => body,
            });
          },
          // A waveform still building streams; `end` closes it or breaks the connection.
          stream() {
            const chunks = [];
            let wake = () => {};
            const reader = {
              async read() {
                while (!chunks.length) await new Promise((next) => { wake = next; });
                const chunk = chunks.shift();
                if (chunk instanceof Error) throw chunk;
                return chunk;
              },
            };
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => 'application/x-ndjson' },
              body: { getReader: () => reader },
            });
            const push = (chunk) => { chunks.push(chunk); wake(); };
            return {
              send: (body) => push({ value: new TextEncoder().encode(`${JSON.stringify(body)}\n`), done: false }),
              close: () => push({ value: undefined, done: true }),
              breakConnection: () => push(new TypeError('network error')),
            };
          },
        });
      });
    },
    state: {
      ui: {},
      utility: {},
      player: {
        current: null,
        appearance: { seekbarMode: 'waveform' },
        loopActive: false,
        streaming,
        waveform: { renderToken: 0 },
      },
    },
    getLocalStorageItem: () => JSON.stringify({ track: TRACK, currentTime: 0, paused }),
    setLocalStorageItem: () => true,
    resolveAlbumForPlayerTrack: () => null,
    getTrackIdentity: (track) => String(track?.path || ''),
    loopEditSessionExpiryController: { start() {}, stop() {} },
    resumeListenSessionPlayback: async () => null,
    maybeSendNowPlaying: async () => null,
    canRestoreActivePlayback: async () => {
      claims += 1;
      return claimed;
    },
    canStartPlaybackInThisTab: async () => {
      claims += 1;
      return true;
    },
    isActivePlaybackOwner: () => claimed,
    getBrowserStreamingSnapshot: () => ({
      currentTime: 0,
      duration: TRACK.durationSeconds,
      ended: false,
      src: TRACK.src,
      paused: engine.paused,
      mode: engine.mode,
      generation: streaming.generation,
    }),
    async startBrowserStreamingTrack(track, options) {
      starts += 1;
      await Promise.resolve();
      if (streamFails) throw new Error('Playback socket closed');
      streaming.generation += 1;
      engine.mode = 'paused';
      context.loadPlayingWaveformPeaks(track.path, streaming.generation);
      onAutoplayStarted = options.onAutoplayStarted || null;
      return { track, generation: streaming.generation, streamId: 1 };
    },
    async resumeBrowserStreaming() {
      engine.paused = false;
      engine.mode = 'playing';
      return true;
    },
  };
  vm.createContext(context);
  for (const { filename, source } of SOURCES) vm.runInContext(source, context, { filename });

  Object.assign(context, {
    getPlayerElements: () => ({}),
    updatePlayerUi() {},
    persistPlayerState() {},
    updateWaveformAppearance: async () => {},
    clearWaveformCanvas() {},
    renderGlobalPlayerMetadata() {},
    focusPlayerTimeline() {},
  });
  if (android) {
    Object.assign(context, {
      connectAndroidBridge: async () => ({}),
      hasAndroidCapability: (name) => name !== 'sandbox.select.v1',
      androidNativePlaybackRoute: () => Promise.resolve(true),
      androidNativeQueueWindow: (track) => ({ items: [track], currentIndex: 0 }),
      requestAndroidNativePlaybackRefs: async () => [],
      buildAndroidNativeQueuePayload: (queueRevision, queue, _refs, _start, autoplay) => ({
        first: 0,
        payload: { queueRevision, items: queue.items, currentIndex: 0, autoplay },
      }),
      saveAndroidNativeAttachment() {},
      readAndroidNativeAttachment: () => [TRACK],
      sendAndroidBridgeCommand: async (name, payload) => { commands.push({ name, payload }); },
    });
    vm.runInContext(`androidBridge.info = { playback: ${JSON.stringify(
      adopted ? { state: adopted, queueRevision: 4, currentIndex: 0, positionMs: 0 } : {},
    )} };`, context);
  }

  const page = {
    context,
    commands,
    claims: () => claims,
    starts: () => starts,
    waveformRequests: () => requests.filter(({ url }) => url.pathname === '/playback/waveform'),
    pending: () => page.waveformRequests().filter(({ signal }) => !signal.aborted),
    // Another song is pressed; its start answers when the test says so.
    async press(track) {
      const start = {};
      start.answered = new Promise((resolve, reject) => Object.assign(start, { resolve, reject }));
      context.startStreamingTrack = () => start.answered;
      const played = context.playTrackFromPayload(track).catch(() => false);
      await settle();
      return {
        async starts({ sounded = false } = {}) {
          start.resolve({
            track, generation: streaming.generation, streamId: 2, firstFrameNotified: sounded,
          });
          await played;
          await settle();
        },
        async fails() {
          start.reject(new Error('start failed'));
          await played;
          await settle();
        },
      };
    },
    async sounds(track, streamId = 2) {
      await context.handleStreamingPlaybackFirstFrame({
        generation: streaming.generation, streamId, trackPath: track.path,
      });
      await settle();
    },
    isResting: () => vm.runInContext('Boolean(playerWaveformRestingTrack)', context),
    requestFor: (track) => page.waveformRequests()
      .filter(({ url }) => url.searchParams.get('path') === track.path),
    autoplayStarts() {
      engine.paused = false;
      engine.mode = 'playing';
      onAutoplayStarted();
    },
    async open() {
      context.restorePlayerState();
      await settle();
      for (const listener of pageShow.splice(0)) listener();
      await settle();
    },
    async runTimer(delay) {
      const timer = timers.find((entry) => !entry.cancelled && !entry.ran && entry.delay === delay);
      assert.ok(timer, `a ${delay} ms timer is waiting`);
      timer.ran = true;
      timer.callback();
      await settle();
    },
    async answer(request = page.pending().at(-1)) {
      assert.ok(request, 'a waveform request is waiting for its answer');
      request.respond(200, {
        sampleCount: 720,
        left: Array(720).fill(0.5),
        right: Array(720).fill(0.25),
      });
      await settle();
    },
    assertShown() {
      const shown = context.state.player.waveform.compactPeaks;
      assert.equal(shown?.path, TRACK.path, 'the waveform of the track in the player is shown');
      assert.equal(shown.data.left.length, 720);
      assert.ok(!shown.partial);
    },
  };
  return page;
}

// Owner rule: the waveform of the track in the player is never low priority, playing or not.
function assertPlayingPriority(request) {
  assert.equal(request.url.searchParams.get('priority'), 'current');
  assert.equal(request.url.searchParams.get('progressive'), '1', 'it draws as it builds');
}

test('a paused track at 0:00 loads its waveform on open without Play or a claim', async () => {
  const page = openPage();
  await page.open();

  assert.equal(page.waveformRequests().length, 1, 'one request outlives the stream opening');
  assertPlayingPriority(page.waveformRequests()[0]);
  await page.answer();

  page.assertShown();
  assert.equal(page.claims(), 0);
  assert.equal(page.context.getPlayerPlaybackSnapshot().paused, true);
});

test('the waveform loads when the paused track\'s stream cannot open', async () => {
  const page = openPage({ streamFails: true });
  await page.open();
  // The failed stream's cleanup cancels its generation.
  page.context.cancelWaveformPeakLoads(0);
  await settle();
  await page.answer();

  page.assertShown();
});

test('a server that is not ready is asked again', async () => {
  const page = openPage();
  await page.open();
  page.pending()[0].respond(503);
  await settle();
  await page.runTimer(50);
  await page.answer();

  page.assertShown();
});

test('a paused track draws its waveform while it builds', async () => {
  const page = openPage();
  await page.open();
  const stream = page.pending()[0].stream();
  stream.send({ sampleCount: 720, left: Array(720).fill(0.1), right: Array(720).fill(0.1), complete: false });
  await settle();

  const shown = page.context.state.player.waveform.compactPeaks;
  assert.equal(shown?.path, TRACK.path);
  assert.equal(shown.partial, true);
});

for (const [name, interrupt] of [
  ['breaks', (stream) => stream.breakConnection()],
  ['ends early', (stream) => stream.close()],
]) {
  test(`a waveform stream that ${name} while building is asked again`, async () => {
    const page = openPage();
    await page.open();
    interrupt(page.pending()[0].stream());
    await settle();
    await page.runTimer(50);

    assert.equal(page.waveformRequests().length, 2);
    await page.answer();
    page.assertShown();
  });
}

test('a waveform that keeps failing while building is asked a bounded number of times', async () => {
  const page = openPage();
  await page.open();
  for (const delay of [50, 100, 200, 400, 800]) {
    page.waveformRequests().at(-1).stream().close();
    await settle();
    await page.runTimer(delay);
  }
  page.waveformRequests().at(-1).stream().close();
  await settle();

  assert.equal(page.waveformRequests().length, 6);
});

test('a missing file is not asked for again', async () => {
  const page = openPage();
  await page.open();
  page.pending()[0].respond(404);
  await settle();

  assert.equal(page.waveformRequests().length, 1);
});

test('a view load that spans the stream opening does not lose the waveform', async () => {
  const page = openPage();
  const suspension = page.context.suspendPlayerWaveformPeakLoadsForForegroundView();
  await page.open();
  assert.equal(page.waveformRequests().length, 0, 'the view loads first');

  void page.context.resumePlayerWaveformPeakLoadsAfterForegroundView(suspension);
  await settle();
  assertPlayingPriority(page.pending()[0]);
  await page.answer();

  page.assertShown();
});

test('Play keeps the waveform request that is already building', async () => {
  const page = openPage();
  await page.open();
  const building = page.pending()[0];

  page.context.togglePlayerPlayback({ focusTimelineOnResume: false });
  await settle();

  assert.equal(building.signal.aborted, false);
  assert.equal(page.waveformRequests().length, 1);
  await page.answer();
  page.assertShown();
});

test('Play after the waveform loaded asks for nothing again', async () => {
  const page = openPage();
  await page.open();
  await page.answer();

  page.context.togglePlayerPlayback({ focusTimelineOnResume: false });
  await settle();

  assert.equal(page.waveformRequests().length, 1);
  page.assertShown();
});

test('emptying the player stops waiting for the restored track', async () => {
  const page = openPage();
  await page.open();
  const waiting = page.pending()[0];

  page.context.setCurrentPlayerTrack(null, { persist: false });
  await settle();

  assert.equal(waiting.signal.aborted, true);
});

test('a saved playing track keeps its one request when its autoplay starts', async () => {
  const page = openPage({ paused: false });
  await page.open();
  assertPlayingPriority(page.pending()[0]);

  page.autoplayStarts();
  await settle();

  assert.equal(page.waveformRequests().length, 1);
  await page.answer();
  page.assertShown();
});

test('a saved playing track refused its claim still loads its waveform', async () => {
  const page = openPage({ paused: false, claimed: false });
  await page.open();
  assertPlayingPriority(page.pending()[0]);
  await page.answer();

  page.assertShown();
});

test('the Android page loads a paused track\'s waveform across its queue load', async () => {
  const page = openPage({ android: true });
  await page.open();
  assert.deepEqual(page.commands.map(({ name, payload }) => [name, payload.autoplay]), [['playback.loadQueue', false]]);
  assert.equal(page.waveformRequests().length, 1);
  assertPlayingPriority(page.waveformRequests()[0]);
  await page.answer();

  page.assertShown();
  assert.equal(page.claims(), 0);
});

test('the Android page keeps its one request when Android starts the restored track', async () => {
  const page = openPage({ android: true, paused: false });
  await page.open();
  assertPlayingPriority(page.pending()[0]);

  page.context.handleAndroidNativeState({ state: 'playing', positionMs: 0 });
  await settle();

  assert.equal(page.waveformRequests().length, 1);
  await page.answer();
  page.assertShown();
});

test('the Android page loads the waveform of a paused queue it adopts', async () => {
  const page = openPage({ android: true, adopted: 'paused' });
  await page.open();
  assert.deepEqual(page.commands.filter(({ name }) => name !== 'playback.clearLoop'), []);
  assertPlayingPriority(page.pending()[0]);
  await page.answer();

  page.assertShown();
});

test('the Android page keeps the waveform of a playing queue it adopts', async () => {
  const page = openPage({ android: true, adopted: 'playing' });
  await page.open();
  assertPlayingPriority(page.pending()[0]);
  await page.answer();

  page.assertShown();
});

// A song switch: the restored track's waveform is the old one until the pressed song sounds.
test('the pressed song builds alone, then the restored waveform loads while the switch waits', async () => {
  const page = openPage();
  await page.open();
  const restored = page.requestFor(TRACK)[0];

  await page.press(OTHER);

  // Two builds share the CPU and take both of the server's slots for playing songs.
  assert.equal(restored.signal.aborted, true, 'the pressed song never shares its build');
  assertPlayingPriority(page.requestFor(OTHER)[0]);
  await page.answer(page.requestFor(OTHER)[0]);
  assert.equal(page.requestFor(TRACK).length, 2, 'the old waveform loads again once the pressed one is built');
  await page.answer(page.requestFor(TRACK)[1]);
  page.assertShown();
});

for (const [name, meanwhile] of [
  ['the stream opens', (page) => page.context.loadPlayingWaveformPeaks(OTHER.path)],
  ['a view load ends', (page) => {
    const suspension = page.context.suspendPlayerWaveformPeakLoadsForForegroundView();
    void page.context.resumePlayerWaveformPeakLoadsAfterForegroundView(suspension);
  }],
]) {
  test(`the restored waveform does not compete with the pressed one when ${name}`, async () => {
    const page = openPage();
    await page.open();

    await page.press(OTHER);
    void meanwhile(page);
    await settle();

    const building = page.requestFor(TRACK).filter(({ signal }) => !signal.aborted);
    assert.equal(building.length, 0);
  });
}

test('a switch that fails to start still gets the restored waveform', async () => {
  const page = openPage();
  await page.open();

  const switched = await page.press(OTHER);
  await switched.fails();

  assert.equal(page.requestFor(TRACK).length, 2);
  await page.answer(page.requestFor(TRACK)[1]);
  page.assertShown();
});

test('a switch that starts while the pressed waveform builds never asks for the old one again', async () => {
  const page = openPage();
  await page.open();

  const switched = await page.press(OTHER);
  await switched.starts();

  assert.equal(page.requestFor(TRACK).length, 1, 'only the request the page opened with');
});

test('once the pressed song is the current one only its waveform builds, and the rest ends when it sounds', async () => {
  const page = openPage();
  await page.open();

  const switched = await page.press(OTHER);
  await page.answer(page.requestFor(OTHER)[0]);
  await switched.starts();
  assert.equal(page.requestFor(TRACK).filter(({ signal }) => !signal.aborted).length, 0);
  assert.equal(page.isResting(), true, 'started, but nothing of it has sounded');

  await page.sounds(OTHER);
  assert.equal(page.isResting(), false);
});

test('a pressed song that sounded before its start returned ends the rest then', async () => {
  const page = openPage();
  await page.open();

  const switched = await page.press(OTHER);
  await page.sounds(OTHER);
  await switched.starts({ sounded: true });

  assert.equal(page.isResting(), false);
});

test('the restored track sounding itself keeps its request', async () => {
  const page = openPage();
  await page.open();

  await page.sounds(TRACK, 1);

  assert.equal(page.requestFor(TRACK).length, 1);
  assert.equal(page.requestFor(TRACK)[0].signal.aborted, false);
});

test('a gapless move to the next song ends the restored load', async () => {
  const page = openPage();
  await page.open();
  const restored = page.requestFor(TRACK)[0];
  page.context.getNextQueuedTrack = () => OTHER;
  page.context.peekNextQueuedTrack = () => null;

  await page.context.handleStreamingPlaybackBoundary({
    generation: 1,
    outgoingStreamId: 1,
    incomingStreamId: 2,
    outgoingTrackPath: TRACK.path,
    incomingTrackPath: OTHER.path,
  });
  await settle();

  assert.equal(restored.signal.aborted, true);
});

test('pressing the restored track again keeps its one request', async () => {
  const page = openPage();
  await page.open();

  const again = await page.press(TRACK);
  await again.starts();

  assert.equal(page.requestFor(TRACK).length, 1);
  assert.equal(page.requestFor(TRACK)[0].signal.aborted, false);
});

test('going back to the restored track before the other sounds loads it at once', async () => {
  const page = openPage();
  await page.open();

  await page.press(OTHER);
  const back = await page.press(TRACK);
  await back.starts();

  const building = page.pending();
  assert.deepEqual(building.map(({ url }) => url.searchParams.get('path')), [TRACK.path]);
  assertPlayingPriority(building[0]);
});

test('pressing the current song during a switch cancels the pressed song\'s build', async () => {
  const page = openPage();
  await page.open();
  // The engine's half of a cancel, whose file this page does not load.
  page.context.cancelStreamingWaveformGeneration = (generation) => page.context.cancelWaveformPeakLoads(generation);

  await page.press(OTHER);
  // Its stream opened and took over the press's request.
  void page.context.loadPlayingWaveformPeaks(OTHER.path);
  await settle();
  const replaced = page.requestFor(OTHER)[0];

  await page.press(TRACK);

  assert.equal(replaced.signal.aborted, true);
});

test('every playing-priority request names this page\'s playback client, and keeps that name', async () => {
  const page = openPage();
  let clientId = '4f7c0b62-2b55-4e0e-9a43-3f0c6f1d2a10';
  page.context.getPlaybackOwnershipTabId = () => clientId;
  await page.open();
  const named = clientId;
  // A refused renewal gives the tab a new claim identity mid-page; its builds are still this page's.
  clientId = 'ffffffff-2b55-4e0e-9a43-3f0c6f1d2a10';

  await page.press(OTHER);

  assert.deepEqual(page.waveformRequests().map(({ url }) => url.searchParams.get('client_id')), [named, named]);
});
