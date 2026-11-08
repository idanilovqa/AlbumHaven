const STREAMING_RUNTIME_ASSET_VERSION = encodeURIComponent(
  String(window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ || ''),
);
const STREAMING_WORKLET_URL = '/static/js/audio-worklets/gapless-playback-processor.js'
  + (STREAMING_RUNTIME_ASSET_VERSION ? `?v=${STREAMING_RUNTIME_ASSET_VERSION}` : '');
const STREAMING_PROCESSOR_NAME = 'album-haven-gapless-playback';
const STREAMING_MAX_CREDIT_SECONDS = 1;
const STREAMING_CREDIT_LOW_WATER_SECONDS = 0.25;
const STREAMING_INITIAL_PLAYBACK_CUSHION_SECONDS = 2;
const STREAMING_AUTOMATIC_RECONNECT_ATTEMPTS = 1;
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
const STREAMING_RECENT_STALL_MS = 60_000;
const STREAMING_REQUIRED_HEADROOM = 1.5;
const STREAMING_TRANSFER_WINDOW_BYTES = 32 * 1024 * 1024;
const STREAMING_OUTPUT_REPORT_INTERVAL_MS = 5000;

function streamingEngineState() {
  return state.player.streaming;
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

async function performInterruptedStreamingPlaybackRecovery(expectedContext) {
  const engine = streamingEngineState();
  const context = engine.context;
  const current = engine.roles.current;
  if (!context || !current) return 'inactive';
  if (expectedContext && context !== expectedContext) return 'stale';
  if (engine.snapshot.paused || engine.snapshot.ended) return 'paused';
  if (context.state === 'running') return 'continued';
  if (context.state !== 'suspended' && context.state !== 'interrupted') return 'failed';

  const generation = engine.generation;
  const streamId = current.streamId;
  const startRequestId = engine.startRequestId;
  let resumed = false;
  try {
    resumed = await resumeStreamingPlayback(startRequestId, null, current);
  } catch (_error) {
    resumed = false;
  }
  if (engine.context !== context
      || engine.generation !== generation
      || engine.roles.current?.streamId !== streamId
      || engine.startRequestId !== startRequestId) return 'stale';
  if (resumed && context.state === 'running') {
    publishStreamingDiagnostics();
    return 'resumed';
  }
  if (context.state !== 'suspended' && context.state !== 'interrupted') return 'failed';

  engine.snapshot.paused = true;
  if (engine.mode !== 'error') engine.mode = 'paused';
  engine.node?.port?.postMessage?.({ type: 'pause', generation });
  publishStreamingDiagnostics();
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
  return 'gesture-required';
}

function reconcileInterruptedStreamingPlayback(expectedContext = null) {
  const engine = streamingEngineState();
  if (engine.interruptionRecoveryPromise) return engine.interruptionRecoveryPromise;
  const recovery = performInterruptedStreamingPlaybackRecovery(expectedContext);
  const trackedRecovery = recovery.finally(() => {
    if (engine.interruptionRecoveryPromise === trackedRecovery) {
      engine.interruptionRecoveryPromise = null;
    }
  });
  engine.interruptionRecoveryPromise = trackedRecovery;
  return trackedRecovery;
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

function failBrowserStreaming(source, event, reason) {
  setStreamingError(source, event);
  const cleanup = beginStreamingCleanup(reason, { preserveError: true });
  void cleanup.catch((error) => console.error('Streaming cleanup failed', error));
}

function refreshPlayerAfterStreamingTransportChange() {
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}

async function recoverUnexpectedStreamingSocketClose(socket, event) {
  const engine = streamingEngineState();
  if (engine.socket !== socket) return;
  const current = engine.roles.current;
  const startRequestId = engine.startRequestId;
  const recovery = current ? {
    track: current.track,
    startSeconds: Math.max(0, Number(engine.snapshot.currentTime) || 0),
    attempt: Math.max(0, Number(current.transportRecoveryAttempt) || 0),
  } : null;
  const wasPlaying = Boolean(current && !engine.snapshot.paused && !engine.snapshot.ended);
  const detail = [event?.code, event?.reason]
    .filter((value) => value !== undefined && value !== '')
    .join(' ');
  setStreamingError('socket', { message: detail || 'Playback socket closed unexpectedly' });

  let cleanupError = null;
  try {
    await beginStreamingCleanup('socket-closed', {
      preserveError: true,
      socketAlreadyClosed: true,
    });
  } catch (error) {
    cleanupError = error;
    engine.diagnostics.lastCleanupError = {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    };
  }

  if (!recovery || engine.startRequestId !== startRequestId) {
    refreshPlayerAfterStreamingTransportChange();
    return;
  }
  engine.pendingTransportRecovery = recovery;
  Object.assign(engine.snapshot, {
    currentTime: recovery.startSeconds,
    duration: Number(recovery.track?.durationSeconds) || 0,
    paused: true,
    ended: false,
    src: String(recovery.track?.src || ''),
    readyState: 0,
  });
  if (cleanupError
      || !wasPlaying
      || recovery.attempt >= STREAMING_AUTOMATIC_RECONNECT_ATTEMPTS) {
    engine.mode = 'error';
    refreshPlayerAfterStreamingTransportChange();
    return;
  }

  engine.pendingTransportRecovery = null;
  delete engine.diagnostics.lastError;
  try {
    const recovered = await startStreamingTrack(recovery.track, {
      startSeconds: recovery.startSeconds,
      autoplay: true,
      transportRecoveryAttempt: recovery.attempt + 1,
    });
    if (recovered) {
      engine.diagnostics.transportReconnects =
        (Number(engine.diagnostics.transportReconnects) || 0) + 1;
    }
  } catch (error) {
    engine.pendingTransportRecovery = recovery;
    setStreamingError('socket', error);
    engine.snapshot.paused = true;
  }
  refreshPlayerAfterStreamingTransportChange();
}

function observeStreamingFacadeCallback(result, source) {
  if (!result || typeof result.then !== 'function') return;
  void result.catch((error) => {
    failStreamingEngine('facade', error, source);
  });
}

function normalizeStreamingContinuityOptions(options = {}) {
  const kind = ['queued-next', 'short-loop', 'long-loop', 'whole-track-repeat', 'seek']
    .includes(options.kind) ? options.kind : 'queued-next';
  const startSeconds = Math.max(0, Number(options.startSeconds) || 0);
  const endSeconds = Math.max(startSeconds, Number(options.endSeconds) || 0);
  return { kind, startSeconds, endSeconds };
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
  const currentAudible = current?.firstFrameNotified === true
    || (current?.seekTarget !== true && current?.boundaryNotified === true);
  return (current?.replacementPromotion !== true || !engine.pendingPromotion)
    && currentAudible
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
  const continuity = engine.roles.continuity;
  if (!continuity) return true;
  const accepted = sendStreamingControl({
    type: 'close',
    generation: continuity.generation,
    streamId: continuity.streamId,
    reason,
  });
  if (!accepted) return false;
  const options = continuity.continuityOptions;
  if (releaseWorklet && engine.node) {
    if (options?.kind === 'queued-next') {
      engine.node.port.postMessage({
        type: 'drop-continuity',
        generation: continuity.generation,
        streamId: continuity.streamId,
      });
      engine.node.port.postMessage({
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
  if (engine.snapshot.paused) {
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
    });
    return;
  }
  const roleState = streamingRoleForId(message.streamId);
  if (!roleState || message.generation !== engine.generation) {
    engine.diagnostics.staleMessages += 1;
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
    engine.roles.continuity = null;
    engine.pendingSeek = null;
    refreshStreamingActiveRoles();
    startStreamingTrack(roleState.track, { startSeconds: roleState.continuityOptions.startSeconds })
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

function bufferedSeekKey({ generation, requestId, streamId, currentStreamId, timelineFrame, startFrame }) {
  return [
    Number(generation),
    Number(requestId),
    Number(streamId ?? currentStreamId),
    Number(timelineFrame ?? startFrame),
  ].join(':');
}

function findBufferedSeekForMessage(message) {
  const engine = streamingEngineState();
  const pending = engine.pendingBufferedSeek;
  if (pending && bufferedSeekKey(pending) === bufferedSeekKey(message)) {
    return { pending, active: true };
  }
  const superseded = engine.supersededBufferedSeek;
  return superseded && bufferedSeekKey(superseded) === bufferedSeekKey(message)
    ? { pending: superseded, active: false }
    : null;
}

function settlePendingBufferedSeek(outcome, { retainForAcknowledgement = false } = {}) {
  const engine = streamingEngineState();
  const pending = engine.pendingBufferedSeek;
  if (!pending) return false;
  engine.pendingBufferedSeek = null;
  pending.resolve(outcome);
  if (retainForAcknowledgement) engine.supersededBufferedSeek = pending;
  return true;
}

function discardSupersededBufferedSeek() {
  streamingEngineState().supersededBufferedSeek = null;
}

function acceptStreamingPcm(roleState, frameCount, pcm) {
  const engine = streamingEngineState();
  const role = roleState.role;
  const capacityFrames = streamingRoleCapacityFrames(roleState);
  const sequence = roleState.nextSequence;
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
  const replay = startStreamingTrack(track, {
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
  if (message.type === 'buffered-seek-reserved') {
    const match = findBufferedSeekForMessage(message);
    if (!match) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    match.pending.reserved = true;
    return;
  }
  if (message.type === 'buffered-seek-rejected') {
    const match = findBufferedSeekForMessage(message);
    if (!match) {
      engine.diagnostics.staleMessages += 1;
      return;
    }
    if (match.active) settlePendingBufferedSeek('rejected');
    else engine.supersededBufferedSeek = null;
    return;
  }
  if (message.type === 'buffered-seek-boundary') {
    const match = findBufferedSeekForMessage(message);
    const pending = match?.pending || null;
    const current = engine.roles.current;
    if (!pending || !pending.reserved || !current
        || pending.generation !== message.generation
        || pending.requestId !== message.requestId
        || pending.currentStreamId !== message.streamId
        || pending.startFrame !== message.timelineFrame
        || current.streamId !== message.streamId
        || !Number.isInteger(message.bufferedFrames) || message.bufferedFrames < 0
        || !Number.isInteger(message.skippedFrames) || message.skippedFrames < 0) {
      if (match && !match.active) engine.supersededBufferedSeek = null;
      engine.diagnostics.staleMessages += 1;
      return;
    }
    engine.diagnostics.bufferedFrames.current = Math.min(
      message.bufferedFrames,
      streamingRoleCapacityFrames(current),
    );
    if (match.active) {
      engine.diagnostics.seekCapture = message.capture || null;
      engine.diagnostics.seekSilentFrames = Number(message.silentFrames) || 0;
      const committedAtMs = performance.now();
      engine.diagnostics.seekCommittedAtMs = committedAtMs;
      engine.diagnostics.firstFrameAtMs = Math.max(
        committedAtMs,
        (Number(engine.diagnostics.firstFrameAtMs) || 0) + 0.001,
      );
    }
    engine.positionFacadeAtMs = 0;
    Object.assign(engine.snapshot, {
      currentTime: message.timelineFrame / engine.sampleRate,
      requestedStartFrame: message.timelineFrame,
      renderedFrame: Math.max(0, message.timelineFrame - (Number(current.startFrame) || 0)),
      ended: false,
      readyState: 4,
    });
    if (!current.eosReceived) {
      const targetFrames = Number(current.targetBufferFrames)
        || streamingRoleCommittedCapacityFrames(current);
      refillStreamingRoleCredit(current, Math.max(
        0,
        targetFrames
          - engine.diagnostics.bufferedFrames.current
          - engine.diagnostics.inFlightFrames.current,
      ));
    }
    publishStreamingDiagnostics();
    if (match.active) settlePendingBufferedSeek('committed');
    else engine.supersededBufferedSeek = null;
    return;
  }
  if (message.type === 'seek-boundary') {
    const pendingSeek = engine.pendingSeek;
    const current = engine.roles.current;
    const continuity = engine.roles.continuity;
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
        observeStreamingFacadeCallback(handleStreamingPlaybackBoundary({
          generation: message.generation,
          outgoingStreamId: message.outgoingStreamId,
          incomingStreamId: message.incomingStreamId,
          outgoingTrackPath,
          incomingTrackPath,
          outgoingPlaybackSnapshot,
          incomingListenSession: continuity.measuredListenSession || null,
          renderedFrame: message.renderedFrame,
          continuityKind: promotedLoop?.kind || 'queued-next',
        }), 'boundary-facade-error');
      } catch (error) {
        failStreamingEngine('facade', error, 'boundary-facade-error');
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
        observeStreamingFacadeCallback(handleStreamingPlaybackPosition({
          generation: message.generation,
          streamId: current.streamId,
          trackPath: String(current.track?.path || ''),
          timelineFrame: monotonicTimelineFrame,
          currentTime: engine.snapshot.currentTime,
        }), 'position-facade-error');
      } catch (error) {
        failStreamingEngine('facade', error, 'position-facade-error');
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
    const pendingReplacement = engine.pendingSeek;
    if (pendingReplacement?.kind === 'replacement'
        && pendingReplacement.generation === message.generation
        && pendingReplacement.currentStreamId === current.streamId
        && pendingReplacement.streamId === engine.roles.continuity?.streamId) {
      if (!engine.snapshot.paused) {
        engine.node.port.postMessage({ type: 'play', generation: engine.generation });
      }
      return;
    }
    current.endedNotified = true;
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
        observeStreamingFacadeCallback(handleStreamingPlaybackEnded({
          generation: message.generation,
          streamId: current.streamId,
          trackPath: String(current.track?.path || ''),
          timelineFrame,
          currentTime,
          // A successor at another sample rate cannot continue gaplessly; it starts anew.
          startNextTrackPath: engine.sampleRateChangeNext?.generation === message.generation
            ? engine.sampleRateChangeNext.path
            : '',
        }), 'ended-facade-error');
      } catch (error) {
        failStreamingEngine('facade', error, 'ended-facade-error');
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
    if (roleState.role === 'current') roleState.transportRecoveryAttempt = 0;
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
        observeStreamingFacadeCallback(handleStreamingPlaybackFirstFrame({
          generation: message.generation,
          streamId: message.streamId,
          trackPath: String(roleState.track?.path || ''),
          renderedFrame: message.renderedFrame,
          contextTime: message.contextTime,
        }), 'first-frame-facade-error');
      } catch (error) {
        failStreamingEngine('facade', error, 'first-frame-facade-error');
      }
    }
    if (roleState.role === 'current') maybeSchedulePendingStreamingContinuity();
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
  if (engine.qualityPreference === 'original' || engine.qualityPreference === '320') {
    return engine.qualityPreference;
  }
  const lastStallAtMs = Number(engine.lastStallAtMs) || 0;
  if (lastStallAtMs && performance.now() - lastStallAtMs < STREAMING_RECENT_STALL_MS) return '320';
  const transferSeconds = (Number(engine.transferMs) || 0) / 1000;
  const durationSeconds = Number(track.durationSeconds) || 0;
  const sizeBytes = Number(engine.trackFormats?.get(path)?.sizeBytes) || 0;
  if (!transferSeconds || !durationSeconds || !sizeBytes) return 'original';
  const measuredBitsPerSecond = (engine.transferBytes * 8) / transferSeconds;
  return measuredBitsPerSecond < (sizeBytes * 8 * STREAMING_REQUIRED_HEADROOM) / durationSeconds
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
  const { context, node } = engine;
  engine.context = null;
  engine.node = null;
  engine.sampleRate = 0;
  if (node) {
    node.port.postMessage({ type: 'stop', generation: engine.generation, reason: 'sample-rate-change' });
    node.disconnect();
  }
  await context?.close();
}

async function prepareStreamingPlaybackEngine(sampleRate = 0) {
  const engine = streamingEngineState();
  const audioGraphReady = !sampleRate
    || (engine.context && engine.node && engine.sampleRate === sampleRate);
  if (audioGraphReady && engine.socket) return;
  if (engine.preparePromise) {
    await engine.preparePromise;
    return prepareStreamingPlaybackEngine(sampleRate);
  }
  const preparation = (async () => {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    let context = null;
    let node = null;
    let socket = null;
    try {
      if (!audioGraphReady) {
        await retireStreamingAudioGraph();
        // 'playback' asks for large output buffers; the default suits games and calls.
        context = new AudioContextType({ sampleRate, latencyHint: 'playback' });
        engine.context = context;
        engine.sampleRate = sampleRate;
        if (typeof observeBrowserPlaybackAudioContext === 'function') {
          observeBrowserPlaybackAudioContext(context);
        }
        await context.audioWorklet.addModule(STREAMING_WORKLET_URL);
        node = new AudioWorkletNode(context, STREAMING_PROCESSOR_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(context.destination);
        node.port.onmessage = ({ data }) => handleStreamingWorkletMessage(data);
        node.onprocessorerror = (event) => {
          if (engine.node !== node) return;
          failStreamingEngine('processor', event, 'processor-error');
        };
        engine.node = node;
        engine.backingCapacityFrames = initialStreamingBackingCapacities();
      }
      if (engine.socket) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/playback/pcm`);
      socket.binaryType = 'arraybuffer';
      socket.onopen = flushStreamingControls;
      socket.onerror = (event) => {
        if (engine.socket !== socket) return;
        const detail = event?.error?.message || event?.message || 'Playback socket error';
        engine.diagnostics.lastSocketError = {
          message: String(detail),
          atMs: performance.now(),
        };
        publishStreamingDiagnostics();
      };
      socket.onclose = (event) => {
        if (engine.expectedSocketClose === socket) {
          engine.expectedSocketClose = null;
          return;
        }
        if (engine.socket !== socket) return;
        void recoverUnexpectedStreamingSocketClose(socket, event)
          .catch((error) => console.error('Streaming socket recovery failed', error));
      };
      socket.onmessage = ({ data }) => {
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
      engine.socket = socket;
      engine.pendingControls = [];
      engine.nextStreamId ??= 1;
      engine.mode = 'prepared';
    } catch (error) {
      if (engine.socket === socket) engine.socket = null;
      if (engine.node === node) engine.node = null;
      if (context && engine.context === context) {
        engine.context = null;
        engine.sampleRate = 0;
      }
      engine.mode = 'stopped';
      const cleanupErrors = [];
      if (socket) {
        try {
          engine.expectedSocketClose = socket;
          socket.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (node) {
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
      if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
      throw error;
    }
  })();
  engine.preparePromise = preparation;
  try {
    return await preparation;
  } finally {
    if (engine.preparePromise === preparation) engine.preparePromise = null;
  }
}

function openStreamingRole(role, track, startFrame = 0, continuityOptions = null) {
  const engine = streamingEngineState();
  const roleState = {
    role,
    track,
    generation: engine.generation,
    streamId: engine.nextStreamId,
    startFrame,
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
    ...(engine.encodedCodecs?.length ? { codecs: engine.encodedCodecs } : {}),
    ...(roleState.quality === '320' ? { quality: '320' } : {}),
  });
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

async function startBrowserStreamingTrack(track, {
  startSeconds = 0,
  autoplay = true,
  allowSuspendedAutoplayFallback = false,
  onAutoplayStarted = null,
  transportRecoveryAttempt = null,
} = {}) {
  const engine = streamingEngineState();
  settlePendingBufferedSeek('superseded', { retainForAcknowledgement: true });
  if (transportRecoveryAttempt === null) engine.pendingTransportRecovery = null;
  engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  const startRequestId = engine.startRequestId;
  settleStreamingReplacementCushionWaiter(false);
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
    if (engine.roles.continuity
        && !closeStreamingContinuityRole('replacement-target')) return null;
    engine.pendingContinuityTrack = null;
    engine.pendingContinuityOptions = null;
    engine.loopContinuity = null;
    engine.waveformReadyIdentity = null;
    const replacementGeneration = engine.generation;
    const outgoingStreamId = engine.roles.current.streamId;
    if (!replacementOutgoingCushionReady(engine, engine.roles.current)) {
      const cushionReady = await waitForStreamingReplacementCushion(engine, engine.roles.current);
      if (engine.startRequestId !== startRequestId
          || engine.generation !== replacementGeneration
          || engine.roles.current?.streamId !== outgoingStreamId
          || !engine.node
          || engine.socket?.readyState !== WebSocket.OPEN) return null;
      if (!cushionReady) break preparedReplacement;
    }
    const startFrame = streamingFrames(Math.max(0, startSeconds));
    const replacement = openStreamingRole('continuity', track, startFrame, {
      kind: 'seek', startSeconds: Math.max(0, startSeconds), endSeconds: Math.max(0, startSeconds),
    });
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
    engine.node.port.postMessage({
      type: 'reserve-seek', generation: engine.generation,
      streamId: replacement.streamId, timelineStartFrame: startFrame,
    });
    return completion;
  }
  if (engine.roles.current || engine.roles.continuity) {
    cancelStreamingWaveformGeneration(engine.generation);
  }
  const activeStop = engine.stopPromise;
  if (activeStop) {
    try {
      await activeStop;
    } catch (error) {
      engine.diagnostics.lastCleanupError = {
        name: error?.name || 'Error',
        message: error?.message || String(error),
      };
    }
  }
  if (engine.startRequestId !== startRequestId) return null;
  engine.lifecycleEpoch ??= 0;
  const lifecycleEpoch = engine.lifecycleEpoch;
  let sampleRate = 0;
  try {
    await prepareStreamingPlaybackEngine();
    if (typeof ensureStreamingDecoders === 'function') await ensureStreamingDecoders();
    await requestStreamingSampleRate(track);
    sampleRate = streamingPlaybackRate(track);
    if (engine.startRequestId === startRequestId && !sampleRate) {
      throw new Error('The track sample rate could not be read');
    }
  } catch (error) {
    if (engine.startRequestId !== startRequestId) return null;
    throw error;
  }
  if (engine.startRequestId !== startRequestId
      || engine.lifecycleEpoch !== lifecycleEpoch) return null;
  const oldRoles = [engine.roles.current, engine.roles.continuity].filter(Boolean);
  for (const roleState of oldRoles) {
    const accepted = sendStreamingControl({
      type: 'close',
      generation: roleState.generation,
      streamId: roleState.streamId,
      reason: 'replacement',
    });
    if (!accepted) return null;
  }
  engine.generation += 1;
  engine.positionFacadeAtMs = 0;
  engine.roles.current = null;
  engine.roles.continuity = null;
  engine.pendingContinuityTrack = null;
  engine.pendingContinuityOptions = null;
  engine.pendingPromotion = null;
  settlePendingStreamingCutover(new Error('Prepared track replacement was superseded'));
  engine.pendingSeek = null;
  engine.loopContinuity = null;
  engine.waveformReadyIdentity = null;
  engine.mode = 'starting';
  engine.diagnostics.firstFrameAtMs = 0;
  engine.diagnostics.buffering = false;
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
  const current = openStreamingRole('current', track, startFrame);
  if (!current) return null;
  current.transportRecoveryAttempt = Math.max(0, Number(transportRecoveryAttempt) || 0);
  probeStreamingTrackWaveform(track);
  engine.node.port.postMessage({
    type: 'configure',
    generation: engine.generation,
    sampleRate: engine.sampleRate,
    currentCapacityFrames: streamingFrames(engine.limits.currentSeconds),
    continuityCapacityFrames: streamingFrames(engine.limits.continuitySeconds),
    startupBufferFrames: streamingFrames(STREAMING_INITIAL_PLAYBACK_CUSHION_SECONDS),
  });
  if (!autoplay) {
    if (engine.context.state !== 'suspended') {
      await engine.context.suspend();
    }
    if (engine.startRequestId !== startRequestId || engine.roles.current !== current) return null;
    if (engine.mode !== 'error') engine.mode = 'paused';
    return current;
  }
  const autoplayContext = engine.context;
  const autoplayNode = engine.node;
  const autoplayLifecycleEpoch = engine.lifecycleEpoch;
  const autoplayGeneration = engine.generation;
  const resumePromise = resumeStreamingPlayback(startRequestId, onAutoplayStarted, current);
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
  if (engine.startRequestId !== startRequestId) return null;
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

async function pauseBrowserStreaming() {
  const engine = streamingEngineState();
  const startRequestId = engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  if (!engine.context || !engine.node) return;
  settlePendingBufferedSeek('superseded', { retainForAcknowledgement: true });
  engine.snapshot.paused = true;
  engine.node.port.postMessage({ type: 'pause', generation: engine.generation });
  if (engine.pendingSeek?.kind === 'replacement') {
    const currentTrack = engine.roles.current?.track;
    const startSeconds = engine.snapshot.currentTime;
    settlePendingStreamingCutover();
    engine.pendingSeek = null;
    // Reconfigure the clock too: the replacement boundary may already be queued.
    return startStreamingTrack(currentTrack, { startSeconds, autoplay: false });
  }
  await engine.context.suspend();
  if (engine.startRequestId === startRequestId && engine.mode !== 'error') engine.mode = 'paused';
}

async function resumeBrowserStreaming(
  expectedStartRequestId = null,
  onPlaybackStarted = null,
  expectedCurrentRole = null,
) {
  const engine = streamingEngineState();
  const startRequestId = expectedStartRequestId
    ?? (Number(engine.startRequestId) || 0);
  const pendingRecovery = engine.pendingTransportRecovery;
  if (pendingRecovery && !engine.context && !engine.roles.current) {
    engine.pendingTransportRecovery = null;
    delete engine.diagnostics.lastError;
    const recovered = await startStreamingTrack(pendingRecovery.track, {
      startSeconds: pendingRecovery.startSeconds,
      autoplay: true,
      onAutoplayStarted: onPlaybackStarted,
      transportRecoveryAttempt: 0,
    });
    return Boolean(recovered && !engine.snapshot.paused);
  }
  if (!engine.context || !engine.node) await prepareStreamingPlaybackEngine();
  if ((Number(engine.startRequestId) || 0) !== startRequestId) return false;
  const context = engine.context;
  const node = engine.node;
  const lifecycleEpoch = engine.lifecycleEpoch;
  const generation = engine.generation;
  if (!context) return false;
  await context.resume();
  if (engine.context !== context || engine.node !== node
      || engine.lifecycleEpoch !== lifecycleEpoch || engine.generation !== generation
      || context.state !== 'running'
    || (Number(engine.startRequestId) || 0) !== startRequestId
      || (expectedCurrentRole !== null
        && (engine.roles.current !== expectedCurrentRole || engine.mode === 'error'))) {
    return false;
  }
  if (engine.snapshot.paused === false) return true;
  if (expectedStartRequestId === null) {
    engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  }
  node.port.postMessage({ type: 'play', generation });
  engine.snapshot.paused = false;
  maybeGrantDeferredReplacementCredit();
  maybeSchedulePendingStreamingContinuity();
  engine.deferredCreditFrames ??= { current: 0, continuity: 0 };
  for (const role of ['current', 'continuity']) {
    const roleState = engine.roles[role];
    const deferredFrames = engine.deferredCreditFrames[role];
    engine.deferredCreditFrames[role] = 0;
    if (!roleState || deferredFrames <= 0) continue;
    const grantedFrames = grantStreamingCredit(roleState, deferredFrames);
    engine.deferredCreditFrames[role] = deferredFrames - grantedFrames;
  }
  if (engine.mode !== 'error' && engine.roles.current) {
    engine.mode = engine.roles.current.firstFrameNotified ? 'playing' : 'starting';
  }
  if (typeof onPlaybackStarted === 'function') onPlaybackStarted();
  return true;
}
async function seekBrowserStreaming(seconds) {
  const engine = streamingEngineState();
  engine.diagnostics.seekRequestedAtMs = performance.now();
  const currentTrack = engine.roles.current?.track;
  if (!currentTrack || !engine.node) return;
  const current = engine.roles.current;
  if (!current) return null;
  settlePendingBufferedSeek('superseded', { retainForAcknowledgement: true });
  if (engine.pendingPromotion) {
    const pendingPromotion = engine.pendingPromotion;
    if (pendingPromotion.generation === engine.generation
        && pendingPromotion.streamId === current.streamId
        && current.boundaryNotified === true) {
      pendingPromotion.requestedSeekSeconds = Math.max(0, Number(seconds) || 0);
    }
    return null;
  }
  const startSeconds = Math.max(0, Number(seconds) || 0);
  const startFrame = streamingFrames(startSeconds);
  const currentFrame = Math.round(
    Math.max(0, Number(engine.snapshot.currentTime) || 0) * engine.sampleRate,
  );
  const queuedContinuity = engine.roles.continuity;
  const bufferedSeekEligible = queuedContinuity?.continuityOptions?.kind === 'queued-next'
    && engine.diagnostics.bufferedFrames.continuity > 0
    && !engine.snapshot.paused
    && !engine.loopContinuity
    && !engine.pendingSeek
    && !engine.supersededBufferedSeek
    && startFrame >= currentFrame
    && startFrame - currentFrame < streamingRoleCapacityFrames(current)
    && startFrame - currentFrame < engine.diagnostics.bufferedFrames.current
    && startFrame < Math.round((Number(engine.snapshot.duration) || 0) * engine.sampleRate);
  if (bufferedSeekEligible) {
    const requestId = engine.nextBufferedSeekRequestId =
      (Number(engine.nextBufferedSeekRequestId) || 0) + 1;
    const outcome = new Promise((resolve) => {
      engine.pendingBufferedSeek = {
        generation: engine.generation,
        currentStreamId: current.streamId,
        requestId,
        startFrame,
        resolve,
      };
    });
    engine.diagnostics.seekRequestedAtMs = performance.now();
    engine.diagnostics.seekCapture = null;
    engine.diagnostics.seekSilentFrames = null;
    engine.diagnostics.seekCommittedAtMs = 0;
    engine.snapshot.requestedStartFrame = startFrame;
    engine.snapshot.currentTime = startSeconds;
    engine.node.port.postMessage({
      type: 'reserve-buffered-seek',
      generation: engine.generation,
      requestId,
      streamId: current.streamId,
      timelineFrame: startFrame,
    });
    publishStreamingDiagnostics();
    const result = await outcome;
    if (result === 'committed') return current;
    if (result === 'superseded') return null;
    if (engine.generation !== current.generation
        || engine.roles.current !== current) return null;
  }
  cancelStreamingWaveformGeneration(engine.generation);
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
    if (!accepted) return null;
    engine.node.port.postMessage({
      type: 'drop-continuity',
      generation: staleContinuity.generation,
      streamId: staleContinuity.streamId,
    });
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
  const replacement = openStreamingRole('continuity', currentTrack, startFrame, {
    kind: 'seek', startSeconds, endSeconds: startSeconds,
  });
  if (!replacement) return null;
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
  engine.diagnostics.seekCapture = null;
  engine.diagnostics.seekSilentFrames = null;
  engine.diagnostics.seekCommittedAtMs = 0;
  engine.snapshot.requestedStartFrame = startFrame;
  engine.snapshot.currentTime = startSeconds;
  publishStreamingDiagnostics();
  return replacement;
}

async function scheduleBrowserStreamingContinuity(track, options = {}) {
  const engine = streamingEngineState();
  if (!engine.roles.current) return null;
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
  const startFrame = streamingFrames(normalized.startSeconds);
  const continuity = openStreamingRole('continuity', track, startFrame, normalized);
  if (!continuity) return null;
  if (normalized.kind === 'queued-next') {
    engine.node.port.postMessage({
      type: 'expect-continuity',
      generation: engine.generation,
      active: true,
    });
  }
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
  return continuity;
}

function setBrowserStreamingLoop(active, startSeconds = 0, endSeconds = 0) {
  const engine = streamingEngineState();
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

async function cleanupStreamingResources(reason, {
  preserveError = false,
  preserveSnapshot = false,
  socketAlreadyClosed = false,
} = {}) {
  const engine = streamingEngineState();
  const roles = [engine.roles.current, engine.roles.continuity].filter(Boolean);
  const node = engine.node;
  const socket = engine.socket;
  const context = engine.context;
  if (roles.length || engine.waveformReadyIdentity) {
    cancelStreamingWaveformGeneration(engine.generation);
  }
  settleStreamingReplacementCushionWaiter(false);
  settlePendingBufferedSeek('superseded');
  discardSupersededBufferedSeek();
  settlePendingStreamingCutover(new Error(`Prepared track replacement stopped: ${reason}`));
  for (const requestId of [...(engine.sampleRateProbes?.keys() || [])]) {
    settleStreamingSampleRateProbe(requestId, 0);
  }
  engine.context = null;
  engine.node = null;
  engine.socket = null;
  engine.sampleRate = 0;
  engine.roles.current = null;
  engine.roles.continuity = null;
  engine.pendingContinuityTrack = null;
  engine.pendingContinuityOptions = null;
  engine.pendingPromotion = null;
  engine.pendingSeek = null;
  engine.replacementCushionWaiter = null;
  engine.loopContinuity = null;
  engine.waveformReadyIdentity = null;
  engine.pendingControls = [];
  engine.deferredCreditFrames = { current: 0, continuity: 0 };
  sweepStreamingEncodedDecoders();
  if (!preserveError) {
    engine.mode = 'stopped';
    delete engine.diagnostics.lastError;
  }
  engine.diagnostics.firstFrameAtMs = 0;
  engine.diagnostics.buffering = false;
  resetStreamingPcmEvidence(null, { clearAll: true });
  engine.diagnostics.bufferedFrames = { current: 0, continuity: 0 };
  engine.diagnostics.inFlightFrames = { current: 0, continuity: 0 };
  engine.diagnostics.activeRoles = [];
  Object.assign(engine.snapshot, {
    currentTime: preserveSnapshot ? engine.snapshot.currentTime : 0,
    duration: preserveSnapshot ? engine.snapshot.duration : 0,
    paused: true,
    ended: false,
    src: preserveSnapshot ? engine.snapshot.src : '',
    readyState: 0,
  });
  const cleanupErrors = [];
  if (socket && !socketAlreadyClosed && socket.readyState === WebSocket.OPEN) {
    for (const roleState of roles) {
      try {
        socket.send(JSON.stringify({
          type: 'close',
          generation: roleState.generation,
          streamId: roleState.streamId,
          reason,
        }));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (node) {
    try {
      node.port.postMessage({ type: 'stop', generation: engine.generation, reason });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      node.disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (socket && !socketAlreadyClosed) {
    try {
      engine.expectedSocketClose = socket;
      socket.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (context) {
    try {
      await context.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Streaming cleanup failed');
  }
}

function beginStreamingCleanup(reason, options = {}) {
  const engine = streamingEngineState();
  if (engine.stopPromise) return engine.stopPromise;
  engine.lifecycleEpoch = (engine.lifecycleEpoch || 0) + 1;
  const cleanup = (async () => {
    const preparation = engine.preparePromise;
    if (preparation) {
      try {
        await preparation;
      } catch (_error) {
        // Preparation owns partial-resource cleanup and preserves the original rejection.
      }
    }
    await cleanupStreamingResources(reason, options);
  })();
  engine.stopPromise = cleanup;
  const clearStopPromise = () => {
    if (engine.stopPromise === cleanup) engine.stopPromise = null;
  };
  void cleanup.then(clearStopPromise, clearStopPromise);
  return cleanup;
}

async function stopBrowserStreaming(reason = 'stopped', options = {}) {
  streamingEngineState().pendingTransportRecovery = null;
  return beginStreamingCleanup(reason, options);
}
function getBrowserStreamingSnapshot() {
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

// The contract (playback-engine.js) loads after this file and answers for whichever engine plays.
Object.defineProperty(window, '__ALBUM_HAVEN_STREAMING_DIAGNOSTICS__', {
  configurable: true,
  get: () => getStreamingPlaybackSnapshot(),
});
