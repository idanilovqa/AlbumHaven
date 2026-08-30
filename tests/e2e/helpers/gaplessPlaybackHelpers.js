import { expectTimingBudget, performanceTimingBudget } from './timingBudget.js';

const PCM_SOCKET_PATH = '/playback/pcm';
export const LONG_WAVEFORM_TIMING_BUDGET = Object.freeze(
  performanceTimingBudget('gapless-playback.playbackBoundaryMs'),
);

function isPlaybackPcmSocket(url) {
  return new URL(url).pathname === PCM_SOCKET_PATH;
}

function parseControlFrame(payload) {
  if (typeof payload !== 'string') return null;
  const value = JSON.parse(payload);
  return value && typeof value === 'object' ? value : null;
}

function parsePcmFrame(payload) {
  if (typeof payload === 'string') return null;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== 65 || view.getUint8(1) !== 72
      || view.getUint8(2) !== 80 || view.getUint8(3) !== 67) return null;
  const frameCount = view.getUint32(20, false);
  if (view.getUint8(4) !== 1 || frameCount <= 0
      || bytes.byteLength !== 24 + (frameCount * 8)) return null;
  const sampleCount = frameCount * 2;
  const samples = [];
  let finiteSamples = 0;
  let nonZeroSamples = 0;
  let peakSample = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getFloat32(24 + (index * 4), true);
    if (Number.isFinite(sample)) finiteSamples += 1;
    if (sample !== 0) nonZeroSamples += 1;
    peakSample = Math.max(peakSample, Math.abs(sample));
    if (samples.length < 32) samples.push(sample);
  }
  return {
    type: 'pcm',
    role: view.getUint8(5) === 0 ? 'current' : 'continuity',
    generation: view.getUint32(8, false),
    streamId: view.getUint32(12, false),
    sequence: view.getUint32(16, false),
    frameCount,
    finiteSamples,
    nonZeroSamples,
    peakSample,
    samples,
  };
}

export function summarizeTrackPlaybackEvidence({ after, events, path, renderer }) {
  const normalizedPath = String(path || '');
  const eventIndex = Math.max(0, Number(after?.eventIndex || 0));
  const relevantEvents = events.slice(eventIndex);
  const pathOpens = relevantEvents.filter((event) => (
    event.direction === 'sent'
      && event.type === 'open'
      && event.path === normalizedPath
  ));
  const rendererMatches = String(renderer?.path || '') === normalizedPath
    && Number(renderer?.generation || 0) > 0
    && Number(renderer?.currentStreamId || 0) > 0;
  const opened = pathOpens.find((event) => (
    rendererMatches
      && Number(event.generation) === Number(renderer.generation)
      && Number(event.streamId) === Number(renderer.currentStreamId)
  )) || (rendererMatches ? null : pathOpens[0]);
  const baselineMatches = !opened
    && rendererMatches
    && String(after?.path || '') === normalizedPath
    && Number(after?.generation || 0) === Number(renderer.generation)
    && Number(after?.streamId || 0) === Number(renderer.currentStreamId);
  const generation = Number(
    (rendererMatches ? renderer.generation : 0)
      || opened?.generation
      || (baselineMatches ? after.generation : 0),
  );
  const streamId = Number(
    (rendererMatches ? renderer.currentStreamId : 0)
      || opened?.streamId
      || (baselineMatches ? after.streamId : 0),
  );
  if (!generation || !streamId) return null;
  const productionPcm = renderer?.pcmEvidence
    && Number(renderer.pcmEvidence.generation) === generation
    && Number(renderer.pcmEvidence.streamId) === streamId
    ? renderer.pcmEvidence
    : null;
  const baselinePcmFrames = baselineMatches ? Number(after?.pcmFrames || 0) : 0;
  const baselineFiniteSamples = baselineMatches ? Number(after?.finiteSamples || 0) : 0;
  const baselineNonZeroSamples = baselineMatches ? Number(after?.nonZeroSamples || 0) : 0;
  const observedPcmFrames = Math.max(
    0,
    Number(productionPcm?.frames || 0) - baselinePcmFrames,
  );
  const observedFiniteSamples = Math.max(
    0,
    Number(productionPcm?.finiteSamples || 0) - baselineFiniteSamples,
  );
  const observedNonZeroSamples = Math.max(
    0,
    Number(productionPcm?.nonZeroSamples || 0) - baselineNonZeroSamples,
  );
  const evidence = {
    path: normalizedPath,
    generation,
    streamId,
    pcmFrames: observedPcmFrames,
    finiteSamples: observedFiniteSamples,
    nonZeroSamples: observedNonZeroSamples,
    peakSample: observedNonZeroSamples > 0 ? Number(productionPcm?.peakSample || 0) : 0,
    samples: Array.from(productionPcm?.samples || []).slice(0, 32),
    renderedFrameDelta: Number(renderer?.renderedFrame || 0)
      - (baselineMatches ? Number(after?.renderedFrame || 0) : 0),
    firstFrameAtMs: Number(renderer?.firstFrameAtMs || 0),
    observedAtMs: Number(renderer?.observedAtMs || 0),
  };
  if (Number(renderer?.generation || 0) !== generation
      || Number(renderer?.currentStreamId || 0) !== streamId) return null;
  return evidence;
}

async function readPlaybackRendererCheckpoint(page) {
  // parity-check: allow-read-only-measurement-evaluate -- exact current stream and renderer progress
  return page.evaluate(() => {
    if (typeof getStreamingPlaybackSnapshot !== 'function' || typeof state === 'undefined') {
      return {
        generation: 0, streamId: 0, renderedFrame: 0, firstFrameAtMs: 0,
        path: '', pcmEvidence: null,
      };
    }
    const snapshot = getStreamingPlaybackSnapshot();
    const pcmEvidence = snapshot.diagnostics?.renderedPcmEvidence || null;
    return {
      generation: Number(snapshot.generation || 0),
      currentStreamId: Number(
        pcmEvidence?.streamId
          || state.player?.streaming?.roles?.current?.streamId
          || 0,
      ),
      renderedFrame: Number(snapshot.renderedFrame || 0),
      firstFrameAtMs: Number(snapshot.diagnostics?.firstFrameAtMs || 0),
      observedAtMs: performance.now(),
      path: String(state.player?.current?.path || ''),
      pcmEvidence: pcmEvidence
        ? { ...pcmEvidence }
        : null,
    };
  });
}

export function observePlaybackPcmTraffic(page) {
  const sockets = [];
  const controls = [];
  const events = [];
  const receivedFrameDiagnostics = [];
  const waiters = new Set();
  const matches = (control, criteria) => Object.entries(criteria)
    .every(([key, value]) => control[key] === value);
  const notifyWaiters = (control) => {
    for (const waiter of [...waiters]) {
      if (!matches(control, waiter.criteria)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
      waiter.resolve({ ...control });
    }
  };
  const onSocket = (socket) => {
    if (!isPlaybackPcmSocket(socket.url())) return;
    const record = { url: socket.url(), openedAtEpochMs: Date.now(), closedAtEpochMs: null };
    sockets.push(record);
    socket.on('framesent', ({ payload }) => {
      const control = parseControlFrame(payload);
      if (control) {
        const record = { ...control, sentAtEpochMs: Date.now() };
        controls.push(record);
        events.push({ direction: 'sent', ...record });
        notifyWaiters(record);
      }
    });
    socket.on('framereceived', ({ payload }) => {
      const pcm = parsePcmFrame(payload);
      if (pcm) {
        events.push({ direction: 'received', ...pcm, receivedAtEpochMs: Date.now() });
      } else if (typeof payload !== 'string') {
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        receivedFrameDiagnostics.push({
          byteLength: bytes.byteLength,
          header: Array.from(bytes.subarray(0, Math.min(24, bytes.byteLength))),
        });
      }
    });
    socket.on('close', () => { record.closedAtEpochMs = Date.now(); });
  };
  page.on('websocket', onSocket);
  return {
    mark() {
      return controls.length;
    },
    eventMark() {
      return events.length;
    },
    async playbackMark() {
      const renderer = await readPlaybackRendererCheckpoint(page);
      return {
        eventIndex: events.length,
        ...renderer,
        pcmFrames: Number(renderer.pcmEvidence?.frames || 0),
        finiteSamples: Number(renderer.pcmEvidence?.finiteSamples || 0),
        nonZeroSamples: Number(renderer.pcmEvidence?.nonZeroSamples || 0),
        peakSample: Number(renderer.pcmEvidence?.peakSample || 0),
        samples: Array.from(renderer.pcmEvidence?.samples || []).slice(0, 32),
      };
    },
    snapshotSince(mark) {
      return controls.slice(mark).map((control) => ({ ...control }));
    },
    eventsSince(mark) {
      return events.slice(mark).map((event) => ({ ...event }));
    },
    socketCount() {
      return sockets.length;
    },
    activeSocketCount() {
      return sockets.filter((socket) => socket.closedAtEpochMs === null).length;
    },
    waitForControl(criteria, options = {}) {
      const existing = controls.find((control) => matches(control, criteria));
      if (existing) return Promise.resolve({ ...existing });
      return new Promise((resolve, reject) => {
        const waiter = { criteria: { ...criteria }, resolve, timeoutId: null };
        waiter.timeoutId = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Playback PCM control was not observed: ${JSON.stringify(criteria)}`));
        }, options.timeout || 60000);
        waiters.add(waiter);
      });
    },
    async waitForTrackPlaybackEvidence({ after, path }, options = {}) {
      const minimumFrames = Math.max(1, Number(options.minimumFrames || 1));
      const timeout = Math.max(1, Number(options.timeout || 60000));
      const deadline = Date.now() + timeout;
      let lastTargetCandidate = null;
      let lastTargetRenderer = null;
      let sawTargetRenderer = false;
      while (Date.now() <= deadline) {
        const renderer = await readPlaybackRendererCheckpoint(page);
        const evidence = summarizeTrackPlaybackEvidence({ after, events, path, renderer });
        if (String(renderer.path || '') === String(path || '')) {
          sawTargetRenderer = true;
          lastTargetRenderer = renderer;
          lastTargetCandidate = evidence;
        } else if (sawTargetRenderer) {
          break;
        }
        if (evidence
            && evidence.pcmFrames >= minimumFrames
            && evidence.finiteSamples >= evidence.pcmFrames * 2
            && evidence.nonZeroSamples > 0
            && evidence.peakSample > 0
            && evidence.renderedFrameDelta > 0
            && evidence.firstFrameAtMs > 0) return evidence;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const renderer = await readPlaybackRendererCheckpoint(page);
      const compactEvents = events.slice(-12).map(({ samples, ...event }) => event);
      throw new Error(
        `Exact playback evidence was not observed for ${JSON.stringify(path)}: `
        + JSON.stringify({
          events: compactEvents,
          malformedBinaryFrames: receivedFrameDiagnostics.slice(-3),
          lastTargetCandidate,
          lastTargetRenderer,
          renderer,
          socketCount: sockets.length,
        }),
      );
    },
    async waitForBackgroundSettled(options = {}) {
      await page.waitForFunction(() => (
        typeof state === 'undefined'
        || Number(state.player?.decodedTrackPromises?.size || 0) === 0
      ), undefined, { timeout: options.timeout || 5000 });
    },
    stop() {
      page.off('websocket', onSocket);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve(null);
      }
      waiters.clear();
    },
  };
}

export function observeWaveformTraffic(page) {
  const requests = [];
  const waiters = new Set();
  const matches = (record, criteria) => (
    (!criteria.path || record.path === criteria.path)
    && (criteria.cachedOnly === undefined || record.cachedOnly === criteria.cachedOnly)
    && (criteria.status === undefined || record.response?.status === criteria.status)
  );
  const notifyWaiters = (record) => {
    for (const waiter of [...waiters]) {
      const recordIndex = requests.indexOf(record);
      if (!record.response || recordIndex < waiter.afterMark
          || !matches(record, waiter.criteria)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
      waiter.resolve({ ...record, response: { ...record.response } });
    }
  };
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== '/playback/waveform') return;
    requests.push({
      cachedOnly: url.searchParams.get('cachedOnly') === '1',
      path: String(url.searchParams.get('path') || ''),
      requestedAtEpochMs: Date.now(),
      request,
      response: null,
    });
  };
  const onResponse = async (response) => {
    const request = response.request();
    const record = requests.find((candidate) => candidate.request === request);
    if (!record) return;
    const receivedAtEpochMs = Date.now();
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    record.response = {
      payload,
      receivedAtEpochMs,
      status: response.status(),
    };
    notifyWaiters(record);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    mark() {
      return requests.length;
    },
    snapshotSince(mark) {
      return requests.slice(mark).map(({ request, ...record }) => ({
        ...record,
        response: record.response ? { ...record.response } : null,
      }));
    },
    waitForResponse(criteria, options = {}) {
      const afterMark = Math.max(0, Number(options.afterMark || 0));
      const existing = requests.slice(afterMark)
        .find((record) => record.response && matches(record, criteria));
      if (existing) {
        const { request, ...record } = existing;
        return Promise.resolve({ ...record, response: { ...record.response } });
      }
      return new Promise((resolve, reject) => {
        const waiter = { afterMark, criteria: { ...criteria }, resolve, timeoutId: null };
        waiter.timeoutId = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Waveform response was not observed: ${JSON.stringify(criteria)}`));
        }, options.timeout || 60000);
        waiters.add(waiter);
      });
    },
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve(null);
      }
      waiters.clear();
    },
  };
}

export async function createPlaybackLifecycleObserver(page) {
  // parity-check: allow-read-only-measurement-evaluate -- retain production playback resources across a visible replacement click
  const handle = await page.evaluateHandle(() => {
    const engine = state.player?.streaming;
    const context = engine?.context;
    if (!context || !engine?.node || !engine?.socket) {
      throw new Error('Production streaming playback resources are unavailable.');
    }
    return {
      context,
      node: engine.node,
      socket: engine.socket,
    };
  });
  return {
    async checkpoint() {
      // parity-check: allow-read-only-measurement-evaluate -- compare retained resources without replacing or wrapping them
      return page.evaluate((observer) => {
        const engine = state.player?.streaming;
        return {
          contextState: String(engine?.context?.state || ''),
          sameContext: engine?.context === observer.context,
          sameNode: engine?.node === observer.node,
          sameSocket: engine?.socket === observer.socket,
        };
      }, handle);
    },
    async stop() {
      await handle.dispose();
    },
  };
}

export async function createStreamingReplacementDiagnosticsObserver(page) {
  // parity-check: allow-read-only-measurement-evaluate -- retain a bounded timeline for CI-only replacement diagnosis
  const handle = await page.evaluateHandle(() => {
    const startedAt = performance.now();
    const samples = [];
    let lastSignature = '';
    const sample = (source) => {
      const snapshot = typeof getStreamingPlaybackSnapshot === 'function'
        ? getStreamingPlaybackSnapshot()
        : null;
      const engine = typeof state === 'undefined' ? null : state.player?.streaming;
      const diagnostics = snapshot?.diagnostics || {};
      const value = {
        activeRoles: [...(diagnostics.activeRoles || [])],
        bufferedFrames: { ...(diagnostics.bufferedFrames || {}) },
        continuityStreamId: Number(engine?.roles?.continuity?.streamId || 0),
        currentStreamId: Number(engine?.roles?.current?.streamId || 0),
        currentTime: Number(snapshot?.currentTime || 0),
        elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
        inFlightFrames: { ...(diagnostics.inFlightFrames || {}) },
        mode: String(snapshot?.mode || ''),
        pendingPromotionStreamId: Number(engine?.pendingPromotion?.streamId || 0),
        pendingSeek: engine?.pendingSeek ? {
          currentStreamId: Number(engine.pendingSeek.currentStreamId || 0),
          kind: String(engine.pendingSeek.kind || ''),
          prepareSent: Boolean(engine.pendingSeek.prepareSent),
          streamId: Number(engine.pendingSeek.streamId || 0),
        } : null,
        source,
        underruns: Number(diagnostics.underruns || 0),
      };
      const signature = JSON.stringify({
        activeRoles: value.activeRoles,
        bufferedFrames: value.bufferedFrames,
        continuityStreamId: value.continuityStreamId,
        currentStreamId: value.currentStreamId,
        inFlightFrames: value.inFlightFrames,
        mode: value.mode,
        pendingPromotionStreamId: value.pendingPromotionStreamId,
        pendingSeek: value.pendingSeek,
        underruns: value.underruns,
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        samples.push(value);
        if (samples.length > 500) samples.shift();
      }
    };
    sample('initial');
    const intervalId = setInterval(() => sample('interval'), 10);
    return {
      finish() {
        clearInterval(intervalId);
        sample('final');
        return [...samples];
      },
    };
  });
  let finished = false;
  return {
    async finish() {
      if (finished) return [];
      finished = true;
      // parity-check: allow-read-only-measurement-evaluate -- stop and read the bounded CI playback observer without changing application state
      const samples = await handle.evaluate((observer) => observer.finish());
      await handle.dispose();
      return samples;
    },
  };
}

export function findPromotedReplacementOpen(events, path) {
  for (const [openIndex, event] of events.entries()) {
    if (event.direction !== 'sent'
        || event.type !== 'open'
        || event.role !== 'continuity'
        || event.path !== path) continue;
    const relativePromotionIndex = events.slice(openIndex + 1).findIndex((candidate) => (
      candidate.direction === 'sent'
        && candidate.type === 'promote'
        && candidate.generation === event.generation
        && candidate.streamId === event.streamId
    ));
    if (relativePromotionIndex >= 0) {
      return {
        open: event,
        promotionIndex: openIndex + relativePromotionIndex + 1,
      };
    }
  }
  return null;
}

export function assertActiveReplacementContract(expect, {
  activeSocketCount,
  afterDiagnostics,
  beforeDiagnostics,
  events,
  lifecycle,
  path,
  socketCount,
}) {
  const replacementOpens = events.filter((event) => (
    event.direction === 'sent'
      && event.type === 'open'
      && event.role === 'continuity'
      && event.path === path
  ));
  expect(replacementOpens.length, 'the visible replacement click must open the selected track as continuity')
    .toBeGreaterThan(0);
  const promotedReplacement = findPromotedReplacementOpen(events, path);
  expect(promotedReplacement, 'the selected replacement stream must be promoted').toBeTruthy();
  const replacementOpen = promotedReplacement.open;
  const promotionIndex = promotedReplacement.promotionIndex;
  const receivedBeforePromotion = events.slice(0, promotionIndex)
    .filter((event) => (
      event.direction === 'received'
        && event.type === 'pcm'
        && event.generation === replacementOpen.generation
        && event.streamId === replacementOpen.streamId
    ))
    .reduce((total, event) => total + Number(event.frameCount || 0), 0);
  const pcmBeforePromotion = events.slice(0, promotionIndex).filter((event) => (
    event.direction === 'received'
      && event.type === 'pcm'
      && event.generation === replacementOpen.generation
      && event.streamId === replacementOpen.streamId
  ));
  const finiteSamplesBeforePromotion = pcmBeforePromotion
    .reduce((total, event) => total + Number(event.finiteSamples || 0), 0);
  const nonZeroSamplesBeforePromotion = pcmBeforePromotion
    .reduce((total, event) => total + Number(event.nonZeroSamples || 0), 0);
  const peakSampleBeforePromotion = Math.max(
    0,
    ...pcmBeforePromotion.map((event) => Number(event.peakSample || 0)),
  );
  expect(
    receivedBeforePromotion,
    'the selected replacement must receive one second of actual PCM before promotion',
  ).toBeGreaterThanOrEqual(48000);
  expect(finiteSamplesBeforePromotion).toBeGreaterThanOrEqual(receivedBeforePromotion * 2);
  expect(nonZeroSamplesBeforePromotion).toBeGreaterThan(0);
  expect(peakSampleBeforePromotion).toBeGreaterThan(0);
  expect(afterDiagnostics.renderedPcmEvidence?.streamId).toBe(replacementOpen.streamId);
  expect(afterDiagnostics.renderedPcmEvidence?.nonZeroSamples).toBeGreaterThan(0);
  expect(afterDiagnostics.renderedPcmEvidence?.peakSample).toBeGreaterThan(0);
  expect(afterDiagnostics.underruns).toBe(beforeDiagnostics.underruns);
  expect(afterDiagnostics.generation).toBe(beforeDiagnostics.generation);
  expect(afterDiagnostics.paused).toBe(false);
  expect(afterDiagnostics.mode).toBe('playing');
  expect(afterDiagnostics.lastError).toBeNull();
  expect(socketCount).toBe(1);
  expect(activeSocketCount).toBe(1);
  expect(lifecycle.sameContext).toBe(true);
  expect(lifecycle.sameNode).toBe(true);
  expect(lifecycle.sameSocket).toBe(true);
  expect(lifecycle.contextState).toBe('running');
}

export async function waitForActivePlaybackWindow(page, startingTime, options = {}) {
  const seconds = Number(options.seconds || 1);
  await page.waitForFunction(({ start, requiredSeconds }) => {
    if (typeof getStreamingPlaybackSnapshot !== 'function') return false;
    const snapshot = getStreamingPlaybackSnapshot();
    return snapshot.paused === false
      && Number(snapshot.currentTime || 0) >= start + requiredSeconds;
  }, {
    requiredSeconds: seconds,
    start: Number(startingTime || 0),
  }, { timeout: options.timeout || 60000 });
  return readGaplessPlaybackDiagnostics(page);
}

export function assertPersistentWaveformCacheContract(expect, {
  rendered,
  requests,
  response,
}) {
  expect(requests).toHaveLength(1);
  expect(requests[0].cachedOnly).toBe(true);
  expect(requests[0].response?.status).toBe(200);
  expect(response.response.status).toBe(200);
  expect(response.response.payload?.sampleCount).toBe(280);
  expect(response.response.payload?.left).toHaveLength(280);
  expect(response.response.payload?.right).toHaveLength(280);
  expect(rendered.leftPeaks).toEqual(response.response.payload.left);
  expect(rendered.rightPeaks).toEqual(response.response.payload.right);
  expect(rendered.renderedAtEpochMs).toBeGreaterThanOrEqual(
    response.response.receivedAtEpochMs,
  );
}

export async function readGaplessPlaybackDiagnostics(page) {
  // parity-check: allow-read-only-measurement-evaluate -- production bounded streaming diagnostics and worklet boundary capture
  return page.evaluate(() => {
    if (typeof getStreamingPlaybackSnapshot !== 'function' || typeof state === 'undefined') {
      throw new Error('Production streaming playback diagnostics are unavailable.');
    }
    const snapshot = getStreamingPlaybackSnapshot();
    const streaming = state.player?.streaming || {};
    const diagnostics = snapshot.diagnostics || {};
    const sampleRate = Number(snapshot.sampleRate || 48000);
    return {
      mode: String(snapshot.mode || ''),
      generation: Number(snapshot.generation || 0),
      currentTime: Number(snapshot.currentTime || 0),
      paused: Boolean(snapshot.paused),
      src: String(snapshot.src || ''),
      sampleRate,
      activeRoles: [...(diagnostics.activeRoles || [])],
      bufferedFrames: { ...(diagnostics.bufferedFrames || {}) },
      inFlightFrames: { ...(diagnostics.inFlightFrames || {}) },
      currentCapacityFrames: Number(streaming.limits?.currentSeconds || 0) * sampleRate,
      continuityCapacityFrames: Number(streaming.limits?.continuitySeconds || 0) * sampleRate,
      underruns: Number(diagnostics.underruns || 0),
      lastError: diagnostics.lastError || null,
      seekReadinessException: diagnostics.seekReadinessException || null,
      seekRequestedAtMs: Number(diagnostics.seekRequestedAtMs || 0),
      seekCommittedAtMs: Number(diagnostics.seekCommittedAtMs || 0),
      seekSilentFrames: Number(diagnostics.seekSilentFrames || 0),
      seekCapture: diagnostics.seekCapture || null,
      firstFrameAtEpochMs: diagnostics.firstFrameAtMs
        ? performance.timeOrigin + Number(diagnostics.firstFrameAtMs)
        : 0,
      firstFrameAtMs: Number(diagnostics.firstFrameAtMs || 0),
      roleOpenedAtMs: {
        current: Number(diagnostics.roleOpenedAtMs?.current || 0),
        continuity: Number(diagnostics.roleOpenedAtMs?.continuity || 0),
      },
      roleOpenedAtEpochMs: {
        current: diagnostics.roleOpenedAtMs?.current
          ? performance.timeOrigin + Number(diagnostics.roleOpenedAtMs.current)
          : 0,
        continuity: diagnostics.roleOpenedAtMs?.continuity
          ? performance.timeOrigin + Number(diagnostics.roleOpenedAtMs.continuity)
          : 0,
      },
      boundaryCapture: diagnostics.boundaryCapture || null,
      currentStreamId: Number(streaming.roles?.current?.streamId || 0),
      continuityStreamId: Number(streaming.roles?.continuity?.streamId || 0),
      pendingPromotionStreamId: Number(streaming.pendingPromotion?.streamId || 0),
      pcmEvidence: diagnostics.pcmEvidence ? { ...diagnostics.pcmEvidence } : null,
      renderedPcmEvidence: diagnostics.renderedPcmEvidence
        ? { ...diagnostics.renderedPcmEvidence }
        : null,
      decodedTrackCacheSize: Number(state.player?.decodedTrackCache?.size || 0),
    };
  });
}

export function assertLongWaveformTimingBudget(expect, waveform) {
  return expectTimingBudget(
    expect,
    Number(waveform.renderedAtMs) - Number(waveform.firstFrameAtMs),
    LONG_WAVEFORM_TIMING_BUDGET,
    'six-minute waveform render',
  );
}

export function assertNearEndSeekContract(expect, {
  activeSocketCount,
  controls,
  currentAlreadySelected = false,
  diagnostics,
  path,
  seekResult,
  socketCount,
  successorPath,
  expectedSeekCapture,
}) {
  expect(seekResult.seekRequestedAtMs, 'the engine must capture seek entry on performance.now').toBeGreaterThan(0);
  expect(diagnostics.seekRequestedAtMs).toBe(seekResult.seekRequestedAtMs);
  expect(seekResult.seekCommittedAtMs).toBeGreaterThanOrEqual(seekResult.seekRequestedAtMs);
  expect(seekResult.firstFrameAtMs).toBeGreaterThanOrEqual(seekResult.seekCommittedAtMs);
  expect(seekResult.seekSilentFrames, 'a visible seek must not render zero-filled frames').toBe(0);
  expect(diagnostics.seekSilentFrames).toBe(0);
  expect(
    seekResult.durationAfterSeek,
    'a prepared seek tail must not redefine the established whole-track duration',
  ).toBe(seekResult.durationBeforeSeek);
  expect(
    Math.abs(seekResult.timelineValueAfterSeek - seekResult.targetSeconds),
    'the visible waveform cursor must stay at the committed seek position',
  ).toBeLessThanOrEqual(0.25);
  expect(seekResult.seekCapture).toBeTruthy();
  expect(seekResult.seekCapture.outgoing.frames).toBeGreaterThan(0);
  expect(seekResult.seekCapture.incoming.frames).toBeGreaterThan(0);
  if (expectedSeekCapture) {
    expectChannelSamples(
      expect,
      seekResult.seekCapture.outgoing.left.slice(0, seekResult.seekCapture.outgoing.frames),
      Array(seekResult.seekCapture.outgoing.frames).fill(expectedSeekCapture.outgoing),
      'seek outgoing left',
      expectedSeekCapture.tolerance,
    );
    expectChannelSamples(
      expect,
      seekResult.seekCapture.outgoing.right.slice(0, seekResult.seekCapture.outgoing.frames),
      Array(seekResult.seekCapture.outgoing.frames).fill(expectedSeekCapture.outgoing),
      'seek outgoing right',
      expectedSeekCapture.tolerance,
    );
    expectChannelSamples(
      expect,
      seekResult.seekCapture.incoming.left.slice(0, seekResult.seekCapture.incoming.frames),
      Array(seekResult.seekCapture.incoming.frames).fill(expectedSeekCapture.incoming),
      'seek incoming left',
      expectedSeekCapture.tolerance,
    );
    expectChannelSamples(
      expect,
      seekResult.seekCapture.incoming.right.slice(0, seekResult.seekCapture.incoming.frames),
      Array(seekResult.seekCapture.incoming.frames).fill(expectedSeekCapture.incoming),
      'seek incoming right',
      expectedSeekCapture.tolerance,
    );
  }
  expect(seekResult.visibleReadinessErrors, 'near-end readiness must not surface an error').toEqual([]);
  expect(activeSocketCount, 'the production playback WebSocket must remain connected').toBe(1);
  expect(socketCount, 'the near-end seek must not replace the production playback WebSocket').toBe(1);
  expect(diagnostics.generation).toBe(seekResult.generation);
  expect(diagnostics.currentTime).toBeGreaterThanOrEqual(seekResult.targetSeconds - 0.25);
  expect(diagnostics.activeRoles).toContain('current');
  expect(diagnostics.activeRoles.length).toBeLessThanOrEqual(2);
  expect(diagnostics.activeRoles.every((role) => ['current', 'continuity'].includes(role))).toBe(true);
  expect(
    diagnostics.bufferedFrames.current + diagnostics.inFlightFrames.current,
  ).toBeLessThanOrEqual(diagnostics.currentCapacityFrames);
  expect(diagnostics.lastError?.source || '').not.toMatch(/seek|readiness/i);
  if (diagnostics.seekReadinessException && typeof diagnostics.seekReadinessException === 'object') {
    expect(diagnostics.seekReadinessException.visible).not.toBe(true);
  }

  const seekClose = controls.find((control) => (
    control.type === 'close' && control.reason === 'seek-replaced'
  ));
  if (seekResult.continuityStreamIdBeforeSeek) {
    expect(seekClose, 'an existing continuity stream must be closed before the prepared seek').toBeTruthy();
  }
  const seekCloseIndex = seekClose ? controls.indexOf(seekClose) : -1;
  const preparedSeek = controls.find((control, index) => (
    index > seekCloseIndex
      && control.type === 'open'
      && control.role === 'continuity'
      && control.path === path
  ));
  expect(preparedSeek).toBeTruthy();
  const preparedSeekIndex = controls.indexOf(preparedSeek);
  const selectedTrackOpen = controls.slice(0, preparedSeekIndex).findLast((control) => (
    control.type === 'open' && control.path === path
  ));
  if (!selectedTrackOpen) {
    expect(
      currentAlreadySelected,
      'the traffic window may omit the selected-track open only when current identity was verified before marking',
    ).toBe(true);
  } else if (selectedTrackOpen.role === 'continuity') {
    const selectedPromotion = controls.slice(0, seekCloseIndex).find((control) => (
      control.type === 'promote' && control.streamId === selectedTrackOpen.streamId
    ));
    expect(
      selectedPromotion,
      'a visibly selected replacement prepared as continuity must be promoted before its seek',
    ).toBeTruthy();
  } else {
    expect(selectedTrackOpen.role).toBe('current');
  }
  if (selectedTrackOpen) expect(preparedSeek.generation).toBe(selectedTrackOpen.generation);
  expect(preparedSeek.generation).toBe(seekResult.generation);
  if (seekClose) {
    expect(controls.indexOf(seekClose)).toBeLessThan(controls.indexOf(preparedSeek));
  }
  const promotion = controls.find((control) => (
    control.type === 'promote' && control.streamId === preparedSeek.streamId
  ));
  expect(promotion).toBeTruthy();
  const successorOpen = controls.find((control, index) => (
    index > controls.indexOf(promotion)
      && control.type === 'open'
      && control.role === 'continuity'
      && control.path === successorPath
      && control.generation === seekResult.generation
  ));
  expect(successorOpen, 'the queued successor is restored only after the prepared seek is promoted').toBeTruthy();
  expect(diagnostics.roleOpenedAtMs.continuity).toBeGreaterThanOrEqual(seekResult.firstFrameAtMs);
}

function expectChannelSamples(expect, actual, expected, label, tolerance) {
  expect(actual.length, `${label} sample count`).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(
      Math.abs(Number(actual[index]) - Number(expected[index])),
      `${label}[${index}]`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

export function assertGaplessBoundaryCapture(expect, capture, expected) {
  expect(capture).toBeTruthy();
  const tolerance = Number(expected?.tolerance || 0);
  for (const side of ['outgoing', 'incoming']) {
    expect(Number(capture[side]?.frames || 0)).toBeGreaterThan(0);
    expect(Number(capture[side]?.frames || 0)).toBeLessThanOrEqual(64);
    for (const channel of ['left', 'right']) {
      expectChannelSamples(
        expect,
        Array.from(capture[side]?.[channel] || []),
        Array.from(expected?.[side]?.[channel] || []),
        `${side}.${channel}`,
        tolerance,
      );
    }
  }
}

export function assertAudibleBoundaryCapture(expect, capture, expectedSigns = {}) {
  expect(capture).toBeTruthy();
  for (const side of ['outgoing', 'incoming']) {
    const frames = Number(capture[side]?.frames || 0);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(64);
    for (const channel of ['left', 'right']) {
      const samples = Array.from(capture[side]?.[channel] || []).slice(0, frames);
      expect(samples).toHaveLength(frames);
      expect(samples.some((sample) => Math.abs(Number(sample)) > 0)).toBe(true);
      const expectedSign = Number(expectedSigns[side] || 0);
      if (expectedSign) {
        const mean = samples.reduce((total, sample) => total + Number(sample), 0) / samples.length;
        expect(Math.sign(mean)).toBe(expectedSign);
        expect(Math.abs(mean)).toBeGreaterThan(0.01);
      }
    }
  }
}

export async function waitForGaplessBoundary(page, options = {}) {
  await page.waitForFunction((expectedStreamId) => {
    if (typeof getStreamingPlaybackSnapshot !== 'function' || typeof state === 'undefined') {
      return false;
    }
    const snapshot = getStreamingPlaybackSnapshot();
    const streaming = state.player?.streaming || {};
    return Boolean(snapshot.diagnostics?.boundaryCapture)
      && !streaming.pendingPromotion
      && Number(streaming.roles?.current?.streamId || 0) === expectedStreamId;
  }, Number(options.expectedPromotedStreamId || 0), { timeout: options.timeout || 60000 });
  return readGaplessPlaybackDiagnostics(page);
}
