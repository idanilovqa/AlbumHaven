const PLAYER_WAVEFORM_PEAK_COUNT = 280;
const PLAYER_WAVEFORM_DETAIL_PEAK_COUNT = 720;
const PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800]);
// A busy answer means the server is building other waveforms first, so player peaks keep asking
// at this pace for as long as their playback generation lasts.
const PLAYER_WAVEFORM_BUSY_RETRY_MAX_DELAY_MS = 2000;
const playerWaveformPeakCache = new Map();
// Pending peak requests: whether each is for the playing song, and how to stop it.
const playerWaveformPeakRequests = new WeakMap();
const playerWaveformPeakProbes = new Map();
const savedLoopWaveformPeakCache = new Map();
let playerWaveformPeakGeneration = null;
let playerWaveformPeakController = null;
let playerWaveformPeakCurrentIdentity = null;
let playerWaveformForegroundSuspensionDepth = 0;

function trimWaveformPeakCache() {
  while (playerWaveformPeakCache.size > 2) {
    const evicted = [...playerWaveformPeakCache.keys()]
      .find((identity) => identity !== playerWaveformPeakCurrentIdentity);
    if (!evicted) return;
    playerWaveformPeakCache.delete(evicted);
  }
}

function cancelWaveformPeakLoads(generation) {
  if (playerWaveformPeakGeneration !== generation) return;
  playerWaveformPeakController?.abort();
  playerWaveformPeakController = new AbortController();
  const prefix = `${generation}\u0000`;
  for (const identity of playerWaveformPeakCache.keys()) {
    if (identity.startsWith(prefix)) playerWaveformPeakCache.delete(identity);
  }
  for (const identity of playerWaveformPeakProbes.keys()) {
    if (identity.startsWith(prefix)) playerWaveformPeakProbes.delete(identity);
  }
  if (playerWaveformPeakCurrentIdentity?.startsWith(prefix)) {
    playerWaveformPeakCurrentIdentity = null;
  }
}

function validateWaveformPeakPayload(payload, sampleCount) {
  if (!payload || payload.sampleCount !== sampleCount
      || !Array.isArray(payload.left) || !Array.isArray(payload.right)
      || payload.left.length !== sampleCount || payload.right.length !== sampleCount) {
    return null;
  }
  const validPeak = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!payload.left.every(validPeak) || !payload.right.every(validPeak)) return null;
  return { sampleCount, left: [...payload.left], right: [...payload.right] };
}

function suspendPlayerWaveformPeakLoadsForForegroundView() {
  playerWaveformForegroundSuspensionDepth += 1;
  const generation = Number(state.player?.streaming?.generation) || 0;
  if (String(state.player?.current?.path || '')) {
    cancelWaveformPeakLoads(generation);
  }
  return { generation };
}

async function resumePlayerWaveformPeakLoadsAfterForegroundView(suspension) {
  if (!suspension || playerWaveformForegroundSuspensionDepth < 1) return null;
  playerWaveformForegroundSuspensionDepth -= 1;
  if (playerWaveformForegroundSuspensionDepth > 0) return null;

  const generation = Number(state.player?.streaming?.generation) || 0;
  const path = String(state.player?.current?.path || '');
  if (!path || generation !== Number(suspension.generation || 0)) return null;

  const peaks = await loadWaveformPeaks(path, PLAYER_WAVEFORM_DETAIL_PEAK_COUNT, generation, {
    current: true,
  });
  if (!peaks || playerWaveformForegroundSuspensionDepth > 0
      || Number(state.player?.streaming?.generation) !== generation
      || String(state.player?.current?.path || '') !== path) return null;
  state.player.waveform.compactPeaks = { path, generation, data: peaks };
  try {
    await updateWaveformAppearance();
  } catch (_error) {
    // Optional waveform rendering must not interrupt foreground navigation.
  }
  return peaks;
}

function retainSavedLoopWaveformPeaks(loopIds) {
  const retained = new Set(loopIds.map(String));
  for (const [identity, entry] of savedLoopWaveformPeakCache) {
    if (retained.has(identity)) continue;
    savedLoopWaveformPeakCache.delete(identity);
    entry.controller.abort();
  }
}

function getCachedSavedLoopWaveformPeaks(loopId) {
  return savedLoopWaveformPeakCache.get(String(loopId || '').trim())?.peaks || null;
}

async function loadSavedLoopWaveformPeaks(loopId) {
  const identity = String(loopId || '').trim();
  if (!identity || identity.length > 256) return null;
  if (savedLoopWaveformPeakCache.has(identity)) {
    const cached = savedLoopWaveformPeakCache.get(identity);
    return cached.promise;
  }

  const controller = new AbortController();
  const entry = { controller, promise: null, peaks: null };
  entry.promise = (async () => {
    let retained = false;
    try {
      const query = new URLSearchParams({
        loop_id: identity,
        bins: String(PLAYER_WAVEFORM_PEAK_COUNT),
      });
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`/playback/waveform?${query}`, {
          signal: controller.signal,
        });
        if (response.status === 429 && attempt < PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => {
            setTimeout(resolve, PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS[attempt]);
          });
          if (controller.signal.aborted) return null;
          continue;
        }
        if (!response.ok) return null;
        const peaks = validateWaveformPeakPayload(
          await response.json(),
          PLAYER_WAVEFORM_PEAK_COUNT,
        );
        retained = Boolean(peaks);
        entry.peaks = peaks;
        return peaks;
      }
    } catch (_error) {
      return null;
    } finally {
      if (!retained && savedLoopWaveformPeakCache.get(identity) === entry) {
        savedLoopWaveformPeakCache.delete(identity);
      }
    }
  })();
  savedLoopWaveformPeakCache.set(identity, entry);
  return entry.promise;
}

// A building waveform streams as NDJSON: partial peaks, then the complete ones. A cached
// or finished one answers as plain JSON.
async function readWaveformPeakResponse(response, sampleCount, onPartial) {
  if (!String(response.headers?.get?.('content-type') || '').includes('ndjson')) {
    return { peaks: validateWaveformPeakPayload(await response.json(), sampleCount) };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line);
      if (payload.error) return { busy: true };
      const peaks = validateWaveformPeakPayload(payload, sampleCount);
      if (!peaks || payload.complete) return { peaks };
      onPartial?.(peaks);
    }
    if (done) return { peaks: null };
  }
}

// Draws the playing song's waveform as far as it is built, never over a finished one.
function showPartialWaveformPeaks(path, generation, peaks) {
  const shown = state.player.waveform.compactPeaks;
  if (String(state.player.current?.path || '') !== path
      || state.player.streaming.generation !== generation
      || (shown?.path === path && !shown.partial)) return;
  state.player.waveform.compactPeaks = { path, generation, data: peaks, partial: true };
  if (typeof updateWaveformAppearance === 'function') {
    void Promise.resolve(updateWaveformAppearance()).catch(() => {});
  }
}

// The playing song's peaks are asked for with `current`, so the server builds them first at
// playback priority; any other load is a prefetch that yields to it.
async function loadWaveformPeaks(
  path,
  sampleCount = PLAYER_WAVEFORM_PEAK_COUNT,
  generation = 0,
  { current = false } = {},
) {
  const rawPath = String(path || '');
  if (!rawPath || ![PLAYER_WAVEFORM_PEAK_COUNT, PLAYER_WAVEFORM_DETAIL_PEAK_COUNT].includes(sampleCount)) return null;
  if (playerWaveformForegroundSuspensionDepth > 0) return null;
  if (playerWaveformPeakGeneration !== generation) {
    playerWaveformPeakController?.abort();
    playerWaveformPeakController = new AbortController();
    playerWaveformPeakGeneration = generation;
    playerWaveformPeakCurrentIdentity = null;
  } else if (!playerWaveformPeakController) {
    playerWaveformPeakController = new AbortController();
  }
  const identity = `${generation}\u0000${sampleCount}\u0000${rawPath}`;
  if (playerWaveformPeakCache.has(identity)) {
    const cached = playerWaveformPeakCache.get(identity);
    const pending = playerWaveformPeakRequests.get(cached);
    playerWaveformPeakCache.delete(identity);
    if (!current || !pending || pending.current) {
      playerWaveformPeakCache.set(identity, cached);
      return cached;
    }
    // This song is playing now: stop its prefetch and ask again at the playing song's priority.
    pending.controller.abort();
  }
  const pendingProbe = playerWaveformPeakProbes.get(identity);
  if (pendingProbe) {
    let probed = null;
    try {
      probed = await pendingProbe;
    } catch (_error) {
      probed = null;
    }
    if (probed) return probed;
    if (playerWaveformPeakController?.signal.aborted
        || state.player.streaming.generation !== generation) return null;
  }
  const generationSignal = playerWaveformPeakController.signal;
  const controller = new AbortController();
  const abortWithGeneration = () => controller.abort();
  generationSignal.addEventListener('abort', abortWithGeneration, { once: true });
  let request;
  request = (async () => {
    let retained = false;
    try {
      const query = new URLSearchParams({ path: rawPath, bins: String(sampleCount) });
      if (current) {
        query.set('priority', 'current');
        query.set('progressive', '1');
      }
      const showPartial = current
        ? (partial) => showPartialWaveformPeaks(rawPath, generation, partial)
        : null;
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`/playback/waveform?${query}`, { signal: controller.signal });
        const outcome = response.status === 429
          ? { busy: true }
          : response.ok ? await readWaveformPeakResponse(response, sampleCount, showPartial) : null;
        if (outcome?.busy) {
          await new Promise((resolve) => {
            setTimeout(resolve, PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS[attempt]
              ?? PLAYER_WAVEFORM_BUSY_RETRY_MAX_DELAY_MS);
          });
          if (controller.signal.aborted || state.player.streaming.generation !== generation) return null;
          continue;
        }
        const peaks = outcome?.peaks || null;
        if (controller.signal.aborted || state.player.streaming.generation !== generation) return null;
        if (!peaks) return null;
        retained = true;
        return peaks;
      }
    } catch (_error) {
      return null;
    } finally {
      generationSignal.removeEventListener('abort', abortWithGeneration);
      playerWaveformPeakRequests.delete(request);
      if (!retained && playerWaveformPeakCache.get(identity) === request) {
        playerWaveformPeakCache.delete(identity);
      }
    }
  })();
  playerWaveformPeakRequests.set(request, { current, controller });
  playerWaveformPeakCache.set(identity, request);
  trimWaveformPeakCache();
  return request;
}

async function probeCachedWaveformPeaks(path, generation = 0) {
  const rawPath = String(path || '');
  if (!rawPath) return null;
  if (playerWaveformPeakGeneration !== generation) {
    playerWaveformPeakController?.abort();
    playerWaveformPeakController = new AbortController();
    playerWaveformPeakGeneration = generation;
    playerWaveformPeakCurrentIdentity = null;
  } else if (!playerWaveformPeakController) {
    playerWaveformPeakController = new AbortController();
  }
  const identity = `${generation}\u0000${PLAYER_WAVEFORM_DETAIL_PEAK_COUNT}\u0000${rawPath}`;
  let peaks = null;
  if (playerWaveformPeakCache.has(identity)) {
    const cached = playerWaveformPeakCache.get(identity);
    playerWaveformPeakCache.delete(identity);
    playerWaveformPeakCache.set(identity, cached);
    try {
      peaks = await cached;
    } catch (_error) {
      return null;
    }
  } else if (playerWaveformPeakProbes.has(identity)) {
    try {
      peaks = await playerWaveformPeakProbes.get(identity);
    } catch (_error) {
      return null;
    }
  } else {
    const controller = playerWaveformPeakController;
    let probe;
    try {
      probe = (async () => {
        const query = new URLSearchParams({
          path: rawPath,
          bins: String(PLAYER_WAVEFORM_DETAIL_PEAK_COUNT),
          cachedOnly: '1',
        });
        const response = await fetch(`/playback/waveform?${query}`, { signal: controller.signal });
        if (!response.ok || response.status !== 200) return null;
        const cachedPeaks = validateWaveformPeakPayload(
          await response.json(),
          PLAYER_WAVEFORM_DETAIL_PEAK_COUNT,
        );
        if (!cachedPeaks || controller.signal.aborted
            || state.player.streaming.generation !== generation) return null;
        return cachedPeaks;
      })();
      playerWaveformPeakProbes.set(identity, probe);
      peaks = await probe;
      if (!peaks) return null;
      playerWaveformPeakCache.delete(identity);
      playerWaveformPeakCache.set(identity, Promise.resolve(peaks));
      trimWaveformPeakCache();
    } catch (_error) {
      return null;
    } finally {
      if (playerWaveformPeakProbes.get(identity) === probe) {
        playerWaveformPeakProbes.delete(identity);
      }
    }
  }
  if (!peaks || state.player.streaming.generation !== generation
      || String(state.player.current?.path || '') !== rawPath) return null;
  playerWaveformPeakCurrentIdentity = identity;
  trimWaveformPeakCache();
  state.player.waveform.compactPeaks = { path: rawPath, generation, data: peaks };
  try {
    await updateWaveformAppearance();
  } catch (_error) {
    // Waveform rendering remains optional and must never interrupt playback.
  }
  return peaks;
}

async function promoteWaveformPeaks(completedPath, currentPath, generation) {
  const completedIdentity = `${generation}\u0000${PLAYER_WAVEFORM_DETAIL_PEAK_COUNT}\u0000${String(completedPath || '')}`;
  const currentIdentity = `${generation}\u0000${PLAYER_WAVEFORM_DETAIL_PEAK_COUNT}\u0000${String(currentPath || '')}`;
  if (state.player.streaming.generation === generation) {
    // The promoted song plays now, so a prefetch still building for it is upgraded.
    await loadWaveformPeaks(currentPath, PLAYER_WAVEFORM_DETAIL_PEAK_COUNT, generation, {
      current: true,
    });
  }
  const cached = playerWaveformPeakCache.get(currentIdentity);
  const peaks = cached ? await cached : null;
  if (completedIdentity !== currentIdentity) {
    playerWaveformPeakCache.delete(completedIdentity);
  }
  if (!peaks || playerWaveformPeakCache.get(currentIdentity) !== cached) return null;
  playerWaveformPeakCache.delete(currentIdentity);
  playerWaveformPeakCache.set(currentIdentity, cached);
  playerWaveformPeakCurrentIdentity = currentIdentity;
  trimWaveformPeakCache();
  state.player.waveform.compactPeaks = {
    path: String(currentPath || ''),
    generation,
    data: peaks,
  };
  return peaks;
}
