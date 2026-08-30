const PLAYER_WAVEFORM_PEAK_COUNT = 280;
const PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800]);
const SAVED_LOOP_WAVEFORM_CACHE_LIMIT = 4;
const playerWaveformPeakCache = new Map();
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

  const peaks = await loadWaveformPeaks(path, PLAYER_WAVEFORM_PEAK_COUNT, generation);
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

function trimSavedLoopWaveformPeakCache() {
  while (savedLoopWaveformPeakCache.size > SAVED_LOOP_WAVEFORM_CACHE_LIMIT) {
    const oldestIdentity = savedLoopWaveformPeakCache.keys().next().value;
    const evicted = savedLoopWaveformPeakCache.get(oldestIdentity);
    savedLoopWaveformPeakCache.delete(oldestIdentity);
    evicted?.controller?.abort();
  }
}

async function loadSavedLoopWaveformPeaks(loopId) {
  const identity = String(loopId || '').trim();
  if (!identity || identity.length > 256) return null;
  if (savedLoopWaveformPeakCache.has(identity)) {
    const cached = savedLoopWaveformPeakCache.get(identity);
    savedLoopWaveformPeakCache.delete(identity);
    savedLoopWaveformPeakCache.set(identity, cached);
    return cached.promise;
  }

  const controller = new AbortController();
  const entry = { controller, promise: null };
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
  trimSavedLoopWaveformPeakCache();
  return entry.promise;
}

async function loadWaveformPeaks(path, sampleCount = PLAYER_WAVEFORM_PEAK_COUNT, generation = 0) {
  const rawPath = String(path || '');
  if (!rawPath || sampleCount !== PLAYER_WAVEFORM_PEAK_COUNT) return null;
  if (playerWaveformForegroundSuspensionDepth > 0) return null;
  if (playerWaveformPeakGeneration !== generation) {
    playerWaveformPeakController?.abort();
    playerWaveformPeakController = new AbortController();
    playerWaveformPeakGeneration = generation;
    playerWaveformPeakCurrentIdentity = null;
  } else if (!playerWaveformPeakController) {
    playerWaveformPeakController = new AbortController();
  }
  const identity = `${generation}\u0000${rawPath}`;
  if (playerWaveformPeakCache.has(identity)) {
    const cached = playerWaveformPeakCache.get(identity);
    playerWaveformPeakCache.delete(identity);
    playerWaveformPeakCache.set(identity, cached);
    return cached;
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
  const controller = playerWaveformPeakController;
  let request;
  request = (async () => {
    let retained = false;
    try {
      const query = new URLSearchParams({ path: rawPath, bins: String(sampleCount) });
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`/playback/waveform?${query}`, { signal: controller.signal });
        if (response.status === 429 && attempt < PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => {
            setTimeout(resolve, PLAYER_WAVEFORM_BUSY_RETRY_DELAYS_MS[attempt]);
          });
          if (controller.signal.aborted || state.player.streaming.generation !== generation) return null;
          continue;
        }
        if (!response.ok) return null;
        const peaks = validateWaveformPeakPayload(await response.json(), sampleCount);
        if (controller.signal.aborted || state.player.streaming.generation !== generation) return null;
        if (!peaks) return null;
        retained = true;
        return peaks;
      }
    } catch (_error) {
      return null;
    } finally {
      if (!retained && playerWaveformPeakCache.get(identity) === request) {
        playerWaveformPeakCache.delete(identity);
      }
    }
  })();
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
  const identity = `${generation}\u0000${rawPath}`;
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
          bins: String(PLAYER_WAVEFORM_PEAK_COUNT),
          cachedOnly: '1',
        });
        const response = await fetch(`/playback/waveform?${query}`, { signal: controller.signal });
        if (!response.ok || response.status !== 200) return null;
        const cachedPeaks = validateWaveformPeakPayload(
          await response.json(),
          PLAYER_WAVEFORM_PEAK_COUNT,
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
  const completedIdentity = `${generation}\u0000${String(completedPath || '')}`;
  const currentIdentity = `${generation}\u0000${String(currentPath || '')}`;
  let cached = playerWaveformPeakCache.get(currentIdentity);
  let peaks = cached ? await cached : null;
  if (!peaks && state.player.streaming.generation === generation) {
    await loadWaveformPeaks(currentPath, PLAYER_WAVEFORM_PEAK_COUNT, generation);
    cached = playerWaveformPeakCache.get(currentIdentity);
    peaks = cached ? await cached : null;
  }
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
