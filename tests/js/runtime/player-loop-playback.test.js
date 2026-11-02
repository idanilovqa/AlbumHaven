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
// Diagnostic infrastructure only: unchanged cases may still fail their original
// contracts. Existing boolean providers never qualify actual playback authority.
const subjectDeclarations = new Set([...helperSource.matchAll(
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
)].map(match => match[1]));
const runtimeFixtureCleanups = [];
const runtimeFixtureOwners = new WeakMap();
test.after(async () => {
  const failures = [];
  for (const cleanup of runtimeFixtureCleanups.reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Loop diagnostic fixture cleanup failed');
});



function ownActualClickAdmission(context) {
  const owners = runtimeFixtureOwners.get(context);
  const work = [], thrown = [], handles = [];
  owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(work);
    const errors = [...thrown, ...settled.filter(row => row.status === 'rejected').map(row => row.reason)];
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Owned admitted click failed');
  });
  const retain = callback => (...args) => {
    let result;
    try { result = callback(...args); }
    catch (error) { thrown.push(error); throw error; }
    work.push(result);
    void Promise.resolve(result).catch(() => {});
    return result;
  };
  // These two cases assert the legacy audio stays stopped: it is not the
  // streaming transport or its snapshot. Use both genuine dependencies.
  context.getPlayerPlaybackSnapshot = owners.getPlayerPlaybackSnapshot;
  context.resumeStreamingPlayback = retain(owners.resumeStreamingPlayback);
  context.startStreamingTrack = retain(context.startStreamingTrack);
  context.playTrackFromPayload = retain(context.playTrackFromPayload);
  context.canStartPlaybackInThisTab = (...args) => {
    const handle = owners.canStartPlaybackInThisTab(...args);
    handles.push(handle);
    return handle;
  };
  const engine = context.streamingEngineState();
  const scope = context.capturePlaybackOwnershipScope();
  const shell = context.document.getElementById('app-shell');
  assert.ok(shell);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.state.player.current, null);
  assert.equal(engine.roles.current, null);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(context.getPlayerPlaybackSnapshot().paused, true);
  return track => {
    assert.strictEqual(context.document.getElementById('app-shell'), shell);
    assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
    const role = engine.roles.current;
    const attempt = context.captureStreamingPlaybackAttempt();
    const selection = vm.runInContext('playerSelectionOwnership', context);
    const handle = context.getActivePlaybackOwnershipHandle();
    assert.equal(handles.length, 1);
    assert.ok(handle);
    assert.strictEqual(handles[0], handle);
    assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.strictEqual(selection.handle, handle);
    assert.strictEqual(selection.attempt, attempt);
    assert.equal(selection.admitted, true);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.strictEqual(role.track, track);
    assert.strictEqual(context.state.player.current, track);
    assert.equal(engine.context.state, 'running');
    assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
    assert.equal(context.successfulPlaybackClaim(handle), false);
    assert.notEqual(role.firstFrameNotified, true);
    assert.equal(engine.diagnostics.firstFrameAtMs, 0);
  };
}

async function prepareLocalPlayingControl(context) {
  const owners = runtimeFixtureOwners.get(context);
  const track = context.state.player.current;
  assert.equal(track.src, '/track?path=song.flac');
  assert.equal(Object.hasOwn(track, 'path'), false);
  track.path = 'C:/Music/song.flac';
  const scope = context.capturePlaybackOwnershipScope();
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  const originalResume = context.resumeStreamingPlayback;
  let attempt, role;
  // Setup must run the actual local engine resume, not the action observer.
  context.resumeStreamingPlayback = owners.resumeStreamingPlayback;
  try {
    role = await owners.startStreamingTrack(track, {
      autoplay: true, startSeconds: 12,
      onStartAttempt(value) { attempt = value; },
    });
  } finally { context.resumeStreamingPlayback = originalResume; }
  const engine = context.streamingEngineState();
  assert.ok(role);
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(engine.snapshot.paused, false);
  assert.equal(engine.snapshot.currentTime, 12);
  assert.notEqual(role.firstFrameNotified, true);
  assert.equal(engine.diagnostics.firstFrameAtMs, 0);
  return { owners, track, scope, attempt, role, engine };
}

async function preparePositiveFocusControl(context) {
  const owners = runtimeFixtureOwners.get(context);
  const track = context.state.player.current;
  assert.equal(track.src, '/track?path=song.flac');
  assert.equal(Object.hasOwn(track, 'path'), false);
  // Explicit same-song fixture metadata, not a URL-derived authorization claim.
  track.path = 'C:/Music/song.flac';
  const scope = context.capturePlaybackOwnershipScope();
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  if (context.window.AlbumHavenCapabilities) {
    assert.equal(context.window.AlbumHavenCapabilities.allows('library.media.read'), true);
  }
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  let attempt;
  const role = await owners.startStreamingTrack(track, {
    autoplay: false, startSeconds: 12,
    onStartAttempt(value) { attempt = value; },
  });
  const engine = context.streamingEngineState();
  assert.strictEqual(context.state.player.current, track);
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(engine.snapshot.paused, true);
  assert.equal(engine.snapshot.currentTime, 12);
  assert.notEqual(role.firstFrameNotified, true);
  const observer = context.resumeStreamingPlayback;
  const observed = { work: [], thrown: [] };
  owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(observed.work);
    const errors = [...observed.thrown, ...settled.filter(row => row.status === 'rejected').map(row => row.reason)];
    if (errors.length) throw new AggregateError(errors, 'Owned focus resume failed');
  });
  context.resumeStreamingPlayback = (...args) => {
    observer(...args);
    let work;
    try { work = owners.resumeStreamingPlayback(...args); }
    catch (error) { observed.thrown.push(error); throw error; }
    observed.work.push(work);
    // Observe rejection immediately, but return the EXACT actual work promise.
    // Teardown separately awaits it and reports failures; no action wait added.
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  return { track, role, attempt, scope, engine, observed };
}

function mountOriginalTrackModal(context, originalButton) {
  const button = context.document.createElement('button');
  for (const [name, value] of Object.entries(originalButton.attributes)) button.setAttribute(name, value);
  button.hidden = originalButton.hidden;
  button.disabled = originalButton.disabled;
  button.dispatch = (type, values = {}) => {
    const event = new context.Event(type);
    Object.assign(event, values);
    return button.dispatchEvent(event);
  };
  const modal = context.document.createElement('div');
  modal.id = 'track-modal';
  modal.hidden = false;
  context.document.body.appendChild(modal);
  modal.appendChild(button);
  assert.equal(modal.contains(button), true);
  assert.equal(modal.contains(context.document.createElement('button')), false);
  for (const [name, value] of Object.entries(originalButton.attributes)) assert.equal(button.getAttribute(name), value);
  return { button, modal };
}

test('player glyph preserves the mounted SVG across audio ticks despite browser serialization', () => {
  const { context } = loadHelper();
  const button = new FakeElement({ attributes: { 'aria-label': 'Pause' }, disabled: true });
  let writes = 0, rendered = '';
  Object.defineProperty(button, 'innerHTML', {
    get: () => rendered,
    set(value) { writes++; rendered = value.replace(/<path ([^>]+)\/>/g, '<path $1></path>'); },
  });
  const renderer = context.window.ButtonComponent;
  context.renderGlobalPlayerPlayGlyph(button, false);
  assert.notEqual(rendered, renderer.renderIconSvg('pause', { className: 'player-transport-icon' }));
  assert.equal(rendered, renderer.renderIconSvg('pause', { className: 'player-transport-icon' }).replace('/></svg>', '></path></svg>'));
  for (let tick = 0; tick < 60; tick++) context.renderGlobalPlayerPlayGlyph(button, false);
  assert.equal(writes, 1);
  assert.equal(button.getAttribute('data-player-glyph'), 'pause');
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.equal(writes, 2);
  assert.equal(button.getAttribute('data-player-glyph'), 'play');
  assert.equal(rendered, renderer.renderIconSvg('play', { className: 'player-transport-icon' }).replace('/></svg>', '></path></svg>'));
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.equal(writes, 2);
  context.renderGlobalPlayerPlayGlyph(button, false);
  assert.equal(writes, 3);
  assert.equal(button.getAttribute('aria-label'), 'Pause');
  assert.equal(button.disabled, true);
});

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

function loadHelper(overrides = {}, { bootstrapAllowedActions, observeLoopExpiry = false } = {}) {
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
      ButtonComponent: require('../../../music_app/static/js/button-component.js'),
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
  const listener = require('./search-native-fixtures/listener-search.cjs');
  const { world } = require('./search-native-fixtures/ownership-platform.cjs');
  const platform = world().createTab();
  const fixtureCleanups = [];
  const observerCleanups = [];
  let runtimeContext, actualStop, actualRelease, actualDispose;
  runtimeFixtureCleanups.push(async () => {
    const failures = [];
    let capturedHandle;
    try {
      capturedHandle = runtimeContext?.getActivePlaybackOwnershipHandle?.();
      runtimeContext?.retirePlayerSelectionOwnership?.('test-teardown');
      runtimeContext?.retirePlayerRestoreAttempt?.('test-teardown');
    } catch (error) { failures.push(error); }
    try {
      if (capturedHandle) actualRelease('stopped', capturedHandle);
    } catch (error) { failures.push(error); }
    try { if (actualStop) await actualStop('test-teardown'); } catch (error) { failures.push(error); }
    try {
      if (capturedHandle) {
        assert.notStrictEqual(runtimeContext.getActivePlaybackOwnershipHandle(), capturedHandle);
        const lease = runtimeContext.readPlaybackOwnershipRecord();
        assert.equal(Boolean(lease && lease.tab_id === capturedHandle.tab_id
          && lease.claim_revision === capturedHandle.claim_revision), false);
      }
    } catch (error) { failures.push(error); }
    try { actualDispose?.(); } catch (error) { failures.push(error); }
    for (const cleanup of observerCleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    try { platform.dispose(); } catch (error) { failures.push(error); }
    for (const cleanup of fixtureCleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Loop runtime cleanup failed');
  });
  const h = listener.fixture({ after(cleanup) { fixtureCleanups.push(cleanup); } }, {
    beforeRuntimePlatform: (environment) => {
      platform.install(environment);
      if (bootstrapAllowedActions !== undefined) {
        assert.deepEqual(bootstrapAllowedActions, { 'library.loops.create': true });
        environment.c.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__ = Object.freeze({ ...bootstrapAllowedActions });
      }
    },
  });
  platform.installAudio();
  runtimeContext = h.c;
  const lexicalState = h.owner('state');
  actualStop = runtimeContext.stopStreamingPlayback;
  actualRelease = runtimeContext.releasePlaybackOwnership;
  actualDispose = runtimeContext.disposePlaybackOwnershipCoordinator;
  runtimeFixtureOwners.set(runtimeContext, {
    loaded: new Set(h.loaded), loadUtilityLoops: runtimeContext.loadUtilityLoops,
    canStartPlaybackInThisTab: runtimeContext.canStartPlaybackInThisTab,
    startStreamingTrack: runtimeContext.startStreamingTrack,
    resumeStreamingPlayback: runtimeContext.resumeStreamingPlayback,
    pauseStreamingPlayback: runtimeContext.pauseStreamingPlayback,
    getPlayerPlaybackSnapshot: runtimeContext.getPlayerPlaybackSnapshot,
    scheduleStreamingContinuity: runtimeContext.scheduleStreamingContinuity,
    addObserverCleanup(cleanup) { observerCleanups.push(cleanup); },
  });
  // Share supplied nested records, never detach assertions from lexical state.
  // The immutable runtime root itself remains the actual bootstrap owner.
  for (const [key, value] of Object.entries(context.state)) {
    if ((key === 'player' || key === 'utility') && value && typeof value === 'object') {
      const defaults = lexicalState[key];
      for (const [field, defaultValue] of Object.entries(defaults || {})) {
        if (!Object.hasOwn(value, field)) value[field] = defaultValue;
      }
    }
    lexicalState[key] = value;
  }
  runtimeContext.state = lexicalState;
  assert.strictEqual(runtimeContext.state, h.owner('state'));
  for (const key of ['player', 'utility']) {
    if (Object.hasOwn(context.state, key)) assert.strictEqual(runtimeContext.state[key], context.state[key]);
  }
  const NativeHTMLElement = runtimeContext.HTMLElement;
  runtimeContext.HTMLElement = class extends NativeHTMLElement {
    static [Symbol.hasInstance](element) {
      return element instanceof FakeElement || element instanceof NativeHTMLElement;
    }
  };
  // Keep real shell/scope lookups while retaining explicitly supplied unit DOM
  // query observers. Event observers are forwarded without discarding owners.
  if (Object.hasOwn(overrides, 'document')) {
    const nativeDocument = runtimeContext.document;
    const suppliedDocument = overrides.document;
    assert.ok(suppliedDocument && typeof suppliedDocument === 'object', 'explicit document must be a supported object');
    for (const name of ['getElementById', 'querySelector']) {
      if (name in suppliedDocument) assert.equal(typeof suppliedDocument[name], 'function',
        `explicit document ${name} cannot be silently replaced`);
    }
    runtimeContext.document = new Proxy(nativeDocument, {
      get(target, key) {
        if (key === 'getElementById' || key === 'querySelector') {
          return (selector, ...args) => {
            const shellLookup = key === 'getElementById'
              ? selector === 'app-shell' : selector === '#app-shell';
            if (shellLookup) return target[key](selector, ...args);
            const supplied = Reflect.get(suppliedDocument, key, suppliedDocument);
            return typeof supplied === 'function'
              ? supplied.call(suppliedDocument, selector, ...args)
              : target[key](selector, ...args);
          };
        }
        // Native-harness documents inherit queries/events from Element.prototype.
        // Those are intentional original surfaces, not missing overrides.
        if (!(key in suppliedDocument)) {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const value = Reflect.get(suppliedDocument, key, suppliedDocument);
        if (key === 'addEventListener' && typeof value === 'function') {
          return (...args) => { value.apply(suppliedDocument, args); target.addEventListener(...args); };
        }
        return typeof value === 'function' ? value.bind(suppliedDocument) : value;
      },
      set(target, key, value) {
        if (key in suppliedDocument) return Reflect.set(suppliedDocument, key, value, suppliedDocument);
        return Reflect.set(target, key, value, target);
      },
    });
    assert.strictEqual(runtimeContext.document.getElementById('app-shell'), h.shell);
  }
  // Old defaults/overrides preceded subject evaluation. Do not reverse that
  // precedence by copying placeholders over genuine subject declarations.
  for (const [name, value] of Object.entries(context)) {
    if (['state', 'window', 'document', 'HTMLElement'].includes(name)
      || subjectDeclarations.has(name)) continue;
    runtimeContext[name] = value;
  }
  runtimeContext.window.ButtonComponent = context.window.ButtonComponent;
  for (const name of ['updatePlayerUi', 'updateLoopInputsFromState',
    'getPlayerDuration', 'getTimelineSecondsFromClientX']) {
    assert.equal(subjectDeclarations.has(name), true);
    assert.notStrictEqual(runtimeContext[name], context[name]);
  }
  if (observeLoopExpiry) {
    assert.equal(Object.hasOwn(overrides, 'loopEditSessionExpiryController'), true);
    const observers = overrides.loopEditSessionExpiryController;
    const owner = h.owner('loopEditSessionExpiryController');
    const descriptors = Object.getOwnPropertyDescriptors(owner);
    const propertyDescriptor = Object.getOwnPropertyDescriptor(runtimeContext, 'loopEditSessionExpiryController');
    const stopOwnedSession = owner.stop;
    observerCleanups.push(() => {
      const failures = [];
      try { stopOwnedSession('global-player'); } catch (error) { failures.push(error); }
      for (const [name, descriptor] of Object.entries(descriptors)) {
        try { Object.defineProperty(owner, name, descriptor); } catch (error) { failures.push(error); }
      }
      try {
        if (propertyDescriptor) Object.defineProperty(runtimeContext, 'loopEditSessionExpiryController', propertyDescriptor);
        else delete runtimeContext.loopEditSessionExpiryController;
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Expiry observer cleanup failed');
    });
    for (const [name, observer] of Object.entries(observers)) {
      const actual = descriptors[name]?.value;
      assert.equal(typeof observer, 'function');
      assert.equal(typeof actual, 'function');
      owner[name] = (...args) => {
        observer.apply(observers, args);
        return actual.apply(owner, args);
      };
    }
    runtimeContext.loopEditSessionExpiryController = owner;
    assert.strictEqual(owner, h.owner('loopEditSessionExpiryController'));
    assert.strictEqual(runtimeContext.loopEditSessionExpiryController, owner);
  }
  return { context: runtimeContext, audio, timeline, playButton };
}

test('never-played player hides its timestamp until a track is available', () => {
  const playerMarkup = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'),
    'utf8',
  );
  assert.match(playerMarkup, /<div class="player-time" id="player-time" hidden>0:00 \/ 0:00<\/div>/);
  const timelineWrap = new FakeElement();
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range', parentElement: timelineWrap });
  const time = new FakeElement({ hidden: false });
  const play = new FakeElement({ tagName: 'BUTTON' });
  const player = new FakeElement();
  const state = {
    player: {
      current: null,
      loopActive: false,
      loopStart: 0,
      loopEnd: 30,
      saveBusy: false,
      waveform: { renderToken: 0 },
    },
    utility: {},
  };
  const { context } = loadHelper({
    state,
    timeline,
    playButton: play,
    player,
    getPlayerPlaybackSnapshot: () => ({
      currentTime: 0, duration: 0, paused: true, ended: false, src: '',
    }),
    getPlayerElements: () => ({ player, timeline, time, play }),
  });

  context.updatePlayerUi();
  assert.equal(time.hidden, true);
  assert.equal(timelineWrap.classList.contains('is-idle'), true);

  state.player.current = { src: '/track?path=song.flac', title: 'Song' };
  context.getPlayerPlaybackSnapshot = () => ({
    currentTime: 3, duration: 60, paused: true, ended: false, src: '/track?path=song.flac',
  });
  context.updatePlayerUi();
  assert.equal(time.hidden, false);
  assert.equal(time.textContent, '3 / 60');
});

test('optional track paint notification cannot interrupt the native player update', () => {
  const {context} = loadHelper();
  assert.doesNotThrow(() => context.updatePlayerUi(), 'an absent React track module remains optional');
  let notifications = 0;
  context.window.AlbumHavenTrackPlayback = {sync() {notifications++; throw new Error('Paint failed');}};
  assert.doesNotThrow(() => context.updatePlayerUi());
  assert.equal(notifications, 1);
});

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
  const prepared = await prepareLocalPlayingControl(context);
  const work = [];
  prepared.owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(work);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Control dispatch work failed');
  });
  for (const name of ['pauseStreamingPlayback', 'resumeStreamingPlayback']) {
    const observer = context[name];
    context[name] = (...args) => {
      observer(...args);
      const actualWork = prepared.owners[name](...args);
      work.push(actualWork);
      void Promise.resolve(actualWork).catch(() => {});
      return actualWork;
    };
  }
  context.canStartPlaybackInThisTab = (...args) => prepared.owners.canStartPlaybackInThisTab(...args);
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
  assert.equal(work.length, 2);
  assert.strictEqual(prepared.engine.roles.current, prepared.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(prepared.attempt), true);
  const handle = context.getActivePlaybackOwnershipHandle();
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(prepared.role.firstFrameNotified, true);
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

test('isolated streaming pause and resume preserve listen, ownership requests, and UI effects', async () => {
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
  });
  const owners = runtimeFixtureOwners.get(context);
  const work = [];
  const retain = pending => {
    work.push(pending);
    void Promise.resolve(pending).catch(() => {});
    return pending;
  };
  owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(work);
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Pause/resume owner work failed');
  });
  const scope = context.capturePlaybackOwnershipScope();
  let attempt;
  context.resumeStreamingPlayback = owners.resumeStreamingPlayback;
  const role = await retain(owners.startStreamingTrack(track, {
    autoplay: true, startSeconds: 12, onStartAttempt(value) { attempt = value; },
  }));
  const engine = context.streamingEngineState();
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.snapshot.currentTime, 12);
  assert.equal(engine.snapshot.paused, false);
  const handle = owners.canStartPlaybackInThisTab(track, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(scope)
      && context.state.player.current === track && engine.roles.current === role
      && context.isStreamingPlaybackAttemptCurrent(attempt),
  });
  assert.ok(handle);
  assert.equal(context.bindPlaybackOwnershipAttempt(handle, attempt), true);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(role.firstFrameNotified, true);
  context.pauseStreamingPlayback = (...args) => retain(Promise.resolve(owners.pauseStreamingPlayback(...args)).then(result => {
    snapshot.paused = true;
    assert.equal(engine.snapshot.paused, true);
    return result;
  }));
  context.resumeStreamingPlayback = (...args) => retain(Promise.resolve(owners.resumeStreamingPlayback(...args)).then(result => {
    snapshot.paused = false;
    snapshot.ended = false;
    assert.equal(engine.snapshot.paused, false);
    return result;
  }));
  // Explicit action-effect isolation: record requested release without retiring
  // the real preissued handle. Full release/reclaim is tested separately below.
  context.releasePlaybackOwnership = (status, releasedHandle) => {
    ownershipReleases.push({ status, handle: releasedHandle });
    return true;
  };
  context.canStartPlaybackInThisTab = (activeTrack, options) => {
    ownershipClaims.push(activeTrack);
    assert.strictEqual(activeTrack, track);
    assert.equal(options.isCurrent(), true);
    assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
    return handle;
  };
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
  assert.deepEqual(ownershipReleases, [{ status: 'paused', handle }]);
  assert.equal(uiUpdates, 1);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(engine.context.state, 'suspended');

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ownershipClaims, [track]);
  assert.deepEqual(listenResumes, [{ track, startSeconds: 12 }]);
  assert.deepEqual(nowPlaying, [{ track, session: resumedSession }]);
  assert.equal(uiUpdates, 2);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.strictEqual(engine.roles.current, role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(role.firstFrameNotified, true);
});

test('streaming pause and resume release and reclaim real ownership with every repaint', async () => {
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
  const events = [];
  let resumedHandle;
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
  });
  const owners = runtimeFixtureOwners.get(context);
  const actualRelease = context.releasePlaybackOwnership;
  const work = [];
  const retain = pending => {
    work.push(pending);
    void Promise.resolve(pending).catch(() => {});
    return pending;
  };
  owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(work);
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Pause/resume owner work failed');
  });
  const scope = context.capturePlaybackOwnershipScope();
  let attempt;
  context.resumeStreamingPlayback = owners.resumeStreamingPlayback;
  const role = await retain(owners.startStreamingTrack(track, {
    autoplay: true, startSeconds: 12, onStartAttempt(value) { attempt = value; },
  }));
  const engine = context.streamingEngineState();
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.snapshot.currentTime, 12);
  assert.equal(engine.snapshot.paused, false);
  const handle = owners.canStartPlaybackInThisTab(track, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(scope)
      && context.state.player.current === track && engine.roles.current === role
      && context.isStreamingPlaybackAttemptCurrent(attempt),
  });
  assert.ok(handle);
  assert.equal(context.bindPlaybackOwnershipAttempt(handle, attempt), true);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(role.firstFrameNotified, true);
  context.pauseStreamingPlayback = (...args) => retain(Promise.resolve(owners.pauseStreamingPlayback(...args)).then(result => {
    snapshot.paused = true;
    assert.equal(engine.snapshot.paused, true);
    return result;
  }));
  context.resumeStreamingPlayback = (...args) => retain(Promise.resolve(owners.resumeStreamingPlayback(...args)).then(result => {
    snapshot.paused = false;
    snapshot.ended = false;
    assert.equal(engine.snapshot.paused, false);
    return result;
  }));
  context.releasePlaybackOwnership = (status, releasedHandle) => {
    events.push({ type: 'release', status, handle: releasedHandle });
    ownershipReleases.push({ status, handle: releasedHandle });
    return actualRelease(status, releasedHandle);
  };
  context.canStartPlaybackInThisTab = (activeTrack, options) => {
    ownershipClaims.push(activeTrack);
    events.push({ type: 'claim', track: activeTrack });
    resumedHandle = owners.canStartPlaybackInThisTab(activeTrack, options);
    return resumedHandle;
  };
  context.closeListenSegment = () => closedSegments.push('closed');
  context.markListenSessionPaused = (offset) => pausedOffsets.push(offset);
  context.maybeScrobbleListenSession = async (session) => scrobbles.push(session);
  context.resumeListenSessionPlayback = async (activeTrack, startSeconds) => {
    listenResumes.push({ track: activeTrack, startSeconds });
    return resumedSession;
  };
  context.maybeSendNowPlaying = async (activeTrack, session) => nowPlaying.push({ track: activeTrack, session });
  context.updatePlayerUi = () => {
    uiUpdates += 1;
    events.push({ type: 'ui', track: context.state.player.current,
      handle: context.getActivePlaybackOwnershipHandle() });
  };

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(closedSegments, ['closed']);
  assert.deepEqual(pausedOffsets, [12]);
  assert.deepEqual(scrobbles, [pausedSession]);
  assert.deepEqual(ownershipReleases, [{ status: 'paused', handle }]);
  assert.equal(uiUpdates, 2);
  assert.deepEqual(events, [
    { type: 'release', status: 'paused', handle },
    { type: 'ui', track, handle: null },
    { type: 'ui', track, handle: null },
  ]);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), false);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(context.readPlaybackOwnershipRecord(), null);
  assert.equal(engine.context.state, 'suspended');

  assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ownershipClaims, [track]);
  assert.deepEqual(listenResumes, [{ track, startSeconds: 12 }]);
  assert.deepEqual(nowPlaying, [{ track, session: resumedSession }]);
  assert.equal(uiUpdates, 4);
  assert.ok(resumedHandle);
  assert.notStrictEqual(resumedHandle, handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(resumedHandle), true);
  assert.deepEqual(events, [
    { type: 'release', status: 'paused', handle },
    { type: 'ui', track, handle: null },
    { type: 'ui', track, handle: null },
    { type: 'claim', track },
    { type: 'ui', track, handle: resumedHandle },
    { type: 'ui', track, handle: resumedHandle },
  ]);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), resumedHandle);
  assert.strictEqual(engine.roles.current, role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.successfulPlaybackClaim(resumedHandle), false);
  assert.notEqual(role.firstFrameNotified, true);
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

  const ownedWork = [];
  const owners = runtimeFixtureOwners.get(context);
  // Existing fixture cleanup retires selection/claim and stops the engine
  // before observer cleanup. Release this gate ONLY there if action aborts.
  owners.addObserverCleanup(async () => {
    resolvePause();
    const settled = await Promise.allSettled(ownedWork);
    const errors = [...new Set(settled.filter(row => row.status === 'rejected').map(row => row.reason))];
    if (errors.length) throw new AggregateError(errors, 'Owned handoff work failed');
  });
  const prepared = await prepareLocalPlayingControl(context);
  const handle = owners.canStartPlaybackInThisTab(prepared.track, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(prepared.scope)
      && context.state.player.current === prepared.track
      && prepared.engine.roles.current === prepared.role
      && context.isStreamingPlaybackAttemptCurrent(prepared.attempt),
  });
  assert.ok(handle);
  assert.equal(context.bindPlaybackOwnershipAttempt(handle, prepared.attempt), true);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  const pauseObserver = context.pauseStreamingPlayback;
  context.pauseStreamingPlayback = (...args) => {
    const gate = pauseObserver(...args);
    const actualPause = owners.pauseStreamingPlayback(...args);
    const combined = Promise.all([gate, actualPause]).then(() => undefined);
    ownedWork.push(gate, actualPause, combined);
    for (const work of [gate, actualPause, combined]) void Promise.resolve(work).catch(() => {});
    return combined;
  };

  const firstHandoff = context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: false });
  const secondHandoff = context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: true });

  assert.equal(secondHandoff, firstHandoff);
  assert.equal(pauseCalls, 1);
  resolvePause();
  assert.equal(await firstHandoff, true);
  assert.equal(await secondHandoff, true);
  assert.equal(await context.pausePlayerPlaybackForHandoff({ ...snapshot, paused: true }), false);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), false);
  assert.notStrictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  const lease = context.readPlaybackOwnershipRecord();
  assert.equal(Boolean(lease && lease.tab_id === handle.tab_id && lease.claim_revision === handle.claim_revision), false);
  assert.strictEqual(prepared.engine.roles.current, prepared.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(prepared.attempt), true);
  assert.equal(prepared.engine.context.state, 'suspended');
  assert.equal(prepared.engine.snapshot.paused, true);
  assert.notEqual(prepared.role.firstFrameNotified, true);
});

// These two terminal cases share the reviewed finite actual-owner fixture, not
// loadHelper's legacy snapshot/control spies. No application owner is replaced.
async function actualTerminalSong(t, run) {
  const {scenario} = require('./completed-context-fixtures.cjs');
  return scenario(t, async h => {
    const track = {src: '/track?path=song.flac', path: 'C:/Music/song.flac', title: 'Song', durationSeconds: 42};
    await h.complete(h.select(track));
    const engine = h.engine(), role = engine.roles.current, node = engine.node;
    const session = h.state.player.listenSession, handle = h.c.getActivePlaybackOwnershipHandle();
    assert.ok(session && handle);
    assert.equal(h.c.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true);
    engine.socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
      role: 'current', sampleRate: 48000, channels: 2, provisionalTotalFrames: 2016000,
      requestedStartFrame: role.startFrame, timelineStartFrame: role.startFrame});
    await h.flush();
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 42);
    const configure = node.sent.filter(message => message.type === 'configure' && message.generation === role.generation).at(-1);
    const play = node.sent.filter(message => message.type === 'play' && message.generation === role.generation).at(-1);
    assert.ok(configure && play && node.sent.indexOf(configure) < node.sent.indexOf(play));
    assert.ok(Number.isSafeInteger(play.playbackIntentId) && play.playbackIntentId > 0);
    const ended = h.c.handleStreamingPlaybackEnded, callbacks = [];
    h.c.handleStreamingPlaybackEnded = function (...args) {
      const pending = ended.apply(this, args);
      callbacks.push({event: args[0], work: h.own(pending)});
      return pending;
    };
    async function finish() {
      node.emit({type: 'ended', generation: role.generation, streamId: role.streamId,
        timelineFrame: 2016000, playbackIntentId: play.playbackIntentId});
      await h.flush();
      assert.equal(callbacks.length, 1, 'genuine processor EOF reaches the actual terminal facade');
      // Finite real persistence seam replies; neither finalization nor its result
      // is stubbed. Title-only fixture does not issue a now-playing request.
      for (const path of ['/playback/session/scrobble', '/playback/session/complete']) {
        const requests = h.requests.filter(request => !request.settled
          && new URL(request.url, h.location).pathname === path);
        assert.equal(requests.length, 1, `actual terminal session reaches ${path}`);
        requests[0].resolve({ok: true}); await h.flush();
      }
      const result = await callbacks[0].work;
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 42);
      assert.equal(h.c.getPlayerPlaybackSnapshot().ended, true);
      assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
      return callbacks[0].event;
    }
    await run(h, {track, session, handle, role, node, finish});
  });
}

test('streaming terminal ended finalizes and releases ownership exactly once', async t => actualTerminalSong(t, async (h, song) => {
  const {track, session, handle, node, finish} = song;
  const finalizations = [], releases = [], uiUpdates = [];
  let releaseDepth = 0, ownershipPaintDepth = 0;
  const finalize = h.c.finalizeListenSession, release = h.c.releasePlaybackOwnership, update = h.c.updatePlayerUi;
  const repaintOwnership = h.c.repaintPlaybackOwnership;
  h.c.finalizeListenSession = function (reason, payload) {
    finalizations.push({reason, payload}); return finalize.call(this, reason, payload);
  };
  h.c.releasePlaybackOwnership = function (status, releasedHandle) {
    releases.push({status, handle: releasedHandle}); releaseDepth += 1;
    try {return release.call(this, status, releasedHandle);} finally {releaseDepth -= 1;}
  };
  h.c.repaintPlaybackOwnership = function (...args) {
    ownershipPaintDepth += 1;
    try {return repaintOwnership.apply(this, args);} finally {ownershipPaintDepth -= 1;}
  };
  h.c.updatePlayerUi = function (...args) {
    uiUpdates.push({releaseDepth, ownershipPaintDepth, finalizations: finalizations.length,
      completionState: session.completionState});
    return update.apply(this, args);
  };
  const event = await finish();
  const expectedUpdates = [
    {releaseDepth: 1, ownershipPaintDepth: 1, finalizations: 0, completionState: ''},
    {releaseDepth: 0, ownershipPaintDepth: 0, finalizations: 1, completionState: 'done'},
  ];
  assert.deepEqual(uiUpdates, expectedUpdates,
    'one ownership-release repaint precedes finalization; one direct terminal repaint follows completion');
  // Duplicate processor delivery and duplicate facade delivery are both inert.
  const play = node.sent.filter(message => message.type === 'play').at(-1);
  node.emit({type: 'ended', generation: event.generation, streamId: event.streamId,
    timelineFrame: 2016000, playbackIntentId: play.playbackIntentId});
  await h.c.handleStreamingPlaybackEnded(event); await h.flush();
  assert.equal(finalizations.length, 1);
  assert.equal(finalizations[0].reason, 'ended');
  assert.strictEqual(finalizations[0].payload.session, session);
  assert.deepEqual(Object.keys(finalizations[0].payload).sort(), ['currentTime', 'duration', 'finishedFully', 'session']);
  assert.equal(finalizations[0].payload.currentTime, 42);
  assert.equal(finalizations[0].payload.duration, 42);
  assert.equal(finalizations[0].payload.finishedFully, true);
  assert.equal(session.completionState, 'done');
  assert.equal(session.measurement.total, 0, 'terminal state does not fabricate rendered PCM credit');
  assert.deepEqual(releases, [{status: 'paused', handle}]);
  assert.equal(h.c.isPlaybackOwnershipHandleCurrent(handle), false);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.strictEqual(h.state.player.current, track);
  assert.deepEqual(uiUpdates, expectedUpdates, 'duplicate processor and facade EOF add no repaint');
}));

test('play command after terminal EOS opens a fresh generation at frame zero before requesting resume', async t => actualTerminalSong(t, async (h, song) => {
  await song.finish();
  const oldAttempt = h.engine().playbackAttempt, commands = [], seeks = [];
  const priorPort = h.platform.onPortPost, priorSocket = h.platform.onSocketSend;
  h.platform.onPortPost = (node, data) => {commands.push({channel: 'processor', ...data}); priorPort?.(node, data);};
  h.platform.onSocketSend = (socket, data) => {commands.push({channel: 'socket', ...data}); priorSocket?.(socket, data);};
  h.disposals.push(() => {h.platform.onPortPost = priorPort; h.platform.onSocketSend = priorSocket;});
  const seek = h.c.seekStreamingPlayback;
  h.c.seekStreamingPlayback = function (...args) {seeks.push(args); return seek.apply(this, args);};
  const before = h.starts.length;
  assert.equal(h.c.togglePlayerPlayback({focusTimelineOnResume: false}), true);
  await h.open();
  assert.equal(h.starts.length, before + 1, 'one actual same-song fresh start');
  await h.complete(h.starts[before].work);
  const engine = h.engine(), role = engine.roles.current;
  assert.ok(role.generation > song.role.generation, 'terminal processor state is replaced by a fresh generation');
  assert.notStrictEqual(role, song.role);
  assert.notStrictEqual(engine.playbackAttempt, oldAttempt);
  assert.equal(role.track.path, song.track.path);
  assert.equal(role.startFrame, 0);
  const opens = commands.filter(message => message.channel === 'socket' && message.type === 'open' && message.generation === role.generation);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].startFrame, 0);
  assert.equal(opens[0].path, song.track.path);
  const configure = commands.filter(message => message.channel === 'processor' && message.type === 'configure' && message.generation === role.generation);
  const plays = commands.filter(message => message.channel === 'processor' && message.type === 'play' && message.generation === role.generation);
  assert.equal(configure.length, 1); assert.equal(plays.length, 1);
  assert.ok(commands.indexOf(configure[0]) < commands.indexOf(plays[0]), 'actual configure precedes actual PLAY');
  assert.ok(Number.isSafeInteger(plays[0].playbackIntentId) && plays[0].playbackIntentId > 0);
  assert.deepEqual(seeks, [], 'terminal restart is not a seek on the ended generation');
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 0);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(h.c.getPlayerPlaybackSnapshot().ended, false);
  assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true);
  const handle = h.c.getActivePlaybackOwnershipHandle();
  assert.ok(handle); assert.notStrictEqual(handle, song.handle);
  assert.equal(h.c.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.strictEqual(engine.roles.current.track, h.state.player.current);
}));

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
  const progress = new Map();
  timeline.style = { setProperty: (name, value) => progress.set(name, value) };
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
  assert.equal(progress.get('--player-seek-progress'), `${50 / 60 * 100}%`,
    'thin seek progress must follow the pointer without waiting for an audio tick');
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
  timelineParent.dispatch('pointerdown', { clientX: 35, preventDefault() {} });
  document.dispatch('pointercancel');
  assert.equal(context.state.player.timelineDragging, false);
  assert.equal(context.state.player.timelineDragPreviewSeconds, null);
  assert.deepEqual(seeks, [30, 19, 50], 'cancelled touch must not seek');
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
    observeStreamingFacadeCallback: (...args) => {
      assert.equal(args.length, 2);
      const [result, source] = args;
      observed.push({ result, source });
      void result.catch(() => {});
    },
  });
  await prepareLocalPlayingControl(context);
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

// Reporting-only control diagnostics. Operation promises below are intentional
// dependency inputs; all role/scope/attempt/claim authority stays with real owners.
function diagnosticsControlSource(name) {
  const start = helperSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = helperSource.indexOf('\nfunction ', start + 1);
  assert.ok(end > start);
  return helperSource.slice(start, end);
}

async function loadControlDiagnosticsFixture(t, { loop = false, absentObserver = false } = {}) {
  const reports = [], warnings = [], observations = [], work = [], accepted = new Set(), gates = [];
  const consoleObserver = { ...console,
    error(...args) { reports.push(args); }, warn(...args) { warnings.push(args); },
  };
  const { context } = loadHelper({ console: consoleObserver });
  const prepared = await prepareLocalPlayingControl(context);
  const owners = prepared.owners;
  context.getPlayerPlaybackSnapshot = owners.getPlayerPlaybackSnapshot;
  // Loop bounds are explicit input to the clamped-seek unit branch, not a grant.
  context.state.player.loopActive = loop;
  context.state.player.loopStart = 10;
  context.state.player.loopEnd = 30;
  const actualObserver = context.observeStreamingFacadeCallback;
  assert.equal(typeof actualObserver, 'function');
  let subject = context;
  if (absentObserver) {
    // Narrow optional-dependency composition: do not delete an initialized owner.
    assert.equal(vm.runInContext('playerSelectionOwnership', context), null);
    assert.equal(context.captureStreamingRetiredOutgoingAttempt(), null);
    const dependencies = {
      state: context.state, console: consoleObserver,
      isPlaybackLockedByAnotherTab: context.isPlaybackLockedByAnotherTab,
      isNativePlayerSourceCurrent: context.isNativePlayerSourceCurrent,
      getPlayerPlaybackSnapshot: context.getPlayerPlaybackSnapshot,
      getActivePlaybackOwnershipHandle: context.getActivePlaybackOwnershipHandle,
      captureStreamingRetiredOutgoingAttempt: context.captureStreamingRetiredOutgoingAttempt,
      captureStreamingPlaybackAttempt: context.captureStreamingPlaybackAttempt,
      isStreamingPlaybackAttemptCurrent: context.isStreamingPlaybackAttemptCurrent,
      currentPlayerSelection: context.currentPlayerSelection,
      releasePausedPlayerSelection: context.releasePausedPlayerSelection,
      releasePlaybackOwnership: context.releasePlaybackOwnership,
      closeListenSegment: context.closeListenSegment,
      markListenSessionPaused: context.markListenSessionPaused,
      maybeScrobbleListenSession: context.maybeScrobbleListenSession,
      resumeListenSessionPlayback: context.resumeListenSessionPlayback,
      updatePlayerUi: context.updatePlayerUi,
    };
    subject = vm.createContext(dependencies);
    vm.runInContext('let pendingPlayerPlaybackHandoff = null; let playerSelectionOwnership = null;\n'
      + ['setLoopPlaybackHead', 'setPlayerPlaybackHead', 'pausePlayerPlaybackForHandoff']
        .map(diagnosticsControlSource).join('\n'), subject);
    assert.strictEqual(subject.state, context.state);
    assert.equal(vm.runInContext('typeof observeStreamingFacadeCallback', subject), 'undefined');
    assert.strictEqual(context.observeStreamingFacadeCallback, actualObserver);
  } else {
    subject.observeStreamingFacadeCallback = (...args) => {
      observations.push(args);
      return actualObserver(...args);
    };
  }
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  owners.addObserverCleanup(async () => {
    // Runtime cleanup retires actual ownership/engine first. Release only our
    // dependency gates so failed assertions cannot strand the finite teardown.
    gates.forEach(gate => gate.resolve());
    const results = await Promise.allSettled(work);
    const failures = results.flatMap((row, index) => row.status === 'rejected' && !accepted.has(work[index]) ? [row.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Unasserted diagnostics test rejection');
  });
  const defer = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const gate = { promise, resolve, reject }; gates.push(gate); work.push(promise); return gate;
  };
  const own = promise => { work.push(promise); return promise; };
  const assertRejected = async (promise, error) => {
    await assert.rejects(promise, received => received === error);
    accepted.add(promise);
  };
  const assertUnchangedEngine = (role = prepared.role, attempt = prepared.attempt) => {
    assert.strictEqual(prepared.engine.roles.current, role);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.notEqual(prepared.engine.mode, 'error');
    assert.equal(prepared.engine.context.state, 'running');
    assert.equal(prepared.engine.context.closeCount, 0);
    assert.equal(prepared.engine.node.disconnectCount, 0);
  };
  return { context, subject, prepared, owners, reports, warnings, observations,
    unhandled, defer, own, assertRejected, assertUnchangedEngine };
}

function invokeDiagnosticControl(f, route, result) {
  const calls = [];
  if (route === 'pause') {
    f.subject.pauseStreamingPlayback = () => { calls.push([]); return result; };
    return { calls, returned: f.own(f.subject.pausePlayerPlaybackForHandoff()) };
  }
  f.subject.seekStreamingPlayback = (...args) => { calls.push(args); return result; };
  return { calls, returned: f.subject.setPlayerPlaybackHead(50) };
}

for (const route of ['pause', 'normal seek', 'clamped seek']) {
  test(`control diagnostics reports ${route} rejection once with the exact two-argument observer route`, async t => {
    const f = await loadControlDiagnosticsFixture(t, { loop: route === 'clamped seek' });
    const gate = f.defer(), error = new Error(`${route} rejection identity`);
    const { calls, returned } = invokeDiagnosticControl(f, route, gate.promise);
    const expected = route === 'pause' ? returned : gate.promise;
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].length, 2);
    assert.strictEqual(f.observations[0][0], expected);
    assert.equal(f.observations[0][1], route === 'pause' ? 'pause-control-error' : 'seek-control-error');
    assert.deepEqual(calls, route === 'pause' ? [[]] : [[route === 'clamped seek' ? 30 : 50]]);
    if (route !== 'pause') assert.equal(returned, undefined);
    gate.reject(error);
    await f.assertRejected(gate.promise, error);
    if (route === 'pause') await f.assertRejected(returned, error);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.reports, [['Streaming facade callback failed', error]]);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.unhandled, []);
    f.assertUnchangedEngine();
  });
}

test('pause diagnostics preserves pending promise sharing, exact rejection and finally latch cleanup', async t => {
  const f = await loadControlDiagnosticsFixture(t);
  const gate = f.defer(), error = new Error('pending pause identity');
  const { returned: first } = invokeDiagnosticControl(f, 'pause', gate.promise);
  const second = f.subject.pausePlayerPlaybackForHandoff();
  assert.strictEqual(first, second);
  assert.strictEqual(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), first);
  assert.equal(f.observations.length, 1);
  assert.strictEqual(f.observations[0][0], first);
  gate.reject(error);
  await f.assertRejected(gate.promise, error);
  await f.assertRejected(first, error);
  assert.equal(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), null);
  const next = f.defer();
  const { returned: third } = invokeDiagnosticControl(f, 'pause', next.promise);
  assert.notStrictEqual(third, first);
  assert.equal(f.observations.length, 2);
  next.resolve();
  assert.equal(await third, true);
  assert.equal(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.reports, [['Streaming facade callback failed', error]]);
  assert.deepEqual(f.unhandled, []);
});

for (const route of ['pause', 'normal seek', 'clamped seek']) {
  test(`optional diagnostics absence preserves ${route} rejection fallback without removing a real owner`, async t => {
    const f = await loadControlDiagnosticsFixture(t, { loop: route === 'clamped seek', absentObserver: true });
    const gate = f.defer(), error = new Error(`${route} optional observer absence`);
    const { returned } = invokeDiagnosticControl(f, route, gate.promise);
    gate.reject(error);
    // Let the product fallback alone observe rejection before assertion ownership.
    await new Promise(resolve => setImmediate(resolve));
    await f.assertRejected(gate.promise, error);
    if (route === 'pause') {
      await f.assertRejected(returned, error);
      assert.equal(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), null);
    } else assert.equal(returned, undefined);
    assert.deepEqual(f.observations, []);
    assert.deepEqual(f.reports, []);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.unhandled, []);
    f.assertUnchangedEngine();
  });
}

for (const route of ['pause', 'normal seek', 'clamped seek']) {
  test(`control diagnostics does not swallow a synchronous ${route} dependency throw`, async t => {
    const f = await loadControlDiagnosticsFixture(t, { loop: route === 'clamped seek' });
    const error = new Error(`${route} synchronous identity`);
    let calls = 0;
    const throwExact = () => { calls += 1; throw error; };
    if (route === 'pause') f.subject.pauseStreamingPlayback = throwExact;
    else f.subject.seekStreamingPlayback = throwExact;
    assert.throws(() => route === 'pause'
      ? f.subject.pausePlayerPlaybackForHandoff() : f.subject.setPlayerPlaybackHead(50), received => received === error);
    assert.equal(calls, 1);
    assert.deepEqual(f.observations, []);
    assert.deepEqual(f.reports, []);
    assert.equal(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), null);
    f.assertUnchangedEngine();
  });
}

for (const route of ['pause', 'normal seek', 'clamped seek']) {
  test(`control diagnostics leaves successful ${route} return and reporting semantics unchanged`, async t => {
    const f = await loadControlDiagnosticsFixture(t, { loop: route === 'clamped seek' });
    const gate = f.defer();
    const { returned } = invokeDiagnosticControl(f, route, gate.promise);
    if (route === 'pause') assert.strictEqual(f.subject.pausePlayerPlaybackForHandoff(), returned);
    else assert.equal(returned, undefined);
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].length, 2);
    assert.strictEqual(f.observations[0][0], route === 'pause' ? returned : gate.promise);
    gate.resolve(true);
    if (route === 'pause') {
      assert.equal(await returned, true);
      assert.equal(vm.runInContext('pendingPlayerPlaybackHandoff', f.subject), null);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.reports, []);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.unhandled, []);
  });
}

for (const route of ['pause', 'normal seek', 'clamped seek']) {
  test(`late ${route} rejection is reporting-only and cannot fail a genuine successor`, async t => {
    const f = await loadControlDiagnosticsFixture(t, { loop: route === 'clamped seek' });
    const gate = f.defer(), error = new Error(`${route} retired dependency`);
    const { returned } = invokeDiagnosticControl(f, route, gate.promise);
    const successor = { path: 'C:/Music/successor.flac', src: '/track?path=successor.flac', title: 'Successor' };
    for (const name of ['startStreamingTrack', 'resumeStreamingPlayback', 'canStartPlaybackInThisTab']) {
      f.context[name] = f.owners[name];
    }
    assert.equal(await f.own(f.context.playTrackFromPayload(successor)), true);
    const engine = f.context.streamingEngineState(), role = engine.roles.current;
    const attempt = f.context.captureStreamingPlaybackAttempt(), handle = f.context.getActivePlaybackOwnershipHandle();
    assert.strictEqual(role.track, successor);
    assert.equal(f.context.isPlaybackOwnershipHandleCurrent(handle), true);
    const closes = engine.context.closeCount, disconnects = engine.node.disconnectCount;
    gate.reject(error);
    await f.assertRejected(gate.promise, error);
    if (route === 'pause') await f.assertRejected(returned, error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].length, 2);
    assert.deepEqual(f.reports, [['Streaming facade callback failed', error]]);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.unhandled, []);
    assert.strictEqual(engine.roles.current, role);
    assert.strictEqual(f.context.state.player.current, successor);
    assert.equal(f.context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.strictEqual(f.context.getActivePlaybackOwnershipHandle(), handle);
    assert.equal(f.context.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.notEqual(engine.mode, 'error');
    assert.equal(engine.context.state, 'running');
    assert.equal(engine.context.closeCount, closes);
    assert.equal(engine.node.disconnectCount, disconnects);
  });
}

test('playTrackFromPayload claims ownership and dispatches streaming start without assigning native src', async () => {
  const nativeSrcAssignments = [];
  const audio = new FakeAudioElement({ src: '' });
  const originalSetAttribute = audio.setAttribute.bind(audio);
  audio.setAttribute = (name, value) => {
    if (name === 'src') nativeSrcAssignments.push(String(value));
    originalSetAttribute(name, value);
  };
  const ownershipClaims = [];
  let issuedHandle;
  const streamingStarts = [];
  const { context } = loadHelper({
    audio,
    canStartPlaybackInThisTab(track, options) {
      ownershipClaims.push(track);
      issuedHandle = runtimeFixtureOwners.get(context).canStartPlaybackInThisTab(track, options);
      return issuedHandle;
    },
    async startStreamingTrack(track, options) {
      streamingStarts.push({ track, options });
      return runtimeFixtureOwners.get(context).startStreamingTrack(track, options);
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
  const engine = context.streamingEngineState();
  const attempt = context.captureStreamingPlaybackAttempt();
  const selection = vm.runInContext('playerSelectionOwnership', context);
  assert.ok(issuedHandle);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), issuedHandle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(issuedHandle), true);
  assert.ok(attempt);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.strictEqual(selection.handle, issuedHandle);
  assert.strictEqual(selection.attempt, attempt);
  assert.strictEqual(engine.roles.current.track, track);
  assert.strictEqual(context.state.player.current, track);
  assert.notEqual(engine.roles.current.firstFrameNotified, true);
  assert.equal(engine.diagnostics.firstFrameAtMs, 0);
  assert.equal(context.successfulPlaybackClaim(issuedHandle), false);
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
  let issuedHandle;
  const { context } = loadHelper({
    audio,
    canStartPlaybackInThisTab(track, options) {
      issuedHandle = runtimeFixtureOwners.get(context).canStartPlaybackInThisTab(track, options);
      return issuedHandle;
    },
    startStreamingTrack: async () => { throw failure; },
  });

  await assert.rejects(
    context.playTrackFromPayload({
      path: 'C:\\Music\\Rejected.flac', src: '/track?path=Rejected.flac', title: 'Rejected',
    }),
    (error) => error === failure,
  );
  assert.deepEqual(nativeSrcAssignments, []);
  assert.ok(issuedHandle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(issuedHandle), false);
  assert.notStrictEqual(context.getActivePlaybackOwnershipHandle(), issuedHandle);
  const lease = context.readPlaybackOwnershipRecord();
  assert.equal(Boolean(lease && lease.tab_id === issuedHandle.tab_id
    && lease.claim_revision === issuedHandle.claim_revision), false);
  assert.equal(context.streamingEngineState().roles.current, null);
  assert.equal(context.captureStreamingPlaybackAttempt(), null);
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
  const uiEvents = [];
  const publications = [];
  const handles = [];
  const work = [];
  let startIndex = 0;
  const { context } = loadHelper({
    audio,
    resumeListenSessionPlayback: async (track) => {
      listenTracks.push(track);
      return { track };
    },
    maybeSendNowPlaying: async (track) => {
      nowPlayingTracks.push(track);
    },
  });
  const owners = runtimeFixtureOwners.get(context);
  const retain = pending => {
    work.push(pending);
    void Promise.resolve(pending).catch(() => {});
    return pending;
  };
  owners.addObserverCleanup(async () => {
    // Fixture teardown retires selection/claim and stops the engine BEFORE
    // releasing these completion gates; stale publication cannot be revived.
    firstStart.resolve();
    secondStart.resolve();
    const settled = await Promise.allSettled(work);
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Rapid-selection owner work failed');
  });
  context.getPlayerPlaybackSnapshot = owners.getPlayerPlaybackSnapshot;
  context.resumeStreamingPlayback = (...args) => retain(owners.resumeStreamingPlayback(...args));
  context.canStartPlaybackInThisTab = (...args) => {
    const handle = owners.canStartPlaybackInThisTab(...args);
    handles.push(handle);
    return handle;
  };
  context.startStreamingTrack = (...args) => {
    const gate = starts[startIndex++];
    // Invoke genuine admission NOW. Only its returned completion is delayed.
    const actual = retain(owners.startStreamingTrack(...args));
    return retain(Promise.all([actual, gate.promise]).then(([role]) => role));
  };
  const actualPublish = context.setCurrentPlayerTrack;
  context.setCurrentPlayerTrack = (...args) => {
    const published = actualPublish(...args);
    if (published) publications.push(published);
    return published;
  };
  context.updatePlayerUi = () => {
    uiCurrentPaths.push(String(context.state.player.current?.path || ''));
    uiEvents.push({ track: context.state.player.current, handle: context.getActivePlaybackOwnershipHandle() });
  };
  const olderTrack = {
    path: 'C:\\Music\\Older.flac', src: '/track?path=Older.flac', title: 'Older',
  };
  const newerTrack = {
    path: 'C:\\Music\\Newer.flac', src: '/track?path=Newer.flac', title: 'Newer',
  };

  const initialTrack = context.state.player.current;
  const olderResult = retain(context.playTrackFromPayload(olderTrack));
  const newerResult = retain(context.playTrackFromPayload(newerTrack));
  assert.equal(startIndex, 2);
  assert.equal(handles.length, 2);
  assert.ok(handles[0]);
  assert.ok(handles[1]);
  assert.notStrictEqual(handles[0], handles[1]);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handles[0]), false);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handles[1]), true);
  secondStart.resolve({ role: 'current', streamId: 2, generation: 2 });
  assert.equal(await newerResult, true);
  firstStart.resolve({ role: 'current', streamId: 1, generation: 1 });
  assert.equal(await olderResult, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(context.state.player.current, newerTrack);
  assert.deepEqual(listenTracks, [newerTrack]);
  assert.deepEqual(nowPlayingTracks, [newerTrack]);
  // Approved observation split: exactly one successful publication, plus ALL
  // ownership and facade repaints (including the pre-publication old display).
  assert.deepEqual(publications, [newerTrack]);
  assert.deepEqual(uiEvents, [
    { track: initialTrack, handle: handles[0] },
    { track: initialTrack, handle: null },
    { track: initialTrack, handle: handles[1] },
    { track: newerTrack, handle: handles[1] },
    { track: newerTrack, handle: handles[1] },
  ]);
  assert.deepEqual(uiCurrentPaths, ['', '', '', newerTrack.path, newerTrack.path]);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handles[1]);
  const engine = context.streamingEngineState();
  assert.strictEqual(engine.roles.current.track, newerTrack);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(context.captureStreamingPlaybackAttempt()), true);
  assert.equal(context.successfulPlaybackClaim(handles[1]), false);
  assert.notEqual(engine.roles.current.firstFrameNotified, true);
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
  let promotedCurrent, repeatedFirstFrame;
  const { context } = loadHelper({
    audio,
    state: {
      player: { current: outgoing, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
  });
  const owners = runtimeFixtureOwners.get(context);
  const retained = [], thrown = [];
  owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(retained);
    const errors = [...thrown, ...settled.filter(row => row.status === 'rejected').map(row => row.reason)];
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Owned promoted replacement failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  const forward = callback => (...args) => {
    try { return retain(callback(...args)); }
    catch (error) { thrown.push(error); throw error; }
  };
  context.getPlayerPlaybackSnapshot = owners.getPlayerPlaybackSnapshot;
  context.resumeStreamingPlayback = forward(owners.resumeStreamingPlayback);
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = forward(firstFrame);
  // Genuine outgoing setup precedes installation of ALL original action observers.
  const outgoingRole = await retain(owners.startStreamingTrack(outgoing, { autoplay: true }));
  const engine = context.streamingEngineState();
  assert.strictEqual(engine.roles.current, outgoingRole);
  assert.strictEqual(outgoingRole.track, outgoing);
  assert.equal(engine.context.state, 'running');
  engine.socket.open();
  const metadata = (role, total) => ({ type: 'metadata', generation: role.generation,
    streamId: role.streamId, role: role.role, sampleRate: 48000, channels: 2,
    provisionalTotalFrames: total, requestedStartFrame: role.startFrame, timelineStartFrame: role.startFrame });
  engine.socket.emit(metadata(outgoingRole, 96000));
  // Declared finite processor/server reports, not decoded or physically rendered PCM.
  engine.node.emit({ type: 'consumed', generation: outgoingRole.generation,
    streamId: outgoingRole.streamId, role: 'current', frames: 0, bufferedFrames: 48000 });
  engine.node.emit({ type: 'first-frame', generation: outgoingRole.generation,
    streamId: outgoingRole.streamId, renderedFrame: 1, contextTime: 0 });
  assert.equal(outgoingRole.firstFrameNotified, true);
  assert.ok(engine.diagnostics.firstFrameAtMs > 0);
  assert.equal(engine.diagnostics.bufferedFrames.current, 48000);
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(vm.runInContext('playerSelectionOwnership', context), null);
  const scope = context.capturePlaybackOwnershipScope();
  const handle = owners.canStartPlaybackInThisTab(replacement, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(scope)
      && context.isNativePlayerSourceCurrent(replacement),
  });
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.strictEqual(context.state.player.current, outgoing);
  assert.deepEqual(starts, []);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(listenTracks, []);
  assert.deepEqual(nowPlayingTracks, []);
  assert.deepEqual(uiCurrentPaths, []);
  // Original isolated provider boundary: one genuinely issued exact-track grant.
  // No in-action owner repaint is filtered; this is not full claim integration.
  Object.assign(context, {
    canStartPlaybackInThisTab(track, options) {
      assert.strictEqual(track, replacement);
      if (!context.isPlaybackOwnershipScopeCurrent(scope)
        || !context.isPlaybackOwnershipHandleCurrent(handle)
        || options?.isCurrent?.() !== true) return false;
      return handle;
    },
    async startStreamingTrack(track, options) {
      starts.push({ track, options });
      const completion = retain(owners.startStreamingTrack(track, options));
      const pending = engine.pendingSeek;
      assert.ok(pending);
      assert.equal(pending.kind, 'replacement');
      assert.equal(pending.currentStreamId, outgoingRole.streamId);
      const incoming = engine.roles.continuity;
      assert.ok(incoming);
      assert.strictEqual(incoming.track, replacement);
      assert.equal(pending.streamId, incoming.streamId);
      assert.ok(engine.node.sent.some(message => message.type === 'reserve-seek'
        && message.generation === pending.generation && message.streamId === incoming.streamId));
      const total = incoming.targetBufferFrames;
      assert.ok(Number.isInteger(total) && total > 0);
      engine.socket.emit(metadata(incoming, total));
      engine.node.emit({ type: 'consumed', generation: incoming.generation,
        streamId: incoming.streamId, role: 'continuity', frames: 0, bufferedFrames: total });
      engine.socket.emit({ type: 'eos', generation: incoming.generation, streamId: incoming.streamId,
        role: 'continuity', emittedFrames: total, authoritativeTotalFrames: total });
      assert.equal(pending.prepareSent, true);
      assert.ok(engine.node.sent.some(message => message.type === 'prepare-seek'
        && message.generation === pending.generation && message.streamId === incoming.streamId));
      engine.node.emit({ type: 'seek-boundary', generation: pending.generation,
        outgoingStreamId: outgoingRole.streamId, incomingStreamId: incoming.streamId,
        timelineFrame: 0, renderedFrame: 0 });
      assert.strictEqual(engine.roles.current, incoming);
      assert.equal(engine.roles.continuity, null);
      assert.equal(engine.pendingSeek, null);
      assert.ok(engine.pendingPromotion);
      engine.socket.emit({ type: 'promoted', generation: incoming.generation,
        streamId: incoming.streamId, role: 'current' });
      assert.equal(engine.pendingPromotion, null);
      assert.strictEqual(context.state.player.current, outgoing);
      engine.node.emit({ type: 'first-frame', generation: incoming.generation,
        streamId: incoming.streamId, renderedFrame: 1, contextTime: 0 });
      assert.equal(incoming.firstFrameNotified, true);
      assert.deepEqual(scheduled, []);
      assert.deepEqual(listenTracks, []);
      promotedCurrent = await completion;
      assert.strictEqual(promotedCurrent, incoming);
      assert.equal(context.isStreamingPlaybackAttemptCurrent(context.captureStreamingPlaybackAttempt()), true);
      repeatedFirstFrame = { generation: promotedCurrent.generation,
        streamId: promotedCurrent.streamId, trackPath: replacement.path };
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
  context.startStreamingTrack = forward(context.startStreamingTrack);
  context.playTrackFromPayload = forward(context.playTrackFromPayload);
  context.updatePlayerUi = () => {
    uiCurrentPaths.push(String(context.state.player.current?.path || ''));
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
  assert.strictEqual(engine.roles.current, promotedCurrent);
  assert.strictEqual(promotedCurrent.track, replacement);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  const selection = vm.runInContext('playerSelectionOwnership', context);
  assert.strictEqual(selection.handle, handle);
  assert.strictEqual(selection.attempt, context.captureStreamingPlaybackAttempt());
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

  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Simulated processor callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  const current = context.state.player.current;
  assert.equal(current.src, '/track?path=song.flac');
  assert.equal(Object.hasOwn(current, 'path'), false);
  current.path = 'C:/Music/song.flac';
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  assert.equal(await retain(context.playTrackFromPayload(current, { autoplay: true })), true);
  const engine = context.streamingEngineState();
  const role = engine.roles.current;
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  assert.strictEqual(role.track, current);
  assert.ok(handle);
  assert.ok(attempt);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  let firstFrameWork;
  let firstFrameEvent;
  let firstFrameCalls = 0;
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameCalls += 1;
    firstFrameEvent = event;
    firstFrameWork = retain(firstFrame(event));
    return firstFrameWork;
  };
  assert.equal(peekCalls, 0);
  assert.deepEqual(scheduled, []);
  // Simulated processor delivery tests facade dispatch, not rendered PCM or LS-09 evidence.
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;

  assert.equal(peekCalls, 1);
  assert.deepEqual(scheduled, [nextTrack]);
  assert.equal(firstFrameCalls, 1);
  assert.equal(firstFrameEvent.trackPath, current.path);
  assert.equal(firstFrameEvent.generation, role.generation);
  assert.equal(firstFrameEvent.streamId, role.streamId);
  assert.equal(context.successfulPlaybackClaim(handle), true);
});

test('changing tracks clears an outgoing timeline drag preview', () => {
  const { context } = loadHelper();
  context.state.player.timelineDragging = true;
  context.state.player.timelineDragPreviewSeconds = 210;
  context.setCurrentPlayerTrack({ path: 'next.flac', durationSeconds: 300 });
  assert.equal(context.state.player.timelineDragging, false);
  assert.equal(context.state.player.timelineDragPreviewSeconds, null);
});

test('streaming boundary consumes the queued track exactly once', async () => {
  const nextTrack = { path: 'C:\\Music\\Next.flac', durationSeconds: 30 };
  let consumeCalls = 0;
  const { context } = loadHelper({
    peekNextQueuedTrack: () => nextTrack,
    getNextQueuedTrack() {
      consumeCalls += 1;
      return nextTrack;
    },
  });

  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Simulated processor callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  const current = context.state.player.current;
  assert.equal(current.src, '/track?path=song.flac');
  assert.equal(Object.hasOwn(current, 'path'), false);
  current.path = 'C:/Music/song.flac';
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  assert.equal(await retain(context.playTrackFromPayload(current, { autoplay: true })), true);
  const engine = context.streamingEngineState();
  const role = engine.roles.current;
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  assert.strictEqual(role.track, current);
  assert.ok(handle);
  assert.ok(attempt);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  let firstFrameWork;
  let firstFrameEvent;
  let firstFrameCalls = 0;
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameCalls += 1;
    firstFrameEvent = event;
    firstFrameWork = retain(firstFrame(event));
    return firstFrameWork;
  };
  assert.equal(consumeCalls, 0);
  // Simulated readiness and boundary reports are unit inputs, not rendering evidence.
  engine.node.emit({ type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000 });
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;
  assert.equal(firstFrameCalls, 1);
  assert.equal(firstFrameEvent.trackPath, current.path);
  assert.equal(context.successfulPlaybackClaim(handle), true);
  const continuity = engine.roles.continuity;
  assert.ok(continuity);
  assert.strictEqual(continuity.track, nextTrack);
  assert.equal(continuity.continuityOptions.kind, 'queued-next');
  assert.equal(consumeCalls, 0);
  const renderedFrame = context.getPlayerPlaybackSnapshot().renderedFrame;
  assert.equal(renderedFrame, 1);
  let boundaryWork;
  let boundaryEvent;
  let boundaryCalls = 0;
  const boundary = context.handleStreamingPlaybackBoundary;
  context.handleStreamingPlaybackBoundary = event => {
    boundaryCalls += 1;
    boundaryEvent = event;
    boundaryWork = retain(boundary(event));
    return boundaryWork;
  };

  engine.node.emit({ type: 'boundary', generation: role.generation,
    outgoingStreamId: role.streamId, incomingStreamId: continuity.streamId,
    renderedFrame, timelineFrame: 0 });
  assert.ok(boundaryWork);
  await boundaryWork;

  assert.equal(consumeCalls, 1);
  assert.equal(boundaryCalls, 1);
  assert.equal(boundaryEvent.outgoingTrackPath, current.path);
  assert.equal(boundaryEvent.incomingTrackPath, nextTrack.path);
  assert.equal(boundaryEvent.generation, role.generation);
  assert.equal(boundaryEvent.outgoingStreamId, role.streamId);
  assert.equal(boundaryEvent.incomingStreamId, continuity.streamId);
  assert.strictEqual(context.state.player.current, nextTrack);
  assert.strictEqual(engine.roles.current, continuity);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.successfulPlaybackClaim(handle), true);
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
  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Simulated boundary callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  assert.equal(await retain(context.playTrackFromPayload(outgoing, { autoplay: true })), true);
  const engine = context.streamingEngineState();
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  const role = engine.roles.current;
  assert.ok(handle);
  assert.ok(attempt);
  assert.strictEqual(role.track, outgoing);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(consumeCalls, 0);
  let firstFrameWork;
  let firstFrameCalls = 0;
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = (...args) => {
    firstFrameCalls += 1;
    firstFrameWork = retain(firstFrame(...args));
    return firstFrameWork;
  };
  // Simulated processor reports exercise owner guards, not PCM rendering or LS-09 evidence.
  engine.node.emit({ type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000 });
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;
  assert.equal(firstFrameCalls, 1);
  assert.equal(context.successfulPlaybackClaim(handle), true);
  const continuity = engine.roles.continuity;
  assert.ok(continuity);
  assert.strictEqual(continuity.track, incoming);
  assert.equal(continuity.continuityOptions.kind, 'queued-next');
  assert.equal(consumeCalls, 0);
  let boundary;
  let boundaryWork;
  let boundaryCalls = 0;
  const originalBoundary = context.handleStreamingPlaybackBoundary;
  context.handleStreamingPlaybackBoundary = (event) => {
    boundaryCalls += 1;
    boundary = event;
    boundaryWork = retain(originalBoundary(event));
    return boundaryWork;
  };

  engine.node.emit({ type: 'boundary', generation: role.generation,
    outgoingStreamId: role.streamId, incomingStreamId: continuity.streamId,
    renderedFrame: 1440000, timelineFrame: 0 });
  assert.ok(boundaryWork);
  await boundaryWork;
  assert.equal(boundaryCalls, 1);
  assert.equal(boundary.renderedFrame, 1440000);
  assert.equal(boundary.outgoingTrackPath, outgoing.path);
  assert.equal(boundary.incomingTrackPath, incoming.path);
  await retain(originalBoundary(boundary));

  assert.equal(consumeCalls, 1);
  assert.strictEqual(context.state.player.current, incoming);
  assert.strictEqual(engine.roles.current, continuity);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.successfulPlaybackClaim(handle), true);
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
  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Session boundary callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  const controlledSnapshot = context.getPlayerPlaybackSnapshot;
  context.getPlayerPlaybackSnapshot = owners.getPlayerPlaybackSnapshot;
  context.resumeStreamingPlayback = owners.resumeStreamingPlayback;
  const scope = context.capturePlaybackOwnershipScope();
  const handle = owners.canStartPlaybackInThisTab(outgoing, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(scope),
  });
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  let attempt;
  const role = await retain(owners.startStreamingTrack(outgoing, {
    startSeconds: 0, autoplay: true,
    onStartAttempt(value) {
      attempt = value;
      assert.equal(context.bindPlaybackOwnershipAttempt(handle, value), true);
    },
  }));
  const engine = context.streamingEngineState();
  assert.ok(role);
  assert.ok(attempt);
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, outgoing);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(owners.getPlayerPlaybackSnapshot().paused, false);
  let firstFrameWork;
  let firstFrameCalls = 0;
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameCalls += 1;
    firstFrameWork = retain(firstFrame(event));
    return firstFrameWork;
  };
  // Simulated processor coordinates exercise session handoff, not rendered PCM or LS-09 evidence.
  engine.node.emit({ type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000 });
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;
  assert.equal(firstFrameCalls, 1);
  assert.equal(context.commitPlaybackOwnership(handle, role, outgoing), true);
  assert.equal(context.successfulPlaybackClaim(handle), true);
  const continuity = engine.roles.continuity;
  assert.ok(continuity);
  assert.strictEqual(continuity.track, incoming);
  assert.equal(continuity.continuityOptions.kind, 'queued-next');
  assert.strictEqual(context.state.player.current, outgoing);
  assert.strictEqual(context.state.player.listenSession, outgoingSession);
  assert.equal(consumeCalls, 0);
  assert.deepEqual(finalizations, []);
  assert.deepEqual(listenStarts, []);
  assert.deepEqual(nowPlaying, []);
  assert.equal(role.startFrame, 0);
  assert.equal(role.renderedFrameBase, 0);
  assert.equal(vm.runInContext('STREAMING_SAMPLE_RATE', context), 48000);
  assert.equal(1470000 / 48000, exactOutgoingSnapshot.currentTime);
  assert.equal(6000 / 48000, controlledSnapshot().currentTime);
  context.getPlayerPlaybackSnapshot = controlledSnapshot;
  context.attachPlayerEvents();
  assert.strictEqual(context.state.player.listenSession, outgoingSession);
  assert.equal(consumeCalls, 0);
  assert.deepEqual(finalizations, []);
  assert.deepEqual(listenStarts, []);
  assert.deepEqual(nowPlaying, []);
  let boundary;
  let boundaryWork;
  let boundaryCalls = 0;
  const originalBoundary = context.handleStreamingPlaybackBoundary;
  context.handleStreamingPlaybackBoundary = event => {
    boundaryCalls += 1;
    boundary = event;
    const actual = owners.getPlayerPlaybackSnapshot();
    const controlled = controlledSnapshot();
    assert.equal(controlled.mode, 'streaming');
    assert.deepEqual({ currentTime: actual.currentTime, duration: actual.duration,
      paused: actual.paused, ended: actual.ended, src: actual.src },
    { currentTime: controlled.currentTime, duration: controlled.duration,
      paused: controlled.paused, ended: controlled.ended, src: controlled.src });
    assert.equal(actual.generation, role.generation);
    assert.strictEqual(engine.roles.current, continuity);
    assert.equal(engine.context.state, 'running');
    assert.equal(event.outgoingPlaybackSnapshot.currentTime, exactOutgoingSnapshot.currentTime);
    assert.equal(event.outgoingPlaybackSnapshot.duration, exactOutgoingSnapshot.duration);
    assert.equal(event.outgoingTrackPath, outgoing.path);
    assert.equal(event.incomingTrackPath, incoming.path);
    assert.strictEqual(context.state.player.listenSession, outgoingSession);
    boundaryWork = retain(originalBoundary(event));
    return boundaryWork;
  };

  engine.node.emit({ type: 'boundary', generation: role.generation,
    outgoingStreamId: role.streamId, incomingStreamId: continuity.streamId,
    renderedFrame: 1470000, timelineFrame: 6000 });
  assert.ok(boundaryWork);
  assert.equal(boundaryCalls, 1);
  await boundaryWork;
  await retain(originalBoundary(boundary));

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
  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Queue-mutation callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  assert.equal(await retain(context.playTrackFromPayload(outgoing, { autoplay: true })), true);
  const engine = context.streamingEngineState();
  const role = engine.roles.current;
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  assert.strictEqual(role.track, outgoing);
  assert.ok(handle);
  assert.ok(attempt);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  let firstFrameWork;
  let firstFrameCalls = 0;
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameCalls += 1;
    firstFrameWork = retain(firstFrame(event));
    return firstFrameWork;
  };
  // Simulated processor reports test queue guards, not actual rendering or LS-09 evidence.
  engine.node.emit({ type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000 });
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;
  assert.equal(firstFrameCalls, 1);
  const continuity = engine.roles.continuity;
  assert.ok(continuity);
  assert.strictEqual(continuity.track, prepared);
  assert.equal(continuity.continuityOptions.kind, 'queued-next');
  assert.equal(context.successfulPlaybackClaim(handle), true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(consumeCalls, 0);
  next = reordered;

  const renderedFrame = context.getPlayerPlaybackSnapshot().renderedFrame;
  assert.equal(renderedFrame, 1);
  let boundaryWork;
  let boundaryEvent;
  let boundaryCalls = 0;
  const boundary = context.handleStreamingPlaybackBoundary;
  context.handleStreamingPlaybackBoundary = event => {
    boundaryCalls += 1;
    boundaryEvent = event;
    boundaryWork = boundary(event);
    retain(assert.rejects(boundaryWork, /identity|mismatch/i));
    return boundaryWork;
  };
  engine.node.emit({ type: 'boundary', generation: role.generation,
    outgoingStreamId: role.streamId, incomingStreamId: continuity.streamId,
    renderedFrame, timelineFrame: 0 });
  assert.ok(boundaryWork);
  assert.equal(boundaryCalls, 1);
  assert.equal(boundaryEvent.outgoingTrackPath, outgoing.path);
  assert.equal(boundaryEvent.incomingTrackPath, prepared.path);
  await assert.rejects(boundaryWork, /identity|mismatch/i);
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);

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
  const promotionObservation = promotion.then(
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

  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  owners.addObserverCleanup(async () => {
    if (!promotionSettled) rejectPromotion(new Error('Optional waveform fixture teardown'));
    await promotionObservation;
    const results = await Promise.allSettled(retained);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Optional waveform callback work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  const scheduleObserver = context.scheduleStreamingContinuity;
  context.scheduleStreamingContinuity = owners.scheduleStreamingContinuity;
  let role, handle, engine, generation, continuity;
  try {
    assert.equal(await retain(context.playTrackFromPayload(outgoing, { autoplay: true })), true);
    engine = context.streamingEngineState();
    role = engine.roles.current;
    handle = context.getActivePlaybackOwnershipHandle();
    const attempt = context.captureStreamingPlaybackAttempt();
    assert.strictEqual(role.track, outgoing);
    assert.ok(handle);
    assert.ok(attempt);
    assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.equal(engine.context.state, 'running');
    assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
    let firstFrameWork;
    let firstFrameCalls = 0;
    const firstFrame = context.handleStreamingPlaybackFirstFrame;
    context.handleStreamingPlaybackFirstFrame = event => {
      firstFrameCalls += 1;
      firstFrameWork = retain(firstFrame(event));
      return firstFrameWork;
    };
    // Simulated processor reports test facade ordering, not rendered PCM or LS-09 evidence.
    engine.node.emit({ type: 'consumed', generation: role.generation, streamId: role.streamId,
      role: 'current', frames: 0, bufferedFrames: 48000 });
    engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
      renderedFrame: 1, contextTime: 0 });
    assert.ok(firstFrameWork);
    await firstFrameWork;
    assert.equal(firstFrameCalls, 1);
    assert.equal(context.successfulPlaybackClaim(handle), true);
    continuity = engine.roles.continuity;
    assert.ok(continuity);
    assert.strictEqual(continuity.track, incoming);
    assert.equal(continuity.continuityOptions.kind, 'queued-next');
    generation = role.generation;
    assert.equal(engine.generation, generation);
    assert.equal(continuity.generation, generation);
    assert.equal(context.getPlayerPlaybackSnapshot().generation, generation);
    assert.deepEqual(queue, [incoming, third]);
    assert.equal(consumeCalls, 0);
    assert.deepEqual(scheduled, []);
    assert.deepEqual(promotionCalls, []);
  } finally {
    context.scheduleStreamingContinuity = scheduleObserver;
  }
  let boundary;
  let firstBoundary;
  let boundaryCalls = 0;
  const originalBoundary = context.handleStreamingPlaybackBoundary;
  context.handleStreamingPlaybackBoundary = event => {
    boundaryCalls += 1;
    boundary = event;
    const snapshot = context.getPlayerPlaybackSnapshot();
    assert.deepEqual({ generation: snapshot.generation, currentTime: snapshot.currentTime,
      duration: snapshot.duration, paused: snapshot.paused, ended: snapshot.ended, src: snapshot.src },
    { generation, currentTime: 0, duration: 30, paused: false, ended: false, src: incoming.src || '' });
    firstBoundary = retain(originalBoundary(event));
    return firstBoundary;
  };
  const renderedFrame = context.getPlayerPlaybackSnapshot().renderedFrame;
  assert.equal(renderedFrame, 1);
  engine.node.emit({ type: 'boundary', generation,
    outgoingStreamId: role.streamId, incomingStreamId: continuity.streamId,
    renderedFrame, timelineFrame: 0 });
  assert.ok(firstBoundary);
  assert.equal(boundaryCalls, 1);
  assert.equal(boundary.generation, generation);
  retain(firstBoundary.then(() => { boundarySettled = true; }));
  await retain(originalBoundary(boundary));

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promotionSettled, false, 'optional peak promotion remains unresolved');
  assert.equal(boundarySettled, true, 'boundary bookkeeping never awaits optional peak promotion');
  assert.equal(consumeCalls, 1, 'duplicate boundary notification consumes the incoming track once');
  assert.strictEqual(context.state.player.current, incoming);
  assert.deepEqual(scheduled, [third], 'the newly adjacent third track is prepared immediately');
  assert.deepEqual(promotionCalls, [[outgoing.path, incoming.path, generation]]);

  const rejection = new Error('optional compact peaks failed');
  rejectPromotion(rejection);
  await firstBoundary;
  await new Promise((resolve) => setImmediate(resolve));
  await retain(originalBoundary(boundary));

  assert.equal(warnings.length, 1, 'optional peak rejection is observed once as a warning');
  assert.match(String(warnings[0][0]), /optional peak promotion failed/i);
  assert.strictEqual(warnings[0][1], rejection);
  assert.equal(consumeCalls, 1, 'settled duplicate boundary remains an exact no-op');
  assert.deepEqual(scheduled, [third], 'settled duplicate boundary does not prepare continuity twice');
  assert.deepEqual(promotionCalls, [[outgoing.path, incoming.path, generation]]);
  assert.equal(engine.generation, generation);
  assert.strictEqual(engine.roles.current, continuity);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.successfulPlaybackClaim(handle), true);
});

test('unowned streaming boundary with wrong identity is ignored without effects', async () => {
  const current = { path: 'C:\\Music\\Current.flac', title: 'Current' };
  let consumeCalls = 0;
  const { context, audio } = loadHelper({
    state: {
      player: { current, loopActive: false, loopStart: 0, loopEnd: 30, waveform: { renderToken: 0 } },
      utility: { loops: [], loopsLoaded: false, selectedLoopId: '', selectedLoopGroupKey: '', selectedLoopDetailMode: '', activeTab: '' },
    },
    getNextQueuedTrack() {
      consumeCalls += 1;
      return { path: 'C:\\Music\\Expected.flac' };
    },
  });

  const engine = context.streamingEngineState();
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  assert.equal(handle, null);
  assert.equal(attempt, null);
  assert.equal(engine.roles.current, null);
  assert.equal(engine.roles.continuity, null);
  const queue = context.state.player.playbackQueue;
  const boundaryIdentity = context.state.player.lastStreamingBoundaryIdentity;
  const effects = [];
  for (const name of ['setCurrentPlayerTrack', 'updatePlayerUi', 'persistPlayerState',
    'finalizeListenSession', 'resumeListenSessionPlayback', 'maybeSendNowPlaying',
    'scheduleStreamingContinuity', 'startStreamingTrack', 'showToast']) {
    const actual = context[name];
    assert.equal(typeof actual, 'function');
    context[name] = (...args) => { effects.push(name); return actual(...args); };
  }

  assert.equal(await context.handleStreamingPlaybackBoundary({
      generation: 1,
      outgoingStreamId: 7,
      incomingStreamId: 8,
      outgoingTrackPath: 'C:\\Music\\Wrong.flac',
      incomingTrackPath: 'C:\\Music\\Unexpected.flac',
    }), undefined);
  assert.equal(consumeCalls, 0);
  assert.strictEqual(context.state.player.current, current);
  assert.strictEqual(context.state.player.playbackQueue, queue);
  assert.equal(context.state.player.lastStreamingBoundaryIdentity, boundaryIdentity);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.strictEqual(context.captureStreamingPlaybackAttempt(), attempt);
  assert.equal(engine.roles.current, null);
  assert.equal(engine.roles.continuity, null);
  assert.equal(engine.context, null);
  assert.equal(engine.node, null);
  assert.equal(engine.socket, null);
  assert.deepEqual(effects, []);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.pauseCalls, 0);
});

test('focused loop boundary input preserves editing text and commits change', () => {
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
});

test('left-arrow seeks within active loop and consumes event', () => {
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
});

test('shift-right-arrow advances playback head five seconds', () => {
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
});

test('alt-arrow leaves playback head and event untouched', () => {
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
});

test('a prepared paused control preserves the isolated ownership-denial response', async () => {
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

  // This case originally isolated the refusal provider. Prepare its missing
  // local paused control through real owners; a src-only role does not prove
  // server/media admission, first-frame readiness or audible playback.
  const track = context.state.player.current;
  assert.deepEqual(JSON.parse(JSON.stringify(track)), { src: '/track?path=song.flac' });
  const scope = context.capturePlaybackOwnershipScope();
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  if (context.window.AlbumHavenCapabilities) {
    assert.equal(context.window.AlbumHavenCapabilities.allows('library.media.read'), true);
  }
  let preparedAttempt;
  const preparedRole = await context.startStreamingTrack(track, {
    autoplay: false,
    onStartAttempt(attempt) { preparedAttempt = attempt; },
  });
  const engine = context.streamingEngineState();
  assert.ok(preparedRole);
  assert.ok(preparedAttempt);
  assert.strictEqual(engine.roles.current, preparedRole);
  assert.strictEqual(preparedRole.track, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(preparedAttempt), true);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(engine.snapshot.paused, true);
  assert.equal(engine.snapshot.src, track.src);
  assert.equal(engine.diagnostics.firstFrameAtMs, 0);
  assert.notEqual(preparedRole.firstFrameNotified, true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  const resumeCount = engine.context.resumeCount;

  context.attachPlayerEvents();
  playButton.dispatch('click');

  assert.equal(audio.playCalls, 0);
  assert.deepEqual(calls.showToast, [['Playback is active in another tab.', 'error', 2800]]);
  assert.equal(calls.updatePlayerUi, 0);
  // The pre-load UI counter is shadowed by the subject declaration; zero here
  // preserves its original assertion, not a claim that actual UI never ran.
  assert.strictEqual(engine.roles.current, preparedRole);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(preparedAttempt), true);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(engine.context.resumeCount, resumeCount);
  assert.equal(engine.snapshot.paused, true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
});

test('player-surface arrow seek focuses timeline', () => {
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
});

test('text-entry arrow leaves playback and timeline focus unchanged', () => {
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
});

test('paused loop activation uses full duration without seeking legacy audio', () => {
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });

  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);
  context.setLoopActive(true);

  assert.equal(context.state.player.loopActive, true);
  assert.equal(audio.currentTime, 57, 'streaming loop setup does not seek the legacy audio element');
  assert.equal(context.state.player.loopEnd, 60);
});

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
    startStreamingTrack(track, options) {
      streamingStarts.push(track);
      return runtimeFixtureOwners.get(context).startStreamingTrack(track, options);
    },
    resumeListenSessionPlayback: () => ({
      then(callback) {
        callback({ started_at: '2026-05-19T00:00:00Z' });
        return Promise.resolve();
      },
    }),
  });

  const assertAdmission = ownActualClickAdmission(context);
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
  assertAdmission(streamingStarts[0]);
});

test('playing loop setup leaves legacy audio time unchanged', () => {
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });

  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);
  context.setLoopActive(true);

  assert.equal(audio.currentTime, 20);
  assert.equal(context.state.player.loopActive, true);
});

test('player pause does not consume queue or finalize stale native end', () => {
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
});

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
  let playTrackButton = new FakeElement({
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
  let trackModal;
  const document = {
    querySelectorAll(selector) {
      return selector === '.play-track-button' ? [playTrackButton] : [];
    },
    getElementById(id) {
      return id === 'track-modal' ? trackModal : null;
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
    startStreamingTrack(track, options) {
      streamingStarts.push(track);
      return runtimeFixtureOwners.get(context).startStreamingTrack(track, options);
    },
  }));

  ({ button: playTrackButton, modal: trackModal } = mountOriginalTrackModal(context, playTrackButton));
  assert.equal(trackModal.contains(playTrackButton), true);
  const assertAdmission = ownActualClickAdmission(context);
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
  assertAdmission(streamingStarts[0]);
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
  let playTrackButton = new FakeElement({
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
  let trackModal;
  const document = {
    querySelectorAll(selector) {
      return selector === '.play-track-button' ? [playTrackButton] : [];
    },
    getElementById(id) {
      return id === 'track-modal' ? trackModal : null;
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
    async startStreamingTrack(track, options) {
      callOrder.push('streaming-start');
      playbackStartCalls += 1;
      const selection = vm.runInContext('playerSelectionOwnership', context);
      const handle = selection.handle;
      await preparedStart;
      if (!context.currentPlayerSelection(selection)
        || context.getActivePlaybackOwnershipHandle() !== handle
        || !context.isPlaybackOwnershipHandleCurrent(handle)
        || !context.isPlaybackOwnershipScopeCurrent(selection.scope)) return null;
      const role = await retain(owners.startStreamingTrack(track, options));
      const engine = context.streamingEngineState();
      assert.strictEqual(engine.roles.current, role);
      assert.strictEqual(role.track, track);
      assert.strictEqual(selection.attempt, context.captureStreamingPlaybackAttempt());
      assert.equal(context.isStreamingPlaybackAttemptCurrent(selection.attempt), true);
      assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
      assert.equal(engine.context.state, 'running');
      assert.equal(context.state.player.current, null);
      assert.notEqual(role.firstFrameNotified, true);
      // Declared simulated processor delivery: not PCM rendering or LS-09 evidence.
      engine.node.emit({ type: 'first-frame', generation: role.generation,
        streamId: role.streamId, renderedFrame: 2400, contextTime: 0 });
      assert.equal(role.firstFrameNotified, true);
      assert.equal(firstFrameEvents.length, 1);
      assert.equal(firstFrameEvents[0].current, null);
      assert.equal(firstFrameEvents[0].event.trackPath, track.path);
      assert.equal(callOrder.includes('first-frame-peek'), false);
      assert.equal(lifecycleCalls, 0);
      return role;
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
  const owners = runtimeFixtureOwners.get(context);
  const retained = [], thrown = [], firstFrameEvents = [];
  owners.addObserverCleanup(async () => {
    // Fixture teardown has already retired selection/claim and stopped the engine.
    // The real selection guard in the starter prevents late gate release restarting it.
    resolvePreparedStart();
    const settled = await Promise.allSettled(retained);
    const errors = [...thrown, ...settled.filter(row => row.status === 'rejected').map(row => row.reason)];
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Owned accepted-click work failed');
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  const forward = callback => (...args) => {
    try { return retain(callback(...args)); }
    catch (error) { thrown.push(error); throw error; }
  };
  context.resumeStreamingPlayback = forward(owners.resumeStreamingPlayback);
  const firstFrame = context.handleStreamingPlaybackFirstFrame;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameEvents.push({ event, current: context.state.player.current });
    return forward(firstFrame)(event);
  };
  const pauseObserver = context.pauseStreamingPlayback;
  context.pauseStreamingPlayback = forward((...args) => {
    pauseObserver(...args);
    return owners.pauseStreamingPlayback(...args);
  });
  const originalSnapshot = context.getPlayerPlaybackSnapshot;
  const scope = context.capturePlaybackOwnershipScope();
  const shell = context.document.getElementById('app-shell');
  assert.ok(shell);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.state.player.current, null);
  assert.equal(context.streamingEngineState().roles.current, null);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  const productionPlayTrackFromPayload = context.playTrackFromPayload;
  context.playTrackFromPayload = (...args) => {
    callOrder.push('play-track-from-payload');
    return forward(productionPlayTrackFromPayload)(...args);
  };

  ({ button: playTrackButton, modal: trackModal } = mountOriginalTrackModal(context, playTrackButton));
  assert.equal(trackModal.contains(playTrackButton), true);
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

  assert.strictEqual(context.getPlayerPlaybackSnapshot, originalSnapshot);
  assert.strictEqual(context.document.getElementById('app-shell'), shell);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  const engine = context.streamingEngineState();
  const role = engine.roles.current;
  const attempt = context.captureStreamingPlaybackAttempt();
  const handle = context.getActivePlaybackOwnershipHandle();
  assert.strictEqual(role.track, context.state.player.current);
  assert.equal(role.track.path, selectedTrack.path);
  assert.equal(role.firstFrameNotified, true);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.ok(firstFrameEvents.some(row => row.current === role.track));

  playTrackButton.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pauseCalls, 1);
  assert.equal(playbackStartCalls, 1);
  assert.equal(queueInstallCalls, 1);
  assert.equal(lifecycleCalls, 1);
  assert.equal(continuityCalls, 1);
  assert.equal(callOrder.at(-1), 'current-track-toggle');
  assert.strictEqual(context.getPlayerPlaybackSnapshot, originalSnapshot);
  assert.equal(engine.snapshot.paused, true);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), false);
});

test('plain Space intercepts only when foreground playback handles it', async () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: false,
    src: '/track?path=song.flac',
  });
  const { context } = loadHelper({ audio });
  const prepared = await prepareLocalPlayingControl(context);
  const work = [], thrown = [];
  prepared.owners.addObserverCleanup(async () => {
    const settled = await Promise.allSettled(work);
    const errors = [...thrown, ...settled.filter(row => row.status === 'rejected').map(row => row.reason)];
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Owned Space control work failed');
  });
  for (const name of ['pauseStreamingPlayback', 'resumeStreamingPlayback']) {
    const observer = context[name];
    context[name] = (...args) => {
      let actualWork;
      try {
        observer(...args);
        actualWork = prepared.owners[name](...args);
      } catch (error) { thrown.push(error); throw error; }
      work.push(actualWork);
      void Promise.resolve(actualWork).catch(() => {});
      return actualWork;
    };
  }
  context.canStartPlaybackInThisTab = (...args) => prepared.owners.canStartPlaybackInThisTab(...args);
  const assertPendingResume = () => {
    const handle = context.getActivePlaybackOwnershipHandle();
    const selection = vm.runInContext('playerSelectionOwnership', context);
    assert.ok(handle);
    assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.strictEqual(selection.handle, handle);
    assert.strictEqual(selection.attempt, prepared.attempt);
    assert.strictEqual(context.state.player.current, prepared.track);
    assert.strictEqual(prepared.engine.roles.current, prepared.role);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(prepared.attempt), true);
    assert.equal(prepared.engine.context.state, 'running');
    assert.equal(prepared.engine.snapshot.paused, false);
    assert.equal(context.successfulPlaybackClaim(handle), false);
    assert.notEqual(prepared.role.firstFrameNotified, true);
    assert.equal(prepared.engine.diagnostics.firstFrameAtMs, 0);
  };
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
  assertPendingResume();

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
  assertPendingResume();

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
  assertPendingResume();

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
    controls: interceptedControlEvents.map((_, index) => ({
      handled: [2, 7].includes(index),
      observed: { prevented: [2, 7].includes(index) ? 1 : 0, stopped: [2, 7].includes(index) ? 1 : 0 },
      playbackDelta: [2, 7].includes(index) ? 1 : 0,
    })),
  });
  assertPendingResume();
});

test('keyboard Space preserves the focused control after the resume request resolves', async () => {
  const audio = new FakeAudioElement({
    currentTime: 12,
    duration: 60,
    paused: true,
    src: '/track?path=song.flac',
  });
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range' });
  const focusedRange = new FakeElement({ tagName: 'INPUT', type: 'range' });
  const { context } = loadHelper({ audio, timeline });
  const prepared = await preparePositiveFocusControl(context);

  assert.equal(context.handlePlayerKeyboardPlayback({
    key: ' ',
    code: 'Space',
    target: focusedRange,
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
  assert.equal(prepared.observed.work.length, 1);
  assert.strictEqual(context.state.player.current, prepared.track);
  assert.strictEqual(prepared.engine.roles.current, prepared.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(prepared.attempt), true);
  const handle = context.getActivePlaybackOwnershipHandle();
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  const selection = vm.runInContext('playerSelectionOwnership', context);
  assert.strictEqual(selection.handle, handle);
  assert.strictEqual(selection.attempt, prepared.attempt);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(prepared.role.firstFrameNotified, true);
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
    target: new FakeElement({ tagName: 'DIV' }),
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
  const prepared = await preparePositiveFocusControl(context);

  context.attachPlayerEvents();
  playButton.dispatch('click', {
    type: 'click',
    focusTimelineOnResume: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(audio.playCalls, 1);
  assert.equal(timeline.focusCalls.length, 1);
  assert.equal(prepared.observed.work.length, 1);
  assert.strictEqual(context.state.player.current, prepared.track);
  assert.strictEqual(prepared.engine.roles.current, prepared.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(prepared.attempt), true);
  const handle = context.getActivePlaybackOwnershipHandle();
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  const selection = vm.runInContext('playerSelectionOwnership', context);
  assert.strictEqual(selection.handle, handle);
  assert.strictEqual(selection.attempt, prepared.attempt);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  assert.notEqual(prepared.role.firstFrameNotified, true);
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
    }, { bootstrapAllowedActions: { 'library.loops.create': true } });
    assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
    assert.equal(context.state.loopCreateAllowed, true);

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
    }, { bootstrapAllowedActions: { 'library.loops.create': true } });
    assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
    assert.equal(context.state.loopCreateAllowed, true);

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
    }, { bootstrapAllowedActions: { 'library.loops.create': true } });
    assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
    assert.equal(context.state.loopCreateAllowed, true);

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
    }, { bootstrapAllowedActions: { 'library.loops.create': true } });
    assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
    assert.equal(context.state.loopCreateAllowed, true);

    await context.saveCurrentLoop();

    assert.equal(fetchCalls, 0);
    assert.equal(context.state.player.saveBusy, false);
  }
}

test('app-owned save-loop dialog verifier retains its complete original sequence', verifySaveCurrentLoopUsesAppDialog);

test('successful loop save refreshes scissors after clearing the busy state', async () => {
  const uiStates = [];
  const dialogCalls = [];
  const fetchCalls = [];
  const loopActions = {
    _loopActionController: {
      update(nextState) {
        uiStates.push({ ...nextState });
      },
    },
  };
  const { context } = loadHelper({
    showLoopNameDialog: async () => {
      dialogCalls.push('open');
      return 'Saved Loop';
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return {
        ok: true,
        json: async () => ({ ok: true, loop: { id: 'loop-1', name: 'Saved Loop' } }),
      };
    },
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);
  const current = context.state.player.current;

  await context.saveCurrentLoop();

  assert.deepEqual(dialogCalls, ['open']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/loops/create');
  assert.equal(fetchCalls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
    name: 'Saved Loop', source_path: current.path, start_seconds: 10, end_seconds: 20,
    artist: '', title: '', album: '', cover_path: '',
  });
  assert.equal(context.state.utility.selectedLoopId, 'loop-1');
  assert.equal(context.state.loopCreateAllowed, true);
  assert.equal(context.state.player.saveBusy, false);
  assert.equal(context.state.player.loopActive, false);
  assert.strictEqual(context.state.player.current, current);

  assert.deepEqual(uiStates.at(-1), { enabled: true, canCreate: true, contextKey: 'C:/Music/song.flac', active: false, busy: false });
  assert.ok(context.state.player.current, 'the loaded track remains available for another loop');
});

test('loop save without create permission opens no dialog and sends no request', async () => {
  const dialogCalls = [];
  const fetchCalls = [];
  const { context } = loadHelper({
    showLoopNameDialog: async () => {
      dialogCalls.push('open');
      return 'Not Allowed';
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return { ok: true, json: async () => ({ ok: true, loop: { id: 'unexpected' } }) };
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
  assert.equal(context.state.loopCreateAllowed, false);
  assert.equal(context.isPlaybackLockedByAnotherTab(), false);
  const current = context.state.player.current;

  await context.saveCurrentLoop();

  assert.deepEqual(dialogCalls, []);
  assert.deepEqual(fetchCalls, []);
  assert.equal(context.state.loopCreateAllowed, false);
  assert.equal(context.state.player.saveBusy, false);
  assert.equal(context.state.player.loopActive, true);
  assert.strictEqual(context.state.player.current, current);
  assert.equal(context.state.utility.loops.length, 0);
  assert.equal(context.state.utility.selectedLoopId, '');
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);
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
  const playbackControlMacro = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'partials', 'playback-control-cluster.html',
  ), 'utf8');
  const elementLookupSource = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-and-waveform.js',
  ), 'utf8');

  assert.match(`${playerMarkup}\n${playbackControlMacro}`, /data-loop-action-owner="\{\{ owner_id \}\}"/);
  assert.match(playerMarkup, /playback_control_cluster\('expanded-player', owner_id='global-player'\)/);
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
  }, { bootstrapAllowedActions: { 'library.loops.create': true }, observeLoopExpiry: true });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);

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
  }, { observeLoopExpiry: true, bootstrapAllowedActions: { 'library.loops.create': true } });

  const owners = runtimeFixtureOwners.get(context);
  const retained = [];
  const originalFirstFrame = context.handleStreamingPlaybackFirstFrame;
  const originalBoundary = context.handleStreamingPlaybackBoundary;
  const originalSchedule = context.scheduleStreamingContinuity;
  owners.addObserverCleanup(async () => {
    try {
      const results = await Promise.allSettled(retained);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Loop wrap callback work failed');
    } finally {
      context.handleStreamingPlaybackFirstFrame = originalFirstFrame;
      context.handleStreamingPlaybackBoundary = originalBoundary;
      context.scheduleStreamingContinuity = originalSchedule;
    }
  });
  const retain = work => {
    retained.push(work);
    void Promise.resolve(work).catch(() => {});
    return work;
  };
  for (const name of ['canStartPlaybackInThisTab', 'startStreamingTrack',
    'resumeStreamingPlayback', 'getPlayerPlaybackSnapshot']) context[name] = owners[name];
  assert.equal(await retain(context.playTrackFromPayload(track, { autoplay: true })), true);
  const engine = context.streamingEngineState();
  const role = engine.roles.current;
  const handle = context.getActivePlaybackOwnershipHandle();
  const attempt = context.captureStreamingPlaybackAttempt();
  assert.strictEqual(role.track, track);
  assert.ok(handle);
  assert.ok(attempt);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(engine.context.state, 'running');
  assert.equal(context.successfulPlaybackClaim(handle), false);
  engine.socket.open();
  let firstFrameWork;
  let firstFrameCalls = 0;
  context.handleStreamingPlaybackFirstFrame = event => {
    firstFrameCalls += 1;
    firstFrameWork = retain(originalFirstFrame(event));
    return firstFrameWork;
  };
  // Finite processor reports exercise wrap notifications, not rendering or elapsed-cycle evidence.
  engine.node.emit({ type: 'first-frame', generation: role.generation, streamId: role.streamId,
    renderedFrame: 1, contextTime: 0 });
  assert.ok(firstFrameWork);
  await firstFrameWork;
  assert.equal(firstFrameCalls, 1);
  assert.equal(context.successfulPlaybackClaim(handle), true);
  let deferredShortWork = null;
  let deferredShortCalls = 0;
  context.scheduleStreamingContinuity = (value, options) => {
    const deferredShort = options?.kind === 'short-loop' && !engine.pendingPromotion;
    const work = retain(owners.scheduleStreamingContinuity(value, options));
    if (deferredShort) { deferredShortCalls += 1; deferredShortWork = work; }
    return work;
  };
  assert.equal(context.state.loopCreateAllowed, true);
  context.setLoopActive(true);
  const whole = await retain(context.dispatchActiveStreamingLoop());
  assert.ok(whole);
  assert.strictEqual(engine.roles.continuity, whole);
  assert.strictEqual(whole.track, track);
  assert.equal(whole.continuityOptions.kind, 'whole-track-repeat');
  assert.equal(whole.continuityOptions.startSeconds, 0);
  assert.equal(whole.continuityOptions.endSeconds, 60);
  assert.equal(context.state.player.loopActive, true);
  assert.equal(context.state.player.loopStart, 0);
  assert.equal(context.state.player.loopEnd, 60);
  assert.equal(context.loopEditSessionExpiryController.has('global-player'), true);
  let boundaryWork;
  let boundaryCalls = 0;
  context.handleStreamingPlaybackBoundary = event => {
    boundaryCalls += 1;
    assert.equal(event.continuityKind, 'whole-track-repeat');
    boundaryWork = retain(originalBoundary(event));
    return boundaryWork;
  };
  engine.node.emit({ type: 'boundary', generation: role.generation,
    outgoingStreamId: role.streamId, incomingStreamId: whole.streamId,
    renderedFrame: 60 * 48000, timelineFrame: 0 });
  assert.ok(boundaryWork);
  await boundaryWork;
  assert.equal(boundaryCalls, 1);
  assert.strictEqual(engine.roles.current, whole);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.successfulPlaybackClaim(handle), true);
  assert.deepEqual(wraps, ['global-player']);
  assert.ok(engine.pendingPromotion);
  assert.equal(await retain(context.scheduleStreamingContinuity(track,
    { kind: 'short-loop', startSeconds: 0, endSeconds: 5 })), null);
  assert.equal(deferredShortCalls, 0);
  engine.socket.emit({ type: 'promoted', generation: whole.generation,
    streamId: whole.streamId, role: 'current' });
  // The acknowledgement queues exactly one deferStreamingContinuity microtask.
  await Promise.resolve();
  assert.ok(deferredShortWork, 'promotion acknowledgement must dispatch deferred short-loop work');
  const short = await deferredShortWork;
  assert.equal(deferredShortCalls, 1);
  assert.ok(short);
  assert.strictEqual(engine.roles.continuity, short);
  assert.strictEqual(short.track, track);
  assert.equal(short.continuityOptions.kind, 'short-loop');
  assert.equal(engine.pendingPromotion, null);
  assert.ok(engine.node.sent.some(message => message.type === 'set-loop'
    && message.kind === 'short-loop' && message.retainedStreamId === short.streamId));
  const previousRenderedFrame = engine.snapshot.renderedFrame;
  const shortRenderedFrame = 65 * 48000;
  assert.notEqual(previousRenderedFrame, shortRenderedFrame);
  engine.node.emit({ type: 'boundary', generation: whole.generation,
    outgoingStreamId: whole.streamId, incomingStreamId: short.streamId,
    renderedFrame: shortRenderedFrame, timelineFrame: 0 });
  assert.equal(engine.snapshot.renderedFrame, shortRenderedFrame);
  assert.equal(engine.snapshot.currentTime, 0);
  assert.strictEqual(engine.roles.current, whole);
  assert.strictEqual(engine.roles.continuity, short);
  assert.equal(boundaryCalls, 1);

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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);

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
  }, { bootstrapAllowedActions: { 'library.loops.create': true } });
  assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
  assert.equal(context.state.loopCreateAllowed, true);

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
  const playbackControlMacro = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'partials', 'playback-control-cluster.html',
  ), 'utf8');
  assert.equal((playerMarkup.match(/id="player-time"/g) || []).length, 1);
  assert.doesNotMatch(playerMarkup, /data-loop-range-time=/);
  assert.match(
    `${playerMarkup}\n${playbackControlMacro}`,
    /<span class="loop-play-control-actions player-loop-actions"[^>]*data-loop-action-mount="\{\{ owner_id \}\}"[^>]*>\s*<\/span>/,
  );
  assert.doesNotMatch(`${playerMarkup}\n${playbackControlMacro}`, /data-loop-action-owner="\{\{ owner_id \}\}"[^]*data-loop-action="enter"/);
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

for (const action of ['cancel', 'create', 'play']) {
  for (const key of ['Enter', ' ']) {
    test(`main player native ${action} ${key === ' ' ? 'Space' : 'Enter'} preserves button activation`, () => {
      const { context, audio } = loadHelper();
      context.state.player.loopActive = true;
      let saves = 0;
      context.saveCurrentLoop = () => { saves += 1; };
      const target = new FakeElement({ tagName: 'BUTTON', attributes: { 'data-loop-action': action } });
      let prevented = false;
      const event = { key, target, preventDefault() { prevented = true; } };
      const handled = key === 'Enter' ? context.handlePlayerLoopEditKeydown(event) : context.handlePlayerKeyboardPlayback(event);
      assert.equal(handled, false);
      assert.equal(prevented, false);
      assert.equal(saves, 0);
      assert.equal(audio.pauseCalls + audio.playCalls, 0);
    });
  }
}

for (const deleteAllowed of [true, false]) {
  test(`main save before first Settings open loads authoritative loop permissions (delete ${deleteAllowed})`, async () => {
    const requests = [];
    const saved = { id: 'created', name: 'Created loop' };
    const older = { id: 'older', name: 'Other song loop' };
    const { context } = loadHelper({
      showLoopNameDialog: async () => 'Created loop',
      fetch: async url => {
        requests.push(url);
        return { ok: true, json: async () => url === '/loops/create'
          ? { ok: true, loop: saved, loops: [saved] }
          : { ok: true, loops: [older, saved], allowed_actions: { 'library.loops.read': true, 'library.loops.create': true, 'library.loops.delete': deleteAllowed } } };
      },
    }, { bootstrapAllowedActions: { 'library.loops.create': true } });
    assert.deepEqual(context.window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__, { 'library.loops.create': true });
    assert.equal(context.state.loopCreateAllowed, true);
    context.state.player.loopActive = true;
    context.state.utility.loopsLoaded = false;
    context.state.utility.allowedActions = {};
    const owners = runtimeFixtureOwners.get(context);
    assert.equal(owners.loaded.has('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), true);
    assert.strictEqual(context.loadUtilityLoops, owners.loadUtilityLoops);
    context.buildUtilityLoopGroupKey = loop => loop.id === 'created' ? 'saved-song' : 'other-song';
    context.groupUtilityLoops = loops => loops.map(loop => ({ key: context.buildUtilityLoopGroupKey(loop), loops: [loop] }));
    context.collapseAllUtilityLoopGroups = () => {};
    await context.saveCurrentLoop();
    assert.equal(context.state.utility.allowedActions['library.loops.delete'], undefined, 'the mutation response must not invent grants');
    context.state.utility.activeTab = 'loops';
    await context.loadUtilityLoops();
    assert.deepEqual(requests, ['/loops/create', '/utilities/loops']);
    assert.equal(context.state.utility.allowedActions['library.loops.delete'], deleteAllowed);
    assert.equal(context.state.utility.selectedLoopGroupKey, 'saved-song');
    assert.equal(context.state.utility.selectedLoopId, 'created');
    await context.loadUtilityLoops();
    assert.deepEqual(requests, ['/loops/create', '/utilities/loops'], 'an established grant or denial projection may reuse the cache');
  });
}

async function loadPreparedCapabilityTrackRow(actions) {
  const {bindPlaytableSelection} = await import('../../../music_app/static/js/playtables/selection.mjs');
  const effects = [];
  const { context, audio, timeline } = loadHelper();
  const owners = runtimeFixtureOwners.get(context), document = context.document;
  document.readyState = 'loading';
  const shell = document.getElementById('app-shell');
  const scope = context.capturePlaybackOwnershipScope();
  const work = [], thrown = [], nodes = [];
  let selection;
  owners.addObserverCleanup(async () => {
    const failures = [...thrown];
    try {
      const settled = await Promise.allSettled(work);
      failures.push(...settled.filter(row => row.status === 'rejected').map(row => row.reason));
    } finally {
      try { selection?.dispose(); } catch (error) { failures.push(error); }
      for (const node of nodes.reverse()) {
        try { node.remove(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError([...new Set(failures)], 'Owned mobile playback failed');
  });
  const retain = callback => (...args) => {
    let result;
    try { result = callback(...args); }
    catch (error) { thrown.push(error); throw error; }
    work.push(result);
    void Promise.resolve(result).catch(() => {});
    return result;
  };
  assert.ok(shell);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(document.getElementById('track-modal'), null);
  assert.equal(document.getElementById('capability-bootstrap'), null);
  const host = document.createElement('section');
  host.innerHTML = '<div class="album-track-table__row" data-cdt-row-key="song-occurrence" tabindex="0">Song'
    + '<button type="button" class="play-track-button album-track-table__play" data-src="/track?path=song.flac" data-track-path="song.flac" data-track-title="Song">Play</button></div>';
  const row = host.firstElementChild, button = row.querySelector('button');
  const album = { name: 'Album' };
  const modal = document.createElement('div'); modal.id = 'track-modal'; nodes.push(modal);
  // Positive album-row fixture: keep the same controls inside their album modal.
  // Detached-button contracts elsewhere remain unchanged.
  modal.appendChild(host); document.body.appendChild(modal);
  const bootstrap = document.createElement('script'); bootstrap.id = 'capability-bootstrap'; nodes.push(bootstrap);
  bootstrap.textContent = JSON.stringify({allowed_actions: actions,
    denied_selectors: actions?.['library.media.read'] === true ? [] : ['.play-track-button', '.global-player']});
  document.body.appendChild(bootstrap);
  assert.equal(document.querySelectorAll('#track-modal').length, 1);
  assert.equal(document.querySelectorAll('#capability-bootstrap').length, 1);
  assert.strictEqual(document.getElementById('app-shell'), shell);
  assert.strictEqual(host.firstElementChild, row);
  assert.strictEqual(row.querySelector('button'), button);
  assert.equal(modal.contains(button), true);
  context.state.player.current = { path: 'song.flac', src: '/track?path=song.flac' };
  context.state.player.playbackQueue = { tracks: ['retained.flac'] };
  context.state.modalReleases = [album];
  context.state.modalReleaseIndex = 0;
  if (actions !== undefined) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,
      '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
    assert.equal(context.window.AlbumHavenCapabilities.allows('library.media.read'), true);
  } else assert.equal(context.window.AlbumHavenCapabilities, undefined);
  const albumTableOwner = 'music_app/static/js/runtime/album-track-table.js';
  assert.equal(owners.loaded.has(albumTableOwner), true, 'reuse the already evaluated album-table owner');
  assert.equal(context.canPlayTrackModalSelection(button), true);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  const track = context.state.player.current;
  let attempt;
  const role = await owners.startStreamingTrack(track, {
    autoplay: false, startSeconds: Number(audio.currentTime) || 0,
    onStartAttempt(value) { attempt = value; },
  });
  const engine = context.streamingEngineState();
  assert.strictEqual(engine.roles.current, role);
  assert.strictEqual(role.track, track);
  assert.strictEqual(context.state.player.current, track);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(engine.snapshot.paused, true);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.notEqual(role.firstFrameNotified, true);
  // Install original action observers once; no setup effects are reset/filtered.
  context.canStartPlaybackInThisTab = (...args) => {
    effects.push('ownership'); return owners.canStartPlaybackInThisTab(...args);
  };
  context.startStreamingTrack = retain((...args) => {
    effects.push('stream'); return owners.startStreamingTrack(...args);
  });
  const resumeObserver = context.resumeStreamingPlayback;
  context.resumeStreamingPlayback = retain((...args) => {
    resumeObserver(...args); return owners.resumeStreamingPlayback(...args);
  });
  const playTrack = context.playTrackFromPayload;
  context.playTrackFromPayload = retain((...args) => playTrack(...args));
  context.setAlbumPlaybackQueue = () => {
    effects.push('queue'); context.state.player.playbackQueue = { tracks: ['song.flac'] };
  };
  context.usesMobilePageLayout = () => true;
  const readPlayback = context.getPlayerPlaybackSnapshot;
  context.getPlayerPlaybackSnapshot = () => { effects.push('snapshot'); return readPlayback(); };
  const animate = context.triggerAlbumTrackPlayActivation;
  context.triggerAlbumTrackPlayActivation = target => { effects.push('animation'); animate(target); };
  context.updatePlayerUi = () => effects.push('render');
  context.attachSharedPlayer();
  const instance = {};
  selection = bindPlaytableSelection(host, {
    sourceAdapter: {snapshot: () => ({scopeKey: 'media-capability-fixture', instance,
      rows: [{rowKey: 'song-occurrence', readable: true, selectable: true}]})},
    onPlay: (_rowKey, event, options) => context.activateSharedTrackButton(button,
      {restart: options?.restart === true, focusTimeline: event.isTrusted !== false}),
  });
  const emit = (target, type, properties = {}) => {
    const event = new context.Event(type);
    Object.assign(event, {detail: 1, isTrusted: false}, properties); target.dispatchEvent(event); return event;
  };
  const tap = timeStamp => {
    const pointer = {pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 20, clientY: 20};
    emit(row, 'pointerdown', {...pointer, timeStamp});
    emit(row, 'pointerup', {...pointer, timeStamp: timeStamp + 10});
    emit(row, 'click', {timeStamp: timeStamp + 11});
  };
  let resumedHandle;
  const assertPending = restarted => {
    assert.strictEqual(document.getElementById('app-shell'), shell);
    assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
    const currentRole = engine.roles.current;
    const currentAttempt = context.captureStreamingPlaybackAttempt();
    const handle = context.getActivePlaybackOwnershipHandle();
    const selected = vm.runInContext('playerSelectionOwnership', context);
    assert.ok(handle);
    assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
    assert.strictEqual(selected.handle, handle);
    assert.strictEqual(selected.attempt, currentAttempt);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(currentAttempt), true);
    assert.strictEqual(currentRole.track, context.state.player.current);
    assert.equal(engine.context.state, 'running');
    assert.equal(context.successfulPlaybackClaim(handle), false);
    assert.notEqual(currentRole.firstFrameNotified, true);
    assert.equal(engine.diagnostics.firstFrameAtMs, 0);
    if (!restarted) {
      assert.strictEqual(currentRole, role); assert.strictEqual(currentAttempt, attempt);
      resumedHandle = handle;
    } else {
      assert.notStrictEqual(currentRole, role); assert.notStrictEqual(currentAttempt, attempt);
      assert.notStrictEqual(handle, resumedHandle);
      assert.equal(context.isPlaybackOwnershipHandleCurrent(resumedHandle), false);
      assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), false);
    }
  };
  return { context, effects, audio, timeline, tap, button, row, assertPending,
    play: () => emit(button, 'click'), doubleClick: timeStamp => emit(row, 'dblclick', {detail: 2, timeStamp}) };
}

async function loadCapabilityTrackRow(actions, t) {
  const {bindPlaytableSelection} = await import('../../../music_app/static/js/playtables/selection.mjs');
  const native = require('./native-home-harness.cjs').createNativeHomeRuntime(), document = native.document;
  document.readyState = 'loading';
  const effects = [];
  const host = document.createElement('section'); document.body.appendChild(host);
  host.innerHTML = '<div class="album-track-table__row" data-cdt-row-key="song-occurrence" tabindex="0">Song'
    + '<button type="button" class="play-track-button album-track-table__play" data-src="/track?path=song.flac" data-track-path="song.flac" data-track-title="Song">Play</button></div>';
  const row = host.firstElementChild, button = row.querySelector('button');
  const album = { name: 'Album' };
  const modal = document.createElement('div'); modal.id = 'track-modal'; document.body.appendChild(modal);
  const bootstrap = document.createElement('script'); bootstrap.id = 'capability-bootstrap';
  bootstrap.textContent = JSON.stringify({allowed_actions: actions,
    denied_selectors: actions?.['library.media.read'] === true ? [] : ['.play-track-button', '.global-player']});
  document.body.appendChild(bootstrap);
  const { context, audio, timeline } = loadHelper({ document,
    canStartPlaybackInThisTab: () => { effects.push('ownership'); return true; },
    startStreamingTrack: async () => { effects.push('stream'); return { role: 'current' }; },
    setAlbumPlaybackQueue: () => { effects.push('queue'); context.state.player.playbackQueue = { tracks: ['song.flac'] }; },
  });
  context.state.player.current = { path: 'song.flac', src: '/track?path=song.flac' };
  context.state.player.playbackQueue = { tracks: ['retained.flac'] };
  context.state.modalReleases = [album];
  context.state.modalReleaseIndex = 0;
  context.window.document = document;
  if (actions !== undefined) vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/album-track-table.js'), 'utf8'), context);
  context.usesMobilePageLayout = () => true;
  const readPlayback = context.getPlayerPlaybackSnapshot;
  context.getPlayerPlaybackSnapshot = () => { effects.push('snapshot'); return readPlayback(); };
  const animate = context.triggerAlbumTrackPlayActivation;
  context.triggerAlbumTrackPlayActivation = target => { effects.push('animation'); animate(target); };
  context.updatePlayerUi = () => effects.push('render');
  context.attachSharedPlayer();
  const instance = {};
  const selection = bindPlaytableSelection(host, {
    sourceAdapter: {snapshot: () => ({scopeKey: 'media-capability-fixture', instance,
      rows: [{rowKey: 'song-occurrence', readable: true, selectable: true}]})},
    onPlay: (_rowKey, event, options) => context.activateSharedTrackButton(button,
      {restart: options?.restart === true, focusTimeline: event.isTrusted !== false}),
  });
  t.after(() => {selection.dispose(); host.remove(); modal.remove(); bootstrap.remove();});
  const emit = (target, type, properties = {}) => {
    const event = new native.context.Event(type);
    Object.assign(event, {detail: 1, isTrusted: false}, properties); target.dispatchEvent(event); return event;
  };
  const tap = timeStamp => {
    const pointer = {pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 20, clientY: 20};
    emit(row, 'pointerdown', {...pointer, timeStamp});
    emit(row, 'pointerup', {...pointer, timeStamp: timeStamp + 10});
    emit(row, 'click', {timeStamp: timeStamp + 11});
  };
  return { context, effects, audio, timeline, tap, button, row,
    play: () => emit(button, 'click'), doubleClick: timeStamp => emit(row, 'dblclick', {detail: 2, timeStamp}) };
}

for (const actions of [{ 'library.media.read': false }, {}]) {
  test(`denied mobile track gestures and direct restart have no playback effects (${Object.keys(actions).length ? 'denied' : 'missing grant'})`, async t => {
    const f = await loadCapabilityTrackRow(actions, t);
    const before = JSON.stringify(f.context.state.player);
    const queue = f.context.state.player.playbackQueue;
    f.tap(100); f.tap(230); f.doubleClick(245); f.play();
    f.context.activateSharedTrackButton(f.button, { restart: true, focusTimeline: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, []);
    assert.equal(f.row.getAttribute('aria-selected'), 'true', 'readable row selection does not grant media access');
    assert.equal(JSON.stringify(f.context.state.player), before);
    assert.strictEqual(f.context.state.player.playbackQueue, queue);
    assert.equal(f.audio.playCalls, 0);
    assert.deepEqual(f.timeline.focusCalls, []);
  });
}

for (const actions of [{ 'library.media.read': true }, undefined]) {
  test(`mobile row selection, explicit resume and deliberate double-tap use shared playback (${actions ? 'allowed' : 'legacy'})`, async t => {
    const f = await loadPreparedCapabilityTrackRow(actions);
    const queue = f.context.state.player.playbackQueue;
    f.tap(100);
    assert.equal(f.row.getAttribute('aria-selected'), 'true'); assert.deepEqual(f.effects, []);
    assert.equal(f.audio.playCalls, 0, 'a single row tap selects without playing');
    assert.strictEqual(f.context.state.player.playbackQueue, queue);
    f.play();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.audio.playCalls, 1, 'explicit Play resumes the loaded current track');
    assert.equal(f.effects.includes('stream'), false);
    f.assertPending(false);
    f.tap(1000); f.tap(1130); f.doubleClick(1145);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.effects.filter(effect => effect === 'stream').length, 1);
    assert.equal(f.effects.filter(effect => effect === 'queue').length, 1);
    assert.ok(f.effects.includes('ownership'));
    assert.equal(f.context.state.player.current.path, 'song.flac');
    assert.deepEqual(f.context.state.player.playbackQueue, { tracks: ['song.flac'] });
    assert.deepEqual(f.timeline.focusCalls, [], 'row activation must not steal timeline focus');
    f.assertPending(true);
  });
}

test('thin mobile Play hit area yields horizontal playhead drag but preserves taps and vertical intent', () => {
  const seeks = [];
  const listeners = new Map();
  const document = { activeElement: null, querySelectorAll: () => [],
    addEventListener(name, handler) { const entries = listeners.get(name) || []; entries.push(handler); listeners.set(name, entries); },
    dispatch(name, event = {}) { for (const handler of listeners.get(name) || []) handler(event); },
  };
  const { context, timeline, playButton } = loadHelper({ document,
    getTrackIdentity: track => track?.src || '',
    getPlayerPlaybackSnapshot: () => ({ currentTime: 54, duration: 60, paused: false, ended: false, src: '/track?path=song.flac' }),
    seekStreamingPlayback: seconds => seeks.push(seconds),
  });
  context.window.innerWidth = 390;
  context.player.setAttribute('data-player-seekbar-presentation', 'thin');
  timeline.rectangle = { left: 0, top: 70, width: 390, height: 24 };
  timeline.value = '54';
  timeline.parentElement = new FakeElement();
  context.attachPlayerEvents();
  playButton.closest = () => playButton;
  const down = () => { timeline.value = '54'; context.player.dispatch('pointerdown', { pointerId: 7, isPrimary: true, button: 0, clientX: 350, clientY: 76, target: playButton, preventDefault() { throw new Error('Pointer down must preserve taps'); } }); };
  down();
  assert.notEqual(context.state.player.timelineDragging, true);
  document.dispatch('pointermove', { pointerId: 7, clientX: 315, clientY: 77, preventDefault() {} });
  assert.equal(context.state.player.timelineDragging, true);
  context.player.dispatch('pointerdown', { pointerId: 8, isPrimary: false });
  timeline.parentElement.dispatch('pointerdown', { pointerId: 8, clientX: 10, preventDefault() { throw new Error('Second finger must not start native timeline drag'); } });
  assert.deepEqual(seeks, []);
  document.dispatch('pointerup', { pointerId: 7 });
  assert.equal(seeks.length, 1);
  let suppressed = false;
  context.player.dispatch('click', { pointerId: 7, preventDefault() { suppressed = true; }, stopImmediatePropagation() {} });
  assert.equal(suppressed, true);
  down();
  document.dispatch('pointerup', { pointerId: 7 });
  suppressed = false;
  context.player.dispatch('click', { pointerId: 7, preventDefault() { suppressed = true; }, stopImmediatePropagation() {} });
  assert.equal(suppressed, false);
  down();
  document.dispatch('pointermove', { pointerId: 7, clientX: 352, clientY: 99, preventDefault() { throw new Error('Vertical movement belongs to browser'); } });
  document.dispatch('pointerup', { pointerId: 7 });
  assert.equal(seeks.length, 1);
  down();
  document.dispatch('pointermove', { pointerId: 8, clientX: 315, clientY: 77 });
  assert.notEqual(context.state.player.timelineDragging, true, 'other fingers cannot claim the gesture');
  document.dispatch('pointermove', { pointerId: 7, clientX: 315, clientY: 77, preventDefault() {} });
  document.dispatch('pointercancel', { pointerId: 7 });
  assert.equal(context.state.player.timelineDragging, false);
  assert.equal(seeks.length, 1, 'cancel never commits a seek');
  down();
  document.dispatch('pointermove', { pointerId: 7, clientX: 315, clientY: 77, preventDefault() {} });
  context.state.player.current = { src: '/track?path=next.flac' };
  document.dispatch('pointerup', { pointerId: 7 });
  assert.equal(context.state.player.timelineDragging, false);
  assert.equal(seeks.length, 1, 'release cannot seek a replacement track');
  down();
  document.dispatch('pointermove', { pointerId: 7, clientX: 315, clientY: 77, preventDefault() {} });
  context.state.player.current = { ...context.state.player.current, title: 'Hydrated title' };
  document.dispatch('pointerup', { pointerId: 7 });
  assert.equal(seeks.length, 2, 'same-track metadata hydration preserves the gesture');
});
