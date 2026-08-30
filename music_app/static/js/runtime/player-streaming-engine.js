const STREAMING_SAMPLE_RATE = 48_000;
const STREAMING_RUNTIME_ASSET_VERSION = encodeURIComponent(
  String(window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ || ''),
);
const STREAMING_WORKLET_URL = '/static/js/audio-worklets/gapless-playback-processor.js'
  + (STREAMING_RUNTIME_ASSET_VERSION ? `?v=${STREAMING_RUNTIME_ASSET_VERSION}` : '');
const STREAMING_PROCESSOR_NAME = 'album-haven-gapless-playback';
const STREAMING_MAX_CREDIT_FRAMES = 48_000;
const STREAMING_CREDIT_LOW_WATER_FRAMES = 12_000;
const STREAMING_INITIAL_PLAYBACK_CUSHION_FRAMES = STREAMING_CREDIT_LOW_WATER_FRAMES;
const STREAMING_QUEUED_NEXT_PREPARE_FRAMES = 3 * STREAMING_SAMPLE_RATE;
const STREAMING_REPLACEMENT_PREPARE_FRAMES = 2 * STREAMING_SAMPLE_RATE;
const STREAMING_SEEK_PREPARE_FRAMES = 12_000;
const STREAMING_REPLACEMENT_OUTGOING_CUSHION_FRAMES = STREAMING_SAMPLE_RATE;
const STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_FRAMES = STREAMING_REPLACEMENT_PREPARE_FRAMES;
const STREAMING_WAVEFORM_READY_FRAMES = 48_000;
const STREAMING_RESTORE_AUTOPLAY_SETTLEMENT_MS = 750;
const STREAMING_REPLACEMENT_CUSHION_WAIT_MS = 1000;

function streamingEngineState() {
  return state.player.streaming;
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
    current: engine.limits.currentSeconds * STREAMING_SAMPLE_RATE,
    continuity: engine.limits.continuitySeconds * STREAMING_SAMPLE_RATE,
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
  const logicalCapacityFrames = engine.limits[`${role}Seconds`] * STREAMING_SAMPLE_RATE;
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
    ? Math.min(currentCapacityFrames, STREAMING_WAVEFORM_READY_FRAMES)
    : Math.min(currentCapacityFrames, STREAMING_WAVEFORM_READY_FRAMES, currentPlayableFrames);
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
    : STREAMING_SAMPLE_RATE;
  const continuityTargetFrames = continuityPlayableFrames === null
    ? Math.min(STREAMING_SAMPLE_RATE, continuityCapacityFrames)
    : Math.min(STREAMING_SAMPLE_RATE, continuityCapacityFrames, continuityPlayableFrames);
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
  return (current?.replacementPromotion !== true || !engine.pendingPromotion)
    && (current.firstFrameNotified === true || current.boundaryNotified === true)
    && !engine.snapshot.paused
    && !engine.roles.continuity
    && (current.eosReceived === true
      || engine.diagnostics.bufferedFrames.current >= STREAMING_SAMPLE_RATE);
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
    } else {
      engine.node.port.postMessage({
        type: 'set-loop',
        generation: continuity.generation,
        active: false,
        kind: options.kind,
        startFrame: Math.round(options.startSeconds * STREAMING_SAMPLE_RATE),
        endFrame: Math.round(options.endSeconds * STREAMING_SAMPLE_RATE),
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
  const fullCurrentCapacityFrames = engine.limits.currentSeconds * STREAMING_SAMPLE_RATE;
  return roleState?.role === 'current' && capacityFrames === fullCurrentCapacityFrames
    ? Math.max(1, capacityFrames - STREAMING_MAX_CREDIT_FRAMES)
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
      STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_FRAMES
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
  const serverAvailableFrames = Math.max(0, STREAMING_MAX_CREDIT_FRAMES - inFlightFrames);
  const frames = Math.min(requestedFrames, availableFrames, serverAvailableFrames);
  if (frames <= 0) return 0;
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
  if (missingFrames < STREAMING_MAX_CREDIT_FRAMES
      || inFlightFrames > STREAMING_CREDIT_LOW_WATER_FRAMES) return 0;
  return grantStreamingCredit(roleState, STREAMING_MAX_CREDIT_FRAMES - inFlightFrames);
}

function continuityCreditNeedsOutgoingRenderCushion(roleState) {
  const engine = streamingEngineState();
  const pendingReplacement = engine.pendingSeek;
  const current = engine.roles.current;
  const queuedNextNeedsCushion = roleState?.role === 'continuity'
    && roleState.continuityOptions?.kind === 'queued-next'
    && !current?.eosReceived
    && engine.diagnostics.bufferedFrames.current < STREAMING_SAMPLE_RATE;
  const replacementNeedsCushion = roleState?.role === 'continuity'
    && roleState.continuityOptions?.kind === 'seek'
    && pendingReplacement?.kind === 'replacement'
    && pendingReplacement.generation === engine.generation
    && pendingReplacement.streamId === roleState.streamId
    && pendingReplacement.currentStreamId === current?.streamId
    && !current.eosReceived
    && engine.diagnostics.bufferedFrames.current < STREAMING_REPLACEMENT_OUTGOING_CUSHION_FRAMES;
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
      >= STREAMING_REPLACEMENT_OUTGOING_CUSHION_FRAMES;
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
    STREAMING_MAX_CREDIT_FRAMES,
    Number(roleState.targetBufferFrames) || STREAMING_MAX_CREDIT_FRAMES,
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
    && message.sampleRate === STREAMING_SAMPLE_RATE
    && message.channels === 2
    && Number.isInteger(message.provisionalTotalFrames)
    && message.provisionalTotalFrames >= 0
    && message.requestedStartFrame === roleState.startFrame
    && Number.isInteger(message.timelineStartFrame)
    && message.timelineStartFrame >= 0;
}

function handleStreamingControl(message) {
  const engine = streamingEngineState();
  if (!message || typeof message !== 'object') return;
  const roleState = streamingRoleForId(message.streamId);
  if (!roleState || message.generation !== engine.generation) {
    engine.diagnostics.staleMessages += 1;
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
    roleState.eosReceived = true;
    roleState.closed = true;
    engine.diagnostics.inFlightFrames[roleState.role] = 0;
    if (roleState.role === 'current' && !roleState.seekTarget) {
      engine.snapshot.duration = message.authoritativeTotalFrames / STREAMING_SAMPLE_RATE;
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
    if (view.getUint8(4) !== 1) {
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
      type: 'enqueue', generation, streamId, role, sequence, frameCount, pcm,
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
      currentTime: message.timelineFrame / STREAMING_SAMPLE_RATE,
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
        (Number(message.timelineFrame) || 0) / STREAMING_SAMPLE_RATE,
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
        outgoingFrame / STREAMING_SAMPLE_RATE,
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
      ? Math.round((Number(promotedLoop.startSeconds) || 0) * STREAMING_SAMPLE_RATE)
      : 0;
    Object.assign(engine.snapshot, {
      currentTime: timelineFrame / STREAMING_SAMPLE_RATE,
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
      Math.round((Number(engine.snapshot.currentTime) || 0) * STREAMING_SAMPLE_RATE),
    );
    engine.snapshot.currentTime = monotonicTimelineFrame / STREAMING_SAMPLE_RATE;
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
    current.endedNotified = true;
    const timelineFrame = streamingAbsoluteTimelineFrame(current, message.timelineFrame);
    const currentTime = timelineFrame / STREAMING_SAMPLE_RATE;
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
    if (!engine.diagnostics.firstFrameAtMs) {
      engine.diagnostics.firstFrameAtMs = performance.now();
    }
    const firstFrameCurrentTime = roleState.seekTarget
      ? (roleState.startFrame + Math.max(
          0,
          message.renderedFrame - roleState.renderedFrameBase,
        )) / STREAMING_SAMPLE_RATE
      : streamingAbsoluteTimelineFrame(roleState, message.renderedFrame)
        / STREAMING_SAMPLE_RATE;
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
  if (message.type === 'underrun') {
    engine.diagnostics.underruns += 1;
    return;
  }
  if (message.type === 'consumed' && streamingWireRoleAccepted(roleState, message.role)
      && Number.isInteger(message.frames) && message.frames >= 0
      && Number.isInteger(message.bufferedFrames) && message.bufferedFrames >= 0) {
    recordStreamingRenderedPcmEvidence(roleState, message);
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
        (Number(engine.snapshot.currentTime) || 0) + (message.frames / STREAMING_SAMPLE_RATE),
      );
      const absoluteRenderedFrame = Math.round(
        engine.snapshot.currentTime * STREAMING_SAMPLE_RATE,
      );
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
          STREAMING_REPLACEMENT_ACTIVE_OUTGOING_CUSHION_FRAMES,
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

async function prepareStreamingPlaybackEngine() {
  const engine = streamingEngineState();
  if (engine.context && engine.node && engine.socket) return;
  if (engine.preparePromise) return engine.preparePromise;
  const preparation = (async () => {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    let context = null;
    let node = null;
    let socket = null;
    try {
      context = new AudioContextType({ sampleRate: STREAMING_SAMPLE_RATE });
      engine.context = context;
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
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/playback/pcm`);
      socket.binaryType = 'arraybuffer';
      socket.onopen = flushStreamingControls;
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
      if (engine.context === context) engine.context = null;
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
    backingCapacityFrames: ensureStreamingBackingCapacities()[role],
  };
  if (role === 'continuity') {
    const capacityFrames = streamingRoleCapacityFrames(roleState);
    const requestedFrames = continuityOptions?.kind === 'queued-next'
      ? STREAMING_QUEUED_NEXT_PREPARE_FRAMES
      : continuityOptions?.kind === 'seek'
        ? STREAMING_SEEK_PREPARE_FRAMES
      : continuityOptions?.kind === 'short-loop'
        ? Math.max(1, (Math.round(continuityOptions.endSeconds * STREAMING_SAMPLE_RATE) - startFrame))
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
    sampleRate: STREAMING_SAMPLE_RATE,
    durationSeconds: Number(track.durationSeconds) || 0,
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

async function startStreamingTrack(track, {
  startSeconds = 0,
  autoplay = true,
  allowSuspendedAutoplayFallback = false,
  onAutoplayStarted = null,
} = {}) {
  const engine = streamingEngineState();
  engine.startRequestId = (Number(engine.startRequestId) || 0) + 1;
  const startRequestId = engine.startRequestId;
  settleStreamingReplacementCushionWaiter(false);
  const pendingPromotion = engine.pendingPromotion;
  const promotionAllowsReplacement = !pendingPromotion
    || (pendingPromotion.kind === 'replacement'
      && pendingPromotion.generation === engine.generation
      && pendingPromotion.streamId === engine.roles.current?.streamId
      && engine.roles.current?.firstFrameNotified === true);
  const canPrepareReplacement = autoplay
    && engine.roles.current
    && engine.diagnostics.firstFrameAtMs > 0
    && engine.node
    && engine.socket?.readyState === WebSocket.OPEN
    && !engine.snapshot.paused
    && promotionAllowsReplacement
    && !engine.pendingSeek;
  preparedReplacement: {
    if (!canPrepareReplacement) break preparedReplacement;
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
    const startFrame = Math.round(Math.max(0, startSeconds) * STREAMING_SAMPLE_RATE);
    const replacement = openStreamingRole('continuity', track, startFrame, {
      kind: 'seek', startSeconds: Math.max(0, startSeconds), endSeconds: Math.max(0, startSeconds),
    });
    if (!replacement) return null;
    replacement.targetBufferFrames = Math.min(
      streamingRoleCapacityFrames(replacement),
      STREAMING_REPLACEMENT_PREPARE_FRAMES,
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
  try {
    await prepareStreamingPlaybackEngine();
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
  resetStreamingPcmEvidence(null, { clearAll: true });
  engine.diagnostics.bufferedFrames = { current: 0, continuity: 0 };
  engine.diagnostics.inFlightFrames = { current: 0, continuity: 0 };
  engine.deferredCreditFrames = { current: 0, continuity: 0 };
  const startFrame = Math.round(Math.max(0, startSeconds) * STREAMING_SAMPLE_RATE);
  Object.assign(engine.snapshot, {
    currentTime: Math.max(0, startSeconds),
    duration: Number(track.durationSeconds) || 0,
    paused: true,
    ended: false,
    src: track.src || '',
    readyState: 0,
    sampleRate: STREAMING_SAMPLE_RATE,
    requestedStartFrame: startFrame,
    timelineStartFrame: startFrame,
  });
  const current = openStreamingRole('current', track, startFrame);
  if (!current) return null;
  if (typeof probeCachedWaveformPeaks === 'function') {
    try {
      const cachedWaveformProbe = probeCachedWaveformPeaks(
        String(track?.path || ''),
        engine.generation,
      );
      if (cachedWaveformProbe && typeof cachedWaveformProbe.catch === 'function') {
        void cachedWaveformProbe.catch(() => {});
      }
    } catch (_error) {
      // Cached waveform probing is optional and must never interrupt playback.
    }
  }
  engine.node.port.postMessage({
    type: 'configure',
    generation: engine.generation,
    sampleRate: STREAMING_SAMPLE_RATE,
    currentCapacityFrames: engine.limits.currentSeconds * STREAMING_SAMPLE_RATE,
    continuityCapacityFrames: engine.limits.continuitySeconds * STREAMING_SAMPLE_RATE,
    startupBufferFrames: STREAMING_INITIAL_PLAYBACK_CUSHION_FRAMES,
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

async function pauseStreamingPlayback() {
  const engine = streamingEngineState();
  if (!engine.context || !engine.node) return;
  engine.snapshot.paused = true;
  engine.node.port.postMessage({ type: 'pause', generation: engine.generation });
  await engine.context.suspend();
  if (engine.mode !== 'error') engine.mode = 'paused';
}

async function resumeStreamingPlayback(
  expectedStartRequestId = null,
  onPlaybackStarted = null,
  expectedCurrentRole = null,
) {
  const engine = streamingEngineState();
  if (!engine.context || !engine.node) await prepareStreamingPlaybackEngine();
  const context = engine.context;
  const node = engine.node;
  const lifecycleEpoch = engine.lifecycleEpoch;
  const generation = engine.generation;
  await context.resume();
  if (engine.context !== context || engine.node !== node
      || engine.lifecycleEpoch !== lifecycleEpoch || engine.generation !== generation
      || context.state !== 'running'
      || (expectedStartRequestId !== null
        && engine.startRequestId !== expectedStartRequestId)
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
  if (engine.mode !== 'error' && engine.roles.current) engine.mode = 'starting';
  if (typeof onPlaybackStarted === 'function') onPlaybackStarted();
  return true;
}
async function seekStreamingPlayback(seconds) {
  const engine = streamingEngineState();
  engine.diagnostics.seekRequestedAtMs = performance.now();
  const currentTrack = engine.roles.current?.track;
  if (!currentTrack || !engine.node) return;
  const current = engine.roles.current;
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
  const startSeconds = Math.max(0, Number(seconds) || 0);
  const startFrame = Math.round(startSeconds * STREAMING_SAMPLE_RATE);
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

async function scheduleStreamingContinuity(track, options = {}) {
  const engine = streamingEngineState();
  if (!engine.roles.current) return null;
  const normalized = normalizeStreamingContinuityOptions(options);
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
  const startFrame = Math.round(normalized.startSeconds * STREAMING_SAMPLE_RATE);
  const continuity = openStreamingRole('continuity', track, startFrame, normalized);
  if (!continuity) return null;
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
      endFrame: Math.round(normalized.endSeconds * STREAMING_SAMPLE_RATE),
      retainedStreamId: continuity.streamId,
    });
  }
  return continuity;
}

function setStreamingLoop(active, startSeconds = 0, endSeconds = 0) {
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
    message.startFrame = Math.round(Math.max(0, startSeconds) * STREAMING_SAMPLE_RATE);
    message.endFrame = Math.round(Math.max(0, endSeconds) * STREAMING_SAMPLE_RATE);
    message.retainedStreamId = loop.streamId;
    if (continuity?.streamId === loop.streamId) {
      if (!closeStreamingContinuityRole('loop-disabled', { releaseWorklet: false })) return false;
    }
    engine.loopContinuity = null;
    engine.pendingContinuityTrack = null;
    engine.pendingContinuityOptions = null;
  } else if (active && continuity) {
    message.kind = loop?.kind || continuity.continuityOptions?.kind || 'long-loop';
    message.startFrame = Math.round(Math.max(0, startSeconds) * STREAMING_SAMPLE_RATE);
    message.endFrame = Math.round(Math.max(0, endSeconds) * STREAMING_SAMPLE_RATE);
    message.retainedStreamId = continuity.streamId;
  }
  engine.node.port.postMessage(message);
  return true;
}

async function cleanupStreamingResources(reason, {
  preserveError = false,
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
  settlePendingStreamingCutover(new Error(`Prepared track replacement stopped: ${reason}`));
  engine.context = null;
  engine.node = null;
  engine.socket = null;
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
  if (!preserveError) {
    engine.mode = 'stopped';
    delete engine.diagnostics.lastError;
  }
  engine.diagnostics.firstFrameAtMs = 0;
  resetStreamingPcmEvidence(null, { clearAll: true });
  engine.diagnostics.bufferedFrames = { current: 0, continuity: 0 };
  engine.diagnostics.inFlightFrames = { current: 0, continuity: 0 };
  engine.diagnostics.activeRoles = [];
  Object.assign(engine.snapshot, {
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    src: '',
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

async function stopStreamingPlayback(reason = 'stopped') {
  return beginStreamingCleanup(reason);
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
