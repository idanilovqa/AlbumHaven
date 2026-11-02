'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, world, track, deferred, start} = require('./search-native-fixtures/ownership-platform.cjs');
const SAVED = 'albumhaven.playerState.v1';
const plain = value => JSON.parse(JSON.stringify(value));

async function presentationFixture(t) {
  let h;
  const work = [];
  t.after(async () => {
    if (!h) return;
    h.c.retirePlayerRestoreAttempt('presentation-test-teardown');
    const handle = h.c.getActivePlaybackOwnershipHandle();
    const attempt = h.c.captureStreamingPlaybackAttempt();
    if (handle) h.c.releasePlaybackOwnership('stopped', handle);
    if (attempt) await h.c.stopStreamingPlayback('presentation-test-teardown', {expectedAttempt: attempt});
    if (h.engine().stopPromise) await h.engine().stopPromise;
    await Promise.all(work);
    assert.equal(h.engine().roles.current, null);
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    h.c.disposePlaybackOwnershipCoordinator();
  });
  h = await fixture(t, world(), {readyState: 'loading'});
  h.c.innerWidth = 1200;
  const actualStart = h.c.startStreamingTrack;
  h.c.startStreamingTrack = (...args) => {
    const result = actualStart(...args);
    work.push(Promise.resolve(result).then(value => ({value}), error => ({error})));
    return result;
  };
  return Object.assign(h, {startupWork: work});
}

function metadata(h, role, duration) {
  h.engine().socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
    role: role.role, sampleRate: 48000, channels: 2, requestedStartFrame: role.startFrame,
    timelineStartFrame: role.startFrame, provisionalTotalFrames: duration * 48000});
}
function eos(h, role, duration) {
  h.engine().socket.emit({type: 'eos', generation: role.generation, streamId: role.streamId,
    role: role.role, emittedFrames: 0, authoritativeTotalFrames: duration * 48000});
}
function shown(h, duration, offset = 33) {
  const full = h.c.getPlayerElements(), compact = h.c.compactPlayerElements();
  assert.equal(full.timeline.max, String(duration));
  assert.equal(full.timeline.value, String(offset));
  assert.equal(full.time.textContent, `${h.c.formatLoopTime(offset)} / ${h.c.formatLoopTime(duration)}`);
  assert.equal(full.play.getAttribute('aria-label'), 'Play');
  assert.equal(compact.play.getAttribute('aria-label'), 'Play');
  assert.equal(compact.titleText.textContent, h.state.player.current.title);
}
async function pausedRestore(h) {
  const data = {track: {...track('MeasuredPreview'), durationSeconds: 181}, playbackQueue: null,
    currentTime: 33, paused: true, loop: {active: false, start: 0, end: 30}};
  h.c.localStorage.setItem(SAVED, JSON.stringify(data));
  h.state.player.restoredFromStorage = false;
  h.c.restorePlayerState();
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
  return data;
}

test('preview436 presentation: paused admission reconciles 181 to measured 200 during suspend then 210 metadata and authoritative EOS', async t => {
  const h = await presentationFixture(t), suspended = deferred();
  let suspendCalls = 0, uiCalls = 0;
  const ui = h.c.updatePlayerUi;
  h.c.updatePlayerUi = (...args) => { uiCalls++; return ui(...args); };
  h.platform.onContextCreate = context => {
    context.state = 'running';
    context.suspend = () => { suspendCalls++; return suspended.promise.then(() => { context.state = 'suspended'; }); };
  };
  try {
    await pausedRestore(h);
    assert.equal(suspendCalls, 1, 'saved-paused uses its real direct preparation, without pageshow');
    const role = h.engine().roles.current;
    assert.ok(role);
    assert.equal(h.startupWork.length, 1);
    shown(h, 181);
    assert.equal(uiCalls, 1, 'one explicit preview paint while actual role admission awaits suspend');
    const canonical = h.state.player.current;
    const stored = h.c.localStorage.getItem(SAVED), cache = h.state.player.lastPersistedSnapshot;
    metadata(h, role, 200);
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 200);
    shown(h, 181);
    assert.equal(canonical.durationSeconds, 181, 'unadmitted wire metadata does not mutate preview DTO');
    assert.equal(h.c.persistPlayerState(true), false);
    assert.equal(h.c.localStorage.getItem(SAVED), stored);
    assert.equal(h.state.player.lastPersistedSnapshot, cache);
    suspended.resolve();
    await Promise.all(h.startupWork);
    await h.flush();
    shown(h, 200);
    assert.strictEqual(h.state.player.current, canonical);
    assert.equal(uiCalls, 1, 'admission uses render-only reconciliation, not another updatePlayerUi');
    assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 33);
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    assert.equal(h.state.player.listenSession, null);
    assert.equal(JSON.parse(h.c.localStorage.getItem(SAVED)).track.durationSeconds, 200);
    const writes = h.world.writes.filter(row => row.key === SAVED).length;
    const confirmed = h.state.player.lastPersistedSnapshot;
    metadata(h, role, 210);
    shown(h, 210);
    assert.equal(uiCalls, 1);
    assert.equal(h.world.writes.filter(row => row.key === SAVED).length, writes);
    assert.equal(h.state.player.lastPersistedSnapshot, confirmed);
    eos(h, role, 205);
    shown(h, 205);
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 205);
    assert.equal(h.engine().node.sent.filter(row => row.type === 'eos' && row.streamId === role.streamId).length, 1);
    assert.equal(h.engine().diagnostics.inFlightFrames.current, 0);
    assert.equal(h.world.writes.filter(row => row.key === SAVED).length, writes);
    assert.equal(h.state.player.lastPersistedSnapshot, confirmed);
    assert.equal(h.state.player.listenSession, null);
  } finally { suspended.resolve(); }
});

test('preview436 presentation: metadata before manual publication cannot copy measured duration into predecessor', async t => {
  const h = await presentationFixture(t);
  const predecessor = {...track('Predecessor'), durationSeconds: 81};
  h.c.setCurrentPlayerTrack(predecessor, {persist: false});
  h.platform.holds.resume = true;
  const incoming = track('PendingMeasurement');
  const work = h.c.playTrackFromPayload(incoming);
  try {
    await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    const role = h.engine().roles.current;
    assert.ok(role);
    assert.strictEqual(h.state.player.current, predecessor);
    const before = h.c.getPlayerElements().time.textContent;
    metadata(h, role, 200);
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 200);
    assert.equal(predecessor.durationSeconds, 81);
    assert.equal(h.c.getPlayerElements().time.textContent, before);
    h.platform.contexts[0].state = 'running';
    h.platform.contexts[0].resumeGate.resolve();
    assert.equal(await work, true);
    assert.equal(h.state.player.current.path, incoming.path);
    assert.equal(h.c.getPlayerElements().timeline.max, '200');
  } finally {
    const context = h.platform.contexts[0];
    if (context?.resumeGate) { context.state = 'running'; context.resumeGate.resolve(); }
    await work;
  }
});

for (const event of ['metadata', 'eos']) {
  test(`preview436 presentation: ${event} optional render failure is reporting-only after required wire work`, async t => {
    const h = await presentationFixture(t);
    await pausedRestore(h);
    await Promise.all(h.startupWork);
    await h.flush();
    if (event === 'metadata') {
      const admittedRole = h.engine().roles.current, admittedAttempt = h.c.captureStreamingPlaybackAttempt();
      const admittedScope = h.c.capturePlaybackOwnershipScope();
      const resume = h.c.resumeStreamingPlayback;
      let resumeWork;
      h.c.resumeStreamingPlayback = (...args) => {
        const work = resume(...args);
        resumeWork = work;
        return work;
      };
      try {
        assert.equal(h.c.togglePlayerPlayback(), true, 'real facade admits resume of the saved-paused role');
        assert.ok(resumeWork && typeof resumeWork.then === 'function', 'capture actual owner-returned resume work');
        assert.equal(await resumeWork, true);
        await h.flush();
        assert.strictEqual(h.engine().roles.current, admittedRole);
        assert.strictEqual(h.c.captureStreamingPlaybackAttempt(), admittedAttempt);
        assert.equal(h.c.isPlaybackOwnershipScopeCurrent(admittedScope), true);
        assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false, 'socket-credit scenario must be genuinely running');
        assert.equal(h.c.isPlaybackOwnershipHandleCurrent(h.c.getActivePlaybackOwnershipHandle()), true);
      } finally { h.c.resumeStreamingPlayback = resume; }
    }
    const role = h.engine().roles.current, context = h.engine().context, node = h.engine().node, socket = h.engine().socket;
    assert.ok(role);
    const failures = [], render = h.c.renderGlobalPlayerMetadata, reporter = h.c.console;
    const fault = new Error('optional presentation fault'), required = [];
    let renderCalls = 0;
    h.c.console = {...reporter, error: (...args) => { failures.push(args); }};
    h.c.renderGlobalPlayerMetadata = (...args) => {
      renderCalls++;
      required.push(event === 'eos' ? {
        accepted: role.eosReceived,
        portCount: node.sent.filter(row => row.type === 'eos' && row.streamId === role.streamId).length,
        inFlight: h.engine().diagnostics.inFlightFrames.current,
      } : {
        accepted: role.metadataAccepted,
        credited: socket.sent.some(row => row.type === 'credit' && row.streamId === role.streamId),
      });
      throw fault;
    };
    try {
      if (event === 'metadata') metadata(h, role, 200); else eos(h, role, 200);
      await h.flush();
      assert.equal(renderCalls, 1, 'wire update reaches actual existing presentation body');
      assert.deepEqual(required, event === 'eos'
        ? [{accepted: true, portCount: 1, inFlight: 0}]
        : [{accepted: true, credited: true}], 'required wire work precedes optional rendering');
      assert.equal(failures.length, 1);
      assert.strictEqual(failures[0][1], fault, 'only the injected optional fault is reported');
      assert.strictEqual(h.engine().roles.current, role);
      assert.strictEqual(h.engine().context, context);
      assert.strictEqual(h.engine().node, node);
      assert.strictEqual(h.engine().socket, socket);
      assert.equal(context.closeCount, 0);
      assert.equal(node.disconnectCount, 0);
      assert.equal(socket.closeCount, 0);
      assert.notEqual(h.engine().mode, 'error');
      assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 200);
    } finally { h.c.renderGlobalPlayerMetadata = render; h.c.console = reporter; }
  });
}

for (const successor of [false, true]) {
  test(`preview436 presentation: rejected optional observation cannot close ${successor ? 'successor' : 'current'} engine`, async t => {
    const h = await presentationFixture(t);
    await pausedRestore(h);
    await Promise.all(h.startupWork);
    await h.flush();
    const oldRole = h.engine().roles.current, rejected = deferred(), failures = [];
    const observe = h.c.observeStreamingFacadeCallback, reporter = h.c.console;
    const ownerArguments = [], fault = new Error('optional asynchronous render fault');
    let injecting = false, observations = 0;
    h.c.console = {...reporter, error: (...args) => { failures.push(args); }};
    h.c.observeStreamingFacadeCallback = function(result, source, ...owner) {
      if (!injecting) return observe(result, source, ...owner);
      observations++;
      ownerArguments.push(owner.length);
      // Fault at the existing asynchronous observation boundary; no new helper
      // is referenced and the real reporting-only observer remains responsible.
      return observe(rejected.promise, source, ...owner);
    };
    try {
      injecting = true;
      metadata(h, oldRole, 200);
      injecting = false;
      assert.equal(observations, 1, 'real metadata presentation dispatch observes optional result');
      assert.deepEqual(ownerArguments, [0], 'optional presentation observation must have exactly two arguments');
      if (successor) {
        const next = await start(h, track('AfterOptionalPaint'), {autoplay: false});
        assert.equal(await next.work, true);
      }
      const role = h.engine().roles.current, context = h.engine().context, node = h.engine().node, socket = h.engine().socket;
      const closes = [context.closeCount, node.disconnectCount, socket.closeCount];
      rejected.reject(fault);
      await h.flush();
      assert.equal(failures.length, 1);
      assert.strictEqual(failures[0][1], fault);
      assert.strictEqual(h.engine().roles.current, role);
      assert.deepEqual([context.closeCount, node.disconnectCount, socket.closeCount], closes);
      assert.notEqual(h.engine().mode, 'error');
    } finally {
      injecting = false;
      rejected.resolve();
      h.c.observeStreamingFacadeCallback = observe;
      h.c.console = reporter;
    }
  });
}

test('preview436 presentation: ordinary UI lock recursion retains one save and one optional sync epilogue', async t => {
  const h = await presentationFixture(t);
  h.c.setCurrentPlayerTrack(track('OrdinaryUi'), {persist: false});
  const duration = h.c.getPlayerDuration, persist = h.c.persistPlayerState, ui = h.c.updatePlayerUi;
  const trackPlayback = h.c.AlbumHavenTrackPlayback, sync = trackPlayback?.sync;
  assert.equal(typeof sync, 'function', 'real optional track playback owner is loaded');
  let changed = false, calls = 0, saves = 0, syncs = 0;
  h.c.getPlayerDuration = (...args) => {
    if (!changed) {
      changed = true;
      h.c.localStorage.setItem('albumhaven.playbackOwnership.v1', JSON.stringify({tab_id: 'ui-recursion-foreign',
        claim_revision: 91, status: 'playing', reason: 'manual_start', updated_at_ms: h.world.now(),
        expires_at_ms: h.world.now() + 15000}));
    }
    return duration(...args);
  };
  h.c.persistPlayerState = (...args) => { saves++; return persist(...args); };
  h.c.AlbumHavenTrackPlayback = {...trackPlayback, sync: (...args) => { syncs++; return sync(...args); }};
  h.c.updatePlayerUi = (...args) => { calls++; return ui(...args); };
  try {
    h.c.updatePlayerUi();
    assert.equal(calls, 2, 'existing lock-change recursion remains a full update');
    assert.equal(saves, 1, 'superseded outer presentation cannot repeat the persistence epilogue');
    assert.equal(syncs, 1);
    assert.equal(h.c.getPlayerElements().title.textContent, 'Playing in another tab');
    assert.equal(h.c.compactPlayerElements().titleText.textContent, 'Playing in another tab');
  } finally {
    h.c.getPlayerDuration = duration;
    h.c.persistPlayerState = persist;
    h.c.updatePlayerUi = ui;
    h.c.AlbumHavenTrackPlayback = trackPlayback;
  }
});

for (const sameObject of [false, true]) {
  test(`preview436 presentation: old role metadata cannot paint a later ${sameObject ? 'same-object' : 'same-path'} publication`, async t => {
    const h = await presentationFixture(t);
    await pausedRestore(h);
    await Promise.all(h.startupWork);
    await h.flush();
    const role = h.engine().roles.current, original = h.state.player.current;
    const successor = sameObject ? original : {...original, title: 'Unassociated same-path successor'};
    h.c.setCurrentPlayerTrack(successor, {persist: false});
    const duration = successor.durationSeconds, time = h.c.getPlayerElements().time.textContent;
    const writes = h.world.writes.filter(row => row.key === SAVED).length;
    metadata(h, role, 210);
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 210, 'valid wire event still updates real engine');
    assert.strictEqual(h.state.player.current, successor);
    assert.equal(successor.durationSeconds, duration, 'object/path equality cannot inherit the old role publication receipt');
    assert.equal(h.c.getPlayerElements().time.textContent, time);
    assert.equal(h.world.writes.filter(row => row.key === SAVED).length, writes);
  });
}

test('preview436 presentation: reentrant same-path replacement during optional paint fences later old-role paint', async t => {
  const h = await presentationFixture(t);
  await pausedRestore(h);
  await Promise.all(h.startupWork);
  await h.flush();
  const role = h.engine().roles.current, render = h.c.renderGlobalPlayerMetadata;
  let successor;
  h.c.renderGlobalPlayerMetadata = (...args) => {
    if (!successor) {
      successor = {...h.state.player.current, title: 'Reentrant optional-paint successor'};
      h.c.setCurrentPlayerTrack(successor, {persist: false});
      return;
    }
    return render(...args);
  };
  try {
    metadata(h, role, 200);
    assert.ok(successor, 'actual metadata notification reaches presentation');
    assert.strictEqual(h.state.player.current, successor);
    assert.equal(h.c.getPlayerElements().title.textContent, `${successor.artist} - ${successor.title} /`);
    assert.equal(h.c.compactPlayerElements().titleText.textContent, successor.title);
    const duration = successor.durationSeconds, time = h.c.getPlayerElements().time.textContent;
    metadata(h, role, 210);
    assert.equal(successor.durationSeconds, duration);
    assert.equal(h.c.getPlayerElements().time.textContent, time);
    assert.strictEqual(h.engine().roles.current, role);
    assert.equal(h.engine().context.closeCount, 0);
  } finally { h.c.renderGlobalPlayerMetadata = render; }
});

test('preview436 presentation: cached waveform reply cannot publish while exact restore role admission is suspended', async t => {
  const h = await presentationFixture(t), suspended = deferred();
  h.platform.onContextCreate = context => {
    context.state = 'running';
    context.suspend = () => suspended.promise.then(() => { context.state = 'suspended'; });
  };
  try {
    await pausedRestore(h);
    const role = h.engine().roles.current;
    assert.ok(role);
    const probes = h.requests.map((request, index) => ({request, index}))
      .filter(({request}) => new URL(request.url, h.location).pathname === '/playback/waveform');
    assert.equal(probes.length, 1, 'real engine cached-only probe is bounded independently of preview setter');
    assert.equal(new URL(probes[0].request.url, h.location).searchParams.get('cachedOnly'), '1');
    const peaks = {sampleCount: 720, left: Array(720).fill(0.25), right: Array(720).fill(0.5)};
    h.reply(probes[0].index, peaks);
    await h.flush();
    assert.equal(h.state.player.waveform.compactPeaks, null, 'cached availability is not publication admission');
    suspended.resolve();
    await Promise.all(h.startupWork);
    await h.flush();
    const published = h.state.player.waveform.compactPeaks;
    assert.ok(published);
    assert.equal(published.path, h.state.player.current.path);
    assert.equal(published.generation, role.generation);
    assert.deepEqual(plain(published.data), peaks);
  } finally { suspended.resolve(); }
});

for (const successor of [false, true]) {
  test(`preview436 presentation: actual async waveform canvas rejection cannot fail ${successor ? 'successor' : 'current'} playback or delay EOS`, async t => {
    const h = await presentationFixture(t);
    await pausedRestore(h);
    await Promise.all(h.startupWork);
    await h.flush();
    const oldRole = h.engine().roles.current, oldNode = h.engine().node;
    const canvas = h.c.getPlayerElements().waveformCanvas, getContext = canvas.getContext;
    const reporter = h.c.console, fault = new Error('actual async waveform canvas fault');
    const failures = [], requiredAtCanvas = [];
    h.state.player.appearance.seekbarMode = 'waveform';
    h.c.console = {...reporter, error: (...args) => { failures.push(args); }};
    canvas.getContext = () => {
      // Actual updateWaveformAppearance is async: this real canvas boundary
      // throws inside it, creating its own rejected promise. No observer or
      // render owner is replaced and no fabricated rejected promise is supplied.
      requiredAtCanvas.push({eos: oldRole.eosReceived,
        delivered: oldNode.sent.filter(row => row.type === 'eos' && row.streamId === oldRole.streamId).length,
        inFlight: h.engine().diagnostics.inFlightFrames.current});
      throw fault;
    };
    try {
      eos(h, oldRole, 205);
      // Required wire work is synchronous; it must not await optional rendering.
      assert.equal(oldNode.sent.filter(row => row.type === 'eos' && row.streamId === oldRole.streamId).length, 1);
      assert.deepEqual(requiredAtCanvas, [{eos: true, delivered: 1, inFlight: 0}]);
      canvas.getContext = getContext;
      if (successor) {
        const next = await start(h, track('AfterActualCanvasFault'), {autoplay: false});
        assert.equal(await next.work, true);
        assert.equal(h.state.player.current.path, next.payload.path);
        assert.notStrictEqual(h.engine().roles.current, oldRole);
      }
      await h.flush();
      assert.equal(failures.length, 1, 'actual async renderer rejection is reported exactly once');
      assert.strictEqual(failures[0][1], fault);
      const role = h.engine().roles.current, context = h.engine().context, node = h.engine().node, socket = h.engine().socket;
      assert.ok(role);
      assert.equal(h.c.isStreamingPlaybackAttemptCurrent(h.c.captureStreamingPlaybackAttempt()), true);
      if (!successor) assert.strictEqual(role, oldRole);
      assert.equal(context.closeCount, 0);
      assert.equal(node.disconnectCount, 0);
      assert.equal(socket.closeCount, 0);
      assert.notEqual(h.engine().mode, 'error');
      // Let normal queued observation finish; don't mask unhandled rejections
      // with a process listener or a catch attached by the test.
      await h.flush();
      assert.equal(failures.length, 1);
      assert.strictEqual(h.engine().roles.current, role);
      assert.equal(context.closeCount, 0);
    } finally {
      canvas.getContext = getContext;
      h.c.console = reporter;
    }
  });
}

test('preview436 presentation: paused metadata defers credit before optional render failure without waking playback', async t => {
  const h = await presentationFixture(t);
  await pausedRestore(h);
  await Promise.all(h.startupWork);
  await h.flush();
  const role = h.engine().roles.current, context = h.engine().context, node = h.engine().node, socket = h.engine().socket;
  assert.ok(role);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  const before = Number(h.engine().deferredCreditFrames.current) || 0;
  const expectedCredit = Math.min(h.owner('STREAMING_MAX_CREDIT_FRAMES'),
    Number(role.targetBufferFrames) || h.owner('STREAMING_MAX_CREDIT_FRAMES'));
  assert.ok(expectedCredit > 0);
  const render = h.c.renderGlobalPlayerMetadata, reporter = h.c.console;
  const fault = new Error('paused metadata optional render fault'), observations = [], failures = [];
  h.c.console = {...reporter, error: (...args) => { failures.push(args); }};
  h.c.renderGlobalPlayerMetadata = () => {
    observations.push({accepted: role.metadataAccepted, deferred: h.engine().deferredCreditFrames.current,
      sent: socket.sent.filter(row => row.type === 'credit' && row.streamId === role.streamId).length});
    throw fault;
  };
  try {
    metadata(h, role, 200);
    await h.flush();
    assert.deepEqual(observations, [{accepted: true, deferred: before + expectedCredit, sent: 0}],
      'paused wire credit is deferred before optional rendering, never omitted or sent early');
    assert.equal(failures.length, 1);
    assert.strictEqual(failures[0][1], fault);
    assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 200);
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    assert.equal(h.state.player.listenSession, null);
    assert.strictEqual(h.engine().roles.current, role);
    assert.strictEqual(h.engine().context, context);
    assert.strictEqual(h.engine().node, node);
    assert.strictEqual(h.engine().socket, socket);
    assert.equal(context.closeCount, 0);
    assert.equal(node.disconnectCount, 0);
    assert.equal(socket.closeCount, 0);
    assert.notEqual(h.engine().mode, 'error');
  } finally { h.c.renderGlobalPlayerMetadata = render; h.c.console = reporter; }
});

for (const throwingReporter of [false, true]) {
  test(`preview436 paused failure: publication error promptly retires actual pending startup with ${throwingReporter ? 'late dependency rejection and throwing' : 'normal'} reporter and preserves successor`, async t => {
    const h = await presentationFixture(t);
    h.platform.holds.module = true;
    const data = {track: {...track('ThrowingPausedPublication'), durationSeconds: 181}, playbackQueue: null,
      currentTime: 33, paused: true, loop: {active: false, start: 0, end: 30}};
    h.c.localStorage.setItem(SAVED, JSON.stringify(data));
    h.state.player.restoredFromStorage = false;
    const original = h.c.localStorage.getItem(SAVED);
    const setter = h.c.setCurrentPlayerTrack, elements = h.c.getPlayerElements, reporter = h.c.console;
    const actualStart = h.c.startStreamingTrack;
    const publicationFault = new Error('actual paused publication failure');
    const reportingFault = new Error('optional restore reporter failure');
    const lateFault = new Error('injected returned-start continuation rejection');
    let derivedStarts = 0;
    const attempts = [];
    h.c.startStreamingTrack = (track, options) => {
      const onStartAttempt = options.onStartAttempt;
      const actualWork = actualStart(track, {...options, onStartAttempt(attempt) {
        attempts.push({path: track.path, attempt});
        return onStartAttempt?.(attempt);
      }});
      if (!throwingReporter || track.path !== data.track.path) return actualWork;
      derivedStarts++;
      // Explicit dependency-fault seam: retain the real start/attempt unchanged,
      // then reject its returned continuation only after finite actual work settles.
      // The test must not catch this promise; production owns its observation.
      return actualWork.then(() => { throw lateFault; });
    };
    const reports = [];
    let insideSetter = false, oldContext, manualWork;
    h.c.setCurrentPlayerTrack = (...args) => {
      insideSetter = true;
      try { return setter(...args); }
      finally { insideSetter = false; }
    };
    h.c.getPlayerElements = (...args) => {
      if (insideSetter) throw publicationFault;
      return elements(...args);
    };
    h.c.console = {...reporter, error: (...args) => {
      reports.push(args);
      if (throwingReporter && (args.includes(publicationFault) || args.includes(lateFault))) throw reportingFault;
    }};
    try {
      h.c.restorePlayerState();
      assert.equal(h.startupWork.length, 1, 'saved-paused actual start is issued before synchronous publication');
      const started = h.startupWork[0], attempt = attempts.find(row => row.path === data.track.path)?.attempt;
      assert.ok(attempt, 'actual start returned work and issued its own attempt');
      await h.flush();
      assert.equal(h.owner('playerRestoreAttempt'), null, 'publication failure retires restore without awaiting held module');
      assert.equal(h.c.isStreamingPlaybackAttemptCurrent(attempt), false);
      assert.equal(h.state.player.current, null);
      assert.equal(h.c.localStorage.getItem(SAVED), original);
      assert.deepEqual(plain(h.state.player.lastRestoreError), {name: publicationFault.name, message: publicationFault.message});
      assert.equal(reports.filter(args => args.includes(publicationFault)).length, 1);
      oldContext = h.platform.contexts[0];
      assert.ok(oldContext?.module, 'finite real AudioContext module remains externally held');
      h.c.setCurrentPlayerTrack = setter;
      h.c.getPlayerElements = elements;
      h.platform.holds.module = false;
      const successor = track('AfterPausedPublicationFailure');
      manualWork = h.c.playTrackFromPayload(successor, {autoplay: false});
      const successorAttempt = attempts.find(row => row.path === successor.path)?.attempt;
      assert.ok(successorAttempt, 'actual successor start issued its own pending attempt');
      assert.notStrictEqual(successorAttempt, attempt);
      oldContext.module.reject(new Error('retired module preparation failed'));
      assert.deepEqual(await started, {value: null}, 'real retired prepare rejection is intentionally suppressed, not a fabricated startup rejection');
      assert.equal(await manualWork, true);
      await h.flush();
      assert.equal(h.state.player.current.path, successor.path);
      assert.equal(h.engine().roles.current.track.path, successor.path);
      assert.equal(h.c.isStreamingPlaybackAttemptCurrent(successorAttempt), true);
      assert.strictEqual(h.c.captureStreamingPlaybackAttempt(), successorAttempt, 'admitted role retains the actually observed pending attempt');
      assert.equal(h.engine().context.closeCount, 0);
      assert.notEqual(h.engine().context, oldContext);
      assert.equal(oldContext.closeCount, 1);
      assert.notEqual(h.engine().mode, 'error');
      assert.equal(reports.filter(args => args.includes(publicationFault)).length, 1);
      assert.equal(derivedStarts, throwingReporter ? 1 : 0);
      assert.equal(reports.filter(args => args.includes(lateFault)).length, throwingReporter ? 1 : 0,
        'returned dependency rejection is observed once without current-owner failure authority');
      assert.deepEqual(plain(h.state.player.lastRestoreError), {name: publicationFault.name, message: publicationFault.message});
    } finally {
      h.c.startStreamingTrack = actualStart;
      h.c.setCurrentPlayerTrack = setter;
      h.c.getPlayerElements = elements;
      for (const context of h.platform.contexts) context.module.resolve();
      if (manualWork) await manualWork;
      h.c.console = reporter;
    }
  });
}
