const STREAMING_RUNTIME_ASSET_VERSION = encodeURIComponent(
  String(window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ || ''),
);
const STREAMING_WORKLET_URL = '/static/js/audio-worklets/gapless-playback-processor.js'
  + (STREAMING_RUNTIME_ASSET_VERSION ? `?v=${STREAMING_RUNTIME_ASSET_VERSION}` : '');
const STREAMING_PROCESSOR_NAME = 'album-haven-gapless-playback';
const STREAMING_MAX_CREDIT_SECONDS = 1;
const STREAMING_CREDIT_LOW_WATER_SECONDS = 0.25;
const STREAMING_INITIAL_PLAYBACK_CUSHION_SECONDS = 2;
const STREAMING_QUEUED_NEXT_PREPARE_SECONDS = 3;
const STREAMING_REPLACEMENT_PREPARE_SECONDS = 2;
const STREAMING_ENCODED_REPLACEMENT_PREPARE_SECONDS = 1;
const STREAMING_SEEK_PREPARE_SECONDS = 0.25;
const STREAMING_REPLACEMENT_OUTGOING_CUSHION_SECONDS = 1;
const STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_SECONDS = STREAMING_REPLACEMENT_PREPARE_SECONDS;
const STREAMING_WAVEFORM_READY_SECONDS = 1;
const STREAMING_RESTORE_AUTOPLAY_SETTLEMENT_MS = 750;
const STREAMING_REPLACEMENT_CUSHION_WAIT_MS = 1000;
const STREAMING_MAX_KNOWN_TRACK_RATES = 512;
const STREAMING_ENCODED_BUFFER_SECONDS = { current: 120, continuity: 30 };
const STREAMING_ENCODED_BUFFER_MIN_BYTES = 1024 * 1024;
const STREAMING_ENCODED_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const STREAMING_FALLBACK_BYTES_PER_SECOND = 40_000;
const STREAMING_ENCODED_CREDIT_BYTES = 64 * 1024;
const STREAMING_TRANSFER_WINDOW_BYTES = 32 * 1024 * 1024;
const STREAMING_OUTPUT_REPORT_INTERVAL_MS = 5000;

// Capture ownership is separate from playback attempt/lease ownership. The
// staged gate cannot start a context request, timer or producer while false.
const streamingCaptureOwners = new WeakMap();
function streamingCaptureSafely(callback) {
  try { return callback(); } catch (_) { return null; }
}
function streamingCaptureBridge(node = streamingEngineState().node) {
  return node ? streamingCaptureOwners.get(node) || null : null;
}
function streamingCaptureTransport() {
  const position = typeof document !== 'undefined'
    && document.getElementById('app-shell')?.dataset.positionCaptureEnabled === 'true';
  return Object.freeze({position,
    contextPath: position ? '/playback/capture/position/context' : '/playback/capture/context',
    checkpointPath: position ? '/playback/capture/position/checkpoint' : '/playback/capture/checkpoint'});
}
function canStartOrdinaryAlbumListening() {
  const native = streamingRateCaptureBridge();
  if (native) return Boolean(native.ready && native.selectionReady && native.guard());
  const bridge = streamingCaptureBridge();
  return Boolean(bridge?.positionReady && bridge?.selectionReady && bridge.guard());
}
function beginStreamingCaptureContext() {
  if (nativeStreamingCaptureEnabled()) return null;
  if (typeof PLAYBACK_CAPTURE_ENABLED === 'undefined' || !PLAYBACK_CAPTURE_ENABLED) return null;
  const scope = typeof capturePlaybackOwnershipScope === 'function' ? capturePlaybackOwnershipScope() : null;
  if (!scope) return null;
  const controller = new AbortController();
  const transport = streamingCaptureTransport();
  const current = () => typeof isPlaybackOwnershipScopeCurrent === 'function' && isPlaybackOwnershipScopeCurrent(scope)
    && PLAYBACK_CAPTURE_ENABLED === true && streamingCaptureTransport().position === transport.position;
  // Start alongside worklet loading. This request never gates audio preparation.
  const promise = Promise.resolve().then(async () => {
    if (!current()) return null;
    const response = await fetch(transport.contextPath, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok || !current()) return null;
    const value = await response.json();
    if (transport.position && !(Array.isArray(value?.supported_protocols)
        && value.supported_protocols.includes('app-rendered-position-v2'))) return null;
    if (!transport.position && value?.supported_protocols?.includes('app-rendered-position-v2')) return null;
    return current() ? value : null;
  }).catch(() => null);
  return { scope, promise, transport, discard: () => controller.abort() };
}
function prepareStreamingCapture(engine, context, node, preparedContext = null) {
  if (streamingRateCaptureBridge(node) || nativeStreamingCaptureEnabled()) return;
  if (typeof PLAYBACK_CAPTURE_ENABLED === 'undefined' || !PLAYBACK_CAPTURE_ENABLED
      || typeof PlaybackCaptureTelemetry === 'undefined' || context.sampleRate !== 48000) {
    preparedContext?.discard();
    return;
  }
  const prepared = preparedContext || beginStreamingCaptureContext();
  const scope = prepared?.scope;
  if (!scope) return;
  const transport = prepared.transport || streamingCaptureTransport();
  const bridge = { owner: null, generation: engine.generation, retired: false, positionReady: false, selectionReady: false };
  const currentScope = () => typeof isPlaybackOwnershipScopeCurrent === 'function'
    && isPlaybackOwnershipScopeCurrent(scope) && PLAYBACK_CAPTURE_ENABLED === true
    && streamingCaptureTransport().position === transport.position;
  const guard = () => {
    if (currentScope()) return true;
    // An old owner must not invalidate observations on a successor node.
    if (engine.node === node) {
      for (const role of [engine.roles.current, engine.roles.continuity]) {
        if (role) { role.captureSource = null; role.capturePendingPositions = null; role.captureMappedBinding = null; }
      }
    }
    bridge.owner?.onScopeLost();
    return false;
  };
  const owner = PlaybackCaptureTelemetry.createOwner({
    getContext: async () => {
      if (!guard()) throw new Error('Capture scope retired');
      const value = await prepared.promise;
      if (!guard()) throw new Error('Capture context unavailable');
      const advertisesPosition = Array.isArray(value?.supported_protocols) && value.supported_protocols.includes('app-rendered-position-v2');
      if (advertisesPosition !== transport.position) throw new Error('Capture transport mismatch');
      bridge.selectionReady = transport.position && value?.listening_selections_available === true;
      bridge.observationReady = transport.position && value?.decoded_observations_available === true;
      return value;
    },
    postCheckpoint: async (body, scopeHeader, { signal, keepalive }) => {
      if (!guard()) throw new Error('Capture scope retired');
      const response = await fetch(transport.checkpointPath, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Playback-Capture-Scope': scopeHeader },
        body, signal, keepalive,
      });
      if (!guard()) throw new Error('Capture scope retired');
      if (response.status === 401 || response.status === 403) return { status: response.status, data: null };
      const data = await response.json().catch(() => null);
      if (!guard()) throw new Error('Capture scope retired');
      return { status: response.status, data };
    },
    clock: { now: () => performance.now(), utc: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(() => { if (guard()) fn(); }, ms),
      clearTimeout: id => window.clearTimeout(id) },
    crypto: window.crypto,
    generation: () => engine.node === node ? engine.generation : bridge.generation,
    sendCommand: (message, transfer) => {
      if (message.type === 'capture-disable') { bridge.positionReady = false; bridge.selectionReady = false; bridge.observationReady = false; }
      if (message.type === 'capture-disable' || guard()) node.port.postMessage(message, transfer);
    },
    diagnostic: reason => { bridge.diagnostic = reason; },
  });
  bridge.owner = owner; bridge.guard = guard;
  streamingCaptureOwners.set(node, bridge);
  const stateChanged = () => { if (guard()) owner.onContextState(context.state); };
  context.addEventListener('statechange', stateChanged);
  const pagehide = () => { if (guard()) owner.pagehide(); };
  window.addEventListener('pagehide', pagehide);
  bridge.detach = () => {
    prepared.discard();
    context.removeEventListener('statechange', stateChanged);
    window.removeEventListener('pagehide', pagehide);
  };
  void owner.enable().then(accepted => {
    if (!accepted || !guard()) return;
    bridge.positionReady = transport.position;
    stateChanged();
    // Reuse the genuine in-flight preparation/attempt, never probe separately.
    // Optional selection remains parallel to audio and can settle before seal.
    const attempt = engine.playbackAttempt;
    const track = streamingAttemptRecords.get(attempt)?.incomingTrack || engine.roles.current?.track;
    if (bridge.positionReady && bridge.selectionReady && track?.albumListeningIntent
        && typeof beginOrdinaryAlbumListening === 'function') {
      beginOrdinaryAlbumListening(track, () => guard() && isStreamingPlaybackAttemptCurrent(attempt));
    }
  }).catch(() => owner.onScopeLost());
}
function bindStreamingCapture(role, metadata) {
  if (streamingRateCaptureBridge() || metadata.coverageMode === 'native') {
    bindStreamingRateCapture(role, metadata); return;
  }
  const engine = streamingEngineState(), bridge = streamingCaptureBridge();
  if (!bridge || !bridge.guard() || role.captureBinding || role.captureSkipped) return;
  bridge.generation = engine.generation;
  if (metadata.sampleRate !== 48000 || engine.context?.sampleRate !== 48000) {
    role.captureSkipped = true; bridge.diagnostic = 'unsupported_capture_rate'; return;
  }
  const source = metadata.captureSource;
  const local = source?.coordinateBasis === 'decoded-output-local';
  if (role.metadataAccepted || role.nextSequence !== 0
      || metadata.generation !== role.generation || metadata.streamId !== role.streamId
      || role.generation !== engine.generation || streamingRoleForId(role.streamId) !== role
      || !Number.isSafeInteger(metadata.requestedStartFrame) || metadata.requestedStartFrame < 0
      || metadata.timelineStartFrame !== metadata.requestedStartFrame
      || metadata.requestedStartFrame !== role.startFrame
      || (local ? (metadata.requestedStartFrame === 0 || bridge.observationReady !== true
          || source.requestedStart48 !== metadata.requestedStartFrame) : metadata.requestedStartFrame !== 0)
      || !source || source.version !== 'decoded-pcm-observation-v1'
      || (!local && source.coordinateBasis !== 'decoded-output-zero') || source.sourceBase48 !== 0
      || source.extentFrames48 !== null || typeof source.observationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source.observationId)) {
    // Local decoder zero counts rendered time, never proves the requested seek offset.
    role.captureSkipped = true; bridge.diagnostic = 'unsupported_capture_source'; return;
  }
  // Use a settled proof now, or resolve it once at first body seal. A reply
  // after that seal can never relabel the historical association.
  const selected = role.track?.listeningSelection
    || (typeof settledOrdinaryAlbumListeningSelection === 'function' ? settledOrdinaryAlbumListeningSelection(role.track) : null);
  const editionSelectionRef = selected?.selection_ref ?? null;
  const continuation = ['seek', 'short-loop', 'long-loop', 'whole-track-repeat'].includes(role.continuityOptions?.kind)
    && !(engine.pendingSeek?.kind === 'replacement' && engine.pendingSeek.streamId === role.streamId)
    && role.track?.path === engine.roles.current?.track?.path
    && (role.track?.albumListeningIntent
      ? role.track.albumListeningIntent === engine.roles.current?.track?.albumListeningIntent
      : editionSelectionRef === (typeof bridge.owner.selectionRefFor === 'function'
        ? bridge.owner.selectionRefFor(engine.roles.current?.captureParent)
        : engine.roles.current?.captureEditionSelectionRef ?? null));
  const parent = continuation ? engine.roles.current?.captureParent : bridge.owner.bindTrack({
    trackPath: role.track?.path,
    deviceId: typeof getMeasuredPlaybackDeviceId === 'function' ? getMeasuredPlaybackDeviceId().toLowerCase() : '',
    v1SessionId: null,
    editionSelectionRef,
    editionSelectionResolver: role.track?.albumListeningIntent && typeof settledOrdinaryAlbumListeningSelection === 'function'
      ? () => bridge.guard() ? settledOrdinaryAlbumListeningSelection(role.track)?.selection_ref ?? null : null : null,
  });
  if (!parent) { role.captureSkipped = true; bridge.diagnostic = 'capture_binding_unavailable_before_pcm'; return; }
  role.captureParent = parent;
  role.captureEditionSelectionRef = continuation
    ? (typeof bridge.owner.selectionRefFor === 'function' ? bridge.owner.selectionRefFor(parent) : engine.roles.current?.captureEditionSelectionRef ?? null)
    : editionSelectionRef;
  role.captureBinding = bridge.owner.linkStream(parent, {
    generation: role.generation, streamId: role.streamId, sourceBase48: source.sourceBase48,
    sourceRate: metadata.sampleRate, outputRate: engine.context.sampleRate,
    ...(bridge.observationReady ? {sourceObservationRef:source.observationId} : {}),
  });
  if (!role.captureBinding) {
    role.captureSkipped = true;
    if (!continuation) bridge.owner.requestClose(parent, 'capture_limit');
  } else {
    role.captureSource = Object.freeze({ ...source });
    role.captureReceivedFrames = 0;
  }
}
// Optional sideband is paired with exactly one future binary frame. Invalid or
// repeated controls discard mapping, never PCM or the ordinary local binding.
function stageStreamingCapturePositions(role, message) {
  const bridge = streamingCaptureBridge(), engine = streamingEngineState();
  if (role.capturePositionSequence === message.sequence) {
    role.capturePendingPositions = null;
    return;
  }
  role.capturePendingPositions = null;
  if (!bridge || !bridge.guard() || !bridge.observationReady || !role.captureBinding
      || role.captureBinding.mapped || !role.captureParent || !role.metadataAccepted
      || role.captureSource?.coordinateBasis !== 'decoded-output-local'
      || role.eosReceived || role.generation !== engine.generation
      || message.generation !== role.generation || message.streamId !== role.streamId
      || message.sequence !== role.nextSequence || !Number.isSafeInteger(message.sequence)
      || !Number.isSafeInteger(message.frameCount) || message.frameCount < 1
      || message.frameCount > streamingRoleCapacityFrames(role)
      || typeof message.observationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.observationId)
      || message.observationId === role.captureSource.observationId
      || !Array.isArray(message.ranges) || !message.ranges.length || message.ranges.length > 32) return;
  role.capturePositionSequence = message.sequence;
  let end = 0;
  const ranges = [];
  for (const range of message.ranges) {
    if (!Array.isArray(range) || range.length !== 3 || range.some(value => !Number.isSafeInteger(value) || Object.is(value, -0))
        || range[0] < end || range[1] < 0 || range[2] < 1
        || range[0] > message.frameCount - range[2] || range[1] > Number.MAX_SAFE_INTEGER - range[2]) return;
    end = range[0] + range[2];
    ranges.push([range[0], range[1], range[2]]);
  }
  if (!role.captureMappedBinding) {
    role.captureMappedBinding = bridge.owner.linkStream(role.captureParent, {
      mapped: true, baseBindingSerial: role.captureBinding.bindingSerial,
      generation: role.generation, streamId: role.streamId, sourceBase48: 0,
      sourceRate: 48000, outputRate: engine.context?.sampleRate,
      sourceObservationRef: message.observationId,
    });
    if (!role.captureMappedBinding) return;
    role.captureMappedObservation = message.observationId;
  }
  if (role.captureMappedObservation !== message.observationId) return;
  role.capturePendingPositions = {sequence: message.sequence, frameCount: message.frameCount,
    bindingSerial: role.captureMappedBinding.bindingSerial, ranges};
}
function consumeStreamingCapturePositions(role, sequence, frameCount) {
  const value = role.capturePendingPositions;
  role.capturePendingPositions = null;
  const bridge = streamingCaptureBridge();
  return bridge?.guard() && value?.sequence === sequence && value.frameCount === frameCount
    ? {bindingSerial: value.bindingSerial, ranges: value.ranges} : null;
}
function completeStreamingCaptureSource(role, message) {
  const bridge = streamingCaptureBridge();
  if (!bridge || !bridge.guard()) { role.captureSource = null; return; }
  if (!role.captureSource) return;
  const source = message.captureSource;
  if (!source || source.version !== role.captureSource.version
      || source.observationId !== role.captureSource.observationId
      || source.coordinateBasis !== role.captureSource.coordinateBasis || source.sourceBase48 !== 0
      || source.requestedStart48 !== role.captureSource.requestedStart48
      || !Number.isSafeInteger(source.extentFrames48) || source.extentFrames48 < 0
      || source.extentFrames48 !== message.emittedFrames
      || !Number.isSafeInteger(message.authoritativeTotalFrames)
      || source.extentFrames48 + role.startFrame !== message.authoritativeTotalFrames
      || source.extentFrames48 !== role.captureReceivedFrames) {
    role.captureSource = null;
    bridge.diagnostic = 'capture_extent_unavailable';
    return;
  }
  // EOF is decoded extent only. The unchanged worklet still owns rendered spans.
  // This local association is not persisted by the existing checkpoint schema.
  role.captureSource = Object.freeze({ ...source });
}
function retireStreamingCapture(role, successor = null, reason = 'track_change', node = streamingEngineState().node) {
  retireStreamingRateCapture(role, successor, reason);
  if (role) { role.captureSource = null; role.capturePendingPositions = null; role.captureMappedBinding = null; }
  const bridge = streamingCaptureBridge(node);
  if (!bridge || !bridge.guard() || !role) return;
  if (role.captureBinding) bridge.owner.unlinkStream(role.captureBinding);
  if (role.captureParent && role.captureParent !== successor?.captureParent) bridge.owner.requestClose(role.captureParent, reason);
}


function streamingEngineState() {
  return state.player.streaming;
}

// Handles are opaque capabilities for local cancellation, never media authority.
const streamingAttemptRecords = new WeakMap();
const streamingUnsafeCleanupFailures = new WeakMap();
// Resource provenance only: these nodes have never admitted a playback role.
const streamingEmptyPreparations = new WeakMap();
const streamingPreparationOutcomes = new WeakMap();
const streamingCleanupOutcomes = new WeakMap();
// Correlate transport controls without changing media or playback ownership.
// The counter survives stop/configure; only the scheduling authority expires.
const streamingPlaybackIntents = new WeakMap();
function sendStreamingPlaybackIntent(engine, node, generation, kind) {
  const intents = streamingPlaybackIntents.get(engine);
  const configured = intents?.configured;
  const message = {type: kind, generation};
  if (configured?.node === node && configured.generation === generation
      && engine.node === node && engine.generation === generation
      && engine.roles.current?.generation === generation) {
    if (intents.counter >= Number.MAX_SAFE_INTEGER) {
      intents.active = null;
      failStreamingEngine('processor', {message: 'Playback intent IDs exhausted'}, 'playback-intent-exhausted');
      return false;
    }
    message.playbackIntentId = ++intents.counter;
    intents.active = {node, generation, id: message.playbackIntentId, kind};
  }
  // Publish before the port effect, and never overwrite a reentrant successor.
  node.port.postMessage(message);
  return true;
}
function registerStreamingAttempt(engine, role = null, incomingTrack = null) {
  const handle = Object.freeze({});
  const record = { engine, request: engine.startRequestId, lifecycle: engine.lifecycleEpoch || 0,
    generation: engine.generation, role, phase: role ? 'role' : 'pending', retired: false,
    outgoing: null, cutover: null, barrier: engine.stopPromise || null,
    pendingRole:engine.roles.current, pendingContinuity:engine.roles.continuity, incomingTrack };
  streamingAttemptRecords.set(handle, record);
  engine.playbackAttempt = handle;
  return handle;
}
function isStreamingPlaybackAttemptCurrent(handle) {
  const record = handle && streamingAttemptRecords.get(handle), engine = streamingEngineState();
  if (!record || record.retired || record.engine !== engine || engine.playbackAttempt !== handle
      || record.request !== engine.startRequestId || record.lifecycle !== (engine.lifecycleEpoch || 0)
      || record.generation !== engine.generation) return false;
  if (record.phase === 'pending') return engine.roles.current === record.pendingRole
    && engine.roles.continuity === record.pendingContinuity;
  if (record.phase === 'replacement') return engine.roles.current === record.outgoing
    && engine.roles.continuity === record.role && engine.pendingSeek === record.cutover;
  return engine.roles.current === record.role && Boolean(record.role);
}
function captureStreamingPlaybackAttempt() {
  const engine = streamingEngineState();
  if (engine.stopPromise || !engine.roles.current) return null;
  if (engine.playbackAttempt) {
    const record = streamingAttemptRecords.get(engine.playbackAttempt);
    return record?.phase === 'role' && isStreamingPlaybackAttemptCurrent(engine.playbackAttempt) ? engine.playbackAttempt : null;
  }
  return registerStreamingAttempt(engine, engine.roles.current);
}

// Retire an outgoing source while a different, already admitted start owns the
// handoff. Keep the logical role until that existing transaction replaces it;
// the worklet can commit its prepared seek while paused, without rendering it.
function retireStreamingOutgoingRole(role, attempt) {
  const engine = streamingEngineState(), record = attempt && streamingAttemptRecords.get(attempt);
  if (!role || engine.roles.current !== role || !isStreamingPlaybackAttemptCurrent(attempt)
      || !record.incomingTrack || record.incomingTrack === role.track
      || (record.phase !== 'pending' && record.phase !== 'replacement')
      || (record.phase === 'pending' ? record.pendingRole !== role : record.outgoing !== role)
      || !engine.node || !engine.context || engine.stopPromise) return false;
  if (record.retiredOutgoing) return record.retiredOutgoing.role === role;
  const context = engine.context, node = engine.node;
  const retirement = {role, resume: engine.snapshot.paused !== true};
  record.retiredOutgoing = retirement;
  engine.snapshot.paused = true;
  const current = () => isStreamingPlaybackAttemptCurrent(attempt)
    && engine.roles.current === role && engine.context === context && engine.node === node;
  try { if (!sendStreamingPlaybackIntent(engine, node, engine.generation, 'pause')) return true; }
  catch (error) {
    if (current()) failStreamingEngine('processor', error, 'retired-outgoing-pause-error');
    return true;
  }
  if (!current()) return true;
  if (record.phase === 'pending') settleStreamingReplacementCushionWaiter(false);
  else {
    maybeGrantDeferredReplacementCredit();
    if (current() && streamingRetiredOutgoingIncoming(engine.roles.continuity)) {
      const deferred = Number(engine.deferredCreditFrames?.continuity) || 0;
      if (deferred > 0) {
        engine.deferredCreditFrames.continuity = 0;
        grantStreamingCredit(engine.roles.continuity, deferred);
      }
    }
  }
  // A prior deliberate pause may have suspended processing. Resume only the
  // context, never the outgoing worklet stream, so its handoff can finish.
  if (current() && context.state === 'suspended') {
    void context.resume().catch(error => {
      if (current()) failStreamingEngine('context', error, 'retired-outgoing-resume-error');
    });
  }
  return true;
}
function streamingRetiredOutgoingIncoming(role) {
  const engine = streamingEngineState(), attempt = engine.playbackAttempt;
  const owner = attempt && streamingAttemptRecords.get(attempt);
  return Boolean(owner?.phase === 'replacement' && owner.role === role
    && owner.retiredOutgoing?.role === engine.roles.current && isStreamingPlaybackAttemptCurrent(attempt));
}
function captureStreamingRetiredOutgoingAttempt() {
  const engine = streamingEngineState(), attempt = engine.playbackAttempt;
  const owner = attempt && streamingAttemptRecords.get(attempt);
  if (!owner?.retiredOutgoing || !isStreamingPlaybackAttemptCurrent(attempt)) return null;
  const outgoing = owner.retiredOutgoing.role === engine.roles.current
    && (owner.phase === 'pending' || owner.phase === 'replacement');
  const awaitingIncomingResume = owner.phase === 'role' && owner.role === engine.roles.current
    && owner.role !== owner.retiredOutgoing.role && owner.role.track === owner.incomingTrack
    && owner.retiredOutgoing.resume && owner.retiredOutgoing.awaitingResume === true && engine.snapshot.paused;
  return outgoing || awaitingIncomingResume ? attempt : null;
}
function advanceStreamingAttempt(handle, role, cutover = null) {
  const record = streamingAttemptRecords.get(handle), engine = streamingEngineState();
  if (!record || record.retired || engine.playbackAttempt !== handle
      || record.request !== engine.startRequestId || record.lifecycle !== (engine.lifecycleEpoch || 0)) return false;
  record.generation = engine.generation;
  record.role = role;
  record.phase = cutover ? 'replacement' : 'role';
  record.outgoing = cutover ? engine.roles.current : null;
  record.cutover = cutover;
  return true;
}
function promoteStreamingAttempt(outgoing, incoming, pending = null) {
  const engine = streamingEngineState(), handle = engine.playbackAttempt;
  const record = handle && streamingAttemptRecords.get(handle);
  if (!record || record.retired || record.request !== engine.startRequestId
      || record.lifecycle !== (engine.lifecycleEpoch || 0) || record.generation !== engine.generation) return;
  if (record.phase === 'replacement' ? record.outgoing === outgoing && record.role === incoming && record.cutover === pending
      : record.phase === 'role' && record.role === outgoing) advanceStreamingAttempt(handle, incoming);
}

function streamingFrames(seconds) {
  return Math.round(seconds * streamingEngineState().sampleRate);
}

function publishStreamingDiagnostics() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.setAttribute(
    'data-streaming-diagnostics',
    JSON.stringify(getStreamingPlaybackSnapshot()),
  );
}

function streamingRoleForId(streamId) {
  const engine = streamingEngineState();
  if (engine.roles.current?.streamId === streamId) return engine.roles.current;
  if (engine.roles.continuity?.streamId === streamId) return engine.roles.continuity;
  return null;
}

function streamingWireRoleAccepted(roleState, wireRole) {
  return wireRole === roleState?.role
    || (wireRole === 'continuity'
      && roleState?.role === 'current'
      && roleState.acceptsPromotedContinuityWireRole === true);
}

function initialStreamingBackingCapacities() {
  const engine = streamingEngineState();
  return {
    current: streamingFrames(engine.limits.currentSeconds),
    continuity: streamingFrames(engine.limits.continuitySeconds),
  };
}

function ensureStreamingBackingCapacities() {
  const engine = streamingEngineState();
  engine.backingCapacityFrames ??= initialStreamingBackingCapacities();
  return engine.backingCapacityFrames;
}

function streamingRoleCapacityFrames(roleState) {
  const engine = streamingEngineState();
  const role = roleState?.role;
  const logicalCapacityFrames = streamingFrames(engine.limits[`${role}Seconds`]);
  const backingCapacityFrames = Number(roleState?.backingCapacityFrames)
    || Number(ensureStreamingBackingCapacities()[role])
    || logicalCapacityFrames;
  return Math.min(logicalCapacityFrames, backingCapacityFrames);
}

function swapStreamingBackingCapacities(current, continuity) {
  const engine = streamingEngineState();
  const capacities = ensureStreamingBackingCapacities();
  const outgoingCapacityFrames = Number(current?.backingCapacityFrames)
    || capacities.current;
  const incomingCapacityFrames = Number(continuity?.backingCapacityFrames)
    || capacities.continuity;
  engine.backingCapacityFrames = {
    current: incomingCapacityFrames,
    continuity: outgoingCapacityFrames,
  };
  continuity.backingCapacityFrames = incomingCapacityFrames;
}

function refreshStreamingActiveRoles() {
  const engine = streamingEngineState();
  engine.diagnostics.activeRoles = ['current', 'continuity']
    .filter((role) => engine.roles[role] !== null);
}

function createStreamingPcmEvidence(roleState = null) {
  const engine = streamingEngineState();
  return {
    generation: Number(roleState?.generation || engine.generation || 0),
    streamId: Number(roleState?.streamId || 0),
    frames: 0,
    finiteSamples: 0,
    nonZeroSamples: 0,
    peakSample: 0,
    samples: [],
  };
}

function resetStreamingRenderedPcmEvidence(roleState = null, { clearAll = false } = {}) {
  const engine = streamingEngineState();
  engine.renderedPcmEvidenceByStream ??= new Map();
  if (clearAll) engine.renderedPcmEvidenceByStream.clear();
  const evidence = createStreamingPcmEvidence(roleState);
  if (roleState) engine.renderedPcmEvidenceByStream.set(roleState.streamId, evidence);
  if (roleState?.role === 'current') engine.audibleStreamId = roleState.streamId;
  engine.diagnostics.renderedPcmEvidence = evidence;
  return evidence;
}

function recordStreamingRenderedPcmEvidence(roleState, message) {
  if (!Number.isInteger(message.finiteSamples) || message.finiteSamples < 0
      || !Number.isInteger(message.nonZeroSamples) || message.nonZeroSamples < 0
      || !Number.isFinite(message.peakSample) || message.peakSample < 0
      || !Array.isArray(message.samples)) return;
  const engine = streamingEngineState();
  engine.renderedPcmEvidenceByStream ??= new Map();
  let evidence = engine.renderedPcmEvidenceByStream.get(roleState.streamId);
  if (!evidence || evidence.generation !== roleState.generation) {
    evidence = createStreamingPcmEvidence(roleState);
    engine.renderedPcmEvidenceByStream.set(roleState.streamId, evidence);
  }
  evidence.frames += message.frames;
  evidence.finiteSamples += message.finiteSamples;
  evidence.nonZeroSamples += message.nonZeroSamples;
  evidence.peakSample = Math.max(evidence.peakSample, message.peakSample);
  for (const sample of message.samples) {
    if (evidence.samples.length >= 32) break;
    if (Number.isFinite(sample)) evidence.samples.push(sample);
  }
  if (message.audible === true) engine.audibleStreamId = roleState.streamId;
  if (roleState.streamId === engine.audibleStreamId || message.audible === true) {
    engine.diagnostics.renderedPcmEvidence = evidence;
  }
}

function resetStreamingPcmEvidence(roleState = null, { clearAll = false } = {}) {
  const engine = streamingEngineState();
  engine.pcmEvidenceByStream ??= new Map();
  if (clearAll) engine.pcmEvidenceByStream.clear();
  const evidence = createStreamingPcmEvidence(roleState);
  if (roleState) {
    engine.pcmEvidenceByStream.set(roleState.streamId, evidence);
    while (engine.pcmEvidenceByStream.size > 2) {
      engine.pcmEvidenceByStream.delete(engine.pcmEvidenceByStream.keys().next().value);
    }
  }
  engine.diagnostics.pcmEvidence = evidence;
  resetStreamingRenderedPcmEvidence(roleState, { clearAll });
  return evidence;
}

function recordStreamingPcmEvidence(roleState, frameCount, pcm) {
  const engine = streamingEngineState();
  engine.pcmEvidenceByStream ??= new Map();
  let evidence = engine.pcmEvidenceByStream.get(roleState.streamId);
  if (!evidence || evidence.generation !== roleState.generation) {
    evidence = createStreamingPcmEvidence(roleState);
    engine.pcmEvidenceByStream.set(roleState.streamId, evidence);
  }
  evidence.frames += frameCount;
  for (const sample of pcm) {
    if (!Number.isFinite(sample)) continue;
    evidence.finiteSamples += 1;
    const magnitude = Math.abs(sample);
    if (magnitude > 0) evidence.nonZeroSamples += 1;
    evidence.peakSample = Math.max(evidence.peakSample, magnitude);
    if (evidence.samples.length < 32) evidence.samples.push(sample);
  }
  if (roleState.role === 'current') engine.diagnostics.pcmEvidence = evidence;
}

function promoteStreamingPcmEvidence(roleState) {
  const engine = streamingEngineState();
  const evidence = engine.pcmEvidenceByStream?.get(roleState.streamId)
    || createStreamingPcmEvidence(roleState);
  engine.diagnostics.pcmEvidence = evidence;
  const renderedEvidence = engine.renderedPcmEvidenceByStream?.get(roleState.streamId)
    || createStreamingPcmEvidence(roleState);
  engine.diagnostics.renderedPcmEvidence = renderedEvidence;
  engine.audibleStreamId = roleState.streamId;
}

function cancelStreamingWaveformGeneration(generation) {
  if (typeof cancelWaveformPeakLoads !== 'function') return;
  try {
    cancelWaveformPeakLoads(generation);
  } catch (error) {
    console.warn('[AlbumHaven][Waveform] Optional peak cancellation failed.', error);
  }
}

function streamingRolePlayableFrames(roleState) {
  const provisionalTotalFrames = Number(roleState?.provisionalTotalFrames);
  if (!Number.isInteger(provisionalTotalFrames) || provisionalTotalFrames < 0) return null;
  const timelineStartFrame = Number.isInteger(roleState.timelineStartFrame)
    ? roleState.timelineStartFrame
    : Number(roleState.startFrame) || 0;
  return Math.max(0, provisionalTotalFrames - timelineStartFrame);
}

function streamingAbsoluteTimelineFrame(roleState, relativeFrame) {
  const initialStartFrame = roleState?.role === 'current'
      && !roleState.seekTarget
      && !roleState.continuityOptions
    ? Math.max(0, Number(roleState.startFrame) || 0)
    : 0;
  return initialStartFrame + Math.max(0, Number(relativeFrame) || 0);
}

function maybeNotifyStreamingWaveformReady({ includeCommittedFrames = false } = {}) {
  const engine = streamingEngineState();
  const current = engine.roles.current;
  const continuity = engine.roles.continuity;
  if (!current) return;
  const currentCapacityFrames = streamingRoleCapacityFrames(current);
  const currentPlayableFrames = streamingRolePlayableFrames(current);
  const currentTargetFrames = currentPlayableFrames === null
    ? Math.min(currentCapacityFrames, streamingFrames(STREAMING_WAVEFORM_READY_SECONDS))
    : Math.min(currentCapacityFrames, streamingFrames(STREAMING_WAVEFORM_READY_SECONDS), currentPlayableFrames);
  if (typeof handleStreamingPlaybackWaveformReady !== 'function') return;
  const currentCommittedFrames = engine.diagnostics.bufferedFrames.current
    + (includeCommittedFrames ? engine.diagnostics.inFlightFrames.current : 0);
  const continuityCommittedFrames = engine.diagnostics.bufferedFrames.continuity
    + (includeCommittedFrames ? engine.diagnostics.inFlightFrames.continuity : 0);
  const renderedCurrentFrames = Math.max(
    0,
    (Number(engine.snapshot.renderedFrame) || 0) - (Number(current.renderedFrameBase) || 0),
  );
  const currentReady = currentCommittedFrames + renderedCurrentFrames >= currentTargetFrames;
  const continuityPlayableFrames = streamingRolePlayableFrames(continuity);
  const continuityCapacityFrames = continuity
    ? streamingRoleCapacityFrames(continuity)
    : streamingFrames(1);
  const continuityTargetFrames = continuityPlayableFrames === null
    ? Math.min(streamingFrames(1), continuityCapacityFrames)
    : Math.min(streamingFrames(1), continuityCapacityFrames, continuityPlayableFrames);
  const continuityReady = !continuity
    || continuityCommittedFrames >= continuityTargetFrames;
  if (!currentReady || !continuityReady) return;
  const identity = `${engine.generation}:${current.streamId}:${continuity?.streamId || ''}`;
  if (engine.waveformReadyIdentity === identity) return;
  engine.waveformReadyIdentity = identity;
  try {
    const result = handleStreamingPlaybackWaveformReady({
      generation: engine.generation,
      currentPath: String(current.track?.path || ''),
      continuityPath: String(continuity?.track?.path || ''),
    });
    if (result && typeof result.then === 'function') {
      void result.catch((error) => console.warn('[AlbumHaven][Waveform] Optional peak load failed.', error));
    }
  } catch (error) {
    console.warn('[AlbumHaven][Waveform] Optional peak load failed.', error);
  }
}

function setStreamingError(source, event) {
  const engine = streamingEngineState();
  const detail = event?.error?.message || event?.message || `${source} failed`;
  engine.mode = 'error';
  engine.diagnostics.lastError = { source, message: String(detail) };
}

function failStreamingEngine(source, event, reason) {
  setStreamingError(source, event);
  const cleanup = beginStreamingCleanup(reason, { preserveError: true });
  void cleanup.catch((error) => console.error('Streaming cleanup failed', error));
}

function captureStreamingFacadeOwner() {
  const engine = streamingEngineState();
  return Object.freeze({ engine, attempt: engine.playbackAttempt, request: engine.startRequestId,
    lifecycle: engine.lifecycleEpoch, generation: engine.generation, role: engine.roles.current });
}
function streamingFacadeOwnerCurrent(owner) {
  const engine = streamingEngineState();
  return Boolean(owner && owner.engine === engine && owner.attempt === engine.playbackAttempt
    && owner.request === engine.startRequestId && owner.lifecycle === engine.lifecycleEpoch
    && owner.generation === engine.generation && owner.role === engine.roles.current);
}
function reportStreamingFacadeFailure(error, source, owner) {
  // Logging does not grant the failing callback any ownership. Recheck after it.
  console.error('Streaming facade callback failed', error);
  if (!streamingFacadeOwnerCurrent(owner)) return;
  // Never read exception getters while holding authority to fail an engine.
  failStreamingEngine('facade', {message: 'Streaming facade callback failed'}, source);
}
function observeStreamingFacadeCallback(result, source, owner = null) {
  // Legacy callers pass already-invoked results. Without a pre-invocation owner
  // those failures are reporting-only, not authority over the current engine.
  try {
    if (!result || typeof result.then !== 'function') return;
    void Promise.resolve(result).catch(error => reportStreamingFacadeFailure(error, source, owner));
  } catch (error) { reportStreamingFacadeFailure(error, source, owner); }
}
function invokeStreamingFacadeCallback(callback, source, expectedRole, expectedGeneration) {
  const owner = captureStreamingFacadeOwner();
  if (owner.role !== expectedRole || owner.generation !== expectedGeneration) return;
  try { observeStreamingFacadeCallback(callback(), source, owner); }
  catch (error) { reportStreamingFacadeFailure(error, source, owner); }
}

// Optional display observation has no engine failure/cleanup authority.
function notifyStreamingPlaybackPresentation(role, lineage) {
  const engine = streamingEngineState();
  if (!lineage || lineage.engine !== engine || lineage.role !== role
    || engine.roles.current !== role || engine.playbackAttempt !== lineage.attempt
    || engine.startRequestId !== lineage.request || engine.lifecycleEpoch !== lineage.lifecycle
    || engine.generation !== lineage.generation
    || typeof handleStreamingPlaybackPresentation !== 'function') return;
  try {
    const result = handleStreamingPlaybackPresentation(lineage);
    if (result !== undefined) observeStreamingFacadeCallback(result, 'presentation');
  } catch (error) { reportStreamingFacadeFailure(error, 'presentation', null); }
}

function normalizeStreamingContinuityOptions(options = {}) {
  const kind = ['queued-next', 'short-loop', 'long-loop', 'whole-track-repeat', 'seek']
    .includes(options.kind) ? options.kind : 'queued-next';
  const startSeconds = Math.max(0, Number(options.startSeconds) || 0);
  const endSeconds = Math.max(startSeconds, Number(options.endSeconds) || 0);
  return { kind, startSeconds, endSeconds, ...(typeof options.isCurrent === 'function' ? {isCurrent: options.isCurrent} : {}) };
}

function streamingContinuityIdentity(track, options) {
  return [String(track?.path || ''), options.kind, options.startSeconds, options.endSeconds].join(':');
}

function deferStreamingContinuity(track, options, generation, currentStreamId) {
  Promise.resolve().then(() => {
    const engine = streamingEngineState();
    if (engine.generation !== generation
        || engine.roles.current?.streamId !== currentStreamId
        || engine.pendingContinuityTrack !== track
        || engine.pendingContinuityOptions !== options) return;
    engine.pendingContinuityTrack = null;
    engine.pendingContinuityOptions = null;
    return scheduleStreamingContinuity(track, options);
  });
}

function protectedQueuedContinuityReady(engine, current, options) {
  if (options?.kind !== 'queued-next') return true;
  return (current?.replacementPromotion !== true || !engine.pendingPromotion)
    && (current.firstFrameNotified === true || current.boundaryNotified === true)
    && !engine.snapshot.paused
    && !engine.roles.continuity
    && (current.eosReceived === true
      || engine.diagnostics.bufferedFrames.current >= streamingFrames(1));
}

function maybeSchedulePendingStreamingContinuity() {
  const engine = streamingEngineState();
  const current = engine.roles.current;
  const track = engine.pendingContinuityTrack;
  if (!current || !track || engine.pendingPromotion
      || engine.pendingSeek || engine.roles.continuity) return false;
  const options = engine.pendingContinuityOptions
    || normalizeStreamingContinuityOptions();
  if (!protectedQueuedContinuityReady(engine, current, options)) return false;
  deferStreamingContinuity(track, options, engine.generation, current.streamId);
  return true;
}

function closeStreamingContinuityRole(reason, { releaseWorklet = true } = {}) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return false;
  const continuity = engine.roles.continuity, node=engine.node, request=engine.startRequestId, lifecycle=engine.lifecycleEpoch;
  const current=()=>!engine.stopPromise&&engine.roles.continuity===continuity&&engine.node===node
    &&engine.startRequestId===request&&engine.lifecycleEpoch===lifecycle;
  if (!continuity) return true;
  const accepted = sendStreamingControl({
    type: 'close',
    generation: continuity.generation,
    streamId: continuity.streamId,
    reason,
  });
  if (!accepted || !current()) return false;
  const options = continuity.continuityOptions;
  if (releaseWorklet && engine.node) {
    if (options?.kind === 'queued-next') {
      engine.node.port.postMessage({
        type: 'drop-continuity',
        generation: continuity.generation,
        streamId: continuity.streamId,
      });
      if (!current()) return false;
      node.port.postMessage({
        type: 'expect-continuity',
        generation: continuity.generation,
        active: false,
      });
    } else {
      engine.node.port.postMessage({
        type: 'set-loop',
        generation: continuity.generation,
        active: false,
        kind: options.kind,
        startFrame: streamingFrames(options.startSeconds),
        endFrame: streamingFrames(options.endSeconds),
        retainedStreamId: continuity.streamId,
      });
    }
  }
  if (!current()) return false;
  streamingCaptureSafely(() => retireStreamingCapture(continuity, engine.roles.current));
  engine.roles.continuity = null;
  engine.pcmEvidenceByStream?.delete(continuity.streamId);
  engine.renderedPcmEvidenceByStream?.delete(continuity.streamId);
  engine.diagnostics.bufferedFrames.continuity = 0;
  engine.diagnostics.inFlightFrames.continuity = 0;
  engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
  engine.deferredCreditFrames.continuity = 0;
  refreshStreamingActiveRoles();
  return true;
}

function sendStreamingControl(message) {
  const engine = streamingEngineState();
  const socket = engine.socket;
  if (!socket) return false;
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      failStreamingEngine('socket', error, 'control-send-error');
      return false;
    }
  }
  const connectingState = Number.isInteger(WebSocket.CONNECTING) ? WebSocket.CONNECTING : 0;
  if (socket.readyState === connectingState) {
    engine.pendingControls ??= [];
    engine.pendingControls.push(message);
    return true;
  }
  failStreamingEngine(
    'socket',
    { message: 'Playback socket is not open for control delivery' },
    'control-send-error',
  );
  return false;
}

function flushStreamingControls() {
  const engine = streamingEngineState();
  const controls = engine.pendingControls || [];
  engine.pendingControls = [];
  for (const message of controls) sendStreamingControl(message);
}

function streamingRoleCommittedCapacityFrames(roleState) {
  const engine = streamingEngineState();
  const capacityFrames = streamingRoleCapacityFrames(roleState);
  const fullCurrentCapacityFrames = streamingFrames(engine.limits.currentSeconds);
  return roleState?.role === 'current' && capacityFrames === fullCurrentCapacityFrames
    ? Math.max(1, capacityFrames - streamingFrames(STREAMING_MAX_CREDIT_SECONDS))
    : capacityFrames;
}

function grantStreamingCredit(roleState, requestedFrames) {
  if (!roleState || !Number.isInteger(requestedFrames) || requestedFrames <= 0) return 0;
  const engine = streamingEngineState();
  const role = roleState.role;
  const pendingSeek = engine.pendingSeek;
  const outgoingReplacementCurrent = pendingSeek?.kind === 'replacement'
      && pendingSeek.generation === engine.generation
      && role === 'current'
      && pendingSeek.currentStreamId === roleState.streamId
      && roleState.generation === engine.generation;
  const bufferedFrames = engine.diagnostics.bufferedFrames[role];
  const inFlightFrames = engine.diagnostics.inFlightFrames[role];
  if (outgoingReplacementCurrent) {
    const remainingSafetyFrames = Math.max(
      0,
      streamingFrames(STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_SECONDS)
        - bufferedFrames
        - inFlightFrames,
    );
    requestedFrames = Math.min(requestedFrames, remainingSafetyFrames);
    if (requestedFrames <= 0) return 0;
  }
  engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
  if (engine.snapshot.paused && !streamingRetiredOutgoingIncoming(roleState)) {
    if (outgoingReplacementCurrent) return 0;
    engine.deferredCreditFrames[role] += requestedFrames;
    return 0;
  }
  const committedCapacityFrames = streamingRoleCommittedCapacityFrames(roleState);
  const availableFrames = Math.max(
    0,
    committedCapacityFrames - bufferedFrames - inFlightFrames,
  );
  const serverAvailableFrames = Math.max(0, streamingFrames(STREAMING_MAX_CREDIT_SECONDS) - inFlightFrames);
  const frames = Math.min(requestedFrames, availableFrames, serverAvailableFrames);
  if (frames <= 0) return 0;
  if (roleState.encoded) {
    if (roleState.eosReceived) return 0;
    roleState.encoded.localCreditFrames += frames;
    engine.diagnostics.inFlightFrames[role] += frames;
    void pumpStreamingEncodedRole(roleState);
    return frames;
  }
  const accepted = sendStreamingControl({
    type: 'credit',
    generation: roleState.generation,
    streamId: roleState.streamId,
    frames,
  });
  if (!accepted) return 0;
  engine.diagnostics.inFlightFrames[role] += frames;
  return frames;
}

function refillStreamingRoleCredit(roleState, missingFrames) {
  if (!roleState || !Number.isInteger(missingFrames) || missingFrames <= 0) return 0;
  const engine = streamingEngineState();
  const outgoingReplacementCurrent = roleState.role === 'current'
    && engine.pendingSeek?.kind === 'replacement'
    && engine.pendingSeek.generation === engine.generation
    && engine.pendingSeek.currentStreamId === roleState.streamId
    && roleState.generation === engine.generation;
  if (roleState.role !== 'current' || outgoingReplacementCurrent) {
    return grantStreamingCredit(roleState, missingFrames);
  }
  const inFlightFrames = engine.diagnostics.inFlightFrames.current;
  if (missingFrames < streamingFrames(STREAMING_MAX_CREDIT_SECONDS)
      || inFlightFrames > streamingFrames(STREAMING_CREDIT_LOW_WATER_SECONDS)) return 0;
  return grantStreamingCredit(roleState, streamingFrames(STREAMING_MAX_CREDIT_SECONDS) - inFlightFrames);
}

function continuityCreditNeedsOutgoingRenderCushion(roleState) {
  const engine = streamingEngineState();
  const pendingReplacement = engine.pendingSeek;
  const current = engine.roles.current;
  if (streamingRetiredOutgoingIncoming(roleState)) return false;
  const queuedNextNeedsCushion = roleState?.role === 'continuity'
    && roleState.continuityOptions?.kind === 'queued-next'
    && !current?.eosReceived
    && engine.diagnostics.bufferedFrames.current < streamingFrames(1);
  const replacementNeedsCushion = roleState?.role === 'continuity'
    && roleState.continuityOptions?.kind === 'seek'
    && pendingReplacement?.kind === 'replacement'
    && pendingReplacement.generation === engine.generation
    && pendingReplacement.streamId === roleState.streamId
    && pendingReplacement.currentStreamId === current?.streamId
    && !current.eosReceived
    && engine.diagnostics.bufferedFrames.current < streamingFrames(STREAMING_REPLACEMENT_OUTGOING_CUSHION_SECONDS);
  return queuedNextNeedsCushion || replacementNeedsCushion;
}

function settleStreamingReplacementCushionWaiter(ready) {
  const engine = streamingEngineState();
  const waiter = engine.replacementCushionWaiter;
  if (!waiter) return false;
  engine.replacementCushionWaiter = null;
  if (waiter.timeoutId) window.clearTimeout(waiter.timeoutId);
  waiter.resolve(Boolean(ready));
  return true;
}

function replacementOutgoingCushionReady(engine, current) {
  return current?.eosReceived === true
    || engine.diagnostics.bufferedFrames.current
      >= streamingFrames(STREAMING_REPLACEMENT_OUTGOING_CUSHION_SECONDS);
}

function maybeResolveStreamingReplacementCushion() {
  const engine = streamingEngineState();
  const waiter = engine.replacementCushionWaiter;
  if (!waiter) return false;
  const current = engine.roles.current;
  if (engine.generation !== waiter.generation
      || current?.streamId !== waiter.currentStreamId) {
    return settleStreamingReplacementCushionWaiter(false);
  }
  if (!replacementOutgoingCushionReady(engine, current)) return false;
  return settleStreamingReplacementCushionWaiter(true);
}

function waitForStreamingReplacementCushion(engine, current) {
  if (replacementOutgoingCushionReady(engine, current)) return Promise.resolve(true);
  settleStreamingReplacementCushionWaiter(false);
  return new Promise((resolve) => {
    const waiter = {
      generation: engine.generation,
      currentStreamId: current.streamId,
      resolve,
      timeoutId: 0,
    };
    engine.replacementCushionWaiter = waiter;
    waiter.timeoutId = window.setTimeout(() => {
      if (engine.replacementCushionWaiter === waiter) {
        settleStreamingReplacementCushionWaiter(false);
      }
    }, STREAMING_REPLACEMENT_CUSHION_WAIT_MS);
  });
}

function grantStreamingInitialCredit(roleState) {
  if (continuityCreditNeedsOutgoingRenderCushion(roleState)) {
    roleState.initialCreditDeferred = true;
    return 0;
  }
  roleState.initialCreditDeferred = false;
  return grantStreamingCredit(roleState, Math.min(
    streamingFrames(STREAMING_MAX_CREDIT_SECONDS),
    Number(roleState.targetBufferFrames) || streamingFrames(STREAMING_MAX_CREDIT_SECONDS),
  ));
}

function maybeGrantDeferredReplacementCredit() {
  const continuity = streamingEngineState().roles.continuity;
  if (!continuity?.initialCreditDeferred || !continuity.metadataAccepted) return 0;
  return grantStreamingInitialCredit(continuity);
}

function validateStreamingMetadata(message, roleState) {
  return message.generation === roleState.generation
    && message.streamId === roleState.streamId
    && message.role === roleState.role
    && message.sampleRate === streamingEngineState().sampleRate
    && message.channels === 2
    && (message.codec === undefined
      || (streamingEngineState().encodedCodecs?.includes(message.codec)
        && Number.isInteger(message.skipFrames) && message.skipFrames >= 0
        && Number.isInteger(message.totalFrames) && message.totalFrames >= 0))
    && Number.isInteger(message.provisionalTotalFrames)
    && message.provisionalTotalFrames >= 0
    && message.requestedStartFrame === roleState.startFrame
    && Number.isInteger(message.timelineStartFrame)
    && message.timelineStartFrame >= 0;
}

function handleStreamingControl(message) {
  const engine = streamingEngineState();
  if (!message || typeof message !== 'object') return;
  if (message.type === 'probe-result') {
    settleStreamingSampleRateProbe(message.requestId, Number(message.sampleRate) || 0, {
      fallbackSampleRate: Number(message.fallbackSampleRate) || 0,
      sizeBytes: Number(message.sizeBytes) || 0,
      losslessBitsPerSecond: Number(message.losslessBitsPerSecond) || 0,
    });
    return;
  }
  const roleState = streamingRoleForId(message.streamId);
  if (!roleState || message.generation !== engine.generation) {
    engine.diagnostics.staleMessages += 1;
    return;
  }
  if (message.type === 'rate-positions') {
    streamingCaptureSafely(() => stageStreamingRatePositions(roleState, message));
    return;
  }
  if (message.type === 'capture-positions') {
    streamingCaptureSafely(() => stageStreamingCapturePositions(roleState, message));
    return;
  }
  if (message.type === 'rate-mismatch') {
    handleStreamingRateMismatch(roleState, message);
    return;
  }
  if (message.type === 'metadata') {
    if (!validateStreamingMetadata(message, roleState)) {
      failStreamingEngine(
        'socket',
        { message: 'Invalid streaming metadata' },
        'metadata-protocol-error',
      );
      return;
    }
    const presentation = {engine, role: roleState, attempt: engine.playbackAttempt,
      request: engine.startRequestId, lifecycle: engine.lifecycleEpoch, generation: engine.generation};
    streamingCaptureSafely(() => bindStreamingCapture(roleState, message));
    roleState.metadataAccepted = true;
    if (message.codec) {
      createStreamingEncodedRole(roleState, message);
      refillStreamingEncodedBytes(roleState);
      // Compressed audio keeps arriving far faster than it plays, so a shorter head is safe.
      if (engine.pendingSeek?.kind === 'replacement'
          && engine.pendingSeek.streamId === roleState.streamId) {
        roleState.targetBufferFrames = Math.min(
          roleState.targetBufferFrames,
          streamingFrames(STREAMING_ENCODED_REPLACEMENT_PREPARE_SECONDS),
        );
      }
    }
    roleState.provisionalTotalFrames = message.provisionalTotalFrames;
    roleState.timelineStartFrame = message.timelineStartFrame;
    if (roleState.continuityOptions?.kind === 'seek') {
      roleState.targetBufferFrames = Math.min(
        roleState.targetBufferFrames,
        Math.max(0, message.provisionalTotalFrames - message.timelineStartFrame),
      );
    }
    if (roleState.role === 'current') {
      Object.assign(engine.snapshot, {
        sampleRate: message.sampleRate,
        requestedStartFrame: message.requestedStartFrame,
        timelineStartFrame: message.timelineStartFrame,
        duration: message.provisionalTotalFrames / message.sampleRate,
        readyState: 1,
      });
    }
    grantStreamingInitialCredit(roleState);
    publishStreamingDiagnostics();
    notifyStreamingPlaybackPresentation(roleState, presentation);
    return;
  }
  if (message.type === 'promoted') {
    const pending = engine.pendingPromotion;
    if (!pending || pending.generation !== message.generation
        || pending.streamId !== message.streamId || message.role !== 'current') {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    const retainedSeekSeconds = Number.isFinite(pending.requestedSeekSeconds)
      ? pending.requestedSeekSeconds
      : null;
    engine.pendingPromotion = null;
    if (retainedSeekSeconds !== null) {
      void seekStreamingPlayback(retainedSeekSeconds);
    } else {
      maybeSchedulePendingStreamingContinuity();
    }
    return;
  }
  if (message.type === 'eos') {
    if (!streamingWireRoleAccepted(roleState, message.role)
        || !Number.isInteger(message.emittedFrames) || message.emittedFrames < 0
        || !Number.isInteger(message.authoritativeTotalFrames)
        || message.authoritativeTotalFrames < message.emittedFrames) {
      failStreamingEngine(
        'socket',
        { message: 'Invalid streaming end-of-stream event' },
        'eos-protocol-error',
      );
      return;
    }
    if (roleState.eosReceived) return;
    if (roleState.encoded && !roleState.encoded.delivered) {
      roleState.encoded.eos = message;
      void pumpStreamingEncodedRole(roleState);
      return;
    }
    const presentation = {engine, role: roleState, attempt: engine.playbackAttempt,
      request: engine.startRequestId, lifecycle: engine.lifecycleEpoch, generation: engine.generation};
    streamingCaptureSafely(() => completeStreamingCaptureSource(roleState, message));
    roleState.eosReceived = true;
    roleState.closed = true;
    engine.diagnostics.inFlightFrames[roleState.role] = 0;
    if (roleState.role === 'current' && !roleState.seekTarget) {
      engine.snapshot.duration = message.authoritativeTotalFrames / engine.sampleRate;
    }
    engine.node.port.postMessage({
      type: 'eos',
      generation: message.generation,
      streamId: message.streamId,
      role: roleState.role,
      emittedFrames: message.emittedFrames,
      authoritativeTotalFrames: message.authoritativeTotalFrames,
    });
    if (roleState.role === 'current') {
      maybeResolveStreamingReplacementCushion();
      maybeGrantDeferredReplacementCredit();
      maybeSchedulePendingStreamingContinuity();
    }
    maybePrepareStreamingSeek(roleState);
    publishStreamingDiagnostics();
    notifyStreamingPlaybackPresentation(roleState, presentation);
    return;
  }
  if (message.type === 'error') {
    failStreamingEngine(
      'socket',
      { message: message.message || message.code || 'Streaming failed' },
      'server-error',
    );
    return;
  }
  failStreamingEngine(
    'socket',
    { message: `Unknown active streaming control: ${String(message.type)}` },
    'control-protocol-error',
  );
}

function leaveStreamingTrackForRateChange(track) {
  const engine = streamingEngineState();
  // One AudioContext has one rate, so this track starts its own context after `ended`.
  engine.sampleRateChangeNext = { generation: engine.generation, path: String(track.path || '') };
  engine.node?.port.postMessage({
    type: 'expect-continuity',
    generation: engine.generation,
    active: false,
  });
}

function handleStreamingRateMismatch(roleState, message) {
  const engine = streamingEngineState();
  rememberStreamingTrackFormat(String(roleState.track?.path || ''), message.sampleRate, {
    fallbackSampleRate: Number(message.fallbackSampleRate) || 0,
    sizeBytes: 0,
  });
  const replacement = engine.pendingSeek;
  if (replacement?.kind === 'replacement' && replacement.streamId === roleState.streamId) {
    if (!isStreamingPlaybackAttemptCurrent(engine.playbackAttempt)) return;
    const callbacks = streamingAttemptRecords.get(engine.playbackAttempt);
    engine.roles.continuity = null;
    engine.pendingSeek = null;
    refreshStreamingActiveRoles();
    startStreamingTrack(roleState.track, {
      startSeconds: roleState.continuityOptions.startSeconds,
      onStartAttempt: callbacks.onStartAttempt,
      onAutoplayStarted: callbacks.onAutoplayStarted,
    })
      .then(replacement.resolve, replacement.reject);
    return;
  }
  if (roleState.role !== 'continuity' || roleState.continuityOptions?.kind !== 'queued-next') {
    failStreamingEngine('socket', { message: 'The track sample rate changed' }, 'rate-mismatch');
    return;
  }
  engine.roles.continuity = null;
  engine.pcmEvidenceByStream?.delete(roleState.streamId);
  engine.diagnostics.bufferedFrames.continuity = 0;
  engine.diagnostics.inFlightFrames.continuity = 0;
  refreshStreamingActiveRoles();
  leaveStreamingTrackForRateChange(roleState.track);
}

function reportStreamingAudioOutput() {
  const engine = streamingEngineState();
  const context = engine.context;
  const now = performance.now();
  if (!context || now - (Number(engine.outputReportedAtMs) || 0)
      < STREAMING_OUTPUT_REPORT_INTERVAL_MS) return;
  const stats = context.playbackStats;
  const underruns = Number(stats?.underrunEvents) || 0;
  const alreadyReported = engine.outputReportedContext === context
    && underruns <= (Number(engine.outputReportedUnderruns) || 0);
  engine.outputReportedAtMs = now;
  if (alreadyReported) return;
  engine.outputReportedContext = context;
  engine.outputReportedUnderruns = underruns;
  engine.diagnostics.outputUnderruns = underruns;
  sendStreamingControl({
    type: 'output-report',
    sampleRate: engine.sampleRate,
    baseLatencyMs: Math.round((Number(context.baseLatency) || 0) * 1000),
    outputLatencyMs: Math.round((Number(context.outputLatency) || 0) * 1000),
    underruns,
    underrunMs: Math.round((Number(stats?.underrunDuration) || 0) * 1000),
    statsAvailable: Boolean(stats),
  });
}

function maybePrepareStreamingSeek(roleState) {
  const engine = streamingEngineState();
  const pendingSeek = engine.pendingSeek;
  if (roleState?.role !== 'continuity'
      || roleState.continuityOptions?.kind !== 'seek'
      || pendingSeek?.generation !== roleState.generation
      || pendingSeek.streamId !== roleState.streamId
      || pendingSeek.prepareSent
      || engine.diagnostics.bufferedFrames.continuity <= 0
      || (!roleState.eosReceived
        && engine.diagnostics.bufferedFrames.continuity < roleState.targetBufferFrames)) return;
  pendingSeek.prepareSent = true;
  engine.node.port.postMessage({
    type: 'prepare-seek',
    generation: roleState.generation,
    streamId: roleState.streamId,
    timelineStartFrame: pendingSeek.startFrame,
  });
  publishStreamingDiagnostics();
}

function settlePendingStreamingCutover(error = null, roleState = null) {
  const pending = streamingEngineState().pendingSeek;
  if (typeof pending?.resolve !== 'function' && typeof pending?.reject !== 'function') return;
  const resolve = pending.resolve;
  const reject = pending.reject;
  pending.resolve = null;
  pending.reject = null;
  if (error) reject?.(error);
  else resolve?.(roleState);
}

function acceptStreamingPcm(roleState, frameCount, pcm) {
  const engine = streamingEngineState();
  const role = roleState.role;
  const capacityFrames = streamingRoleCapacityFrames(roleState);
  const sequence = roleState.nextSequence;
  let ratePosition = null;
  streamingCaptureSafely(() => { ratePosition = streamingRateEnqueuePosition(roleState, frameCount); });
  let capturePositions = null;
  streamingCaptureSafely(() => { capturePositions = consumeStreamingCapturePositions(roleState, sequence, frameCount); });
  if (roleState.captureSource) {
    const received = roleState.captureReceivedFrames + frameCount;
    if (Number.isSafeInteger(received)) roleState.captureReceivedFrames = received;
    else roleState.captureSource = null;
  }
  recordStreamingPcmEvidence(roleState, frameCount, pcm);
  roleState.nextSequence += 1;
  engine.diagnostics.inFlightFrames[role] -= frameCount;
  engine.diagnostics.bufferedFrames[role] += frameCount;
  if (role === 'current') {
    maybeResolveStreamingReplacementCushion();
    maybeGrantDeferredReplacementCredit();
    maybeSchedulePendingStreamingContinuity();
  }
  engine.node.port.postMessage({
    type: 'enqueue',
    generation: roleState.generation,
    streamId: roleState.streamId,
    role,
    sequence,
    frameCount,
    pcm,
    ...(capturePositions ? {capturePositions} : {}),
    ...(ratePosition ? {ratePosition} : {}),
  }, [pcm.buffer]);
  if (!roleState.eosReceived) {
    const targetFrames = Number(roleState.targetBufferFrames) || capacityFrames;
    const missingFrames = targetFrames
      - engine.diagnostics.bufferedFrames[role]
      - engine.diagnostics.inFlightFrames[role];
    refillStreamingRoleCredit(roleState, missingFrames);
  }
  maybeNotifyStreamingWaveformReady({ includeCommittedFrames: true });
  maybePrepareStreamingSeek(roleState);
  publishStreamingDiagnostics();
}

function sweepStreamingEncodedDecoders() {
  const engine = streamingEngineState();
  const live = [engine.roles.current?.encoded, engine.roles.continuity?.encoded];
  for (const encoded of [...(engine.encodedStreams || [])]) {
    if (live.includes(encoded) || encoded.pumping) continue;
    engine.encodedStreams.delete(encoded);
    void encoded.decoder.ready.then(() => encoded.decoder.free()).catch(() => {});
  }
}

function createStreamingEncodedRole(roleState, message) {
  const engine = streamingEngineState();
  const decoder = createStreamingDecoder(message.codec);
  const encoded = {
    codec: message.codec,
    decoder,
    ready: false,
    skipFrames: message.skipFrames,
    remainingFrames: message.totalFrames,
    deliveredFrames: 0,
    queue: [],
    queuedBytes: 0,
    creditedBytes: Number(message.initialCreditBytes) || 0,
    nextWireSequence: 0,
    lastArrivalMs: 0,
    localCreditFrames: 0,
    decodedPcm: [],
    decodedFrames: 0,
    pumping: false,
    eos: null,
    flushed: false,
    delivered: false,
  };
  engine.encodedStreams ??= new Set();
  engine.encodedStreams.add(encoded);
  roleState.encoded = encoded;
  sweepStreamingEncodedDecoders();
  decoder.ready.then(() => {
    encoded.ready = true;
    return pumpStreamingEncodedRole(roleState);
  }).catch(() => failStreamingEncodedRole(roleState, 'decoder-unavailable'));
}

function streamingEncodedBufferBytes(roleState) {
  const engine = streamingEngineState();
  const sizeBytes = Number(engine.trackFormats?.get(String(roleState.track?.path || ''))?.sizeBytes);
  const durationSeconds = Number(roleState.track?.durationSeconds);
  const bytesPerSecond = roleState.quality !== '320' && sizeBytes > 0 && durationSeconds > 0
    ? sizeBytes / durationSeconds
    : STREAMING_FALLBACK_BYTES_PER_SECOND;
  return Math.min(
    STREAMING_ENCODED_BUFFER_MAX_BYTES,
    Math.max(
      STREAMING_ENCODED_BUFFER_MIN_BYTES,
      bytesPerSecond * STREAMING_ENCODED_BUFFER_SECONDS[roleState.role],
    ),
  );
}

function refillStreamingEncodedBytes(roleState) {
  const encoded = roleState.encoded;
  if (encoded.eos || roleState.closed) return;
  // The stream being left must not compete with the audio the listener just asked for.
  if (streamingEngineState().pendingSeek?.currentStreamId === roleState.streamId) return;
  const missingBytes = streamingEncodedBufferBytes(roleState)
    - encoded.queuedBytes - encoded.creditedBytes;
  if (missingBytes < STREAMING_ENCODED_CREDIT_BYTES
      || encoded.creditedBytes >= STREAMING_ENCODED_CREDIT_BYTES) return;
  const frames = STREAMING_ENCODED_CREDIT_BYTES;
  if (sendStreamingControl({
    type: 'credit',
    generation: roleState.generation,
    streamId: roleState.streamId,
    frames,
  })) encoded.creditedBytes += frames;
}

function appendStreamingDecodedAudio(encoded, decoded) {
  const [left, right = left] = decoded.channelData;
  const skipped = Math.min(encoded.skipFrames, decoded.samplesDecoded);
  encoded.skipFrames -= skipped;
  const kept = Math.min(decoded.samplesDecoded - skipped, encoded.remainingFrames);
  if (kept <= 0) return;
  const pcm = new Float32Array(kept * 2);
  for (let frame = 0; frame < kept; frame += 1) {
    pcm[frame * 2] = left[skipped + frame];
    pcm[(frame * 2) + 1] = right[skipped + frame];
  }
  encoded.remainingFrames -= kept;
  encoded.decodedPcm.push(pcm);
  encoded.decodedFrames += kept;
}

function takeStreamingDecodedPcm(encoded, frameCount) {
  const pcm = new Float32Array(frameCount * 2);
  let written = 0;
  while (written < pcm.length) {
    const head = encoded.decodedPcm[0];
    const taken = Math.min(head.length, pcm.length - written);
    pcm.set(head.subarray(0, taken), written);
    written += taken;
    if (taken === head.length) encoded.decodedPcm.shift();
    else encoded.decodedPcm[0] = head.subarray(taken);
  }
  encoded.decodedFrames -= frameCount;
  return pcm;
}

function streamingRoleIsLive(roleState) {
  return roleState.generation === streamingEngineState().generation
    && streamingRoleForId(roleState.streamId) === roleState;
}

async function pumpStreamingEncodedRole(roleState) {
  const encoded = roleState.encoded;
  if (!encoded?.ready || encoded.pumping || !streamingRoleIsLive(roleState)) return;
  encoded.pumping = true;
  try {
    while (streamingRoleIsLive(roleState)) {
      if (encoded.localCreditFrames > 0 && encoded.decodedFrames > 0) {
        const frameCount = Math.min(encoded.localCreditFrames, encoded.decodedFrames);
        encoded.localCreditFrames -= frameCount;
        encoded.deliveredFrames += frameCount;
        acceptStreamingPcm(roleState, frameCount, takeStreamingDecodedPcm(encoded, frameCount));
      } else if ((encoded.localCreditFrames > 0 || !encoded.remainingFrames)
          && encoded.queue.length) {
        const bytes = encoded.queue.shift();
        encoded.queuedBytes -= bytes.length;
        appendStreamingDecodedAudio(encoded, await encoded.decoder.decode(bytes));
      } else if (encoded.eos && !encoded.flushed && !encoded.queue.length) {
        encoded.flushed = true;
        const flushed = await encoded.decoder.flush?.();
        if (flushed?.samplesDecoded) appendStreamingDecodedAudio(encoded, flushed);
      } else {
        break;
      }
      refillStreamingEncodedBytes(roleState);
    }
    if (streamingRoleIsLive(roleState) && encoded.eos && encoded.flushed
        && !encoded.decodedFrames && !encoded.queue.length) {
      finishStreamingEncodedRole(roleState);
    }
  } catch (_error) {
    failStreamingEncodedRole(roleState, 'decode-error');
  } finally {
    encoded.pumping = false;
    sweepStreamingEncodedDecoders();
  }
}

function finishStreamingEncodedRole(roleState) {
  const encoded = roleState.encoded;
  if (encoded.remainingFrames > 0) reportStreamingDecoderFallback('short-decode');
  const startFrame = encoded.eos.authoritativeTotalFrames - encoded.deliveredFrames
    - encoded.remainingFrames;
  const eos = {
    ...encoded.eos,
    emittedFrames: encoded.deliveredFrames,
    authoritativeTotalFrames: startFrame + encoded.deliveredFrames,
  };
  encoded.eos = null;
  encoded.delivered = true;
  handleStreamingControl(eos);
}

function reportStreamingDecoderFallback(reason) {
  const engine = streamingEngineState();
  engine.encodedCodecs = [];
  engine.diagnostics.decoderFallback = reason;
  sendStreamingControl({ type: 'decoder-fallback', reason });
}

function failStreamingEncodedRole(roleState, reason) {
  const engine = streamingEngineState();
  if (!streamingRoleIsLive(roleState)) return;
  reportStreamingDecoderFallback(reason);
  const { track, continuityOptions } = roleState;
  if (roleState.role === 'continuity' && continuityOptions?.kind !== 'seek') {
    closeStreamingContinuityRole('decoder-fallback');
    engine.pendingContinuityTrack = track;
    engine.pendingContinuityOptions = continuityOptions;
    maybeSchedulePendingStreamingContinuity();
    return;
  }
  if (!isStreamingPlaybackAttemptCurrent(engine.playbackAttempt)) return;
  const callbacks = streamingAttemptRecords.get(engine.playbackAttempt);
  const replay = startStreamingTrack(track, {
    onStartAttempt: callbacks.onStartAttempt,
    onAutoplayStarted: callbacks.onAutoplayStarted,
    startSeconds: roleState.role === 'continuity'
      ? continuityOptions.startSeconds
      : Number(engine.snapshot.currentTime) || 0,
    autoplay: !engine.snapshot.paused,
  });
  void replay.catch((error) => failStreamingEngine('decoder', error, 'decoder-fallback-error'));
}

function handleStreamingEncodedBytes(view, buffer, failProtocol) {
  const engine = streamingEngineState();
  const generation = view.getUint32(8, false);
  const streamId = view.getUint32(12, false);
  const sequence = view.getUint32(16, false);
  const byteCount = view.getUint32(20, false);
  if (byteCount <= 0 || buffer.byteLength !== 24 + byteCount) {
    failProtocol('declared byte length does not match payload');
    return;
  }
  const roleState = streamingRoleForId(streamId);
  const encoded = roleState?.encoded;
  if (!encoded || generation !== engine.generation || generation !== roleState.generation
      || sequence !== encoded.nextWireSequence) {
    engine.diagnostics.staleMessages += 1;
    return;
  }
  if (byteCount > encoded.creditedBytes) {
    failProtocol('frame exceeds granted byte credit');
    return;
  }
  const now = performance.now();
  if (encoded.lastArrivalMs) {
    engine.transferBytes = (Number(engine.transferBytes) || 0) + byteCount;
    engine.transferMs = (Number(engine.transferMs) || 0) + (now - encoded.lastArrivalMs);
    if (engine.transferBytes > STREAMING_TRANSFER_WINDOW_BYTES) {
      engine.transferBytes /= 2;
      engine.transferMs /= 2;
    }
  }
  encoded.nextWireSequence += 1;
  encoded.creditedBytes -= byteCount;
  encoded.lastArrivalMs = encoded.creditedBytes > 0 ? now : 0;
  encoded.queue.push(new Uint8Array(buffer, 24, byteCount));
  encoded.queuedBytes += byteCount;
  refillStreamingEncodedBytes(roleState);
  void pumpStreamingEncodedRole(roleState);
}

function handleStreamingPcm(buffer) {
  const engine = streamingEngineState();
  const failProtocol = (message) => failStreamingEngine(
    'socket',
    { message: `PCM protocol error: ${message}` },
    'pcm-protocol-error',
  );
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) {
      failProtocol('frame is shorter than the AHPC header');
      return;
    }
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 65 || view.getUint8(1) !== 72
        || view.getUint8(2) !== 80 || view.getUint8(3) !== 67) {
      failProtocol('bad AHPC magic');
      return;
    }
    const version = view.getUint8(4);
    if (version !== 1 && version !== 2) {
      failProtocol('unsupported AHPC version');
      return;
    }
    const roleCode = view.getUint8(5);
    if (roleCode !== 0 && roleCode !== 1) {
      failProtocol('invalid stream role');
      return;
    }
    if (view.getUint16(6, false) !== 0) {
      failProtocol('nonzero reserved flags');
      return;
    }
    if (version === 2) {
      handleStreamingEncodedBytes(view, buffer, failProtocol);
      return;
    }
    const wireRole = roleCode === 0 ? 'current' : 'continuity';
    const generation = view.getUint32(8, false);
    const streamId = view.getUint32(12, false);
    const sequence = view.getUint32(16, false);
    const frameCount = view.getUint32(20, false);
    if (frameCount <= 0 || buffer.byteLength !== 24 + (frameCount * 8)) {
      failProtocol('declared frame length does not match payload');
      return;
    }
    const roleState = streamingRoleForId(streamId);
    if (!roleState || generation !== engine.generation
        || generation !== roleState.generation
        || !streamingWireRoleAccepted(roleState, wireRole)
        || sequence !== roleState.nextSequence) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    if (!roleState.metadataAccepted) {
      failProtocol('PCM arrived before metadata');
      return;
    }
    const role = roleState.role;
    if (frameCount > engine.diagnostics.inFlightFrames[role]) {
      failProtocol('frame exceeds granted credit');
      return;
    }
    const capacityFrames = streamingRoleCapacityFrames(roleState);
    if (frameCount > capacityFrames - engine.diagnostics.bufferedFrames[role]) {
      failProtocol('frame exceeds inherited backing capacity');
      return;
    }
    const pcm = new Float32Array(frameCount * 2);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = view.getFloat32(24 + (index * 4), true);
    }
    acceptStreamingPcm(roleState, frameCount, pcm);
  } catch (error) {
    failProtocol(error?.message || 'PCM decode failed');
  }
}

function handleStreamingWorkletMessage(message) {
  const engine = streamingEngineState();
  if (!message || message.generation !== engine.generation) {
    engine.diagnostics.staleMessages += 1;
    return;
  }
  const attempt = engine.playbackAttempt, owner = attempt && streamingAttemptRecords.get(attempt);
  if (owner?.retiredOutgoing?.role === engine.roles.current && isStreamingPlaybackAttemptCurrent(attempt)
      && message.streamId === engine.roles.current?.streamId
      && ['first-frame', 'position', 'ended'].includes(message.type)) {
    engine.diagnostics.staleMessages += 1;
    return;
  }
  if (message.type === 'protocol-reject') {
    if (!streamingRoleForId(message.streamId)) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    engine.diagnostics.processorRejectCounts ??= {};
    const rejectKey = `${String(message.operation || 'unknown')}:${String(message.reason || 'unknown')}`;
    engine.diagnostics.processorRejectCounts[rejectKey]
      = (Number(engine.diagnostics.processorRejectCounts[rejectKey]) || 0) + 1;
    engine.diagnostics.lastProcessorReject = { ...message };
    publishStreamingDiagnostics();
    failStreamingEngine(
      'processor',
      {
        message: `AudioWorklet protocol rejection: ${String(message.operation || 'unknown')}`
          + ` (${String(message.reason || 'unknown')})`,
      },
      'processor-protocol-reject',
    );
    return;
  }
  if (message.type === 'seek-boundary') {
    const pendingSeek = engine.pendingSeek;
    const current = engine.roles.current;
    const continuity = engine.roles.continuity;
    const handoffAttempt = engine.playbackAttempt;
    const handoffOwner = handoffAttempt && streamingAttemptRecords.get(handoffAttempt);
    if (!pendingSeek || !current || !continuity
        || pendingSeek.generation !== message.generation
        || pendingSeek.currentStreamId !== message.outgoingStreamId
        || pendingSeek.streamId !== message.incomingStreamId
        || current.streamId !== message.outgoingStreamId
        || continuity.streamId !== message.incomingStreamId
        || !Number.isInteger(message.timelineFrame) || message.timelineFrame < 0) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    const wasPaused = engine.snapshot.paused;
    engine.diagnostics.cutoverPreparedFrames = engine.diagnostics.bufferedFrames.continuity;
    swapStreamingBackingCapacities(current, continuity);
    continuity.boundaryNotified = true;
    continuity.role = 'current';
    continuity.acceptsPromotedContinuityWireRole = true;
    continuity.renderedFrameBase = Number(message.renderedFrame) || 0;
    continuity.targetBufferFrames = streamingRoleCapacityFrames(continuity);
    continuity.seekTarget = true;
    continuity.replacementPromotion = pendingSeek.kind === 'replacement';
    streamingCaptureSafely(() => retireStreamingCapture(current, continuity));
    promoteStreamingAttempt(current, continuity, engine.pendingSeek);
    engine.roles.current = continuity;
    engine.roles.continuity = null;
    if (continuity.encoded) refillStreamingEncodedBytes(continuity);
    promoteStreamingPcmEvidence(continuity);
    engine.pcmEvidenceByStream?.delete(current.streamId);
    engine.renderedPcmEvidenceByStream?.delete(current.streamId);
    engine.diagnostics.bufferedFrames.current = engine.diagnostics.bufferedFrames.continuity;
    engine.diagnostics.inFlightFrames.current = engine.diagnostics.inFlightFrames.continuity;
    engine.diagnostics.bufferedFrames.continuity = 0;
    engine.diagnostics.inFlightFrames.continuity = 0;
    engine.deferredCreditFrames.current = engine.deferredCreditFrames.continuity;
    engine.deferredCreditFrames.continuity = 0;
    engine.diagnostics.seekCapture = message.capture || null;
    engine.diagnostics.seekSilentFrames = Number(message.silentFrames) || 0;
    engine.diagnostics.seekCommittedAtMs = performance.now();
    engine.diagnostics.firstFrameAtMs = 0;
    Object.assign(engine.snapshot, {
      currentTime: message.timelineFrame / engine.sampleRate,
      requestedStartFrame: pendingSeek.startFrame,
      timelineStartFrame: pendingSeek.startFrame,
      renderedFrame: message.renderedFrame,
      paused: wasPaused,
      ended: false,
      readyState: 4,
    });
    if (pendingSeek.kind === 'replacement') {
      engine.snapshot.duration = Number(continuity.track?.durationSeconds) || 0;
      engine.snapshot.src = String(continuity.track?.src || '');
    }
    engine.pendingSeek = null;
    engine.pendingPromotion = {
      generation: message.generation,
      streamId: continuity.streamId,
      kind: pendingSeek.kind || 'seek',
    };
    engine.node.port.postMessage({
      type: 'expect-continuity',
      generation: message.generation,
      active: Boolean(engine.pendingContinuityTrack),
    });
    refreshStreamingActiveRoles();
    const promoted = sendStreamingControl({
      type: 'promote',
      generation: message.generation,
      streamId: continuity.streamId,
      fromRole: 'continuity',
      toRole: 'current',
    });
    if (promoted && !continuity.eosReceived) {
      grantStreamingCredit(continuity, streamingRoleCapacityFrames(continuity));
    }
    if (pendingSeek.kind === 'replacement') {
      pendingSeek.resolve?.(continuity);
    }
    if (handoffOwner?.retiredOutgoing?.role === current && handoffOwner.retiredOutgoing.resume
        && isStreamingPlaybackAttemptCurrent(handoffAttempt) && engine.roles.current === continuity) {
      handoffOwner.retiredOutgoing.awaitingResume = true;
      void resumeStreamingPlayback(null, null, continuity, handoffAttempt,
        () => handoffOwner.retiredOutgoing.resume).finally(() => {
        handoffOwner.retiredOutgoing.awaitingResume = false;
      }).catch(error => {
        if (isStreamingPlaybackAttemptCurrent(handoffAttempt) && engine.roles.current === continuity) {
          failStreamingEngine('context', error, 'retired-outgoing-handoff-resume-error');
        }
      });
    }
    publishStreamingDiagnostics();
    return;
  }
  if (message.type === 'boundary') {
    const continuity = engine.roles.continuity;
    const current = engine.roles.current;
    const loopState = engine.loopContinuity;
    if (loopState?.kind === 'short-loop'
        && message.incomingStreamId === loopState.streamId
        && (message.outgoingStreamId === loopState.streamId
          || message.outgoingStreamId === current?.streamId)) {
      promoteStreamingPcmEvidence(loopState);
      engine.diagnostics.boundaryCapture = message.capture || null;
      engine.snapshot.currentTime = Math.max(
        loopState.startSeconds,
        (Number(message.timelineFrame) || 0) / engine.sampleRate,
      );
      engine.snapshot.renderedFrame = Number(message.renderedFrame) || engine.snapshot.renderedFrame;
      return;
    }
    if (!current || !continuity || message.outgoingStreamId !== current.streamId
        || message.incomingStreamId !== continuity.streamId) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    if (continuity.boundaryNotified) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    continuity.boundaryNotified = true;
    const outgoingTrackPath = String(current.track?.path || '');
    const incomingTrackPath = String(continuity.track?.path || '');
    const outgoingDuration = Number(engine.snapshot.duration)
      || Number(current.track?.durationSeconds)
      || 0;
    const renderedFrameBase = Number.isInteger(current.renderedFrameBase)
      ? current.renderedFrameBase
      : 0;
    const boundaryRenderedFrame = Number.isInteger(message.renderedFrame)
      ? message.renderedFrame
      : renderedFrameBase;
    const outgoingFrame = Math.max(
      current.startFrame,
      current.startFrame + Math.max(0, boundaryRenderedFrame - renderedFrameBase),
    );
    const outgoingPlaybackSnapshot = {
      ...engine.snapshot,
      currentTime: Math.min(
        outgoingDuration || Number.POSITIVE_INFINITY,
        outgoingFrame / engine.sampleRate,
      ),
      duration: outgoingDuration,
      src: String(current.track?.src || engine.snapshot.src || ''),
    };
    engine.diagnostics.boundaryCapture = message.capture || null;
    swapStreamingBackingCapacities(current, continuity);
    streamingCaptureSafely(() => retireStreamingCapture(current, continuity));
    promoteStreamingAttempt(current, continuity, engine.pendingSeek);
    engine.roles.current = continuity;
    engine.roles.current.role = 'current';
    engine.roles.current.targetBufferFrames = streamingRoleCapacityFrames(engine.roles.current);
    engine.roles.current.acceptsPromotedContinuityWireRole = true;
    engine.roles.current.renderedFrameBase = boundaryRenderedFrame;
    engine.roles.continuity = null;
    if (engine.roles.current.encoded) refillStreamingEncodedBytes(engine.roles.current);
    promoteStreamingPcmEvidence(continuity);
    engine.pcmEvidenceByStream?.delete(current.streamId);
    engine.renderedPcmEvidenceByStream?.delete(current.streamId);
    engine.waveformReadyIdentity = null;
    engine.diagnostics.bufferedFrames.current = engine.diagnostics.bufferedFrames.continuity;
    engine.diagnostics.inFlightFrames.current = engine.diagnostics.inFlightFrames.continuity;
    engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
    engine.deferredCreditFrames.current = engine.deferredCreditFrames.continuity;
    engine.deferredCreditFrames.continuity = 0;
    engine.diagnostics.bufferedFrames.continuity = 0;
    engine.diagnostics.inFlightFrames.continuity = 0;
    const promotedLoop = continuity.continuityOptions;
    const incomingBoundaryFrames = Number(message.capture?.incoming?.frames) || 0;
    const timelineFrame = Number.isInteger(message.timelineFrame) && message.timelineFrame >= 0
      ? message.timelineFrame
      : incomingBoundaryFrames;
    const timelineStartFrame = promotedLoop && promotedLoop.kind !== 'queued-next'
      ? streamingFrames((Number(promotedLoop.startSeconds) || 0))
      : 0;
    Object.assign(engine.snapshot, {
      currentTime: timelineFrame / engine.sampleRate,
      duration: Number(continuity.track?.durationSeconds) || 0,
      src: String(continuity.track?.src || ''),
      renderedFrame: incomingBoundaryFrames,
      timelineStartFrame,
      requestedStartFrame: timelineStartFrame,
      ended: false,
    });
    refreshStreamingActiveRoles();
    engine.pendingPromotion = {
      generation: message.generation,
      streamId: continuity.streamId,
    };
    if (promotedLoop && promotedLoop.kind !== 'queued-next') {
      engine.loopContinuity = {
        ...promotedLoop,
        streamId: continuity.streamId,
        track: continuity.track,
      };
      if (promotedLoop.kind !== 'short-loop') {
        engine.pendingContinuityTrack = continuity.track;
        engine.pendingContinuityOptions = { ...promotedLoop };
      }
    }
    sendStreamingControl({
      type: 'promote',
      generation: message.generation,
      streamId: continuity.streamId,
      fromRole: 'continuity',
      toRole: 'current',
    });
    if (typeof handleStreamingPlaybackBoundary === 'function') {
      try {
        invokeStreamingFacadeCallback(() => handleStreamingPlaybackBoundary({
          generation: message.generation,
          outgoingStreamId: message.outgoingStreamId,
          incomingStreamId: message.incomingStreamId,
          outgoingTrackPath,
          incomingTrackPath,
          outgoingPlaybackSnapshot,
          incomingListenSession: continuity.measuredListenSession || null,
          renderedFrame: message.renderedFrame,
          continuityKind: promotedLoop?.kind || 'queued-next',
        }), 'boundary-facade-error', continuity, message.generation);
      } catch (error) {
        console.error('Streaming facade reporting failed', error);
      }
    }
    return;
  }
  if (message.type === 'position') {
    const current = engine.roles.current;
    if (!current || message.streamId !== current.streamId
        || !Number.isInteger(message.timelineFrame) || message.timelineFrame < 0) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    if (engine.pendingSeek?.currentStreamId === current.streamId) return;
    const timelineFrame = streamingAbsoluteTimelineFrame(current, message.timelineFrame);
    const monotonicTimelineFrame = Math.max(
      timelineFrame,
      streamingFrames((Number(engine.snapshot.currentTime) || 0)),
    );
    engine.snapshot.currentTime = monotonicTimelineFrame / engine.sampleRate;
    reportStreamingAudioOutput();
    const observedAtMs = performance.now();
    const previousObservedAtMs = Number(engine.positionFacadeAtMs) || 0;
    if (typeof handleStreamingPlaybackPosition === 'function'
        && (!previousObservedAtMs || observedAtMs - previousObservedAtMs >= 250)) {
      engine.positionFacadeAtMs = observedAtMs;
      try {
        invokeStreamingFacadeCallback(() => handleStreamingPlaybackPosition({
          generation: message.generation,
          streamId: current.streamId,
          trackPath: String(current.track?.path || ''),
          timelineFrame: monotonicTimelineFrame,
          currentTime: engine.snapshot.currentTime,
        }), 'position-facade-error', current, message.generation);
      } catch (error) {
        console.error('Streaming facade reporting failed', error);
      }
    }
    return;
  }
  if (message.type === 'ended') {
    const current = engine.roles.current;
    if (!current || message.streamId !== current.streamId
        || !Number.isInteger(message.timelineFrame) || message.timelineFrame < 0
        || current.endedNotified) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    const intents = streamingPlaybackIntents.get(engine);
    const configured = intents?.configured, active = intents?.active;
    if (!configured || configured.node !== engine.node
        || configured.generation !== engine.generation
        || !active || active.node !== engine.node || active.generation !== engine.generation
        || !Number.isSafeInteger(active.id) || active.id <= 0
        || active.kind !== 'play' || engine.snapshot.paused) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    if (!Number.isSafeInteger(message.playbackIntentId) || message.playbackIntentId <= 0) {
      failStreamingEngine('processor', {message: 'Uncorrelated playback ended message'}, 'playback-intent-mismatch');
      return;
    }
    if (message.playbackIntentId !== active.id) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    const pendingReplacement = engine.pendingSeek;
    if (pendingReplacement?.kind === 'replacement'
        && pendingReplacement.generation === message.generation
        && pendingReplacement.currentStreamId === current.streamId
        && pendingReplacement.streamId === engine.roles.continuity?.streamId) {
      if (!engine.snapshot.paused) {
        if (!sendStreamingPlaybackIntent(engine, engine.node, engine.generation, 'play')) return;
      }
      return;
    }
    current.endedNotified = true;
    streamingCaptureSafely(() => retireStreamingCapture(current, null, 'ended'));
    const timelineFrame = streamingAbsoluteTimelineFrame(current, message.timelineFrame);
    const currentTime = timelineFrame / engine.sampleRate;
    Object.assign(engine.snapshot, {
      currentTime,
      renderedFrame: message.timelineFrame,
      paused: true,
      ended: true,
      readyState: 4,
    });
    if (engine.mode !== 'error') engine.mode = 'ended';
    if (typeof handleStreamingPlaybackEnded === 'function') {
      try {
        invokeStreamingFacadeCallback(() => handleStreamingPlaybackEnded({
          generation: message.generation,
          streamId: current.streamId,
          trackPath: String(current.track?.path || ''),
          timelineFrame,
          currentTime,
          sampleRateChangeTrackPath: engine.sampleRateChangeNext?.generation === message.generation
            ? engine.sampleRateChangeNext.path
            : '',
        }), 'ended-facade-error', current, message.generation);
      } catch (error) {
        console.error('Streaming facade reporting failed', error);
      }
    }
    return;
  }
  const roleState = streamingRoleForId(message.streamId);
  if (!roleState) {
    engine.diagnostics.staleMessages += 1;
    return;
  }
  if (message.type === 'first-frame') {
    if (roleState.firstFrameNotified) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    roleState.firstFrameNotified = true;
    if (!engine.diagnostics.firstFrameAtMs) {
      engine.diagnostics.firstFrameAtMs = performance.now();
    }
    const firstFrameCurrentTime = roleState.seekTarget
      ? (roleState.startFrame + Math.max(
          0,
          message.renderedFrame - roleState.renderedFrameBase,
        )) / engine.sampleRate
      : streamingAbsoluteTimelineFrame(roleState, message.renderedFrame)
        / engine.sampleRate;
    Object.assign(engine.snapshot, {
      startedAtContextTime: message.contextTime,
      renderedFrame: message.renderedFrame,
      currentTime: firstFrameCurrentTime,
      readyState: 4,
    });
    engine.mode = 'playing';
    if (roleState.role === 'current' && typeof handleStreamingPlaybackFirstFrame === 'function') {
      try {
        invokeStreamingFacadeCallback(() => handleStreamingPlaybackFirstFrame({
          generation: message.generation,
          streamId: message.streamId,
          trackPath: String(roleState.track?.path || ''),
          renderedFrame: message.renderedFrame,
          contextTime: message.contextTime,
        }), 'first-frame-facade-error', roleState, message.generation);
      } catch (error) {
        console.error('Streaming facade reporting failed', error);
      }
    }
    if (roleState.role === 'current' && engine.roles.current === roleState
      && engine.generation === message.generation) maybeSchedulePendingStreamingContinuity();
    return;
  }
  if (message.type === 'buffering-start') {
    if (roleState.role !== 'current' || engine.diagnostics.buffering) return;
    engine.diagnostics.buffering = true;
    engine.mode = 'buffering';
    engine.stallStartedAtMs = performance.now();
    engine.lastStallAtMs = engine.stallStartedAtMs;
    grantStreamingCredit(roleState, streamingFrames(STREAMING_MAX_CREDIT_SECONDS));
    publishStreamingDiagnostics();
    return;
  }
  if (message.type === 'buffering-end') {
    if (roleState.role !== 'current' || !engine.diagnostics.buffering) return;
    engine.diagnostics.buffering = false;
    if (!engine.snapshot.paused && engine.mode !== 'error') engine.mode = 'playing';
    sendStreamingControl({
      type: 'stall-report',
      generation: roleState.generation,
      streamId: roleState.streamId,
      durationMs: Math.max(0, Math.round(performance.now() - engine.stallStartedAtMs)),
      targetBufferFrames: Number(roleState.targetBufferFrames)
        || streamingRoleCommittedCapacityFrames(roleState),
      pageVisible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    });
    publishStreamingDiagnostics();
    return;
  }
  if (message.type === 'underrun') {
    engine.diagnostics.underruns += 1;
    if (typeof breakMeasuredListenSegment === 'function') breakMeasuredListenSegment(roleState.measuredListenSession);
    return;
  }
  if (message.type === 'consumed' && streamingWireRoleAccepted(roleState, message.role)
      && Number.isInteger(message.frames) && message.frames >= 0
      && Number.isInteger(message.bufferedFrames) && message.bufferedFrames >= 0) {
    recordStreamingRenderedPcmEvidence(roleState, message);
    if (typeof recordMeasuredStreamingFrames === 'function') {
      recordMeasuredStreamingFrames(roleState, message, engine.sampleRate);
    }
    const capacityFrames = streamingRoleCapacityFrames(roleState);
    const reconciledBufferedFrames = message.frames === 0
      ? message.bufferedFrames
      : Math.max(
        message.bufferedFrames,
        engine.diagnostics.bufferedFrames[roleState.role] - message.frames,
      );
    engine.diagnostics.bufferedFrames[roleState.role] = Math.min(
      Math.max(0, reconciledBufferedFrames),
      capacityFrames,
    );
    if (roleState.role === 'current') {
      engine.snapshot.currentTime = Math.max(
        0,
        (Number(engine.snapshot.currentTime) || 0) + (message.frames / engine.sampleRate),
      );
      const absoluteRenderedFrame = streamingFrames(engine.snapshot.currentTime);
      engine.snapshot.renderedFrame = !roleState.seekTarget && !roleState.continuityOptions
        ? Math.max(0, absoluteRenderedFrame - Math.max(0, Number(roleState.startFrame) || 0))
        : absoluteRenderedFrame;
    }
    maybeNotifyStreamingWaveformReady();
    if (roleState.role === 'current' && !roleState.eosReceived && message.frames > 0) {
      const pendingReplacement = engine.pendingSeek;
      const restoringReplacementCushion = pendingReplacement?.kind === 'replacement'
        && pendingReplacement.generation === engine.generation
        && pendingReplacement.currentStreamId === roleState.streamId;
      if (restoringReplacementCushion) {
        grantStreamingCredit(
          roleState,
          streamingFrames(STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_SECONDS),
        );
      } else {
        const targetFrames = Number(roleState.targetBufferFrames)
          || streamingRoleCommittedCapacityFrames(roleState);
        const missingFrames = Math.max(
          0,
          targetFrames
            - engine.diagnostics.bufferedFrames.current
            - engine.diagnostics.inFlightFrames.current,
        );
        refillStreamingRoleCredit(roleState, missingFrames);
      }
    }
  }
}

function knownStreamingSampleRate(track) {
  return streamingEngineState().trackSampleRates?.get(String(track?.path || '')) || 0;
}

function chooseStreamingQuality(track) {
  const engine = streamingEngineState();
  const path = String(track?.path || '');
  if (!path.toLowerCase().endsWith('.flac') || !engine.encodedCodecs?.includes('mp3')) {
    return 'original';
  }
  if (engine.roles.current?.track?.path === track?.path) {
    return engine.roles.current.quality || 'original';
  }
  if (engine.qualityPreference === 'original') return 'original';
  const transferBytes = Number(engine.transferBytes);
  const transferSeconds = Number(engine.transferMs) / 1000;
  const requiredBitsPerSecond = Number(engine.trackFormats?.get(path)?.losslessBitsPerSecond);
  if (!Number.isFinite(transferBytes) || transferBytes <= 0
      || !Number.isFinite(transferSeconds) || transferSeconds <= 0
      || !Number.isFinite(requiredBitsPerSecond) || requiredBitsPerSecond <= 0) return 'original';
  const measuredBitsPerSecond = (transferBytes * 8) / transferSeconds;
  return Number.isFinite(measuredBitsPerSecond) && measuredBitsPerSecond > 0
      && measuredBitsPerSecond < requiredBitsPerSecond
    ? '320'
    : 'original';
}

function streamingPlaybackRate(track) {
  const engine = streamingEngineState();
  const nativeRate = knownStreamingSampleRate(track);
  if (chooseStreamingQuality(track) !== '320') return nativeRate;
  return engine.trackFormats?.get(String(track?.path || ''))?.fallbackSampleRate || nativeRate;
}

function rememberStreamingTrackFormat(path, sampleRate, format) {
  const engine = streamingEngineState();
  engine.trackSampleRates ??= new Map();
  engine.trackFormats ??= new Map();
  if (engine.trackSampleRates.size >= STREAMING_MAX_KNOWN_TRACK_RATES) {
    engine.trackSampleRates.clear();
    engine.trackFormats.clear();
  }
  engine.trackSampleRates.set(path, sampleRate);
  if (format) engine.trackFormats.set(path, format);
}

function settleStreamingSampleRateProbe(requestId, sampleRate, format = null) {
  const engine = streamingEngineState();
  const probe = engine.sampleRateProbes?.get(requestId);
  if (!probe) return;
  engine.sampleRateProbes.delete(requestId);
  if (sampleRate > 0) rememberStreamingTrackFormat(probe.path, sampleRate, format);
  probe.resolve(sampleRate);
}

function requestStreamingSampleRate(track) {
  const known = knownStreamingSampleRate(track);
  if (known) return Promise.resolve(known);
  const engine = streamingEngineState();
  engine.sampleRateProbes ??= new Map();
  engine.nextSampleRateProbeId = (Number(engine.nextSampleRateProbeId) || 0) + 1;
  const requestId = engine.nextSampleRateProbeId;
  return new Promise((resolve) => {
    engine.sampleRateProbes.set(requestId, { path: String(track?.path || ''), resolve });
    if (!sendStreamingControl({ type: 'probe', requestId, path: track.path })) {
      settleStreamingSampleRateProbe(requestId, 0);
    }
  });
}

async function retireStreamingAudioGraph() {
  const engine = streamingEngineState();
  const { context, node, generation } = engine;
  const capture = streamingCaptureBridge(node);
  if (capture) streamingCaptureSafely(() => {
    if (capture.guard()) capture.owner.close('owner_closed');
    capture.detach();
  });
  engine.context = null;
  engine.node = null;
  engine.sampleRate = 0;
  const cleanupErrors = [];
  if (node) {
    try {
      node.port.postMessage({ type: 'stop', generation, reason: 'sample-rate-change' });
    } catch (error) {
      cleanupErrors.push(error);
    }
    streamingCaptureSafely(() => retireStreamingRateOwner(node));
    try {
      node.disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await context?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    const failure = new AggregateError(cleanupErrors, 'Streaming graph retirement failed');
    Object.defineProperty(failure, 'retiredGraph', {
      value: Object.freeze({context, node, generation}),
    });
    streamingUnsafeCleanupFailures.set(engine, failure);
    throw failure;
  }
}

async function prepareStreamingPlaybackEngine(sampleRate = 0) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return null;
  if (streamingUnsafeCleanupFailures.has(engine)) throw streamingUnsafeCleanupFailures.get(engine);
  const audioGraphReady = !sampleRate
    || (engine.context && engine.node && engine.sampleRate === sampleRate);
  if (audioGraphReady && engine.socket) return;
  if (engine.preparePromise) {
    await engine.preparePromise;
    return prepareStreamingPlaybackEngine(sampleRate);
  }
  const lifecycle = engine.lifecycleEpoch || 0;
  const preparationGeneration = engine.generation;
  const preparationRequest = engine.startRequestId;
  const preparationOutcome = { settled: false, published: false, physicalSafe: false, intentionalRetirement: false, cleanupErrors: [] };
  const preparation = Promise.resolve().then(async () => {
    let context = null;
    let rateOwnerUuid = null;
    let node = null;
    let socket = null;
    let openedSocket = false;
    let emptyPreparation = null;
    const captureContext = !audioGraphReady
      ? streamingCaptureSafely(() => beginStreamingCaptureContext()) : null;
    try {
      if (!audioGraphReady) {
      await retireStreamingAudioGraph();
      if ((engine.lifecycleEpoch || 0) !== lifecycle || engine.stopPromise) {
        preparationOutcome.intentionalRetirement = true;
        throw new Error('Preparation retired');
      }
      const AudioContextType = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextType({ sampleRate, latencyHint: 'playback' });
      rateOwnerUuid = streamingCaptureSafely(() => nativeStreamingCaptureEnabled() ? window.crypto.randomUUID() : null);
      if (typeof observeBrowserPlaybackAudioContext === 'function') {
        observeBrowserPlaybackAudioContext(context);
      }
      await context.audioWorklet.addModule(STREAMING_WORKLET_URL);
      node = new AudioWorkletNode(context, STREAMING_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      streamingCaptureSafely(() => prepareStreamingRateCapture(context, node, rateOwnerUuid));
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (streamingCaptureSafely(() => acceptStreamingRateCaptureMessage(node, data))) return;
        if (data?.type === 'capture-packet') {
          const bridge = streamingCaptureBridge(node);
          streamingCaptureSafely(() => { if (bridge?.guard()) bridge.owner.acceptPacket(data.buffer); });
          return;
        }
        if (engine.node === node) handleStreamingWorkletMessage(data);
      };
      node.onprocessorerror = (event) => {
        if (engine.node !== node) return;
        failStreamingEngine('processor', event, 'processor-error');
      };
      }
      socket = engine.socket;
      if (!socket) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/playback/pcm`);
      openedSocket = true;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { if (engine.socket === socket) flushStreamingControls(); };
      socket.onerror = (event) => {
        if (engine.socket !== socket) return;
        failStreamingEngine('socket', event, 'socket-error');
      };
      socket.onclose = (event) => {
        if (engine.expectedSocketClose === socket) {
          engine.expectedSocketClose = null;
          return;
        }
        if (engine.socket !== socket) return;
        const detail = [event?.code, event?.reason].filter((value) => value !== undefined && value !== '').join(' ');
        setStreamingError('socket', { message: detail || 'Playback socket closed unexpectedly' });
        const cleanup = beginStreamingCleanup('socket-closed', {
          preserveError: true,
          socketAlreadyClosed: true,
        });
        void cleanup.catch((error) => console.error('Streaming cleanup failed', error));
      };
      socket.onmessage = ({ data }) => {
        if (engine.socket !== socket) return;
        if (data instanceof ArrayBuffer) {
          handleStreamingPcm(data);
          return;
        }
        if (typeof data !== 'string') return;
        try {
          handleStreamingControl(JSON.parse(data));
        } catch (error) {
          failStreamingEngine('socket', error, 'json-protocol-error');
        }
      };
      }
      if ((engine.lifecycleEpoch || 0) !== lifecycle || engine.stopPromise) {
        preparationOutcome.intentionalRetirement = true;
        throw new Error('Preparation retired');
      }
      if (context && node) {
        engine.context = context; engine.node = node; engine.sampleRate = sampleRate;
      }
      engine.socket = socket;
      if (context && node && engine.startRequestId === preparationRequest && engine.generation === preparationGeneration
          && !engine.playbackAttempt && !engine.roles.current && !engine.roles.continuity) {
        emptyPreparation = { context, node, socket, request: preparationRequest,
          lifecycle, generation: preparationGeneration, published: false };
        streamingEmptyPreparations.set(engine, emptyPreparation);
      }
      if (context && node) {
        streamingCaptureSafely(() => prepareStreamingCapture(engine, context, node, captureContext));
        engine.backingCapacityFrames = initialStreamingBackingCapacities();
      }
      if (openedSocket) engine.pendingControls = [];
      engine.nextStreamId ??= 1;
      engine.mode = 'prepared';
      // Capture setup may reenter selection/stop; it cannot certify their resources.
      if (emptyPreparation && streamingEmptyPreparations.get(engine) === emptyPreparation) {
        emptyPreparation.published = engine.context === context && engine.node === node
          && engine.socket === socket && engine.startRequestId === preparationRequest
          && (engine.lifecycleEpoch || 0) === lifecycle && engine.generation === preparationGeneration
          && !engine.stopPromise && !engine.playbackAttempt && !engine.roles.current && !engine.roles.continuity;
      }
      Object.assign(preparationOutcome, {settled: true, published: true, context, node, socket});
    } catch (error) {
      if (streamingEmptyPreparations.get(engine) === emptyPreparation) streamingEmptyPreparations.delete(engine);
      streamingCaptureSafely(() => captureContext?.discard());
      if (openedSocket && engine.socket === socket) engine.socket = null;
      if (engine.node === node) engine.node = null;
      if (context && engine.context === context) { engine.context = null; engine.sampleRate = 0; }
      if ((engine.lifecycleEpoch || 0) === lifecycle && !engine.stopPromise) engine.mode = 'stopped';
      const cleanupErrors = [];
      if (openedSocket && socket) {
        try {
          socket.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (node) {
        try {
          node.port.postMessage({ type: 'stop', generation: preparationGeneration, reason: 'preparation-retired' });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          node.disconnect();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (context) {
        try {
          await context.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      Object.assign(preparationOutcome, {settled: true, published: false, physicalSafe: cleanupErrors.length === 0, cleanupErrors});
      if (cleanupErrors.length) streamingUnsafeCleanupFailures.set(engine, new AggregateError(cleanupErrors, 'Preparation cleanup failed'));
      if (cleanupErrors.length && error && (typeof error === 'object' || typeof error === 'function')) {
        // Diagnostic only: successor safety remains in the private outcome record.
        try { Object.defineProperty(error, 'cleanupErrors', { value: cleanupErrors.slice(), configurable: true }); }
        catch (_error) { /* Preserve frozen, primitive and accessor-backed primary rejections. */ }
      }
      if (preparationOutcome.intentionalRetirement && preparationOutcome.physicalSafe) return null;
      throw error;
    }
  });
  streamingPreparationOutcomes.set(preparation, preparationOutcome);
  engine.preparePromise = preparation;
  try {
    return await preparation;
  } finally {
    if (engine.preparePromise === preparation) engine.preparePromise = null;
  }
}

function openStreamingRole(role, track, startFrame = 0, continuityOptions = null, attempt = null) {
  const engine = streamingEngineState();
  streamingEmptyPreparations.delete(engine);
  if (engine.stopPromise) return null;
  const request=engine.startRequestId,lifecycle=engine.lifecycleEpoch;
  const roleState = {
    role,
    track,
    generation: engine.generation,
    streamId: engine.nextStreamId,
    startFrame,
    rateListeningIntent: track?.albumListeningIntent || null,
    rateSelectionRef: track?.listeningSelection?.selection_ref || null,
    renderedFrameBase: role === 'current' ? 0 : null,
    openedAtMs: 0,
    nextSequence: 0,
    metadataAccepted: false,
    continuityOptions,
    quality: chooseStreamingQuality(track),
    backingCapacityFrames: ensureStreamingBackingCapacities()[role],
  };
  if (role === 'continuity') {
    const capacityFrames = streamingRoleCapacityFrames(roleState);
    const requestedFrames = continuityOptions?.kind === 'queued-next'
      ? streamingFrames(STREAMING_QUEUED_NEXT_PREPARE_SECONDS)
      : continuityOptions?.kind === 'seek'
        ? streamingFrames(STREAMING_SEEK_PREPARE_SECONDS)
      : continuityOptions?.kind === 'short-loop'
        ? Math.max(1, (streamingFrames(continuityOptions.endSeconds) - startFrame))
        : capacityFrames;
    roleState.targetBufferFrames = Math.min(capacityFrames, requestedFrames);
    roleState.continuityIdentity = streamingContinuityIdentity(track, continuityOptions);
  }
  engine.nextStreamId += 1;
  engine.roles[role] = roleState;
  if (attempt) {
    const record = streamingAttemptRecords.get(attempt);
    if (record?.phase === 'pending') {
      record.pendingRole = engine.roles.current; record.pendingContinuity = engine.roles.continuity;
    }
    if (role === 'current') advanceStreamingAttempt(attempt, roleState);
  }
  if (role === 'current') resetStreamingPcmEvidence(roleState, { clearAll: true });
  else {
    engine.pcmEvidenceByStream ??= new Map();
    engine.pcmEvidenceByStream.set(roleState.streamId, createStreamingPcmEvidence(roleState));
  }
  engine.diagnostics.bufferedFrames[role] = 0;
  engine.diagnostics.inFlightFrames[role] = 0;
  refreshStreamingActiveRoles();
  roleState.openedAtMs = performance.now();
  const accepted = sendStreamingControl({
    type: 'open',
    generation: roleState.generation,
    streamId: roleState.streamId,
    role,
    path: track.path,
    startFrame,
    sampleRate: engine.sampleRate,
    durationSeconds: Number(track.durationSeconds) || 0,
    ...(streamingRateCaptureBridge()?.ownerUuid ? { trackingOwnerUuid: streamingRateCaptureBridge().ownerUuid } : {}),
    ...(engine.encodedCodecs?.length ? { codecs: engine.encodedCodecs } : {}),
    ...(roleState.quality === '320' ? { quality: '320' } : {}),
  });
  if (engine.startRequestId!==request || engine.lifecycleEpoch!==lifecycle || engine.roles[role]!==roleState
      || attempt && !isStreamingPlaybackAttemptCurrent(attempt)) return null;
  if (!accepted) {
    if (engine.roles[role] === roleState) engine.roles[role] = null;
    engine.diagnostics.bufferedFrames[role] = 0;
    engine.diagnostics.inFlightFrames[role] = 0;
    engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
    engine.deferredCreditFrames[role] = 0;
    refreshStreamingActiveRoles();
    return null;
  }
  return roleState;
}

function probeStreamingTrackWaveform(track) {
  if (typeof probeCachedWaveformPeaks !== 'function') return;
  try {
    const cachedWaveformProbe = probeCachedWaveformPeaks(
      String(track?.path || ''),
      streamingEngineState().generation,
    );
    if (cachedWaveformProbe && typeof cachedWaveformProbe.catch === 'function') {
      void cachedWaveformProbe.catch(() => {});
    }
  } catch (_error) {
    // Cached waveform probing is optional and must never interrupt playback.
  }
}

async function startStreamingTrack(track, {
  startSeconds = 0,
  autoplay = true,
  allowSuspendedAutoplayFallback = false,
  onAutoplayStarted = null,
  onStartAttempt = null,
} = {}) {
  const engine = streamingEngineState();
  streamingEmptyPreparations.delete(engine);
  engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  const startRequestId = engine.startRequestId;
  engine.lifecycleEpoch ??= 0;
  const attempt = registerStreamingAttempt(engine, null, track);
  Object.assign(streamingAttemptRecords.get(attempt), {onStartAttempt, onAutoplayStarted});
  try { if (typeof onStartAttempt === 'function') onStartAttempt(attempt); }
  catch (error) {
    if (isStreamingPlaybackAttemptCurrent(attempt)) {
      const stopped = stopStreamingPlayback('start-callback-error', {expectedAttempt: attempt});
      void stopped.catch(failure => console.error('Streaming cleanup failed', failure));
    }
    throw error;
  }
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  if (autoplay && track?.albumListeningIntent && typeof beginOrdinaryAlbumListening === 'function') {
    beginOrdinaryAlbumListening(track, () => isStreamingPlaybackAttemptCurrent(attempt));
    if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  }
  const activeStop = engine.stopPromise;
  if (activeStop) {
    try { await activeStop; }
    catch (error) {
      // The retiring owner still receives this rejected cleanup promise. Only
      // errors after verified physical retirement permit a successor to proceed.
      // Keep the error on this private attempt, without changing live engine
      // diagnostics, mode or Queue state from the old cleanup continuation.
      streamingAttemptRecords.get(attempt).priorCleanupError = error;
      const outcome = streamingCleanupOutcomes.get(activeStop);
      if (!outcome?.completed || outcome.physicalSafe !== true) throw error;
    }
  }
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  settleStreamingReplacementCushionWaiter(false);
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  const canPrepareReplacement = () => {
    const pendingPromotion = engine.pendingPromotion;
    const promotionAllowsReplacement = !pendingPromotion
      || (pendingPromotion.kind === 'replacement'
        && pendingPromotion.generation === engine.generation
        && pendingPromotion.streamId === engine.roles.current?.streamId
        && engine.roles.current?.firstFrameNotified === true);
    return autoplay
      && engine.roles.current
      && engine.diagnostics.firstFrameAtMs > 0
      && engine.node
      && engine.socket?.readyState === WebSocket.OPEN
      && !engine.snapshot.paused
      && promotionAllowsReplacement
      && !engine.pendingSeek;
  };
  // A switch to a track's start can open at this rate; the server refuses a wrong one.
  if (canPrepareReplacement() && !knownStreamingSampleRate(track)
      && (startSeconds > 0 || chooseStreamingQuality(track) === '320')) {
    await requestStreamingSampleRate(track);
    if (engine.startRequestId !== startRequestId) return null;
  }
  preparedReplacement: {
    if (!canPrepareReplacement()
        || (knownStreamingSampleRate(track)
          && streamingPlaybackRate(track) !== engine.sampleRate)) break preparedReplacement;
    cancelStreamingWaveformGeneration(engine.generation);
    if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
    if (engine.roles.continuity
        && !closeStreamingContinuityRole('replacement-target')) return null;
    if (engine.startRequestId !== startRequestId || engine.stopPromise) return null;
    streamingAttemptRecords.get(attempt).pendingContinuity = engine.roles.continuity;
    if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
    engine.pendingContinuityTrack = null;
    engine.pendingContinuityOptions = null;
    engine.loopContinuity = null;
    engine.waveformReadyIdentity = null;
    const replacementGeneration = engine.generation;
    const outgoingStreamId = engine.roles.current.streamId;
    if (!replacementOutgoingCushionReady(engine, engine.roles.current)) {
      const cushionReady = await waitForStreamingReplacementCushion(engine, engine.roles.current);
      if (!isStreamingPlaybackAttemptCurrent(attempt)
          || engine.generation !== replacementGeneration
          || engine.roles.current?.streamId !== outgoingStreamId
          || !engine.node
          || engine.socket?.readyState !== WebSocket.OPEN) return null;
      if (!cushionReady) break preparedReplacement;
    }
    const startFrame = streamingFrames(Math.max(0, startSeconds));
    const replacement = openStreamingRole('continuity', track, startFrame, {
      kind: 'seek', startSeconds: Math.max(0, startSeconds), endSeconds: Math.max(0, startSeconds),
    }, attempt);
    if (!replacement) return null;
    probeStreamingTrackWaveform(track);
    replacement.targetBufferFrames = Math.min(
      streamingRoleCapacityFrames(replacement),
      streamingFrames(STREAMING_REPLACEMENT_PREPARE_SECONDS),
    );
    const completion = new Promise((resolve, reject) => {
      engine.pendingSeek = {
        generation: engine.generation,
        currentStreamId: engine.roles.current.streamId,
        streamId: replacement.streamId,
        startFrame,
        prepareSent: false,
        kind: 'replacement',
        resolve,
        reject,
      };
    });
    if (!advanceStreamingAttempt(attempt, replacement, engine.pendingSeek)) return null;
    engine.node.port.postMessage({
      type: 'reserve-seek', generation: engine.generation,
      streamId: replacement.streamId, timelineStartFrame: startFrame,
    });
    return completion;
  }
  if (engine.roles.current || engine.roles.continuity) {
    cancelStreamingWaveformGeneration(engine.generation);
  }
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  engine.lifecycleEpoch ??= 0;
  const lifecycleEpoch = engine.lifecycleEpoch;
  let sampleRate = 0;
  try {
    await prepareStreamingPlaybackEngine();
    if (!isStreamingPlaybackAttemptCurrent(attempt)
        || engine.lifecycleEpoch !== lifecycleEpoch) return null;
    if (typeof ensureStreamingDecoders === 'function') await ensureStreamingDecoders();
    if (!isStreamingPlaybackAttemptCurrent(attempt)
        || engine.lifecycleEpoch !== lifecycleEpoch) return null;
    await requestStreamingSampleRate(track);
    if (!isStreamingPlaybackAttemptCurrent(attempt)
        || engine.lifecycleEpoch !== lifecycleEpoch) return null;
    sampleRate = streamingPlaybackRate(track);
    if (engine.startRequestId === startRequestId && !sampleRate) {
      throw new Error('The track sample rate could not be read');
    }
  } catch (error) {
    if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
    throw error;
  }
  if (!isStreamingPlaybackAttemptCurrent(attempt)
      || engine.lifecycleEpoch !== lifecycleEpoch) return null;
  const oldRoles = [engine.roles.current, engine.roles.continuity].filter(Boolean);
  for (const roleState of oldRoles) {
    streamingCaptureSafely(() => retireStreamingCapture(roleState));
    const accepted = sendStreamingControl({
      type: 'close',
      generation: roleState.generation,
      streamId: roleState.streamId,
      reason: 'replacement',
    });
    if (!accepted || !isStreamingPlaybackAttemptCurrent(attempt)) return null;
  }
  const previousIntents = streamingPlaybackIntents.get(engine);
  if (previousIntents) {
    previousIntents.configured = null;
    previousIntents.active = null;
  }
  engine.generation += 1;
  const attemptRecord = streamingAttemptRecords.get(attempt);
  attemptRecord.generation = engine.generation;
  engine.positionFacadeAtMs = 0;
  engine.roles.current = null;
  engine.roles.continuity = null;
  engine.pendingContinuityTrack = null;
  engine.pendingContinuityOptions = null;
  engine.pendingPromotion = null;
  const retiredCutover = engine.pendingSeek;
  engine.pendingSeek = null;
  attemptRecord.pendingRole = null; attemptRecord.pendingContinuity = null;
  engine.loopContinuity = null;
  engine.waveformReadyIdentity = null;
  engine.mode = 'starting';
  engine.diagnostics.firstFrameAtMs = 0;
  resetStreamingPcmEvidence(null, { clearAll: true });
  engine.diagnostics.bufferedFrames = { current: 0, continuity: 0 };
  engine.diagnostics.inFlightFrames = { current: 0, continuity: 0 };
  engine.deferredCreditFrames = { current: 0, continuity: 0 };
  try {
    await prepareStreamingPlaybackEngine(sampleRate);
  } catch (error) {
    if (engine.startRequestId !== startRequestId) return null;
    throw error;
  }
  if (engine.startRequestId !== startRequestId
      || engine.lifecycleEpoch !== lifecycleEpoch) return null;
  // Native-rate graph preparation publishes "prepared". This still-current
  // admitted start is not an idle preparation, including if resume rejects.
  engine.mode = 'starting';
  const startFrame = streamingFrames(Math.max(0, startSeconds));
  Object.assign(engine.snapshot, {
    currentTime: Math.max(0, startSeconds),
    duration: Number(track.durationSeconds) || 0,
    paused: true,
    ended: false,
    src: track.src || '',
    readyState: 0,
    sampleRate: engine.sampleRate,
    requestedStartFrame: startFrame,
    timelineStartFrame: startFrame,
  });
  if (retiredCutover) {
    const reject = retiredCutover.reject; retiredCutover.resolve = null; retiredCutover.reject = null;
    reject?.(new Error('Prepared track replacement was superseded'));
    if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  }
  const current = openStreamingRole('current', track, startFrame, null, attempt);
  if (!current || !advanceStreamingAttempt(attempt, current)) return null;
  probeStreamingTrackWaveform(track);
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  const configuredNode = engine.node, configuredGeneration = engine.generation;
  configuredNode.port.postMessage({
    type: 'configure',
    generation: configuredGeneration,
    sampleRate: engine.sampleRate,
    currentCapacityFrames: streamingFrames(engine.limits.currentSeconds),
    continuityCapacityFrames: streamingFrames(engine.limits.continuitySeconds),
    startupBufferFrames: streamingFrames(STREAMING_INITIAL_PLAYBACK_CUSHION_SECONDS),
  });
  if (!isStreamingPlaybackAttemptCurrent(attempt)
      || engine.node !== configuredNode || engine.generation !== configuredGeneration) return null;
  let intents = streamingPlaybackIntents.get(engine);
  if (!intents) {
    intents = {counter: 0, configured: null, active: null};
    streamingPlaybackIntents.set(engine, intents);
  }
  intents.configured = {node: configuredNode, generation: configuredGeneration};
  if (!autoplay || attemptRecord.retiredOutgoing?.resume === false) {
    if (engine.context.state !== 'suspended') {
      await engine.context.suspend();
    }
    if (!isStreamingPlaybackAttemptCurrent(attempt) || engine.roles.current !== current) return null;
    if (engine.mode !== 'error') engine.mode = 'paused';
    return current;
  }
  const autoplayContext = engine.context;
  const autoplayNode = engine.node;
  const autoplayLifecycleEpoch = engine.lifecycleEpoch;
  const autoplayGeneration = engine.generation;
  if (attemptRecord.retiredOutgoing) attemptRecord.retiredOutgoing.awaitingResume = true;
  const nativeResume = resumeStreamingPlayback(startRequestId, onAutoplayStarted, current, attempt,
    attemptRecord.retiredOutgoing ? () => attemptRecord.retiredOutgoing.resume : null);
  const resumePromise = attemptRecord.retiredOutgoing ? nativeResume.finally(() => {
    attemptRecord.retiredOutgoing.awaitingResume = false;
  }) : nativeResume;
  let resumeSettled = false;
  let fallbackRetained = false;
  let settlementTimer = null;
  const trackedResumePromise = resumePromise.then((resumed) => {
    resumeSettled = true;
    return resumed;
  });
  void trackedResumePromise.catch((error) => {
    const rejectedRestoreIsCurrent = fallbackRetained
      && engine.context === autoplayContext
      && engine.node === autoplayNode
      && engine.lifecycleEpoch === autoplayLifecycleEpoch
      && engine.generation === autoplayGeneration
      && engine.startRequestId === startRequestId
      && engine.roles.current === current
      && engine.mode === 'paused'
      && engine.snapshot.paused === true
      && autoplayContext?.state === 'suspended';
    if (rejectedRestoreIsCurrent) {
      failStreamingEngine('context', error, 'context-resume-error');
    }
  });
  if (allowSuspendedAutoplayFallback) {
    try {
      await Promise.race([
        trackedResumePromise,
        new Promise((resolve) => {
          settlementTimer = window.setTimeout(resolve, STREAMING_RESTORE_AUTOPLAY_SETTLEMENT_MS);
        }),
      ]);
    } finally {
      if (settlementTimer !== null) window.clearTimeout(settlementTimer);
    }
    if (!resumeSettled) {
      const fallbackOwnsStart = engine.startRequestId === startRequestId;
      const blockedRestoreIsCurrent = fallbackOwnsStart
        && engine.context === autoplayContext
        && engine.node === autoplayNode
        && engine.lifecycleEpoch === autoplayLifecycleEpoch
        && engine.generation === autoplayGeneration
        && engine.roles.current === current
        && engine.mode !== 'error'
        && autoplayContext?.state === 'suspended';
      if (!blockedRestoreIsCurrent) return null;
      engine.mode = 'paused';
      fallbackRetained = true;
      return current;
    }
  }
  const resumed = await trackedResumePromise;
  if (!isStreamingPlaybackAttemptCurrent(attempt)) return null;
  if (!resumed && attemptRecord.retiredOutgoing?.resume === false
      && engine.roles.current === current && engine.snapshot.paused && engine.mode !== 'error') return current;
  if (!resumed || engine.roles.current !== current) {
    const blockedRestoreIsCurrent = allowSuspendedAutoplayFallback
      && !resumed
      && engine.context === autoplayContext
      && engine.node === autoplayNode
      && engine.lifecycleEpoch === autoplayLifecycleEpoch
      && engine.generation === autoplayGeneration
      && engine.roles.current === current
      && engine.mode !== 'error'
      && autoplayContext?.state === 'suspended';
    if (!blockedRestoreIsCurrent) return null;
    engine.mode = 'paused';
    return current;
  }
  return current;
}

async function pauseStreamingPlayback() {
  const engine = streamingEngineState();
  if (engine.stopPromise || !engine.context || !engine.node) return;
  engine.pauseIntentId = (Number(engine.pauseIntentId) || 0) + 1;
  const attempt = engine.playbackAttempt, owner = attempt && streamingAttemptRecords.get(attempt);
  const retiredHandoff = owner?.retiredOutgoing && isStreamingPlaybackAttemptCurrent(attempt);
  if (retiredHandoff) owner.retiredOutgoing.resume = false;
  const context=engine.context, node=engine.node, request=engine.startRequestId;
  engine.snapshot.paused = true;
  if (!sendStreamingPlaybackIntent(engine, node, engine.generation, 'pause')) return;
  // Keep the processor available to commit an admitted replacement, but never
  // restart its playback after this explicit pause.
  if (retiredHandoff && owner.phase === 'replacement' && isStreamingPlaybackAttemptCurrent(attempt)) return;
  await context.suspend();
  if (engine.context!==context || engine.node!==node || engine.startRequestId!==request) return;
  if (engine.mode !== 'error') engine.mode = 'paused';
}

// Resume an empty browser context without acquiring any playback authority.
async function resumeEmptyStreamingPreparation(engine, pauseIntentId, isCurrent) {
  const prepared = streamingEmptyPreparations.get(engine);
  const ownsPreparation = () => prepared?.published === true
    && streamingEngineState() === engine && streamingEmptyPreparations.get(engine) === prepared
    && !streamingUnsafeCleanupFailures.has(engine) && !engine.stopPromise
    && engine.context === prepared.context && engine.node === prepared.node && engine.socket === prepared.socket
    && engine.startRequestId === prepared.request && (engine.lifecycleEpoch || 0) === prepared.lifecycle
    && engine.generation === prepared.generation && (Number(engine.pauseIntentId) || 0) === pauseIntentId
    && !engine.playbackAttempt && !engine.roles.current && !engine.roles.continuity
    && !engine.pendingSeek && !engine.pendingPromotion && !engine.pendingContinuityTrack
    && !engine.pendingContinuityOptions && !engine.replacementCushionWaiter
    && !engine.pendingControls?.length && engine.snapshot.paused === true
    && (engine.mode === 'prepared' || engine.mode === 'paused') && prepared.context.state !== 'closed';
  if (!ownsPreparation()) return false;
  if (typeof isCurrent === 'function' && !isCurrent()) return false;
  if (!ownsPreparation()) return false;
  try {
    // Invoke before the first await so the caller's user gesture remains live.
    await prepared.context.resume();
  } catch (error) {
    if (!ownsPreparation()) return false;
    throw error;
  }
  if (!ownsPreparation()) return false;
  if (typeof isCurrent === 'function' && !isCurrent()) return false;
  if (!ownsPreparation() || prepared.context.state !== 'running') return false;
  // An unconfigured processor ignores play; later configure resets it to paused.
  try {
    prepared.node.port.postMessage({ type: 'play', generation: prepared.generation });
  } catch (error) {
    if (!ownsPreparation()) return false;
    throw error;
  }
  return ownsPreparation();
}

async function resumeStreamingPlayback(
  expectedStartRequestId = null,
  onPlaybackStarted = null,
  expectedCurrentRole = null,
  expectedAttempt = null,
  isCurrent = null,
) {
  const engine = streamingEngineState();
  const pauseIntentId = Number(engine.pauseIntentId) || 0;
  if (!engine.roles.current) {
    if (expectedStartRequestId !== null || onPlaybackStarted !== null
        || expectedCurrentRole !== null || expectedAttempt !== null) return false;
    return resumeEmptyStreamingPreparation(engine, pauseIntentId, isCurrent);
  }
  if (typeof isCurrent === 'function' && !isCurrent()) return false;
  if (engine.stopPromise || !engine.roles.current) return false;
  const attempt = expectedAttempt || captureStreamingPlaybackAttempt();
  const ownsResume = () => (Number(engine.pauseIntentId) || 0) === pauseIntentId
    && isStreamingPlaybackAttemptCurrent(attempt);
  if (!ownsResume()) return false;
  expectedCurrentRole ||= engine.roles.current;
  if (expectedCurrentRole.track?.albumListeningIntent && typeof beginOrdinaryAlbumListening === 'function') {
    beginOrdinaryAlbumListening(expectedCurrentRole.track, () => ownsResume()
      && engine.roles.current === expectedCurrentRole && (typeof isCurrent !== 'function' || isCurrent() === true));
    if (!ownsResume()) return false;
  }
  if (!engine.context || !engine.node) return false;
  const context = engine.context;
  const node = engine.node;
  const lifecycleEpoch = engine.lifecycleEpoch;
  const generation = engine.generation;
  try {
    await context.resume();
  } catch (error) {
    if ((Number(engine.pauseIntentId) || 0) !== pauseIntentId) return false;
    throw error;
  }
  if (typeof isCurrent === 'function' && !isCurrent()) return false;
  if (!ownsResume() || engine.context !== context || engine.node !== node
      || engine.lifecycleEpoch !== lifecycleEpoch || engine.generation !== generation
      || context.state !== 'running'
      || (expectedStartRequestId !== null
        && engine.startRequestId !== expectedStartRequestId)
      || (expectedCurrentRole !== null
        && (engine.roles.current !== expectedCurrentRole || engine.mode === 'error'))) {
    return false;
  }
  if (engine.snapshot.paused === false) return true;
  if (!sendStreamingPlaybackIntent(engine, node, generation, 'play')) return false;
  if (typeof isCurrent === 'function' && !isCurrent()) return false;
  if (!ownsResume()) return false;
  engine.snapshot.paused = false;
  maybeGrantDeferredReplacementCredit();
  if (!ownsResume()) return false;
  maybeSchedulePendingStreamingContinuity();
  if (!ownsResume()) return false;
  engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
  for (const role of ['current', 'continuity']) {
    const roleState = engine.roles[role];
    const deferredFrames = engine.deferredCreditFrames[role];
    engine.deferredCreditFrames[role] = 0;
    if (!roleState || deferredFrames <= 0) continue;
    const grantedFrames = grantStreamingCredit(roleState, deferredFrames);
    if (!ownsResume()) return false;
    engine.deferredCreditFrames[role] = deferredFrames - grantedFrames;
  }
  if (engine.mode !== 'error' && engine.roles.current) engine.mode = 'starting';
  if (typeof onPlaybackStarted === 'function') onPlaybackStarted();
  return ownsResume();
}
async function seekStreamingPlayback(seconds) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return null;
  engine.diagnostics.seekRequestedAtMs = performance.now();
  const currentTrack = engine.roles.current?.track;
  if (!currentTrack || !engine.node) return;
  const current = engine.roles.current,request=engine.startRequestId,lifecycle=engine.lifecycleEpoch,generation=engine.generation;
  const owns=()=>!engine.stopPromise&&engine.roles.current===current&&engine.startRequestId===request
    &&engine.lifecycleEpoch===lifecycle&&engine.generation===generation;
  if (!current) return null;
  if (engine.pendingPromotion) {
    const pendingPromotion = engine.pendingPromotion;
    if (pendingPromotion.generation === engine.generation
        && pendingPromotion.streamId === current.streamId
        && current.boundaryNotified === true) {
      pendingPromotion.requestedSeekSeconds = Math.max(0, Number(seconds) || 0);
    }
    return null;
  }
  cancelStreamingWaveformGeneration(engine.generation);
  if (!owns()) return null;
  const staleContinuity = engine.roles.continuity;
  const pendingQueuedOptions = engine.pendingContinuityOptions?.kind === 'queued-next'
    ? engine.pendingContinuityOptions
    : null;
  const activeQueuedOptions = staleContinuity?.continuityOptions?.kind === 'queued-next'
    ? staleContinuity.continuityOptions
    : null;
  const queuedTrack = pendingQueuedOptions
    ? engine.pendingContinuityTrack
    : activeQueuedOptions
      ? staleContinuity.track
      : null;
  const queuedOptions = (pendingQueuedOptions || activeQueuedOptions)
    ? { ...(pendingQueuedOptions || activeQueuedOptions) }
    : null;
  if (staleContinuity) {
    const accepted = sendStreamingControl({
      type: 'close',
      generation: staleContinuity.generation,
      streamId: staleContinuity.streamId,
      reason: 'seek-replaced',
    });
    if (!accepted || !owns()) return null;
    engine.node.port.postMessage({
      type: 'drop-continuity',
      generation: staleContinuity.generation,
      streamId: staleContinuity.streamId,
    });
    if (!owns() || engine.roles.continuity!==staleContinuity) return null;
    streamingCaptureSafely(() => retireStreamingCapture(staleContinuity, engine.roles.current));
    engine.roles.continuity = null;
    engine.diagnostics.bufferedFrames.continuity = 0;
    engine.diagnostics.inFlightFrames.continuity = 0;
    engine.deferredCreditFrames.continuity = 0;
    refreshStreamingActiveRoles();
  }
  engine.positionFacadeAtMs = 0;
  engine.pendingContinuityTrack = queuedTrack;
  engine.pendingContinuityOptions = queuedOptions;
  engine.loopContinuity = null;
  engine.waveformReadyIdentity = null;
  const startSeconds = Math.max(0, Number(seconds) || 0);
  const startFrame = streamingFrames(startSeconds);
  const replacement = openStreamingRole('continuity', currentTrack, startFrame, {
    kind: 'seek', startSeconds, endSeconds: startSeconds,
  });
  if (!replacement || !owns()) return null;
  engine.pendingSeek = {
    generation: engine.generation,
    currentStreamId: current.streamId,
    streamId: replacement.streamId,
    startFrame,
    prepareSent: false,
  };
  engine.node.port.postMessage({
    type: 'reserve-seek',
    generation: engine.generation,
    streamId: replacement.streamId,
    timelineStartFrame: startFrame,
  });
  if (!owns()) return null;
  engine.diagnostics.seekCapture = null;
  engine.diagnostics.seekSilentFrames = null;
  engine.diagnostics.seekCommittedAtMs = 0;
  engine.snapshot.requestedStartFrame = startFrame;
  engine.snapshot.currentTime = startSeconds;
  publishStreamingDiagnostics();
  return replacement;
}

async function scheduleStreamingContinuity(track, options = {}) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return null;
  if (!engine.roles.current) return null;
  const current=engine.roles.current,request=engine.startRequestId,lifecycle=engine.lifecycleEpoch;
  const intentCurrent=()=>{try{return typeof options.isCurrent!=='function'||options.isCurrent()===true;}catch{return false;}};
  const owns=()=>!engine.stopPromise&&engine.roles.current===current&&engine.startRequestId===request&&engine.lifecycleEpoch===lifecycle&&intentCurrent();
  if (!owns()) return null;
  const normalized = normalizeStreamingContinuityOptions(options);
  if (normalized.kind === 'queued-next') {
    // Most albums share one rate, so an unknown track is opened at this rate and
    // the server refuses it if wrong. Only a 320 kbps stream needs its rate first.
    if (!knownStreamingSampleRate(track) && chooseStreamingQuality(track) === '320') {
      return await requestStreamingSampleRate(track)
        ? scheduleStreamingContinuity(track, normalized)
        : null;
    }
    if (knownStreamingSampleRate(track) && streamingPlaybackRate(track) !== engine.sampleRate) {
      leaveStreamingTrackForRateChange(track);
      return null;
    }
  }
  const identity = streamingContinuityIdentity(track, normalized);
  if (engine.roles.continuity?.continuityIdentity === identity) {
    return engine.roles.continuity;
  }
  if (engine.pendingPromotion) {
    engine.pendingContinuityTrack = track;
    engine.pendingContinuityOptions = normalized;
    return null;
  }
  if (!protectedQueuedContinuityReady(engine, engine.roles.current, normalized)) {
    engine.pendingContinuityTrack = track;
    engine.pendingContinuityOptions = normalized;
    return null;
  }
  if (!engine.diagnostics.firstFrameAtMs
      && engine.roles.current?.boundaryNotified !== true) {
    engine.pendingContinuityTrack = track;
    engine.pendingContinuityOptions = normalized;
    return null;
  }
  if (engine.roles.continuity
      && normalized.kind === 'queued-next'
      && engine.roles.continuity.continuityOptions?.kind === 'queued-next') {
    engine.pendingContinuityTrack = track;
    engine.pendingContinuityOptions = normalized;
    return null;
  }
  if (engine.roles.continuity && !closeStreamingContinuityRole('continuity-replaced')) {
    return null;
  }
  if (!owns()) return null;
  if (track?.albumListeningIntent && typeof beginOrdinaryAlbumListening === 'function') {
    const queue = typeof state !== 'undefined' ? state.player?.playbackQueue : null;
    const sourceCurrent = () => owns() && (typeof state === 'undefined' || state.player?.playbackQueue === queue);
    beginOrdinaryAlbumListening(track, sourceCurrent);
    if (!sourceCurrent()) return null;
  }
  const startFrame = streamingFrames(normalized.startSeconds);
  const continuity = openStreamingRole('continuity', track, startFrame, normalized);
  if (!continuity || !owns()) return null;
  if (normalized.kind === 'queued-next') {
    engine.node.port.postMessage({
      type: 'expect-continuity',
      generation: engine.generation,
      active: true,
    });
  }
  if (!owns()) return null;
  if (normalized.kind !== 'queued-next') {
    engine.loopContinuity = {
      ...normalized,
      streamId: continuity.streamId,
      track,
    };
    engine.node.port.postMessage({
      type: 'set-loop',
      generation: engine.generation,
      active: true,
      kind: normalized.kind,
      startFrame,
      endFrame: streamingFrames(normalized.endSeconds),
      retainedStreamId: continuity.streamId,
    });
  }
  return owns() ? continuity : null;
}

function setStreamingLoop(active, startSeconds = 0, endSeconds = 0) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return false;
  if (!engine.node) return;
  const loop = engine.loopContinuity;
  const continuity = engine.roles.continuity;
  const message = {
    type: 'set-loop',
    generation: engine.generation,
    active: Boolean(active),
  };
  if (!active && loop) {
    message.kind = loop.kind;
    message.startFrame = streamingFrames(Math.max(0, startSeconds));
    message.endFrame = streamingFrames(Math.max(0, endSeconds));
    message.retainedStreamId = loop.streamId;
    if (continuity?.streamId === loop.streamId) {
      if (!closeStreamingContinuityRole('loop-disabled', { releaseWorklet: false })) return false;
    }
    engine.loopContinuity = null;
    engine.pendingContinuityTrack = null;
    engine.pendingContinuityOptions = null;
  } else if (active && continuity) {
    message.kind = loop?.kind || continuity.continuityOptions?.kind || 'long-loop';
    message.startFrame = streamingFrames(Math.max(0, startSeconds));
    message.endFrame = streamingFrames(Math.max(0, endSeconds));
    message.retainedStreamId = continuity.streamId;
  }
  engine.node.port.postMessage(message);
  return true;
}

// Cleanup owns a detached snapshot. No callback below may target current slots.
async function cleanupStreamingResources(record) {
  const {reason, roles, node, socket, context, generation, preparation, options} = record;
  for (const role of roles) role.captureSource = null;
  const capture = streamingCaptureBridge(node);
  if (capture) {
    capture.generation = generation;
    streamingCaptureSafely(() => {
      if (capture.guard()) capture.owner.close('owner_closed');
      capture.detach();
    });
  }
  const errors = [];
  let physicalFailure = false;
  const invoke = (callback, physical = false) => { try { callback(); } catch (error) {
    errors.push(error); if (physical) physicalFailure = true;
  } };
  if (socket && !options.socketAlreadyClosed) invoke(() => {
    if (socket.readyState === WebSocket.OPEN) {
      for (const role of roles) invoke(() => socket.send(JSON.stringify({type:'close',
        generation:role.generation, streamId:role.streamId, reason})), true);
    }
  }, true);
  if (node) {
    invoke(() => node.port.postMessage({type:'stop', generation, reason}), true);
    streamingCaptureSafely(() => retireStreamingRateOwner(node));
    invoke(() => node.disconnect(), true);
  }
  if (socket && !options.socketAlreadyClosed) invoke(() => socket.close(), true);
  if (record.waveform) invoke(() => cancelStreamingWaveformGeneration(generation));
  if (record.waiter) {
    if (record.waiter.timeoutId) invoke(() => window.clearTimeout(record.waiter.timeoutId));
    invoke(() => record.waiter.resolve(false));
  }
  if (record.cutover) {
    const reject = record.cutover.reject;
    record.cutover.resolve = null; record.cutover.reject = null;
    if (reject) invoke(() => reject(new Error(`Prepared track replacement stopped: ${reason}`)));
  }
  if (record.queueDispatch) invoke(record.queueDispatch);
  if (context) { try {
    await context.close();
    streamingCaptureSafely(() => capture?.owner.onContextState('closed'));
  } catch (error) { errors.push(error); physicalFailure = true; } }
  if (preparation) {
    let rejected = false, preparationError;
    try { await preparation; } catch (error) { rejected = true; preparationError = error; }
    const outcome = streamingPreparationOutcomes.get(preparation);
    const retiredSafely = outcome?.settled === true && outcome.published === false && outcome.physicalSafe === true;
    const publishedCaptured = outcome?.settled === true && outcome.published === true
      && outcome.context === context && outcome.node === node && outcome.socket === socket;
    if (!retiredSafely && !publishedCaptured) {
      physicalFailure = true;
      errors.push(new Error('Preparation physical retirement was not established'));
    }
    if (outcome?.cleanupErrors?.length) errors.push(...outcome.cleanupErrors);
    if (rejected && outcome?.intentionalRetirement !== true) errors.push(preparationError);
  }
  // Only this owned result records positive physical completion. Arbitrary
  // thrown values, properties and getters never determine successor safety.
  record.outcome.completed = true;
  record.outcome.physicalSafe = !physicalFailure;
  if (errors.length) throw new AggregateError(errors, 'Streaming cleanup failed');
  return true;
}

function beginStreamingCleanup(reason, options = {}) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return engine.stopPromise;
  return stopStreamingPlayback(reason, {...options, notifyQueue:false});
}
function stopStreamingPlayback(reason = 'stopped', options = {}) {
  const engine = streamingEngineState();
  const conditional = Object.prototype.hasOwnProperty.call(options, 'expectedAttempt');
  const expected = conditional ? options.expectedAttempt : engine.playbackAttempt;
  const expectedRecord = expected && streamingAttemptRecords.get(expected);
  if (conditional && expectedRecord?.retired && expectedRecord.cleanup && engine.stopPromise === expectedRecord.cleanup) return expectedRecord.cleanup;
  if (conditional && !isStreamingPlaybackAttemptCurrent(expected)) return Promise.resolve(false);
  // Scope reads may dispatch callbacks; capture before the callback-free commit,
  // then validate both engine and Queue ownership again.
  const request = engine.startRequestId, lifecycle = engine.lifecycleEpoch || 0;
  const queue = options.notifyQueue !== false && typeof ExplicitQueueRuntime !== 'undefined'
    ? ExplicitQueueRuntime.captureStop() : null;
  if (engine.startRequestId !== request || (engine.lifecycleEpoch || 0) !== lifecycle
      || conditional && !isStreamingPlaybackAttemptCurrent(expected)
      || queue && !ExplicitQueueRuntime.isStopCurrent(queue)) return Promise.resolve(false);
  const previous = engine.stopPromise;
  if (previous && !engine.playbackAttempt) return previous;
  const attempt = engine.playbackAttempt, owner = attempt && streamingAttemptRecords.get(attempt);
  if (owner) owner.retired = true;
  engine.playbackAttempt = null;
  engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  // A pending successor can be retired without adopting the old cleanup's resources.
  if (previous) {
    const dispatch = queue ? ExplicitQueueRuntime.commitStop(queue) : null;
    if (dispatch) dispatch();
    return Promise.resolve(true);
  }
  streamingEmptyPreparations.delete(engine);
  engine.lifecycleEpoch = lifecycle + 1;
  let resolveCleanup, rejectCleanup;
  const cleanup = new Promise((resolve,reject) => {resolveCleanup=resolve;rejectCleanup=reject;});
  const outcome = {completed: false, physicalSafe: false};
  streamingCleanupOutcomes.set(cleanup, outcome);
  const record = {reason, options, outcome, generation:engine.generation,
    roles:[engine.roles.current,engine.roles.continuity].filter(Boolean),
    node:engine.node, socket:engine.socket, context:engine.context,
    preparation:engine.preparePromise, waiter:engine.replacementCushionWaiter,
    cutover:engine.pendingSeek, waveform:Boolean(engine.roles.current || engine.roles.continuity || engine.waveformReadyIdentity)};
  engine.stopPromise = cleanup;
  const intents = streamingPlaybackIntents.get(engine);
  if (intents) {
    intents.configured = null;
    intents.active = null;
  }
  if (owner) owner.cleanup = cleanup;
  engine.context = null; engine.node = null; engine.socket = null;
  engine.sampleRate = 0;
  engine.roles.current = null; engine.roles.continuity = null;
  engine.pendingContinuityTrack = null; engine.pendingContinuityOptions = null;
  engine.pendingPromotion = null; engine.pendingSeek = null;
  engine.replacementCushionWaiter = null; engine.loopContinuity = null;
  engine.waveformReadyIdentity = null; engine.pendingControls = [];
  engine.deferredCreditFrames = {current:0,continuity:0};
  if (!options.preserveError) {engine.mode='stopped';delete engine.diagnostics.lastError;}
  engine.diagnostics.firstFrameAtMs = 0;
  resetStreamingPcmEvidence(null, {clearAll:true});
  engine.diagnostics.bufferedFrames = {current:0,continuity:0};
  engine.diagnostics.inFlightFrames = {current:0,continuity:0};
  engine.diagnostics.activeRoles = [];
  Object.assign(engine.snapshot,{currentTime:0,duration:0,paused:true,ended:false,src:'',readyState:0});
  for (const requestId of [...(engine.sampleRateProbes?.keys() || [])]) {
    settleStreamingSampleRateProbe(requestId, 0);
  }
  sweepStreamingEncodedDecoders();
  record.queueDispatch = queue ? ExplicitQueueRuntime.commitStop(queue) : null;
  const finish = (fulfilled, error) => {
    // Unknown/escaped/falsy rejections remain failures. Only our private record
    // can establish that all detached physical resources retired successfully.
    const physicallySafe = outcome.completed === true && outcome.physicalSafe === true;
    if (!physicallySafe) streamingUnsafeCleanupFailures.set(engine,
      new AggregateError(fulfilled ? [] : [error], 'Streaming physical cleanup is unresolved'));
    if (engine.stopPromise === cleanup) engine.stopPromise = null;
    if (fulfilled && physicallySafe) resolveCleanup(true);
    else if (!fulfilled) rejectCleanup(error);
    else rejectCleanup(streamingUnsafeCleanupFailures.get(engine));
  };
  // The latch and all detachments are installed before physical effects.
  void cleanupStreamingResources(record).then(() => finish(true), error => finish(false, error));
  return cleanup;
}
function getStreamingPlaybackSnapshot() {
  const engine = streamingEngineState();
  return {
    ...engine.snapshot,
    mode: engine.mode,
    generation: engine.generation,
    diagnostics: {
      ...engine.diagnostics,
      bufferedFrames: { ...engine.diagnostics.bufferedFrames },
      inFlightFrames: { ...engine.diagnostics.inFlightFrames },
      activeRoles: [...engine.diagnostics.activeRoles],
      pcmEvidence: engine.diagnostics.pcmEvidence ? {
        ...engine.diagnostics.pcmEvidence,
        samples: [...engine.diagnostics.pcmEvidence.samples],
      } : null,
      renderedPcmEvidence: engine.diagnostics.renderedPcmEvidence ? {
        ...engine.diagnostics.renderedPcmEvidence,
        samples: [...engine.diagnostics.renderedPcmEvidence.samples],
      } : null,
      roleOpenedAtMs: {
        current: Number(engine.roles.current?.openedAtMs || 0),
        continuity: Number(engine.roles.continuity?.openedAtMs || 0),
      },
      pendingSeek: engine.pendingSeek ? {
        generation: engine.pendingSeek.generation,
        currentStreamId: engine.pendingSeek.currentStreamId,
        streamId: engine.pendingSeek.streamId,
        startFrame: engine.pendingSeek.startFrame,
        prepareSent: Boolean(engine.pendingSeek.prepareSent),
        kind: String(engine.pendingSeek.kind || 'seek'),
      } : null,
      currentStreamId: engine.roles.current?.streamId || null,
      continuityStreamId: engine.roles.continuity?.streamId || null,
      currentSequence: engine.roles.current?.nextSequence || 0,
      continuitySequence: engine.roles.continuity?.nextSequence || 0,
      continuityMetadataAccepted: Boolean(engine.roles.continuity?.metadataAccepted),
      currentEosReceived: Boolean(engine.roles.current?.eosReceived),
      continuityEosReceived: Boolean(engine.roles.continuity?.eosReceived),
      continuityTargetBufferFrames: Number(engine.roles.continuity?.targetBufferFrames || 0),
      contextState: String(engine.context?.state || ''),
    },
  };
}

Object.defineProperty(window, '__ALBUM_HAVEN_STREAMING_DIAGNOSTICS__', {
  configurable: true,
  get: getStreamingPlaybackSnapshot,
});
