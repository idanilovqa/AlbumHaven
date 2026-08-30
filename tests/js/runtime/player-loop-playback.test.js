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
  'player-loop-playback.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

class FakeElement {
  constructor(options = {}) {
    this.tagName = options.tagName || 'DIV';
    this.disabled = Boolean(options.disabled);
    this.hidden = Boolean(options.hidden);
    this.type = options.type || '';
    this.value = options.value || '';
    this.isContentEditable = Boolean(options.isContentEditable);
    this.closestSelector = options.closestSelector || '';
    this.focusCalls = [];
    this.dataset = { ...(options.dataset || {}) };
    this.attributes = { ...(options.attributes || {}) };
    const classes = new Set(options.classNames || []);
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    };
    this.listeners = new Map();
    this.parentElement = options.parentElement || null;
    this.rectangle = {
      width: 640,
      height: 88,
      ...(options.rectangle || {}),
    };
  }

  getAttribute(name) {
    if (name === 'type') return this.type;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : '';
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  closest(selector) {
    return selector === this.closestSelector ? this : null;
  }

  focus(options = {}) {
    this.focusCalls.push(options);
  }

  getBoundingClientRect() {
    return { ...this.rectangle };
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatch(name, event = {}) {
    const handlers = this.listeners.get(name) || [];
    handlers.forEach((handler) => handler(event));
  }
}

class FakeAudioElement extends FakeElement {
  constructor(options = {}) {
    super({
      tagName: 'AUDIO',
      dataset: options.dataset,
      attributes: {
        src: options.src || '',
        ...(options.attributes || {}),
      },
    });
    this.currentTime = Number(options.currentTime) || 0;
    this.duration = Number(options.duration) || 0;
    this.paused = Object.prototype.hasOwnProperty.call(options, 'paused') ? Boolean(options.paused) : true;
    this.ended = Boolean(options.ended);
    this.preload = options.preload || 'none';
    this.autoplay = Boolean(options.autoplay);
    this.playCalls = 0;
    this.pauseCalls = 0;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.ended = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatch('pause');
  }
}

function loadHelper(overrides = {}) {
  const audio = overrides.audio || new FakeAudioElement({
    currentTime: 0,
    duration: 60,
    src: '/track?path=song.flac',
  });
  const timeline = overrides.timeline || new FakeElement({
    tagName: 'INPUT',
    type: 'range',
  });
  const playButton = overrides.playButton || new FakeElement({
    tagName: 'BUTTON',
  });
  const player = overrides.player || new FakeElement({
    tagName: 'DIV',
  });
  const context = {
    HTMLElement: FakeElement,
    state: {
      player: {
        current: { src: '/track?path=song.flac' },
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: {
          renderToken: 0,
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: Number(audio.currentTime) || 0,
      duration: Number(audio.duration) || 0,
      paused: Boolean(audio.paused),
      ended: Boolean(audio.ended),
      src: typeof audio.getAttribute === 'function' ? String(audio.getAttribute('src') || '') : '/track?path=song.flac',
    }),
    getPlayerElements: () => ({
      player,
      timeline,
      play: playButton,
    }),
    getComputedStyle: (element) => ({
      display: element.hidden ? 'none' : 'grid',
      opacity: '1',
      visibility: 'visible',
    }),
    closeListenSegment: () => {},
    markListenSessionPaused: () => {},
    maybeScrobbleListenSession: async () => {},
    resumeListenSessionPlayback: async () => null,
    pauseStreamingPlayback: () => {
      audio.pauseCalls += 1;
      audio.paused = true;
    },
    resumeStreamingPlayback: () => {
      audio.playCalls += 1;
      audio.paused = false;
      audio.ended = false;
      return Promise.resolve(true);
    },
    seekStreamingPlayback: (seconds) => {
      audio.currentTime = Number(seconds) || 0;
      return Promise.resolve();
    },
    updatePlayerUi: () => {},
    persistPlayerState: () => {},
    maybeSendNowPlaying: async () => {},
    finalizeListenSession: async () => {},
    showToast: () => {},
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: () => false,
      stop: () => false,
      has: () => false,
    },
    showLoopNameDialog: async () => null,
    showBrowserPrompt: () => {
      throw new Error('saveCurrentLoop must use the app-owned loop-name dialog');
    },
    buildUtilityLoopGroupKey: () => '',
    renderUtilityModalContent: () => {},
    getPlayerDuration: () => Number(audio.duration) || 0,
    formatLoopTime: (value) => String(value),
    getTimelineSecondsFromClientX: () => 0,
    getTrackIdentity: () => '',
    clearWaveformCanvas: () => {},
    resolveAlbumForPlayerTrack: () => null,
    openTrackModal: () => {},
    parseLoopTime: (value) => Number(value),
    setAlbumPlaybackQueue: () => {},
    updateLoopInputsFromState: () => {},
    updateWaveformAppearance: () => {},
    refreshTrackModalPlaybackState: () => {},
    refreshNonAlbumModalPlaybackState: () => {},
    getNextQueuedTrack: () => null,
    restorePlayerState: () => {},
    document: overrides.document || {
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }),
    console,
  };
  Object.assign(context, overrides, {
    audio,
    player,
    timeline,
    playButton,
  });
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, audio, timeline, playButton };
}

test('visible play control and global Space dispatch pause and resume through the streaming engine', async () => {
  const calls = [];
  const snapshot = {
    currentTime: 12,
    duration: 60,
    paused: false,
    ended: false,
    src: '/track?path=song.flac',
  };
  const audio = new FakeAudioElement({ paused: false, src: '/track?path=song.flac' });
  const { context, playButton, player } = (() => {
    const loaded = loadHelper({
      audio,
      getPlayerPlaybackSnapshot: () => ({ ...snapshot }),
      pauseStreamingPlayback: () => { calls.push('pause'); snapshot.paused = true; },
      resumeStreamingPlayback: () => { calls.push('resume'); snapshot.paused = false; },
      canStartPlaybackInThisTab: () => true,
    });
    return { ...loaded, player: loaded.context.player };
  })();
  context.attachPlayerEvents();

  playButton.dispatch('click');
  assert.deepEqual(calls, ['pause']);
  assert.equal(audio.pauseCalls, 0);
  context.handlePlayerKeyboardPlayback({
    key: ' ', code: 'Space', target: player, defaultPrevented: false,
    isComposing: false, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['pause', 'resume']);
  assert.equal(audio.playCalls, 0);
});

test('streaming position updates the facade at the bounded callback cadence', async () => {
  const track = {
    src: '/track?path=song.flac',
    path: 'C:/Music/song.flac',
    title: 'Song',
  };
  const session = { duration_seconds: 0 };
  const scrobbles = [];
  let uiUpdates = 0;
  const { context } = loadHelper({
    state: {
      player: {
        current: track,
        listenSession: session,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 12.5,
      duration: 60,
      paused: false,
      ended: false,
      src: track.src,
    }),
  });
  context.maybeScrobbleListenSession = async (activeSession) => scrobbles.push(activeSession);
  context.updatePlayerUi = () => { uiUpdates += 1; };

  await context.handleStreamingPlaybackPosition({
    generation: 3,
    streamId: 9,
    trackPath: track.path,
    timelineFrame: 600_000,
    currentTime: 12.5,
  });

  assert.equal(session.duration_seconds, 60);
  assert.deepEqual(scrobbles, [session]);
  assert.equal(uiUpdates, 1);
});

test('streaming pause and resume drive listen, now-playing, ownership, and UI effects', async () => {
  const track = {
    src: '/track?path=song.flac',
    path: 'C:/Music/song.flac',
    title: 'Song',
  };
  const pausedSession = { id: 'paused-session' };
  const resumedSession = { id: 'resumed-session' };
  const snapshot = {
    currentTime: 12,
    duration: 60,
    paused: false,
    ended: false,
    src: track.src,
  };
  const closedSegments = [];
  const pausedOffsets = [];
  const scrobbles = [];
  const ownershipClaims = [];
  const ownershipReleases = [];
  const listenResumes = [];
  const nowPlaying = [];
  let uiUpdates = 0;
  const { context } = loadHelper({
    state: {
      player: {
        current: track,
        listenSession: pausedSession,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({ ...snapshot }),
    pauseStreamingPlayback: async () => { snapshot.paused = true; },
    resumeStreamingPlayback: async () => { snapshot.paused = false; snapshot.ended = false; return true; },
    canStartPlaybackInThisTab: (activeTrack) => { ownershipClaims.push(activeTrack); return true; },
    releasePlaybackOwnership: (status, activeTrack) => ownershipReleases.push({ status, track: activeTrack }),
  });
  context.closeListenSegment = () => closedSegments.push('closed');
  context.markListenSessionPaused = (offset) => pausedOffsets.push(offset);
  context.maybeScrobbleListenSession = async (session) => scrobbles.push(session);
  context.resumeListenSessionPlayback = async (activeTrack, startSeconds) => {
    listenResumes.push({ track: activeTrack, startSeconds });
    return resumedSession;
  };
  context.maybeSendNowPlaying = async (activeTrack, session) => nowPlaying.push({ track: activeTrack, session });
  context.updatePlayerUi = () => { uiUpdates += 1; };

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(closedSegments, ['closed']);
  assert.deepEqual(pausedOffsets, [12]);
  assert.deepEqual(scrobbles, [pausedSession]);
  assert.deepEqual(ownershipReleases, [{ status: 'paused', track }]);
  assert.equal(uiUpdates, 1);

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ownershipClaims, [track]);
  assert.deepEqual(listenResumes, [{ track, startSeconds: 12 }]);
  assert.deepEqual(nowPlaying, [{ track, session: resumedSession }]);
  assert.equal(uiUpdates, 2);
});

test('global-player handoff shares its pending pause until streaming ownership is released', async () => {
  const snapshot = {
    currentTime: 12,
    duration: 60,
    paused: false,
    ended: false,
    src: '/track?path=song.flac',
  };
  let resolvePause;
  let pauseCalls = 0;
  const pendingPause = new Promise((resolve) => {
    resolvePause = resolve;
  });
  const { context } = loadHelper({
    getPlayerPlaybackSnapshot: () => ({ ...snapshot }),
    pauseStreamingPlayback: () => {
      pauseCalls += 1;
      snapshot.paused = true;
      return pendingPause;
    },
  });

  const firstHandoff = context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: false });
  const secondHandoff = context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: true });

  assert.equal(secondHandoff, firstHandoff);
  assert.equal(pauseCalls, 1);
  resolvePause();
  assert.equal(await firstHandoff, true);
  assert.equal(await secondHandoff, true);
  assert.equal(await context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: true }), false);
});

test('streaming terminal ended finalizes and releases ownership exactly once', async () => {
  const track = {
    src: '/track?path=song.flac',
    path: 'C:/Music/song.flac',
    title: 'Song',
  };
  const session = { id: 'terminal-session' };
  const finalizations = [];
  const releases = [];
  let uiUpdates = 0;
  const { context } = loadHelper({
    state: {
      player: {
        current: track,
        listenSession: session,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 42,
      duration: 42,
      paused: true,
      ended: true,
      src: track.src,
    }),
    releasePlaybackOwnership: (status, activeTrack) => releases.push({ status, track: activeTrack }),
  });
  context.finalizeListenSession = async (reason, payload) => finalizations.push({ reason, payload });
  context.updatePlayerUi = () => { uiUpdates += 1; };
  const event = {
    generation: 3,
    streamId: 9,
    trackPath: track.path,
    timelineFrame: 2_016_000,
    currentTime: 42,
  };

  await context.handleStreamingPlaybackEnded(event);
  await context.handleStreamingPlaybackEnded(event);

  assert.deepEqual(JSON.parse(JSON.stringify(finalizations)), [{
    reason: 'ended',
    payload: {
      session,
      currentTime: 42,
      duration: 42,
      finishedFully: true,
    },
  }]);
  assert.deepEqual(releases, [{ status: 'stopped', track }]);
  assert.equal(uiUpdates, 1);
});

test('play command after terminal EOS opens a fresh generation at frame zero before requesting resume', async () => {
  const track = {
    src: '/track?path=song.flac',
    path: 'C:/Music/song.flac',
    title: 'Song',
  };
  const calls = [];
  const { context } = loadHelper({
    state: {
      player: {
        current: track,
        listenSession: null,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 42,
      duration: 42,
      paused: true,
      ended: true,
      src: track.src,
    }),
    canStartPlaybackInThisTab: () => true,
    seekStreamingPlayback: async (seconds) => { calls.push(['seek', seconds]); },
    resumeStreamingPlayback: async () => { calls.push(['resume']); return true; },
  });

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [['seek', 0], ['resume']]);
});

test('timeline input, keyboard seek, and drag release each issue one streaming seek', () => {
  const seeks = [];
  const documentListeners = new Map();
  const document = {
    activeElement: null,
    querySelectorAll: () => [],
    addEventListener(name, handler) {
      const handlers = documentListeners.get(name) || [];
      handlers.push(handler);
      documentListeners.set(name, handlers);
    },
    dispatch(name, event = {}) {
      for (const handler of documentListeners.get(name) || []) handler(event);
    },
  };
  const timelineParent = new FakeElement();
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range' });
  timeline.parentElement = timelineParent;
  const { context } = loadHelper({
    document,
    timeline,
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 20, duration: 60, paused: false, ended: false, src: '/track?path=song.flac',
    }),
    seekStreamingPlayback: (seconds) => { seeks.push(seconds); },
  });
  timeline.rectangle = { ...timeline.rectangle, left: 0, width: 60 };
  timelineParent.rectangle = { ...timelineParent.rectangle, left: 0, width: 60 };
  context.attachPlayerEvents();
  timeline.value = '30';

  timeline.dispatch('input');
  assert.deepEqual(seeks, [30]);
  context.handlePlayerTimelineKeydown({
    key: 'ArrowLeft', defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false,
    shiftKey: false, preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(seeks, [30, 19]);

  timelineParent.dispatch('pointerdown', {
    target: timeline, clientX: 40, preventDefault() {},
  });
  timeline.value = '45';
  timeline.dispatch('input');
  document.dispatch('pointermove', { clientX: 45 });
  timeline.value = '50';
  timeline.dispatch('input');
  document.dispatch('pointermove', { clientX: 50 });
  timeline.value = '47';
  timeline.dispatch('input');
  assert.deepEqual(seeks, [30, 19], 'drag previews must not restart the decoder');
  context.updatePlayerUi();
  assert.equal(
    timeline.value,
    '50',
    'the native range value must not pull the wrapper-owned drag cursor backward',
  );
  document.dispatch('pointerup', { clientX: 50 });
  assert.deepEqual(seeks, [30, 19, 50], 'drag release performs exactly one seek at the final offset');
});

test('pause and seek rejections are observed by the streaming diagnostics boundary', async () => {
  const observed = [];
  const rejection = new Error('streaming control failed');
  const snapshot = {
    currentTime: 20, duration: 60, paused: false, ended: false, src: '/track?path=song.flac',
  };
  const { context, playButton, timeline } = loadHelper({
    getPlayerPlaybackSnapshot: () => snapshot,
    pauseStreamingPlayback: () => Promise.reject(rejection),
    resumeStreamingPlayback: () => Promise.resolve(true),
    seekStreamingPlayback: () => Promise.reject(rejection),
    observeStreamingFacadeCallback: (result, source) => {
      observed.push({ result, source });
      void result.catch(() => {});
    },
  });
  context.attachPlayerEvents();

  playButton.dispatch('click');
  timeline.value = '30';
  timeline.dispatch('input');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observed.map(({ source }) => source), [
    'pause-control-error',
    'seek-control-error',
  ]);
  assert.ok(observed.every(({ result }) => result && typeof result.then === 'function'));
});

test('playTrackFromPayload claims ownership and dispatches streaming start without assigning native src', async () => {
  const nativeSrcAssignments = [];
  const audio = new FakeAudioElement({ src: '' });
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const ownershipClaims = [];
  const streamingStarts = [];
  const { context } = loadHelper({
    audio,
    canStartPlaybackInThisTab(track) {
      ownershipClaims.push(track);
      return true;
    },
    async startStreamingTrack(track, options) {
      streamingStarts.push({ track, options });
    },
  });
  const track = {
    path: 'C:\\Music\\Streaming.flac',
    src: '/track?path=Streaming.flac',
    title: 'Streaming',
    durationSeconds: 42,
  };

  await context.playTrackFromPayload(track, { autoplay: true });

  assert.deepEqual(ownershipClaims, [track]);
  assert.equal(streamingStarts.length, 1);
  assert.strictEqual(streamingStarts[0].track, track);
  assert.deepEqual(nativeSrcAssignments, []);
});

test('ownership denial leaves streaming, current track, and native src untouched', async () => {
  const current = { path: 'C:\\Music\\Current.flac', title: 'Current' };
  const audio = new FakeAudioElement({ src: '' });
  const nativeSrcAssignments = [];
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  let streamingStarts = 0;
  const { context } = loadHelper({
    audio,
    state: {
      player: { current, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    canStartPlaybackInThisTab: () => false,
    async startStreamingTrack() {
      streamingStarts += 1;
    },
  });

  await context.playTrackFromPayload({
    path: 'C:\\Music\\Denied.flac', src: '/track?path=Denied.flac', title: 'Denied',
  });

  assert.equal(streamingStarts, 0);
  assert.strictEqual(context.state.player.current, current);
  assert.deepEqual(nativeSrcAssignments, []);
});

test('streaming start rejection stays inspectable and never falls back to native src', async () => {
  const audio = new FakeAudioElement({ src: '' });
  const nativeSrcAssignments = [];
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const failure = new Error('streaming transport rejected');
  const { context } = loadHelper({
    audio,
    canStartPlaybackInThisTab: () => true,
    startStreamingTrack: async () => { throw failure; },
  });

  await assert.rejects(
    context.playTrackFromPayload({
      path: 'C:\\Music\\Rejected.flac', src: '/track?path=Rejected.flac', title: 'Rejected',
    }),
    (error) => error === failure,
  );
  assert.deepEqual(nativeSrcAssignments, []);
});

test('a stale rapid-selection start completion cannot replace the newer streaming track', async () => {
  const createDeferred = () => {
    let resolve;
    const promise = new Promise((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
  };
  const firstStart = createDeferred();
  const secondStart = createDeferred();
  const starts = [firstStart, secondStart];
  const audio = new FakeAudioElement({ src: '' });
  const nativeSrcAssignments = [];
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const listenTracks = [];
  const nowPlayingTracks = [];
  const uiCurrentPaths = [];
  let startIndex = 0;
  const { context } = loadHelper({
    audio,
    canStartPlaybackInThisTab: () => true,
    startStreamingTrack: () => starts[startIndex++].promise,
    resumeListenSessionPlayback: async (track) => {
      listenTracks.push(track);
      return { track };
    },
    maybeSendNowPlaying: async (track) => {
      nowPlayingTracks.push(track);
    },
  });
  context.updatePlayerUi = () => {
    uiCurrentPaths.push(String(context.state.player.current?.path || ''));
  };
  const olderTrack = {
    path: 'C:\\Music\\Older.flac', src: '/track?path=Older.flac', title: 'Older',
  };
  const newerTrack = {
    path: 'C:\\Music\\Newer.flac', src: '/track?path=Newer.flac', title: 'Newer',
  };

  const olderResult = context.playTrackFromPayload(olderTrack);
  const newerResult = context.playTrackFromPayload(newerTrack);
  secondStart.resolve({ role: 'current', streamId: 2, generation: 2 });
  await newerResult;
  firstStart.resolve({ role: 'current', streamId: 1, generation: 1 });
  await olderResult;
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(context.state.player.current, newerTrack);
  assert.deepEqual(listenTracks, [newerTrack]);
  assert.deepEqual(nowPlayingTracks, [newerTrack]);
  assert.equal(uiCurrentPaths.length, 2);
  assert.equal(uiCurrentPaths.every((path) => path === newerTrack.path), true);
  assert.deepEqual(nativeSrcAssignments, []);
  assert.equal(audio.playCalls, 0);
});

test('playTrackFromPayload reconciles a promoted-current notification exactly once before continuity scheduling', async () => {
  const outgoing = {
    path: 'C:\\Music\\Outgoing.flac', src: '/track?path=Outgoing.flac', title: 'Outgoing',
  };
  const replacement = {
    path: 'C:\\Music\\Replacement.flac', src: '/track?path=Replacement.flac', title: 'Replacement',
  };
  const adjacent = {
    path: 'C:\\Music\\Adjacent.flac', src: '/track?path=Adjacent.flac', title: 'Adjacent',
  };
  const audio = new FakeAudioElement({ paused: false, src: '' });
  const starts = [];
  const scheduled = [];
  const listenTracks = [];
  const nowPlayingTracks = [];
  const uiCurrentPaths = [];
  const promotedCurrent = {
    role: 'current', generation: 4, streamId: 12, track: replacement, firstFrameNotified: true,
  };
  const { context } = loadHelper({
    audio,
    state: {
      player: { current: outgoing, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    canStartPlaybackInThisTab: () => true,
    async startStreamingTrack(track, options) {
      starts.push({ track, options });
      return promotedCurrent;
    },
    peekNextQueuedTrack: () => adjacent,
    async scheduleStreamingContinuity(track) {
      scheduled.push(track);
    },
    async resumeListenSessionPlayback(track) {
      listenTracks.push(track);
      return { track };
    },
    async maybeSendNowPlaying(track) {
      nowPlayingTracks.push(track);
    },
  });
  context.updatePlayerUi = () => {
    uiCurrentPaths.push(String(context.state.player.current?.path || ''));
  };
  const repeatedFirstFrame = {
    generation: promotedCurrent.generation,
    streamId: promotedCurrent.streamId,
    trackPath: replacement.path,
  };

  await context.playTrackFromPayload(replacement, { autoplay: true });
  assert.deepEqual(
    scheduled,
    [adjacent],
    'selected-track synchronization reconciles the replacement first frame',
  );
  await context.handleStreamingPlaybackFirstFrame(repeatedFirstFrame);
  await context.handleStreamingPlaybackFirstFrame(repeatedFirstFrame);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(starts.length, 1, 'reconciliation never reopens the already-current stream');
  assert.strictEqual(starts[0].track, replacement);
  assert.deepEqual(scheduled, [adjacent], 'the promoted current prepares its adjacent queued-next once');
  assert.deepEqual(listenTracks, [replacement]);
  assert.deepEqual(nowPlayingTracks, [replacement]);
  assert.deepEqual(uiCurrentPaths, [replacement.path, replacement.path]);
  assert.equal(audio.playCalls, 0, 'reconciliation never returns to native audio playback');
});

test('streaming first-frame scheduling peeks exactly one queued track', async () => {
  const nextTrack = { path: 'C:\\Music\\Next.flac', durationSeconds: 30 };
  let peekCalls = 0;
  const scheduled = [];
  const { context } = loadHelper({
    peekNextQueuedTrack() {
      peekCalls += 1;
      return nextTrack;
    },
    async scheduleStreamingContinuity(track) {
      scheduled.push(track);
    },
  });

  await context.handleStreamingPlaybackFirstFrame({ generation: 1, streamId: 7 });

  assert.equal(peekCalls, 1);
  assert.deepEqual(scheduled, [nextTrack]);
});

test('streaming boundary consumes the queued track exactly once', async () => {
  const nextTrack = { path: 'C:\\Music\\Next.flac', durationSeconds: 30 };
  let consumeCalls = 0;
  const { context } = loadHelper({
    getNextQueuedTrack() {
      consumeCalls += 1;
      return nextTrack;
    },
  });

  await context.handleStreamingPlaybackBoundary({
    generation: 1,
    outgoingStreamId: 7,
    incomingStreamId: 8,
  });

  assert.equal(consumeCalls, 1);
});

test('duplicate streaming boundary notification is an idempotent queue no-op', async () => {
  const outgoing = { path: 'C:\\Music\\Outgoing.flac', durationSeconds: 30 };
  const incoming = { path: 'C:\\Music\\Incoming.flac', durationSeconds: 30 };
  let consumeCalls = 0;
  const { context } = loadHelper({
    state: {
      player: { current: outgoing, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    peekNextQueuedTrack: () => incoming,
    getNextQueuedTrack() { consumeCalls += 1; return incoming; },
  });
  const boundary = {
    generation: 7, outgoingStreamId: 41, incomingStreamId: 42,
    outgoingTrackPath: outgoing.path, incomingTrackPath: incoming.path, renderedFrame: 1440000,
  };

  await context.handleStreamingPlaybackBoundary(boundary);
  await context.handleStreamingPlaybackBoundary(boundary);

  assert.equal(consumeCalls, 1);
  assert.strictEqual(context.state.player.current, incoming);
});

test('queued boundary hands off listen side effects exactly once at the processor offset', async () => {
  const outgoing = { path: 'C:\\Music\\Outgoing.flac', src: '/track?path=outgoing.flac', durationSeconds: 31 };
  const incoming = { path: 'C:\\Music\\Incoming.flac', src: '/track?path=incoming.flac', durationSeconds: 30 };
  const outgoingSession = { track: outgoing, completionState: '', segmentActive: true };
  const incomingSession = { track: incoming, completionState: '', segmentActive: true };
  const exactOutgoingSnapshot = {
    currentTime: 30.625,
    duration: 31,
    paused: false,
    ended: false,
    src: outgoing.src,
    mode: 'streaming',
  };
  let consumeCalls = 0;
  const finalizations = [];
  const listenStarts = [];
  const nowPlaying = [];
  const { context } = loadHelper({
    state: {
      player: {
        current: outgoing,
        listenSession: outgoingSession,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getTrackIdentity: (track) => `${String(track?.path || '')}::${String(track?.src || '')}`,
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0.125,
      duration: incoming.durationSeconds,
      paused: false,
      ended: false,
      src: incoming.src,
      mode: 'streaming',
    }),
    peekNextQueuedTrack: () => incoming,
    getNextQueuedTrack() {
      consumeCalls += 1;
      return incoming;
    },
    finalizeListenSession: async (reason, options) => {
      finalizations.push({ reason, options });
      if (context.state.player.listenSession === options.session) {
        context.state.player.listenSession = null;
      }
    },
    resumeListenSessionPlayback: async (track, startSeconds) => {
      listenStarts.push({ track, startSeconds });
      context.state.player.listenSession = incomingSession;
      return incomingSession;
    },
    maybeSendNowPlaying: async (track, session) => {
      nowPlaying.push({ track, session });
    },
  });
  context.attachPlayerEvents();
  const boundary = {
    generation: 7,
    outgoingStreamId: 41,
    incomingStreamId: 42,
    outgoingTrackPath: outgoing.path,
    incomingTrackPath: incoming.path,
    outgoingPlaybackSnapshot: exactOutgoingSnapshot,
  };

  await context.handleStreamingPlaybackBoundary(boundary);
  await context.handleStreamingPlaybackBoundary(boundary);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(consumeCalls, 1);
  assert.equal(finalizations.length, 1);
  assert.equal(finalizations[0].reason, 'ended');
  assert.strictEqual(finalizations[0].options.session, outgoingSession);
  assert.equal(finalizations[0].options.currentTime, exactOutgoingSnapshot.currentTime);
  assert.equal(finalizations[0].options.duration, exactOutgoingSnapshot.duration);
  assert.equal(finalizations[0].options.finishedFully, true);
  assert.deepEqual(listenStarts, [{ track: incoming, startSeconds: 0 }]);
  assert.deepEqual(nowPlaying, [{ track: incoming, session: incomingSession }]);
  assert.strictEqual(context.state.player.current, incoming);
});

test('queue mutation invalidates the prepared incoming identity before boundary consumption', async () => {
  const outgoing = { path: 'C:\\Music\\Outgoing.flac' };
  const prepared = { path: 'C:\\Music\\Prepared.flac' };
  const reordered = { path: 'C:\\Music\\Reordered.flac' };
  let next = prepared;
  let consumeCalls = 0;
  const { context } = loadHelper({
    state: {
      player: { current: outgoing, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    peekNextQueuedTrack: () => next,
    getNextQueuedTrack() { consumeCalls += 1; return next; },
  });
  await context.handleStreamingPlaybackFirstFrame({ generation: 9, streamId: 51 });
  next = reordered;

  await assert.rejects(context.handleStreamingPlaybackBoundary({
    generation: 9, outgoingStreamId: 51, incomingStreamId: 52,
    outgoingTrackPath: outgoing.path, incomingTrackPath: prepared.path,
  }), /identity|mismatch/i);
  assert.equal(consumeCalls, 0);
  assert.strictEqual(context.state.player.current, outgoing);
});

test('enabling and disabling an A/B loop swaps one continuity role then restores queued-next', async () => {
  const current = { path: 'C:\\Music\\Current.flac', durationSeconds: 30 };
  const queued = { path: 'C:\\Music\\Queued.flac', durationSeconds: 30 };
  const scheduled = [];
  const loopMessages = [];
  const { context, audio } = loadHelper({
    audio: new FakeAudioElement({ currentTime: 12, duration: 30, paused: false }),
    state: {
      player: { current, loopActive: false, loopStart: 10, loopEnd: 14, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    getPlayerPlaybackSnapshot: () => ({ currentTime: 12, duration: 30, paused: false, ended: false, src: current.path }),
    peekNextQueuedTrack: () => queued,
    scheduleStreamingContinuity: async (track, options) => { scheduled.push({ track, options }); },
    setStreamingLoop: (...args) => { loopMessages.push(args); },
  });
  context.state.player.loopStart = 10;
  context.state.player.loopEnd = 14;

  context.setLoopActive(true);
  await new Promise((resolve) => setImmediate(resolve));
  context.setLoopBoundary('start', 10);
  context.setLoopBoundary('end', 14);
  context.setLoopActive(false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(scheduled.map(({ track, options }) => ({
    path: track.path,
    options: { ...options },
  })), [
    { path: current.path, options: { kind: 'whole-track-repeat', startSeconds: 0, endSeconds: 30 } },
    { path: current.path, options: { kind: 'short-loop', startSeconds: 10, endSeconds: 14 } },
    { path: queued.path, options: { kind: 'queued-next', startSeconds: 0 } },
  ]);
  assert.deepEqual(loopMessages, [[false, 10, 14]], 'the engine schedule owns active loop configuration');
  assert.equal(audio.playCalls, 0, 'bottom-player loops never return to native playback');
});

test('enabling the untouched full-track range prepares whole-track repeat from frame zero', async () => {
  const current = { path: 'C:\\Music\\Repeat.flac', durationSeconds: 30 };
  const scheduled = [];
  const { context } = loadHelper({
    audio: new FakeAudioElement({ currentTime: 12, duration: 30, paused: false }),
    state: {
      player: { current, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    getPlayerPlaybackSnapshot: () => ({ currentTime: 12, duration: 30, paused: false, ended: false, src: current.path }),
    scheduleStreamingContinuity: async (track, options) => { scheduled.push({ track, options }); },
  });

  context.setLoopActive(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(scheduled.map(({ track, options }) => ({ path: track.path, options: { ...options } })), [{
    path: current.path,
    options: { kind: 'whole-track-repeat', startSeconds: 0, endSeconds: 30 },
  }]);
});

test('streaming boundary schedules the third track while optional waveform promotion remains unresolved', async () => {
  const outgoing = { path: 'C:\\Music\\Outgoing.flac', durationSeconds: 30 };
  const incoming = { path: 'C:\\Music\\Incoming.flac', durationSeconds: 30 };
  const third = { path: 'C:\\Music\\Third.flac', durationSeconds: 30 };
  const queue = [incoming, third];
  let consumeCalls = 0;
  let rejectPromotion;
  let promotionSettled = false;
  let boundarySettled = false;
  const promotionCalls = [];
  const scheduled = [];
  const warnings = [];
  const promotion = new Promise((resolve, reject) => {
    rejectPromotion = reject;
  });
  void promotion.then(
    () => { promotionSettled = true; },
    () => { promotionSettled = true; },
  );
  const { context } = loadHelper({
    state: {
      player: {
        current: outgoing,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        waveform: { renderToken: 0, compactPeaks: null },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    peekNextQueuedTrack: () => queue[0] || null,
    getNextQueuedTrack: () => {
      consumeCalls += 1;
      return queue.shift() || null;
    },
    getPlayerPlaybackSnapshot: () => ({
      generation: 7, currentTime: 0, duration: 30, paused: false, ended: false, src: incoming.src || '',
    }),
    promoteWaveformPeaks: (...args) => {
      promotionCalls.push(args);
      return promotion;
    },
    scheduleStreamingContinuity: async (track) => { scheduled.push(track); },
    console: {
      ...console,
      warn: (...args) => { warnings.push(args); },
    },
  });

  const boundary = {
    generation: 7,
    outgoingStreamId: 41,
    incomingStreamId: 42,
    outgoingTrackPath: outgoing.path,
    incomingTrackPath: incoming.path,
  };
  const firstBoundary = context.handleStreamingPlaybackBoundary(boundary);
  void firstBoundary.then(() => { boundarySettled = true; });
  await context.handleStreamingPlaybackBoundary(boundary);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promotionSettled, false, 'optional peak promotion remains unresolved');
  assert.equal(boundarySettled, true, 'boundary bookkeeping never awaits optional peak promotion');
  assert.equal(consumeCalls, 1, 'duplicate boundary notification consumes the incoming track once');
  assert.strictEqual(context.state.player.current, incoming);
  assert.deepEqual(scheduled, [third], 'the newly adjacent third track is prepared immediately');
  assert.deepEqual(promotionCalls, [[outgoing.path, incoming.path, 7]]);

  const rejection = new Error('optional compact peaks failed');
  rejectPromotion(rejection);
  await firstBoundary;
  await new Promise((resolve) => setImmediate(resolve));
  await context.handleStreamingPlaybackBoundary(boundary);

  assert.equal(warnings.length, 1, 'optional peak rejection is observed once as a warning');
  assert.match(String(warnings[0][0]), /optional peak promotion failed/i);
  assert.strictEqual(warnings[0][1], rejection);
  assert.equal(consumeCalls, 1, 'settled duplicate boundary remains an exact no-op');
  assert.deepEqual(scheduled, [third], 'settled duplicate boundary does not prepare continuity twice');
  assert.deepEqual(promotionCalls, [[outgoing.path, incoming.path, 7]]);
});

test('streaming boundary identity mismatch fails without consuming or changing current track', async () => {
  const current = { path: 'C:\\Music\\Current.flac', title: 'Current' };
  let consumeCalls = 0;
  const { context } = loadHelper({
    state: {
      player: { current, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    getNextQueuedTrack() {
      consumeCalls += 1;
      return { path: 'C:\\Music\\Expected.flac' };
    },
  });

  await assert.rejects(
    context.handleStreamingPlaybackBoundary({
      generation: 1,
      outgoingStreamId: 7,
      incomingStreamId: 8,
      outgoingTrackPath: 'C:\\Music\\Wrong.flac',
      incomingTrackPath: 'C:\\Music\\Unexpected.flac',
    }),
    /identity|mismatch/i,
  );
  assert.equal(consumeCalls, 0);
  assert.strictEqual(context.state.player.current, current);
});

{
  const loopStartInput = new FakeElement({
    tagName: 'INPUT',
    type: 'text',
    value: '12.5',
  });
  const loopEndInput = new FakeElement({
    tagName: 'INPUT',
    type: 'text',
    value: 'stale',
  });
  const document = {
    activeElement: loopStartInput,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const { context, audio, timeline, playButton } = loadHelper({
    document,
    state: {
      player: {
        current: { src: '/track?path=song.flac' },
        loopActive: true,
        loopStart: 10,
        loopEnd: 20,
        saveBusy: false,
        waveform: {
          renderToken: 0,
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    getPlayerElements: () => ({
      audio,
      timeline,
      play: playButton,
      loopStartInput,
      loopEndInput,
    }),
  });

  context.attachPlayerEvents();
  context.updateLoopInputsFromState();

  assert.equal(loopStartInput.value, '12.5');
  assert.equal(loopEndInput.value, '20');

  loopStartInput.dispatch('change');

  assert.equal(context.state.player.loopStart, 12.5);
  assert.equal(context.state.player.loopEnd, 20);
}

{
  const { context, audio } = loadHelper({
    state: {
      player: {
        current: { src: '/track?path=song.flac' },
        loopActive: true,
        loopStart: 10,
        loopEnd: 20,
        saveBusy: false,
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    audio: {
      currentTime: 20,
      duration: 60,
    },
  });
  let prevented = false;
  let stopped = false;

  context.handlePlayerTimelineKeydown({
    key: 'ArrowLeft',
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(audio.currentTime, 19);
}

{
  const { context, audio } = loadHelper({
    audio: {
      currentTime: 12,
      duration: 60,
    },
  });

  context.handlePlayerTimelineKeydown({
    key: 'ArrowRight',
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(audio.currentTime, 17);
}

{
  const { context, audio } = loadHelper({
    audio: {
      currentTime: 12,
      duration: 60,
    },
  });
  let prevented = false;

  context.handlePlayerTimelineKeydown({
    key: 'ArrowRight',
    defaultPrevented: false,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  assert.equal(prevented, false);
  assert.equal(audio.currentTime, 12);
}

{
  const calls = {
    showToast: [],
    updatePlayerUi: 0,
  };
  const audio = new FakeAudioElement({
    paused: true,
    src: '/track?path=song.flac',
    duration: 60,
  });
  const playButton = new FakeElement({
    tagName: 'BUTTON',
  });
  const { context } = loadHelper({
    audio,
    playButton,
    canStartPlaybackInThisTab: () => {
      calls.showToast.push(['Playback is active in another tab.', 'error', 2800]);
      return false;
    },
    showToast: (message, tone, duration) => {
      calls.showToast.push([message, tone, duration]);
    },
    updatePlayerUi: () => {
      calls.updatePlayerUi += 1;
    },
  });

  context.attachPlayerEvents();
  playButton.dispatch('click');

  assert.equal(audio.playCalls, 0);
  assert.deepEqual(calls.showToast, [['Playback is active in another tab.', 'error', 2800]]);
  assert.equal(calls.updatePlayerUi, 0);
}

{
  const target = new FakeElement({
    tagName: 'BUTTON',
    closestSelector: '.global-player',
  });
  const { context, audio, timeline } = loadHelper({
    audio: {
      currentTime: 20,
      duration: 60,
    },
  });
  let prevented = false;

  context.handlePlayerKeyboardSeek({
    key: 'ArrowLeft',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  assert.equal(prevented, true);
  assert.equal(audio.currentTime, 19);
  assert.deepEqual(JSON.parse(JSON.stringify(timeline.focusCalls)), [{ preventScroll: true }]);
}

{
  const target = new FakeElement({
    tagName: 'INPUT',
    type: 'text',
    closestSelector: '.global-player',
  });
  const { context, audio, timeline } = loadHelper({
    audio: {
      currentTime: 20,
      duration: 60,
    },
  });

  context.handlePlayerKeyboardSeek({
    key: 'ArrowLeft',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(audio.currentTime, 20);
  assert.equal(timeline.focusCalls.length, 0);
}

{
  const audio = new FakeAudioElement({
    currentTime: 57,
    duration: 60,
    paused: true,
    src: '/track?path=song.flac',
  });
  const { context } = loadHelper({
    audio,
    state: {
      player: {
        current: { src: '/track?path=song.flac' },
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: {
          renderToken: 0,
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
  });

  context.setLoopActive(true);

  assert.equal(context.state.player.loopActive, true);
  assert.equal(audio.currentTime, 57, 'streaming loop setup does not seek the legacy audio element');
  assert.equal(context.state.player.loopEnd, 60);
}

test('shared player click awaits accepted streaming-start command before current-track and now-playing effects', async () => {
  const rawTitle = 'Track Two (feat. Guest Singer)';
  const trackPath = 'C:/Music/Artist Alpha/Album Alpha/02 Track.flac';
  const source = `/track?path=${encodeURIComponent(trackPath)}`;
  const playTrackButton = new FakeElement({
    tagName: 'BUTTON',
    attributes: {
      'data-src': source,
      'data-track-path': trackPath,
      'data-track-title': rawTitle,
      'data-track-artist': 'Solo Voice',
      'data-track-album-artist': 'Various Artists',
      'data-track-album': 'Album Alpha',
      'data-track-cover': '',
    },
  });
  const nowPlayingTracks = [];
  const streamingStarts = [];
  const audio = new FakeAudioElement({ src: '' });
  const document = {
    querySelectorAll(selector) {
      return selector === '.play-track-button' ? [playTrackButton] : [];
    },
    getElementById(id) {
      return id === 'track-modal' ? { hidden: true } : null;
    },
    addEventListener() {},
  };
  const { context } = loadHelper({
    audio,
    document,
    state: {
      player: {
        current: null,
        playbackQueue: null,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    maybeSendNowPlaying: async (track) => {
      nowPlayingTracks.push(track);
    },
    async startStreamingTrack(track) {
      streamingStarts.push(track);
      return { role: 'current', streamId: 7, generation: 1 };
    },
    resumeListenSessionPlayback: () => ({
      then(callback) {
        callback({ started_at: '2026-05-19T00:00:00Z' });
        return Promise.resolve();
      },
    }),
  });

  context.attachPlayerEvents();
  context.attachSharedPlayer();
  playTrackButton.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streamingStarts.length, 1);
  assert.equal(streamingStarts[0].path, trackPath);
  assert.equal(context.state.player.current.title, rawTitle);
  assert.equal(context.state.player.current.artist, 'Solo Voice');
  assert.equal(context.state.player.current.albumArtist, 'Various Artists');
  assert.equal(nowPlayingTracks.length, 1);
  assert.equal(nowPlayingTracks[0].title, rawTitle);
});

{
  const audio = new FakeAudioElement({
    currentTime: 20,
    duration: 60,
    paused: false,
    src: '/track?path=song.flac',
  });
  const { context } = loadHelper({
    audio,
    state: {
      player: {
        current: { src: '/track?path=song.flac' },
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: {
          renderToken: 0,
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
  });

  context.setLoopActive(true);

  assert.equal(audio.currentTime, 20);
}

{
  const currentTrack = {
    src: '/track?path=song1.flac',
    path: 'C:/Music/song1.flac',
    title: 'Song 1',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const nextTrack = {
    src: '/track?path=song2.flac',
    path: 'C:/Music/song2.flac',
    title: 'Song 2',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const finalTrack = {
    src: '/track?path=song3.flac',
    path: 'C:/Music/song3.flac',
    title: 'Song 3',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const audio = new FakeAudioElement({
    currentTime: 41,
    duration: 42,
    paused: true,
    src: currentTrack.src,
  });
  const nativeSrcAssignments = [];
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const finalizeCalls = [];
  const resumeCalls = [];
  let queueConsumeCalls = 0;
  const { context, playButton } = loadHelper({
    audio,
    state: {
      player: {
        current: currentTrack,
        playbackQueue: {
          tracks: [currentTrack, nextTrack, finalTrack],
          currentIndex: 0,
        },
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: {
          renderToken: 0,
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    resumeListenSessionPlayback: async (track) => {
      resumeCalls.push(track);
      return { started_at: '2026-05-19T00:00:00Z' };
    },
    finalizeListenSession: async (reason, payload) => {
      finalizeCalls.push([reason, payload]);
    },
    getPlayerPlaybackSnapshot: () => ({
      mode: 'playing',
      currentTime: 41,
      duration: 42,
      paused: false,
      ended: false,
      src: currentTrack.src,
      readyState: 4,
    }),
    getNextQueuedTrack: () => {
      queueConsumeCalls += 1;
      const queue = context.state.player.playbackQueue;
      if (!queue || !Array.isArray(queue.tracks)) return null;
      const nextIndex = Number(queue.currentIndex) + 1;
      if (nextIndex >= queue.tracks.length) return null;
      queue.currentIndex = nextIndex;
      return queue.tracks[nextIndex];
    },
  });

  context.attachPlayerEvents();

  playButton.dispatch('click');
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.paused, true);
  assert.deepEqual(resumeCalls, []);

  assert.equal(finalizeCalls.length, 0, 'a stale native ended event must not finalize streaming playback');
  assert.equal(queueConsumeCalls, 0, 'a stale native ended event must not consume the streaming queue');
  assert.strictEqual(context.state.player.current, currentTrack);
  assert.equal(context.state.player.playbackQueue.currentIndex, 0);
  assert.deepEqual(nativeSrcAssignments, []);
  assert.equal(audio.getAttribute('src'), currentTrack.src);
  assert.equal(audio.playCalls, 0);
  assert.deepEqual(resumeCalls, []);
}

test('queued album track click dispatches streaming start without touching native audio', async () => {
  const trackPath = 'C:/Music/Artist/Album/01 Long Song.mp3';
  const trackSource = `/track?path=${encodeURIComponent(trackPath)}`;
  const selectedTrack = {
    src: trackSource,
    path: trackPath,
    title: 'Long Song',
    artist: 'Artist',
    albumArtist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 245,
  };
  const queuedTrack = {
    src: '/track?path=C%3A%2FMusic%2FArtist%2FAlbum%2F02%20Next%20Song.mp3',
    path: 'C:/Music/Artist/Album/02 Next Song.mp3',
    title: 'Next Song',
    artist: 'Artist',
    albumArtist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const playTrackButton = new FakeElement({
    tagName: 'BUTTON',
    attributes: {
      'data-src': selectedTrack.src,
      'data-track-path': selectedTrack.path,
      'data-track-title': selectedTrack.title,
      'data-track-artist': selectedTrack.artist,
      'data-track-album-artist': selectedTrack.albumArtist,
      'data-track-album': selectedTrack.album,
      'data-track-cover': selectedTrack.coverPath,
      'data-track-duration-seconds': String(selectedTrack.durationSeconds),
    },
  });
  const audio = new FakeAudioElement({ src: '' });
  const nativeSrcAssignments = [];
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const streamingStarts = [];
  const album = { title: 'Album' };
  const document = {
    querySelectorAll(selector) {
      return selector === '.play-track-button' ? [playTrackButton] : [];
    },
    getElementById(id) {
      return id === 'track-modal' ? { hidden: false } : null;
    },
    addEventListener() {},
  };
  let context;
  ({ context } = loadHelper({
    audio,
    document,
    state: {
      player: {
        current: null,
        playbackQueue: null,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      modalReleases: [album],
      modalReleaseIndex: 0,
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    setAlbumPlaybackQueue: () => {
      context.state.player.playbackQueue = {
        tracks: [selectedTrack, queuedTrack],
        currentIndex: 0,
      };
    },
    async startStreamingTrack(track) {
      streamingStarts.push(track);
      return { role: 'current', streamId: 11, generation: 2 };
    },
  }));

  context.attachSharedPlayer();
  playTrackButton.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(streamingStarts.length, 1);
  assert.equal(streamingStarts[0].path, selectedTrack.path);
  assert.equal(streamingStarts[0].durationSeconds, selectedTrack.durationSeconds);
  assert.equal(audio.playCalls, 0);
  assert.deepEqual(nativeSrcAssignments, []);
  assert.equal(audio.getAttribute('src'), '');
  assert.equal(audio.paused, true);
  assert.equal(context.state.player.current.path, selectedTrack.path);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.playbackQueue)), {
    tracks: [selectedTrack, queuedTrack],
    currentIndex: 0,
  });
});

test('album-row click awaits prepared-start acceptance before installing one first-frame continuity queue', async () => {
  const selectedTrack = {
    src: '/track?path=C%3A%2FMusic%2FArtist%2FAlbum%2F07%20Selected.mp3',
    path: 'C:/Music/Artist/Album/07 Selected.mp3',
    title: 'Selected',
    artist: 'Artist',
    albumArtist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 60,
  };
  const queuedTrack = {
    src: '/track?path=C%3A%2FMusic%2FArtist%2FAlbum%2F08%20Queued.mp3',
    path: 'C:/Music/Artist/Album/08 Queued.mp3',
    title: 'Queued',
    artist: 'Artist',
    albumArtist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 60,
  };
  const album = { title: 'Album' };
  const exactQueue = {
    tracks: [selectedTrack, queuedTrack],
    currentIndex: 0,
  };
  const playTrackButton = new FakeElement({
    tagName: 'BUTTON',
    attributes: {
      'data-src': selectedTrack.src,
      'data-track-path': selectedTrack.path,
      'data-track-title': selectedTrack.title,
      'data-track-artist': selectedTrack.artist,
      'data-track-album-artist': selectedTrack.albumArtist,
      'data-track-album': selectedTrack.album,
      'data-track-cover': selectedTrack.coverPath,
      'data-track-duration-seconds': String(selectedTrack.durationSeconds),
    },
  });
  const document = {
    querySelectorAll(selector) {
      return selector === '.play-track-button' ? [playTrackButton] : [];
    },
    getElementById(id) {
      return id === 'track-modal' ? { hidden: false } : null;
    },
    addEventListener() {},
  };
  const callOrder = [];
  let playbackStartCalls = 0;
  let queueInstallCalls = 0;
  let lifecycleCalls = 0;
  let continuityCalls = 0;
  let pauseCalls = 0;
  let resolvePreparedStart;
  const preparedStart = new Promise((resolve) => {
    resolvePreparedStart = resolve;
  });
  let context;
  ({ context } = loadHelper({
    document,
    state: {
      player: {
        current: null,
        playbackQueue: null,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      modalReleases: [album],
      modalReleaseIndex: 0,
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0.05,
      duration: selectedTrack.durationSeconds,
      paused: false,
      ended: false,
      src: String(context?.state.player.current?.src || ''),
    }),
    setAlbumPlaybackQueue(receivedAlbum, startingTrackPath) {
      callOrder.push('queue-install');
      queueInstallCalls += 1;
      assert.strictEqual(receivedAlbum, album);
      assert.equal(startingTrackPath, selectedTrack.path);
      context.state.player.playbackQueue = exactQueue;
    },
    async startStreamingTrack(track) {
      callOrder.push('streaming-start');
      playbackStartCalls += 1;
      await preparedStart;
      return {
        role: 'continuity',
        generation: 3,
        streamId: 21,
        track,
        firstFrameNotified: true,
      };
    },
    peekNextQueuedTrack() {
      callOrder.push('first-frame-peek');
      assert.strictEqual(context.state.player.playbackQueue, exactQueue);
      return queuedTrack;
    },
    scheduleStreamingContinuity(track) {
      callOrder.push('continuity-schedule');
      continuityCalls += 1;
      assert.strictEqual(track, queuedTrack);
      return Promise.resolve({ role: 'continuity', streamId: 22 });
    },
    resumeListenSessionPlayback: async () => {
      callOrder.push('lifecycle-start');
      lifecycleCalls += 1;
      return null;
    },
    pauseStreamingPlayback: () => {
      callOrder.push('current-track-toggle');
      pauseCalls += 1;
    },
  }));
  const productionPlayTrackFromPayload = context.playTrackFromPayload;
  context.playTrackFromPayload = (...args) => {
    callOrder.push('play-track-from-payload');
    return productionPlayTrackFromPayload(...args);
  };

  context.attachSharedPlayer();
  playTrackButton.dispatch('click');

  assert.deepEqual(callOrder, [
    'play-track-from-payload',
    'streaming-start',
    'queue-install',
  ]);
  assert.strictEqual(context.state.player.playbackQueue, exactQueue);
  assert.equal(playbackStartCalls, 1);
  assert.equal(queueInstallCalls, 1);
  assert.equal(lifecycleCalls, 0);
  assert.equal(continuityCalls, 0);

  resolvePreparedStart();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(callOrder.indexOf('queue-install') < callOrder.indexOf('first-frame-peek'));
  assert.equal(playbackStartCalls, 1);
  assert.equal(queueInstallCalls, 1);
  assert.equal(lifecycleCalls, 1);
  assert.equal(continuityCalls, 1);

  playTrackButton.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pauseCalls, 1);
  assert.equal(playbackStartCalls, 1);
  assert.equal(queueInstallCalls, 1);
  assert.equal(lifecycleCalls, 1);
  assert.equal(continuityCalls, 1);
  assert.equal(callOrder.at(-1), 'current-track-toggle');
});

test('plain Space intercepts only when foreground playback handles it', async () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: false,
    src: '/track?path=song.flac',
  });
  const { context } = loadHelper({ audio });
  const outsidePlayer = new FakeElement({ tagName: 'DIV' });
  const createSpaceEvent = (target, overrides = {}) => {
    const observed = { prevented: 0, stopped: 0 };
    return {
      event: {
        key: ' ',
        code: 'Space',
        target,
        defaultPrevented: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault() {
          observed.prevented += 1;
        },
        stopPropagation() {
          observed.stopped += 1;
        },
        ...overrides,
      },
      observed,
    };
  };

  assert.equal(
    typeof context.handlePlayerKeyboardPlayback,
    'function',
    'player runtime must expose one app-global Space keyboard playback handler',
  );
  const pauseShortcut = createSpaceEvent(outsidePlayer);
  assert.equal(context.handlePlayerKeyboardPlayback(pauseShortcut.event), true);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.paused, true);
  assert.deepEqual(pauseShortcut.observed, { prevented: 1, stopped: 1 });

  const resumeShortcut = createSpaceEvent(outsidePlayer);
  assert.equal(context.handlePlayerKeyboardPlayback(resumeShortcut.event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);
  assert.deepEqual(resumeShortcut.observed, { prevented: 1, stopped: 1 });

  const legacySpacebarShortcut = createSpaceEvent(outsidePlayer, { key: 'Spacebar', code: '' });
  assert.equal(context.handlePlayerKeyboardPlayback(legacySpacebarShortcut.event), true);
  assert.equal(audio.pauseCalls, 2);
  assert.equal(audio.paused, true);
  assert.deepEqual(legacySpacebarShortcut.observed, { prevented: 1, stopped: 1 });

  const codeOnlySpaceShortcut = createSpaceEvent(outsidePlayer, { key: 'Unidentified', code: 'Space' });
  assert.equal(context.handlePlayerKeyboardPlayback(codeOnlySpaceShortcut.event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
  assert.deepEqual(codeOnlySpaceShortcut.observed, { prevented: 1, stopped: 1 });

  const playerTimelineShortcut = createSpaceEvent(new FakeElement({
    tagName: 'INPUT',
    type: 'range',
    attributes: { id: 'player-timeline' },
  }));
  assert.equal(context.handlePlayerKeyboardPlayback(playerTimelineShortcut.event), true);
  assert.equal(audio.pauseCalls, 3);
  assert.equal(audio.paused, true);
  assert.deepEqual(playerTimelineShortcut.observed, { prevented: 1, stopped: 1 });

  const resumeBeforeIgnoredEvents = createSpaceEvent(outsidePlayer);
  assert.equal(context.handlePlayerKeyboardPlayback(resumeBeforeIgnoredEvents.event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.playCalls, 3);
  assert.equal(audio.paused, false);

  const blockedAudio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: true,
    src: '/track?path=blocked.flac',
  });
  const { context: blockedContext } = loadHelper({
    audio: blockedAudio,
    canStartPlaybackInThisTab: () => false,
  });
  const ownershipDeniedShortcut = createSpaceEvent(new FakeElement({ tagName: 'A' }));
  assert.equal(blockedContext.handlePlayerKeyboardPlayback(ownershipDeniedShortcut.event), false);
  assert.equal(blockedAudio.playCalls, 0);
  assert.equal(blockedAudio.paused, true);
  assert.deepEqual(ownershipDeniedShortcut.observed, { prevented: 0, stopped: 0 });

  const noTrackAudio = new FakeAudioElement({ paused: true, src: '' });
  const { context: noTrackContext } = loadHelper({
    audio: noTrackAudio,
    state: {
      player: { current: null },
      utility: {},
    },
  });
  const noTrackShortcut = createSpaceEvent(new FakeElement({ tagName: 'BUTTON' }));
  const noTrackHandled = noTrackContext.handlePlayerKeyboardPlayback(noTrackShortcut.event);
  assert.equal(noTrackAudio.pauseCalls, 0);
  assert.equal(noTrackAudio.playCalls, 0);

  const hiddenPlayer = new FakeElement({
    hidden: true,
    rectangle: { width: 0, height: 0 },
  });
  const {
    context: hiddenPlayerContext,
    audio: hiddenPlayerAudio,
  } = loadHelper({ player: hiddenPlayer });
  const hiddenPlayerShortcut = createSpaceEvent(new FakeElement({ tagName: 'INPUT', type: 'checkbox' }));
  const hiddenPlayerHandled = hiddenPlayerContext.handlePlayerKeyboardPlayback(
    hiddenPlayerShortcut.event,
  );
  assert.equal(hiddenPlayerAudio.pauseCalls, 0);
  assert.equal(hiddenPlayerAudio.playCalls, 0);

  const ignoredEvents = [
    createSpaceEvent(outsidePlayer, { defaultPrevented: true }),
    createSpaceEvent(outsidePlayer, { isComposing: true }),
    createSpaceEvent(outsidePlayer, { repeat: true }),
    createSpaceEvent(outsidePlayer, { altKey: true }),
    createSpaceEvent(outsidePlayer, { ctrlKey: true }),
    createSpaceEvent(outsidePlayer, { metaKey: true }),
    createSpaceEvent(outsidePlayer, { shiftKey: true }),
    createSpaceEvent(new FakeElement({ tagName: 'INPUT', type: 'text' })),
    createSpaceEvent(new FakeElement({ tagName: 'TEXTAREA' })),
    createSpaceEvent(new FakeElement({ tagName: 'DIV', isContentEditable: true })),
  ];
  ignoredEvents.forEach(({ event, observed }) => {
    assert.equal(context.handlePlayerKeyboardPlayback(event), false);
    assert.deepEqual(observed, { prevented: 0, stopped: 0 });
  });
  assert.equal(audio.pauseCalls, 3);
  assert.equal(audio.playCalls, 3);
  assert.equal(audio.paused, false);

  const interceptedControlEvents = [
    createSpaceEvent(new FakeElement({ tagName: 'INPUT', type: 'checkbox' })),
    createSpaceEvent(new FakeElement({ tagName: 'INPUT', type: 'radio' })),
    createSpaceEvent(new FakeElement({ tagName: 'INPUT', type: 'range' })),
    createSpaceEvent(new FakeElement({ tagName: 'BUTTON' })),
    createSpaceEvent(new FakeElement({ tagName: 'SELECT' })),
    createSpaceEvent(new FakeElement({ tagName: 'A' })),
    createSpaceEvent(new FakeElement({ tagName: 'DIV', attributes: { role: 'button' } })),
    createSpaceEvent(new FakeElement({ tagName: 'DIV', attributes: { role: 'slider' } })),
  ];
  const controlInterceptionResults = [];
  for (const { event, observed } of interceptedControlEvents) {
    const playbackCallsBefore = audio.pauseCalls + audio.playCalls;
    const handled = context.handlePlayerKeyboardPlayback(event);
    await new Promise((resolve) => setImmediate(resolve));
    controlInterceptionResults.push({
      handled,
      observed,
      playbackDelta: (audio.pauseCalls + audio.playCalls) - playbackCallsBefore,
    });
  }
  assert.deepEqual({
    noTrack: {
      handled: noTrackHandled,
      observed: noTrackShortcut.observed,
    },
    hiddenPlayer: {
      handled: hiddenPlayerHandled,
      observed: hiddenPlayerShortcut.observed,
    },
    controls: controlInterceptionResults,
  }, {
    noTrack: {
      handled: false,
      observed: { prevented: 0, stopped: 0 },
    },
    hiddenPlayer: {
      handled: false,
      observed: { prevented: 0, stopped: 0 },
    },
    controls: interceptedControlEvents.map(() => ({
      handled: true,
      observed: { prevented: 1, stopped: 1 },
      playbackDelta: 1,
    })),
  });
});

test('keyboard Space preserves the focused control after the resume request resolves', async () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: true,
    src: '/track?path=song.flac',
  });
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range' });
  const focusedButton = new FakeElement({ tagName: 'BUTTON' });
  const { context } = loadHelper({ audio, timeline });

  assert.equal(context.handlePlayerKeyboardPlayback({
    key: ' ',
    code: 'Space',
    target: focusedButton,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault() {},
    stopPropagation() {},
  }), true);
  await Promise.resolve();

  assert.equal(audio.playCalls, 1);
  assert.equal(timeline.focusCalls.length, 0);
});

test('global Space delegates to an owned Utility loop before toggling player audio', () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: false,
    src: '/track?path=song.flac',
  });
  let loopDelegations = 0;
  const { context } = loadHelper({
    audio,
    handleUtilityLoopSpacePlayback() {
      loopDelegations += 1;
      return true;
    },
  });
  let prevented = 0;
  let stopped = 0;

  assert.equal(context.handlePlayerKeyboardPlayback({
    key: ' ',
    code: 'Space',
    target: new FakeElement({ tagName: 'BUTTON' }),
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }), true);
  assert.equal(loopDelegations, 1);
  assert.equal(audio.pauseCalls, 0);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.paused, false);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('visible player play-control focuses the timeline after the resume request resolves', async () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: true,
    src: '/track?path=song.flac',
  });
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range' });
  const { context, playButton } = loadHelper({ audio, timeline });

  context.attachPlayerEvents();
  playButton.dispatch('click', {
    type: 'click',
    focusTimelineOnResume: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(audio.playCalls, 1);
  assert.equal(timeline.focusCalls.length, 1);
});

test('global-player pointerdown clears saved-loop Space ownership', () => {
  const { context } = loadHelper({
    clearUtilityLoopSpaceOwner() {
      context.state.utility.loopSpaceOwnerId = '';
    },
  });
  context.state.utility.loopSpaceOwnerId = 'loop-1';
  context.attachPlayerEvents();

  context.player.dispatch('pointerdown', { target: context.player });

  assert.equal(context.state.utility.loopSpaceOwnerId, '');
});

test('global-player focusin clears saved-loop Space ownership', () => {
  const { context } = loadHelper({
    clearUtilityLoopSpaceOwner() {
      context.state.utility.loopSpaceOwnerId = '';
    },
  });
  context.state.utility.loopSpaceOwnerId = 'loop-1';
  context.attachPlayerEvents();

  context.player.dispatch('focusin', { target: context.player });

  assert.equal(context.state.utility.loopSpaceOwnerId, '');
});

test('interactions outside the global player preserve saved-loop Space ownership', () => {
  const outsideSurface = new FakeElement();
  const loopsSurface = new FakeElement();
  const documentListeners = new Map();
  const document = {
    querySelectorAll: () => [],
    addEventListener(name, handler) {
      const handlers = documentListeners.get(name) || [];
      handlers.push(handler);
      documentListeners.set(name, handlers);
    },
    dispatch(name, event) {
      for (const handler of documentListeners.get(name) || []) handler(event);
    },
  };
  const { context } = loadHelper({
    document,
    clearUtilityLoopSpaceOwner() {
      context.state.utility.loopSpaceOwnerId = '';
    },
  });
  context.state.utility.loopSpaceOwnerId = 'loop-1';
  context.attachPlayerEvents();

  document.dispatch('pointerdown', { target: outsideSurface });
  document.dispatch('focusin', { target: loopsSurface });

  assert.equal(context.state.utility.loopSpaceOwnerId, 'loop-1');
});

test('the global Space playback listener is registered in capture phase', () => {
  const keydownRegistrations = [];
  const document = {
    querySelectorAll: () => [],
    addEventListener(name, handler, options) {
      if (name === 'keydown') keydownRegistrations.push({ handler, options });
    },
  };
  const { context } = loadHelper({ document });

  context.attachPlayerEvents();

  const playbackRegistration = keydownRegistrations.find(
    ({ handler }) => handler === context.handlePlayerKeyboardPlayback,
  );
  assert.ok(playbackRegistration, 'attachPlayerEvents must register the global Space playback handler');
  assert.ok(
    playbackRegistration.options === true || playbackRegistration.options?.capture === true,
    'the global Space playback handler must run in capture phase',
  );
});

async function verifySaveCurrentLoopUsesAppDialog() {
  {
    let resolveDialog;
    const dialogPending = new Promise((resolve) => {
      resolveDialog = resolve;
    });
    const dialogCalls = [];
    const fetchCalls = [];
    const { context } = loadHelper({
      showLoopNameDialog: () => {
        dialogCalls.push('open');
        return dialogPending;
      },
      fetch: async (url, options) => {
        fetchCalls.push([url, options]);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            loop: { id: 'loop-1', name: 'Rapid Loop' },
          }),
        };
      },
      state: {
        player: {
          current: { src: '/track?path=song.flac', path: 'C:/Music/song.flac' },
          loopActive: true,
          loopStart: 10,
          loopEnd: 20,
          saveBusy: false,
          waveform: { renderToken: 0 },
        },
        utility: {
          loops: [],
          loopsLoaded: false,
          selectedLoopId: '',
          selectedLoopGroupKey: '',
          selectedLoopDetailMode: '',
          activeTab: '',
        },
      },
    });

    const firstSave = context.saveCurrentLoop();
    const secondSave = context.saveCurrentLoop();

    assert.deepEqual(dialogCalls, ['open']);
    assert.equal(fetchCalls.length, 0);
    assert.equal(context.state.player.saveBusy, true);

    resolveDialog('  Rapid Loop  ');
    await Promise.all([firstSave, secondSave]);

    assert.deepEqual(dialogCalls, ['open']);
    assert.equal(fetchCalls.length, 1);
    assert.equal(JSON.parse(fetchCalls[0][1].body).name, 'Rapid Loop');
    assert.equal(context.state.player.saveBusy, false);
  }

  {
    let resolveDialog;
    const dialogPending = new Promise((resolve) => {
      resolveDialog = resolve;
    });
    let dialogCalls = 0;
    let fetchCalls = 0;
    const { context } = loadHelper({
      showLoopNameDialog: () => {
        dialogCalls += 1;
        return dialogPending;
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('cancelled naming must not create a loop');
      },
      state: {
        player: {
          current: { src: '/track?path=song.flac', path: 'C:/Music/song.flac' },
          loopActive: true,
          loopStart: 10,
          loopEnd: 20,
          saveBusy: false,
          waveform: { renderToken: 0 },
        },
        utility: {
          loops: [],
          loopsLoaded: false,
          selectedLoopId: '',
          selectedLoopGroupKey: '',
          selectedLoopDetailMode: '',
          activeTab: '',
        },
      },
    });

    const cancelledSave = context.saveCurrentLoop();
    assert.equal(context.state.player.saveBusy, true);
    resolveDialog(null);
    await cancelledSave;

    assert.equal(dialogCalls, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(context.state.player.saveBusy, false);
  }

  {
    const fetchCalls = [];
    const dialogCalls = [];
    const renderCalls = [];
    const warmupLoop = {
      id: 'loop-1', name: 'Warmup Loop', artist: 'Artist', title: 'Song', album: 'Album', duration_seconds: 8,
    };
    const transitionLoop = {
      id: 'loop-2', name: 'Transition Loop', artist: 'Artist', title: 'Song', album: 'Album', duration_seconds: 10,
    };
    const responseLoops = [warmupLoop, transitionLoop];
    const { context } = loadHelper({
      showLoopNameDialog: async () => {
        dialogCalls.push('open');
        return '  Transition Loop  ';
      },
      fetch: async (url, options) => {
        fetchCalls.push([url, options]);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            loop: transitionLoop,
            loops: responseLoops,
          }),
        };
      },
      buildUtilityLoopGroupKey: (loop) => [loop.artist, loop.title, loop.album]
        .map((value) => String(value || '').toLowerCase())
        .join('::'),
      renderUtilityModalContent: () => {
        renderCalls.push({
          loopIds: Array.from(context.state.utility.loops || [], (loop) => String(loop.id || '')),
          selectedLoopId: context.state.utility.selectedLoopId,
          selectedLoopGroupKey: context.state.utility.selectedLoopGroupKey,
          selectedLoopDetailMode: context.state.utility.selectedLoopDetailMode,
        });
      },
      state: {
        player: {
          current: {
            src: '/track?path=song.flac',
            path: 'C:/Music/song.flac',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            coverPath: '',
          },
          loopActive: true,
          loopStart: 10,
          loopEnd: 20,
          saveBusy: false,
          waveform: { renderToken: 0 },
        },
        utility: {
          loops: [],
          loopsLoaded: false,
          selectedLoopId: '',
          selectedLoopGroupKey: '',
          selectedLoopDetailMode: '',
          activeTab: 'loops',
        },
      },
    });

    await context.saveCurrentLoop();

    assert.deepEqual(dialogCalls, ['open']);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], '/loops/create');
    assert.equal(fetchCalls[0][1].method, 'POST');
    assert.equal(JSON.parse(fetchCalls[0][1].body).name, 'Transition Loop');
    assert.deepEqual(
      Array.from(context.state.utility.loops, (loop) => loop.id),
      ['loop-1', 'loop-2'],
      'the server response order is retained',
    );
    assert.equal(context.state.utility.selectedLoopId, 'loop-2');
    assert.equal(context.state.utility.selectedLoopGroupKey, 'artist::song::album');
    assert.equal(context.state.utility.selectedLoopDetailMode, 'group');
    assert.deepEqual(renderCalls, [{
      loopIds: ['loop-1', 'loop-2'],
      selectedLoopId: 'loop-2',
      selectedLoopGroupKey: 'artist::song::album',
      selectedLoopDetailMode: 'group',
    }], 'the complete selected group is established before the single render');
  }

  {
    let fetchCalls = 0;
    const { context } = loadHelper({
      showLoopNameDialog: async () => null,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('cancelled naming must not create a loop');
      },
      state: {
        player: {
          current: { src: '/track?path=song.flac', path: 'C:/Music/song.flac' },
          loopActive: true,
          loopStart: 10,
          loopEnd: 20,
          saveBusy: false,
          waveform: { renderToken: 0 },
        },
        utility: {
          loops: [],
          loopsLoaded: false,
          selectedLoopId: '',
          selectedLoopGroupKey: '',
          selectedLoopDetailMode: '',
          activeTab: '',
        },
      },
    });

    await context.saveCurrentLoop();

    assert.equal(fetchCalls, 0);
    assert.equal(context.state.player.saveBusy, false);
  }
}

verifySaveCurrentLoopUsesAppDialog().catch((error) => {
  process.nextTick(() => {
    throw error;
  });
});

test('successful loop save refreshes scissors after clearing the busy state', async () => {
  const uiStates = [];
  const loopActions = {
    _loopActionController: {
      update(nextState) {
        uiStates.push({ ...nextState });
      },
    },
  };
  const { context } = loadHelper({
    showLoopNameDialog: async () => 'Saved Loop',
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, loop: { id: 'loop-1', name: 'Saved Loop' } }),
    }),
    getPlayerElements: () => ({ loopActions }),
    state: {
      player: {
        current: { src: '/track?path=song.flac', path: 'C:/Music/song.flac' },
        loopActive: true,
        loopStart: 10,
        loopEnd: 20,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
  });

  await context.saveCurrentLoop();

  assert.deepEqual(uiStates.at(-1), { enabled: true, active: false, busy: false });
  assert.ok(context.state.player.current, 'the loaded track remains available for another loop');
});

test('Enter opens loop naming from active edit mode without creating the loop', async () => {
  const dialogCalls = [];
  const fetchCalls = [];
  const { context, player } = loadHelper({
    showLoopNameDialog: async () => {
      dialogCalls.push('open');
      return null;
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return { ok: true, json: async () => ({ ok: true }) };
    },
    state: {
      player: {
        current: { src: '/track?path=song.flac', path: 'C:/Music/song.flac' },
        loopActive: true,
        loopStart: 10,
        loopEnd: 20,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
  });
  let prevented = 0;
  let stopped = 0;

  const handled = context.handlePlayerLoopEditKeydown({
    key: 'Enter',
    target: player,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handled, true);
  assert.deepEqual(dialogCalls, ['open']);
  assert.equal(fetchCalls.length, 0);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('bottom player mounts shared scissors and range controllers instead of the Loop popup', () => {
  const playerMarkup = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'index.html',
  ), 'utf8');
  const elementLookupSource = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-and-waveform.js',
  ), 'utf8');

  assert.match(playerMarkup, /data-loop-action-owner="global-player"/);
  assert.match(playerMarkup, /data-loop-range-owner="global-player"/);
  assert.doesNotMatch(playerMarkup, /id="player-loop-button"|id="loop-popup"/);
  assert.match(helperSource, /mountLoopEditActionControl\s*\(/);
  assert.match(helperSource, /createLoopRangeController\s*\(/);
  assert.doesNotMatch(elementLookupSource, /getElementById\(['"](?:player-loop-button|loop-popup)['"]\)/);
  assert.doesNotMatch(helperSource, /getElementById\(['"](?:player-loop-button|loop-popup)['"]\)/);
});

test('bottom-player shared range previews cheaply and commits streaming state only on release', () => {
  assert.match(helperSource, /onRangePreview\s*:\s*[^]*loopStart[^]*loopEnd/);
  assert.match(helperSource, /onRangeCommit\s*:\s*[^]*scheduleActiveStreamingLoop\s*\(/);
  assert.match(helperSource, /onSeek\s*:\s*\(seconds\)\s*=>\s*setPlayerPlaybackHead\(seconds,\s*\{\s*clampToLoop:\s*false\s*\}\)/);
  assert.match(helperSource, /onCancel\s*:\s*[^]*(?:setLoopActive\(false\)|exit[^\n]*Loop)/i);
  assert.match(helperSource, /onCreate\s*:\s*saveCurrentLoop/);
  assert.doesNotMatch(
    helperSource,
    /onRangePreview\s*:\s*[^}]*scheduleActiveStreamingLoop\s*\(/,
    'pointer-move preview must not schedule a streaming-loop commit',
  );
});

test('bottom-player loop editor uses the shared expiry session and only automatic expiry pauses playback', () => {
  const calls = [];
  const seeks = [];
  let expiryCallback = null;
  let rangeOptions = null;
  const controller = {
    start(options) {
      calls.push(['start', options.ownerId]);
      expiryCallback = options.onExpire;
    },
    renewAfterBoundaryEdit(ownerId) {
      calls.push(['renew', ownerId]);
      return true;
    },
    noteUntouchedWholeRangeWrap: () => false,
    stop(ownerId) {
      calls.push(['stop', ownerId]);
      return true;
    },
    has: () => false,
  };
  let pauses = 0;
  const { context } = loadHelper({
    loopEditSessionExpiryController: controller,
    pauseStreamingPlayback() {
      pauses += 1;
    },
    seekStreamingPlayback(seconds) {
      seeks.push(seconds);
      return Promise.resolve();
    },
    createLoopRangeController(options) {
      rangeOptions = options;
      return {};
    },
  });

  context.setLoopActive(true);
  context.getGlobalPlayerLoopControlOptions().mountRange(new FakeElement());
  assert.deepEqual(calls, [['start', 'global-player']]);

  rangeOptions.onRangeInteractionStart('end');
  rangeOptions.onRangePreview({ startSeconds: 1, endSeconds: 5 });
  rangeOptions.onRangeCommit({ startSeconds: 1, endSeconds: 5 });
  rangeOptions.onSeek(8);
  assert.deepEqual(seeks, [8], 'waveform seeking may audition a position outside the selected loop');
  assert.deepEqual(calls, [
    ['start', 'global-player'],
    ['start', 'global-player'],
    ['renew', 'global-player'],
    ['renew', 'global-player'],
    ['renew', 'global-player'],
  ]);

  const bootstrapSource = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'bootstrap-init.js',
  ), 'utf8');
  assert.match(
    bootstrapSource,
    /reconcileLoopEditSessionExpiry\(event\)[^]*closest\?\.\('\[data-loop-range-handle\]'\)/,
    'capture-phase reconciliation must let an active loop control renew before checking expiry',
  );

  context.setLoopActive(false);
  assert.equal(pauses, 0, 'manual cancellation keeps playback running');
  assert.deepEqual(calls.at(-1), ['stop', 'global-player']);

  context.setLoopActive(true);
  expiryCallback({ ownerId: 'global-player', reason: 'inactive' });
  assert.equal(context.state.player.loopActive, false);
  assert.equal(pauses, 1, 'automatic expiry pauses the bottom player');
  assert.deepEqual(calls.at(-1), ['stop', 'global-player']);
});

test('bottom-player reports only whole-track repeat boundaries to the shared expiry session', async () => {
  const wraps = [];
  const track = { path: 'C:/Music/song.flac', src: '/track?path=song.flac', durationSeconds: 60 };
  const { context } = loadHelper({
    state: {
      player: {
        current: track,
        loopActive: true,
        loopStart: 0,
        loopEnd: 60,
        loopEditDurationSeconds: 60,
        waveform: { renderToken: 0 },
      },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    loopEditSessionExpiryController: {
      start: () => {}, renewAfterBoundaryEdit: () => false, stop: () => false, has: () => true,
      noteUntouchedWholeRangeWrap(ownerId) { wraps.push(ownerId); return true; },
    },
  });

  await context.handleStreamingPlaybackBoundary({
    generation: 2,
    outgoingStreamId: 10,
    incomingStreamId: 11,
    outgoingTrackPath: track.path,
    incomingTrackPath: track.path,
    continuityKind: 'whole-track-repeat',
  });
  await context.handleStreamingPlaybackBoundary({
    generation: 2,
    outgoingStreamId: 11,
    incomingStreamId: 12,
    outgoingTrackPath: track.path,
    incomingTrackPath: track.path,
    continuityKind: 'short-loop',
  });

  assert.deepEqual(wraps, ['global-player']);
});

test('bottom-player integration leaves selection geometry exclusively to the shared range controller', () => {
  const updateStart = helperSource.indexOf('function updateLoopInputsFromState');
  const updateEnd = helperSource.indexOf('\nfunction ', updateStart + 1);
  const updateSource = helperSource.slice(updateStart, updateEnd);

  assert.ok(updateStart >= 0, 'the player loop-state renderer must exist');
  assert.doesNotMatch(
    updateSource,
    /loopRegion\.style\.(?:left|right|width)|loopRegion\.style\.setProperty\s*\(/,
    'the integration must not calculate selection geometry beside createLoopRangeController',
  );
  assert.match(updateSource, /_loopRangeController\?\.render\s*\(/);
});

test('bottom-player loop range freezes the current-role playback duration for one edit session', () => {
  const currentTrack = {
    src: '/track?path=fake-loop-source.wav',
    path: 'C:/Music/Fake Loop Source.wav',
    title: 'Fake Loop Source',
    durationSeconds: 181,
  };
  let playbackDuration = 14;
  let rangeOptions = null;
  const { context } = loadHelper({
    state: {
      player: {
        current: currentTrack,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0.4,
      duration: playbackDuration,
      paused: false,
      ended: false,
      src: currentTrack.src,
    }),
    createLoopRangeController: (options) => {
      rangeOptions = options;
      return {};
    },
  });

  context.setLoopActive(true);
  context.getGlobalPlayerLoopControlOptions().mountRange(new FakeElement());
  playbackDuration = 181;

  assert.equal(rangeOptions.getDuration(), 14);
  rangeOptions.onRangePreview({ startSeconds: 1, endSeconds: 5 });
  rangeOptions.onRangeCommit({ startSeconds: 1, endSeconds: 5 });
  assert.equal(context.state.player.loopStart, 1);
  assert.equal(context.state.player.loopEnd, 5);
});

test('bottom-player loop activation waits for the real full-track duration instead of inventing 30 seconds', () => {
  const currentTrack = {
    src: '/track?path=metadata-pending.wav',
    path: 'C:/Music/Metadata Pending.wav',
    title: 'Metadata Pending',
    durationSeconds: 0,
  };
  let playbackDuration = 0;
  let rangeOptions = null;
  const toasts = [];
  const { context } = loadHelper({
    state: {
      player: {
        current: currentTrack,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0,
      duration: playbackDuration,
      paused: false,
      ended: false,
      src: currentTrack.src,
    }),
    createLoopRangeController: (options) => {
      rangeOptions = options;
      return {};
    },
    showToast: (...args) => toasts.push(args),
  });

  context.setLoopActive(true);
  assert.equal(context.state.player.loopActive, false);
  assert.equal(context.state.player.loopEditDurationSeconds || 0, 0);
  assert.equal(context.state.player.loopEnd, 30);
  assert.deepEqual(toasts, [['Wait for the full track to finish loading before editing a loop.', 'error', 2600]]);

  playbackDuration = 181;
  context.setLoopActive(true);
  context.getGlobalPlayerLoopControlOptions().mountRange(new FakeElement());
  assert.equal(context.state.player.loopActive, true);
  assert.equal(currentTrack.durationSeconds, 181, 'real streaming metadata heals a legacy restored track');
  assert.equal(rangeOptions.getDuration(), 181);
  assert.equal(context.state.player.loopEditDurationSeconds, 181);
  assert.equal(context.state.player.loopEnd, 181);
});

test('an atomic current-track identity change exits and resets the active loop editor', () => {
  const trackA = {
    src: '/track?path=track-a.wav', path: 'C:/Music/Track A.wav', durationSeconds: 14,
  };
  const trackB = {
    src: '/track?path=track-b.wav', path: 'C:/Music/Track B.wav', durationSeconds: 181,
  };
  const { context } = loadHelper({
    state: {
      player: {
        current: trackA,
        loopActive: true,
        loopStart: 1,
        loopEnd: 5,
        saveBusy: false,
        waveform: { renderToken: 0 },
      },
      utility: {
        loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '',
        selectedLoopDetailMode: '', activeTab: '',
      },
    },
    getTrackIdentity: (track) => String(track?.path || ''),
  });

  context.setCurrentPlayerTrack(trackB, { persist: false });

  assert.strictEqual(context.state.player.current, trackB);
  assert.equal(context.state.player.loopActive, false);
  assert.equal(context.state.player.loopStart, 0);
  assert.equal(context.state.player.loopEnd, 30);
});

test('bottom-player cancel and Escape restore ordinary playback time while saves stay deduplicated', () => {
  assert.match(helperSource, /Escape/);
  assert.match(helperSource, /state\.player\.saveBusy/);
  assert.match(helperSource, /if\s*\(state\.player\.saveBusy\)\s*return/);
  assert.match(helperSource, /\/loops\/create/);
  assert.match(helperSource, /els\.time[^]*(?:loopStart|formatLoopTime)[^]*(?:loopEnd|formatLoopTime)/);
});

test('bottom-player scissors availability follows the real playback facade without a parallel audio seam', () => {
  assert.match(
    helperSource,
    /Boolean\(getPlayerPlaybackSnapshot\(\)\.src\s*\|\|\s*state\.player\.current\?\.src\)/,
  );
  assert.match(helperSource, /mountLoopEditActionControl\s*\(\s*\{[^]*enabled\s*:/);
  assert.match(helperSource, /_loopActionController\?\.update\(\s*\{[^]*enabled\s*:/);
  assert.doesNotMatch(helperSource, /state\.player\.audio/);
});

test('bottom player owns one runtime-built pod and one visible time output', () => {
  const playerMarkup = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'index.html',
  ), 'utf8');
  assert.equal((playerMarkup.match(/id="player-time"/g) || []).length, 1);
  assert.doesNotMatch(playerMarkup, /data-loop-range-time=/);
  assert.match(
    playerMarkup,
    /<span class="loop-play-control-actions player-loop-actions"[^>]*data-loop-action-mount="global-player"[^>]*>\s*<\/span>/,
  );
  assert.doesNotMatch(playerMarkup, /data-loop-action-owner="global-player"[^]*data-loop-action="enter"/);
  assert.match(helperSource, /buildLoopEditActionControl\s*\([^]*ownerId:\s*['"]global-player['"]/);
});

test('bottom-player edit mode preserves the stereo waveform and visible playhead layer', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  assert.doesNotMatch(helperSource, /drawCombinedLoopWaveform\s*\(/);
  assert.doesNotMatch(css, /\.player-timeline-wrap\.is-waveform(?:\.is-looping)?\s+\.player-timeline\s*\{[^}]*opacity:\s*0\.0[0-9]/s);
  assert.match(css, /\.player-timeline-wrap\s*>\s*\.loop-range-surface\s+\.loop-range-selection\s*\{[^}]*(?:inset-block:\s*-\d+(?:\.\d+)?px|top:\s*(-?\d+(?:\.\d+)?px)[^}]*bottom:\s*\1)/s);
  assert.match(helperSource, /drawWaveformOnCanvas\s*\([^]*compactPeaks[^]*(?:currentTime|progress)/);
});
