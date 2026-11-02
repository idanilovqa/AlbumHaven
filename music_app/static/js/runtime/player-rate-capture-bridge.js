// Native tracking owns no audio scheduling. Its lifetime follows an actual node/context.
const streamingRateCaptureOwners = new WeakMap();
function nativeStreamingCaptureEnabled() {
  const shell = typeof document === 'undefined' ? null : document.getElementById('app-shell');
  return shell?.dataset.nativeRateCaptureEnabled === 'true' && shell.dataset.positionCaptureEnabled === 'true';
}
function streamingRateCaptureBridge(node = streamingEngineState().node) {
  return node ? streamingRateCaptureOwners.get(node) || null : null;
}
function prepareStreamingRateCapture(context, node, ownerUuid) {
  if (!ownerUuid) return null;
  const bridge = { native: true, ready: false, selectionReady: false, ownerUuid, node, context,
    aliases: new Map(), pending: new Map(), pendingClose: new Map(), nextAlias: 1, nextFlush: 1, packet: 0, stopped: false };
  streamingRateCaptureOwners.set(node, bridge); // Mode stays native even if optional setup fails.
  const scope = typeof capturePlaybackOwnershipScope === 'function' ? capturePlaybackOwnershipScope() : null;
  const guard = () => !bridge.stopped && nativeStreamingCaptureEnabled() && scope
    && typeof isPlaybackOwnershipScopeCurrent === 'function' && isPlaybackOwnershipScopeCurrent(scope);
  bridge.guard = guard;
  const stateChanged = () => { try { node.port.postMessage({ type: 'rate-capture-barrier' }); } catch (_) {} };
  context.addEventListener?.('statechange', stateChanged);
  const fail = reason => { bridge.stopped = true; bridge.ready = false; bridge.owner?.abandon(reason); };
  const request = new AbortController(), timeout = setTimeout(() => request.abort(), 2000);
  bridge.contextPromise = fetch('/playback/capture/rate/context', { credentials: 'same-origin',
    redirect: 'error', cache: 'no-store', signal: request.signal }).then(async response => {
    if (!response.ok || !guard()) throw new Error('rate context unavailable');
    const value = await response.json();
    if (!guard() || value?.protocol !== 'app-rate-tagged-position-v1'
        || value.native_rate_capture_available !== true || typeof value.expected_scope !== 'string'
        || !value.expected_scope || value.expected_scope.length > 256) throw new Error('rate context unsupported');
    bridge.scopeHeader = value.expected_scope; bridge.ready = true;
    bridge.selectionReady = value.listening_selections_available === true;
    return value;
  }).catch(() => { fail('rate_capture_context_unavailable'); return null; }).finally(() => clearTimeout(timeout));
  bridge.owner = PlaybackRateCapture.createOwner({ ownerUuid, coordinateRateHz: context.sampleRate,
    deviceUuid: getMeasuredPlaybackDeviceId().toLowerCase(), crypto: window.crypto,
    clock: { now: () => performance.now(), setTimeout, clearTimeout },
    onDisable: () => {
      bridge.stopped = true; bridge.ready = false;
      context.removeEventListener?.('statechange', stateChanged);
      for (const pending of bridge.pending.values()) clearTimeout(pending.timer);
      bridge.pending.clear(); bridge.pendingClose.clear(); bridge.aliases.clear();
      try { node.port.postMessage({ type: 'rate-capture-disable' }); } catch (_) {}
    },
    postCheckpoint: async (body, options) => {
      const config = await bridge.contextPromise;
      if (!config || !guard()) throw new Error('rate scope retired');
      const response = await fetch('/playback/capture/rate/checkpoint', {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Playback-Capture-Scope': config.expected_scope },
        body, signal: options.signal,
      });
      if (!guard()) throw new Error('rate scope retired');
      return { status: response.status, data: await response.json() };
    },
  });
  if (!bridge.owner) { fail('rate_capture_owner_capacity'); return bridge; }
  const buffers = Array.from({ length: 4 }, () => new ArrayBuffer(16384));
  node.port.postMessage({ type: 'rate-capture-enable', coordinateRateHz: context.sampleRate, buffers }, buffers);
  return bridge;
}
function bindStreamingRateCapture(role, message) {
  const bridge = streamingRateCaptureBridge();
  if (!bridge || !bridge.guard() || !bridge.owner || role.rateCaptureMode) return;
  role.rateCaptureMode = 'native'; role.rateCaptureBridge = bridge; bridge.endedTailKnown = false;
  // Never fall back to v2 after a missing, delayed or unsupported native map.
  const map = message.rateCapture;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const integer = n => Number.isSafeInteger(n) && !Object.is(n, -0) && n >= 0;
  if (message.coverageMode !== 'native' || !map
      || map.delivery_positions !== undefined && map.delivery_positions !== 'per-packet'
      || !uuid.test(map.map_ref || '')
      || map.owner_uuid !== bridge.ownerUuid || map.coordinate_rate_hz !== bridge.context.sampleRate
      || map.generation !== role.generation || map.stream_id !== role.streamId
      || !integer(map.window_start_frame) || !integer(map.window_frames)
      || !integer(map.window_start_frame + map.window_frames)) return;
  if (bridge.aliases.size >= 8 || !Number.isSafeInteger(bridge.nextAlias + 1)) {
    bridge.owner.abandon('rate_capture_binding_capacity'); return;
  }
  const current = streamingEngineState().roles.current;
  const continuation = ['seek', 'short-loop', 'long-loop', 'whole-track-repeat'].includes(role.continuityOptions?.kind)
    && !(streamingEngineState().pendingSeek?.kind === 'replacement'
      && streamingEngineState().pendingSeek.streamId === role.streamId)
    && current?.track?.path === role.track?.path && role.rateListeningIntent === current.rateListeningIntent
    && role.rateSelectionRef === current.rateSelectionRef;
  const intent = role.rateListeningIntent;
  const parent = continuation && current.rateCaptureParent || bridge.owner.bindParent({
    editionSelectionRef: role.rateSelectionRef,
    resolveSelection: intent ? () => intent.ready()?.selection_ref || null : null,
    readyForSeal: () => bridge.ready && !(intent?.pending?.()),
  });
  if (!parent) { bridge.owner.abandon('rate_capture_parent_capacity'); return; }
  role.rateCaptureParent = parent; role.rateDeliveredFrames = 0;
  role.rateCaptureAlias = bridge.nextAlias++;
  bridge.aliases.set(role.rateCaptureAlias, { map: Object.freeze({ ...map }), parent, role, retired: false });
  void bridge.contextPromise.then(() => {
    if (bridge.guard() && bridge.selectionReady && intent) intent.start(() => bridge.guard());
  });
}
function stageStreamingRatePositions(role, message) {
  const bridge = role.rateCaptureBridge, binding = bridge?.aliases.get(role.rateCaptureAlias);
  role.ratePendingPositions = null;
  if (!binding || !bridge.guard() || binding.map.delivery_positions !== 'per-packet'
      || !role.metadataAccepted || message.generation !== role.generation || message.streamId !== role.streamId
      || message.map_ref !== binding.map.map_ref || message.sequence !== role.nextSequence
      || message.sequence === role.ratePositionSequence || !Number.isSafeInteger(message.frameCount)
      || message.frameCount < 1 || !Array.isArray(message.ranges) || message.ranges.length > 32) return;
  role.ratePositionSequence = message.sequence;
  let previousEnd = 0;
  const ranges = [];
  for (const range of message.ranges) {
    if (!Array.isArray(range) || range.length !== 3
        || range.some(n => !Number.isSafeInteger(n) || Object.is(n, -0))
        || range[0] < previousEnd || range[2] < 1 || range[0] > message.frameCount - range[2]
        || range[1] < binding.map.window_start_frame
        || !Number.isSafeInteger(range[1] + range[2])
        || range[1] + range[2] > binding.map.window_start_frame + binding.map.window_frames) return;
    previousEnd = range[0] + range[2]; ranges.push([...range]);
  }
  role.ratePendingPositions = { sequence: message.sequence, frameCount: message.frameCount, ranges };
}
function streamingRateEnqueuePosition(role, frameCount) {
  const bridge = role.rateCaptureBridge, binding = bridge?.aliases.get(role.rateCaptureAlias);
  if (!binding || !bridge.guard()) return null;
  if (binding.map.delivery_positions === 'per-packet') {
    const pending = role.ratePendingPositions; role.ratePendingPositions = null;
    // No extrapolation: an absent/mismatched position packet leaves these samples unmapped.
    return { alias: role.rateCaptureAlias, perPacket: true,
      ranges: pending?.sequence === role.nextSequence && pending.frameCount === frameCount ? pending.ranges : [] };
  }
  const start = role.rateDeliveredFrames;
  if (!Number.isSafeInteger(start + frameCount) || start + frameCount > binding.map.window_frames) {
    bridge.owner.abandon('rate_capture_delivery_window'); return null;
  }
  role.rateDeliveredFrames += frameCount;
  return { alias: role.rateCaptureAlias, startFrame: binding.map.window_start_frame + start };
}
function requestStreamingRateFlush(bridge, callback) {
  if (!bridge?.owner) return;
  if (!bridge.guard()) { bridge.owner.abandon('rate_capture_scope_retired'); return; }
  if (bridge.pending.size >= 8 || !Number.isSafeInteger(bridge.nextFlush + 1)) {
    bridge.owner.abandon('rate_capture_flush_capacity'); return;
  }
  const token = bridge.nextFlush++;
  const timer = setTimeout(() => bridge.owner.abandon('rate_capture_tail_unknown'), 2000);
  bridge.pending.set(token, { callback, timer });
  bridge.node.port.postMessage({ type: 'rate-capture-flush', token });
}
function retireStreamingRateCapture(role, successor = null, reason = 'track_change') {
  const bridge = role?.rateCaptureBridge;
  if (!bridge || !role.rateCaptureParent) return;
  const binding = bridge.aliases.get(role.rateCaptureAlias);
  if (binding) binding.retired = true;
  const parent = role.rateCaptureParent;
  if (reason === 'ended') {
    // The worklet flushes all actual positions before its existing ended message.
    bridge.endedTailKnown = true; bridge.owner.close(parent, reason); return;
  }
  if (parent !== successor?.rateCaptureParent) bridge.pendingClose.set(parent, reason);
  requestStreamingRateFlush(bridge, live => settleStreamingRateAliases(bridge, live));
}
function retireStreamingRateOwner(node) {
  const bridge = streamingRateCaptureBridge(node);
  if (bridge?.endedTailKnown) { bridge.owner.retire('owner_closed'); return; }
  requestStreamingRateFlush(bridge, () => bridge.owner.retire('owner_closed'));
}
function settleStreamingRateAliases(bridge, live) {
  for (const [parent, reason] of bridge.pendingClose) {
    if (![...bridge.aliases].some(([alias, value]) => value.parent === parent && live.has(alias))) {
      bridge.pendingClose.delete(parent); bridge.owner.close(parent, reason);
    }
  }
  for (const [alias, binding] of bridge.aliases) if (binding.retired && !live.has(alias)) bridge.aliases.delete(alias);
}
function acceptStreamingRateCaptureMessage(node, message) {
  if (!message?.type?.startsWith('rate-capture-')) return false;
  const bridge = streamingRateCaptureBridge(node);
  if (!bridge?.owner) return true;
  if (!bridge.guard()) { bridge.owner.abandon('rate_capture_scope_retired'); return true; }
  if (message.type === 'rate-capture-disabled') {
    bridge.owner.abandon(message.reason || 'rate_capture_disabled'); return true;
  }
  if (message.type === 'rate-capture-live') {
    if (!Array.isArray(message.liveAliases) || message.liveAliases.length > 3
        || message.liveAliases.some(n => !Number.isSafeInteger(n) || n < 1)) {
      bridge.owner.abandon('invalid_rate_capture_live'); return true;
    }
    settleStreamingRateAliases(bridge, new Set(message.liveAliases)); return true;
  }
  if (message.type === 'rate-capture-flushed') {
    const pending = bridge.pending.get(message.token);
    if (!pending || !Array.isArray(message.liveAliases) || message.liveAliases.length > 3
        || message.liveAliases.some(n => !Number.isSafeInteger(n) || n < 1)) {
      bridge.owner.abandon('invalid_rate_capture_flush'); return true;
    }
    bridge.pending.delete(message.token); clearTimeout(pending.timer);
    const live = new Set(message.liveAliases);
    pending.callback(live);
    settleStreamingRateAliases(bridge, live);
    return true;
  }
  if (message.type !== 'rate-capture-packet') return true;
  const buffer = message.buffer;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 16384) { bridge.owner.abandon('invalid_rate_capture_packet'); return true; }
  const rows = new Float64Array(buffer), count = rows[0], packet = rows[1], id = rows[2];
  if (!Number.isInteger(count) || count < 1 || count > 256 || packet !== bridge.packet + 1
      || !Number.isInteger(id) || id < 1 || id > 4 || rows[3] !== 1) {
    bridge.owner.abandon('invalid_rate_capture_packet'); return true;
  }
  bridge.packet = packet;
  for (let n = 0; n < count; n += 1) {
    const i = 4 + n * 6, alias = rows[i], binding = bridge.aliases.get(alias);
    if (!binding) { bridge.owner.abandon('unknown_rate_capture_binding'); return true; }
    const span = { map_ref: binding.map.map_ref, coordinate_start_frame: rows[i + 1], frame_count: rows[i + 2],
      repeat_count: rows[i + 3], output_start_frame: rows[i + 4], continuity_serial: rows[i + 5] };
    if (span.coordinate_start_frame < binding.map.window_start_frame
        || span.coordinate_start_frame + span.frame_count > binding.map.window_start_frame + binding.map.window_frames
        || !bridge.owner.append(binding.parent, [span])) { bridge.owner.abandon('invalid_rate_capture_span'); return true; }
  }
  // Rows have been copied into bounded owner state before the unique credit returns.
  node.port.postMessage({ type: 'rate-capture-credit', bufferId: id, buffer }, [buffer]);
  return true;
}
