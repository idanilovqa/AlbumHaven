import {
  TIMING_BUDGET_STATUS,
  defineTimingBudget,
  evaluateTimingBudget,
  performanceTimingBudget,
} from './timingBudget.js';
import { readGaplessPlaybackDiagnostics } from './gaplessPlaybackHelpers.js';

export const PLAYBACK_START_TIMING_BUDGET = Object.freeze(
  performanceTimingBudget('playback-start.maximumStartMs'),
);
export const MAX_PLAYBACK_START_DEGRADATION_MS = 400;

function isTrackRequest(url) {
  return new URL(url).pathname === '/track';
}

function isPlaybackSessionRequest(url) {
  return new URL(url).pathname.startsWith('/playback/session/');
}

function trackPathFromUrl(url) {
  return String(new URL(url).searchParams.get('path') || '');
}

function readRequestHeaders(request) {
  const headers = request.headers();
  return {
    range: String(headers.range || ''),
  };
}

function readResponseHeaders(response) {
  const headers = response.headers();
  return {
    acceptRanges: String(headers['accept-ranges'] || ''),
    contentLength: String(headers['content-length'] || ''),
    contentRange: String(headers['content-range'] || ''),
    contentType: String(headers['content-type'] || ''),
  };
}

export function observePlaybackTrackTraffic(page) {
  const records = [];
  const byRequest = new Map();
  const pendingPlaybackSessionRequests = new Set();
  const pendingSettleChecks = new Set();

  const notifyPendingSettleChecks = () => {
    for (const check of pendingSettleChecks) check();
  };

  const onRequest = (request) => {
    if (isPlaybackSessionRequest(request.url())) {
      pendingPlaybackSessionRequests.add(request);
    }
    if (!isTrackRequest(request.url())) return;
    const record = {
      url: request.url(),
      path: trackPathFromUrl(request.url()),
      method: request.method(),
      requestHeaders: readRequestHeaders(request),
      requestedAtEpochMs: Date.now(),
      responseAtEpochMs: null,
      finishedAtEpochMs: null,
      failedAtEpochMs: null,
      status: null,
      responseHeaders: null,
      failure: '',
    };
    records.push(record);
    byRequest.set(request, record);
  };
  const onResponse = (response) => {
    const record = byRequest.get(response.request());
    if (!record) return;
    record.responseAtEpochMs = Date.now();
    record.status = response.status();
    record.responseHeaders = readResponseHeaders(response);
  };
  const onRequestFinished = (request) => {
    pendingPlaybackSessionRequests.delete(request);
    notifyPendingSettleChecks();
    const record = byRequest.get(request);
    if (record) record.finishedAtEpochMs = Date.now();
  };
  const onRequestFailed = (request) => {
    pendingPlaybackSessionRequests.delete(request);
    notifyPendingSettleChecks();
    const record = byRequest.get(request);
    if (!record) return;
    record.failedAtEpochMs = Date.now();
    record.failure = String(request.failure()?.errorText || 'request failed');
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);

  return {
    mark() {
      return records.length;
    },
    snapshotSince(mark, selectedPath) {
      return records.slice(mark).map((record) => ({
        ...record,
        selected: record.path === selectedPath,
      }));
    },
    async waitForBackgroundSettled(options = {}) {
      const timeout = Number(options.timeout || 5000);
      // parity-check: allow-read-only-measurement-evaluate -- wait outside the timed interval for legacy eager decode work to finish
      await page.waitForFunction(() => (
        typeof state === 'undefined'
        || Number(state.player?.decodedTrackPromises?.size || 0) === 0
      ), undefined, { timeout });
      if (pendingPlaybackSessionRequests.size === 0) return;
      await new Promise((resolve, reject) => {
        let timeoutId = null;
        const check = () => {
          if (pendingPlaybackSessionRequests.size !== 0) return;
          pendingSettleChecks.delete(check);
          if (timeoutId) clearTimeout(timeoutId);
          resolve();
        };
        pendingSettleChecks.add(check);
        timeoutId = setTimeout(() => {
          pendingSettleChecks.delete(check);
          reject(new Error(
            `Playback background work did not settle within ${timeout} ms (${pendingPlaybackSessionRequests.size} session requests pending).`,
          ));
        }, timeout);
        check();
      });
    },
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

async function readBrowserPerformanceNow(page) {
  // parity-check: allow-read-only-measurement-evaluate -- browser monotonic timing only
  return page.evaluate(() => performance.now());
}

async function readPlaybackDiagnostics(page) {
  // parity-check: allow-read-only-measurement-evaluate -- production playback state and browser memory only
  const playback = await page.evaluate(() => {
    if (typeof getPlayerPlaybackSnapshot !== 'function') {
      throw new Error('Production playback snapshot is unavailable.');
    }
    const playback = getPlayerPlaybackSnapshot();
    return {
      playbackMode: String(state?.player?.playbackMode || ''),
      decodedTrackCacheSize: Number(state?.player?.decodedTrackCache?.size || 0),
      decodedTrackPromiseCount: Number(state?.player?.decodedTrackPromises?.size || 0),
      currentPath: String(state?.player?.current?.path || ''),
      currentTitle: String(state?.player?.current?.title || ''),
      currentTime: Number(playback.currentTime || 0),
      duration: Number(playback.duration || 0),
      paused: Boolean(playback.paused),
    };
  });
  const streaming = await readGaplessPlaybackDiagnostics(page);
  return {
    ...playback,
    ...streaming,
    currentPath: playback.currentPath,
    currentTitle: playback.currentTitle,
    currentTime: playback.currentTime,
    duration: playback.duration,
    paused: playback.paused,
  };
}

export function classifyEagerPlaybackRoles({
  openControls,
  selectedPath,
  firstFrameAtMs,
  roleOpenedAtMs,
}) {
  if (!(Number(firstFrameAtMs) > 0)) return [];
  return openControls
    .filter((record) => record.path !== selectedPath)
    .filter((record) => {
      const openedAtMs = Number(roleOpenedAtMs?.[record.role] || 0);
      return openedAtMs > 0 && openedAtMs < Number(firstFrameAtMs);
    })
    .map((record) => record.role);
}

export async function measureAlbumTrackPlaybackStart({
  page,
  trackModalActions,
  traffic,
  rowIndex,
  label,
  cohort = 'general',
  minimumCurrentTime = 0.02,
}) {
  const trafficMark = traffic.mark();
  const playbackMark = await traffic.playbackMark();
  let startedAtMs = 0;
  const track = await trackModalActions.playTrackAt(rowIndex, {
    async recordClickBoundary() {
      startedAtMs = await readBrowserPerformanceNow(page);
    },
  });
  const completionHandle = await page.waitForFunction((expected) => {
    if (
      typeof state === 'undefined'
      || typeof getPlayerPlaybackSnapshot !== 'function'
    ) {
      return false;
    }
    const current = state.player?.current || null;
    if (!current) return false;
    if (String(current.path || '') !== expected.path) return false;
    if (String(current.title || '') !== expected.title) return false;
    const playback = getPlayerPlaybackSnapshot();
    const currentTime = Number(playback.currentTime) || 0;
    if (playback.paused || currentTime < expected.minimumCurrentTime) return false;
    return { completedAtMs: performance.now() };
  }, {
    path: track.path,
    title: track.title,
    minimumCurrentTime,
  });
  let completion;
  try {
    completion = await completionHandle.jsonValue();
  } finally {
    await completionHandle.dispose();
  }
  const stateCompletedAtMs = Number(completion?.completedAtMs || 0);
  const diagnostics = await readPlaybackDiagnostics(page);
  const playbackEvidence = await traffic.waitForTrackPlaybackEvidence({
    after: playbackMark,
    path: track.path,
  });
  const completedAtMs = Math.max(
    stateCompletedAtMs,
    Number(playbackEvidence.observedAtMs || 0),
  );
  const pcmControls = traffic.snapshotSince(trafficMark);
  const openControls = pcmControls.filter((record) => record.type === 'open');
  const selectedTrackTraffic = openControls.filter((record) => record.path === track.path);
  const eagerPlaybackRoles = classifyEagerPlaybackRoles({
    openControls,
    selectedPath: track.path,
    firstFrameAtMs: diagnostics.firstFrameAtMs,
    roleOpenedAtMs: diagnostics.roleOpenedAtMs,
  });
  return {
    label,
    cohort,
    rowIndex,
    track,
    startedAtMs,
    completedAtMs,
    elapsedMs: Math.max(0, completedAtMs - startedAtMs),
    diagnostics,
    pcmControls,
    trackTraffic: pcmControls,
    selectedTrackTraffic,
    eagerTrackTraffic: openControls.filter((record) => record.path !== track.path),
    eagerPlaybackRoles,
    playbackEvidence,
  };
}

export function summarizePlaybackStartAttempts(attempts) {
  const elapsedValues = attempts.map((attempt) => Number(attempt.elapsedMs || 0));
  const repeatedUseValues = attempts
    .filter((attempt) => attempt.cohort === 'repeated-use')
    .map((attempt) => Number(attempt.elapsedMs || 0));
  if (repeatedUseValues.length < 6) {
    throw new RangeError(
      `Playback-start degradation requires at least 6 repeated-use samples, received ${repeatedUseValues.length}.`,
    );
  }
  const firstThree = repeatedUseValues.slice(0, 3);
  const lastThree = repeatedUseValues.slice(-3);
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const earlyMedianMs = median(firstThree);
  const lateMedianMs = median(lastThree);
  return {
    maximumMs: Math.max(0, ...elapsedValues),
    earlyMedianMs,
    lateMedianMs,
    degradationMs: lateMedianMs - earlyMedianMs,
    finalDecodedTrackCacheSize: Number(attempts.at(-1)?.diagnostics?.decodedTrackCacheSize || 0),
  };
}

export function evaluatePlaybackStartBudget(summary) {
  const maximumStart = evaluateTimingBudget(
    summary?.maximumMs,
    PLAYBACK_START_TIMING_BUDGET,
  );
  const rawDegradationMs = summary?.degradationMs;
  const degradationMs = (
    typeof rawDegradationMs === 'number' && Number.isFinite(rawDegradationMs)
      ? rawDegradationMs
      : null
  );
  const degradationPassed = (
    degradationMs !== null
    && degradationMs <= MAX_PLAYBACK_START_DEGRADATION_MS
  );
  const degradation = {
    actualMs: degradationMs,
    maximumAllowedMs: MAX_PLAYBACK_START_DEGRADATION_MS,
    status: degradationPassed
      ? TIMING_BUDGET_STATUS.TARGET_MET
      : TIMING_BUDGET_STATUS.HARD_FAIL,
    passed: degradationPassed,
  };
  const passed = maximumStart.passed && degradation.passed;
  return {
    maximumStart,
    degradation,
    overallStatus: passed
      ? maximumStart.status
      : TIMING_BUDGET_STATUS.HARD_FAIL,
    passed,
  };
}
