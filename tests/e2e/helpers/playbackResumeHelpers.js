const CLAIM_PATH = '/playback/state';

/**
 * The claim requests a page sends (PUT and DELETE; its reads carry a client_id query), timed by the browser
 * on its wall clock, so they compare with page-clock marks through performance.timeOrigin. Observed only.
 */
export function observePlaybackClaimRequests(page) {
  const records = [];
  const byRequest = new Map();
  const isClaimRequest = (request) => {
    const url = new URL(request.url());
    return url.pathname === CLAIM_PATH && !url.search;
  };
  const onRequest = (request) => {
    if (!isClaimRequest(request)) return;
    const record = {
      method: request.method(),
      state: String(request.postDataJSON()?.state || ''),
      // Replaced by the browser's own start once the request settles.
      startedAtEpochMs: Date.now(),
      answeredAtEpochMs: null,
      settled: false,
      failure: '',
    };
    records.push(record);
    byRequest.set(request, record);
  };
  const settle = (request, failure) => {
    const record = byRequest.get(request);
    if (!record) return;
    byRequest.delete(request);
    const timing = request.timing();
    if (timing.startTime > 0) record.startedAtEpochMs = timing.startTime;
    record.answeredAtEpochMs = timing.responseEnd >= 0 ? timing.startTime + timing.responseEnd : null;
    record.failure = failure;
    record.settled = true;
  };
  const onFinished = (request) => settle(request, '');
  const onFailed = (request) => settle(request, String(request.failure()?.errorText || 'request failed'));
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    mark: () => records.length,
    since: (mark) => records.slice(mark).map((record) => ({ ...record })),
    stop() {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}

export async function readResumeCheckpoint(page) {
  // parity-check: allow-read-only-measurement-evaluate -- production playback snapshot and the page clock only
  return page.evaluate(() => {
    const playback = getStreamingPlaybackSnapshot();
    return {
      path: String(state.player?.current?.path || ''),
      paused: Boolean(playback.paused),
      currentTime: Number(playback.currentTime || 0),
      duration: Number(playback.duration || 0),
      resumedAtMs: Number(playback.diagnostics?.resumedAtMs || 0),
      resumeFirstFrameAtMs: Number(playback.diagnostics?.resumeFirstFrameAtMs || 0),
      timeOrigin: performance.timeOrigin,
      nowMs: performance.now(),
    };
  });
}

/** Plays on for a second of the song, so each pause follows real playback. */
export async function playOnForASecond(page, globalPlayerActions) {
  const { currentTime } = await readResumeCheckpoint(page);
  await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: currentTime + 1 });
}

async function waitForResumeFirstFrame(page, pressedAtMs) {
  const handle = await page.waitForFunction((pressed) => {
    const playback = getStreamingPlaybackSnapshot();
    const firstFrameAtMs = Number(playback.diagnostics?.resumeFirstFrameAtMs || 0);
    return firstFrameAtMs >= pressed ? {
      path: String(state.player?.current?.path || ''),
      currentTime: Number(playback.currentTime || 0),
      resumedAtMs: Number(playback.diagnostics.resumedAtMs || 0),
      resumeFirstFrameAtMs: firstFrameAtMs,
    } : false;
  }, pressedAtMs, { timeout: 30000 });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

const isPlayingClaimPut = (record) => record.method === 'PUT' && record.state !== 'paused';

/**
 * Play after Pause, timed from the press to the resumed song's first audible rendered frame on the page clock
 * the press was marked on. `held`: pressed inside the pause hold, it may send no claim request before that
 * frame and says it plays after it. `round-trip`: pressed after the claim was given back, its claim request is
 * answered before that frame. Missing evidence throws.
 */
export async function measureResumeToSound({
  page, globalPlayerActions, playbackEvidence, claimRequests, kind,
}) {
  if (!['held', 'round-trip'].includes(kind)) throw new Error(`Unknown resume kind ${JSON.stringify(kind)}.`);
  const before = await readResumeCheckpoint(page);
  if (!before.paused || !before.path) throw new Error(`Play after Pause: nothing paused to resume (${JSON.stringify(before)}).`);
  const playbackMark = await playbackEvidence.playbackMark();
  const claimMark = claimRequests.mark();
  const playingClaim = page.waitForResponse((response) => (
    response.request().method() === 'PUT' && new URL(response.url()).pathname === CLAIM_PATH
    && response.request().postDataJSON()?.state !== 'paused'
  ), { timeout: 30000 });
  let pressedAtMs = 0;
  await globalPlayerActions.togglePlaybackWithSpace({ paused: false }, {
    async beforePress() {
      pressedAtMs = (await readResumeCheckpoint(page)).nowMs;
    },
  });
  const shownPlayingAtMs = (await readResumeCheckpoint(page)).nowMs;
  const frame = await waitForResumeFirstFrame(page, pressedAtMs);
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: playbackMark, path: before.path });
  const readAtMs = (await readResumeCheckpoint(page)).nowMs;
  if (!(await playingClaim).ok()) throw new Error(`Play after Pause (${kind}): the playing claim request was refused.`);

  if (frame.path !== before.path || !(frame.resumedAtMs >= pressedAtMs)) {
    throw new Error(`Play after Pause (${kind}): the first frame is not this resume's (${JSON.stringify({ before, frame })}).`);
  }
  if (!(evidence.pcmFrames > 0 && evidence.finiteSamples >= evidence.pcmFrames * 2
      && evidence.nonZeroSamples > 0 && evidence.peakSample > 0 && evidence.renderedFrameDelta > 0)) {
    throw new Error(`Play after Pause (${kind}): the resumed audio is silent or not stereo (${JSON.stringify(evidence)}).`);
  }
  if (frame.currentTime < before.currentTime - 0.25 || frame.currentTime > before.currentTime + 2) {
    throw new Error(`Play after Pause (${kind}): it did not go on from ${before.currentTime} s (heard at ${frame.currentTime} s).`);
  }

  const pressedAtEpochMs = before.timeOrigin + pressedAtMs;
  const soundedAtEpochMs = before.timeOrigin + frame.resumeFirstFrameAtMs;
  const requests = claimRequests.since(claimMark);
  const unsettled = requests.filter((record) => !record.settled);
  if (unsettled.length) throw new Error(`Play after Pause (${kind}): claim requests still pending (${JSON.stringify(unsettled)}).`);
  const beforeSound = requests.filter((record) => (
    record.startedAtEpochMs >= pressedAtEpochMs && record.startedAtEpochMs < soundedAtEpochMs));
  let claimRoundTripMs = null;
  if (kind === 'held') {
    if (beforeSound.length) {
      throw new Error(`Play after Pause (held): claim requests before its first frame (${JSON.stringify(beforeSound)}).`);
    }
    if (!requests.some((record) => isPlayingClaimPut(record) && record.startedAtEpochMs >= soundedAtEpochMs)) {
      throw new Error('Play after Pause (held): it never said it plays after its first frame.');
    }
  } else {
    const claim = beforeSound.find((record) => isPlayingClaimPut(record)
      && record.answeredAtEpochMs !== null && record.answeredAtEpochMs <= soundedAtEpochMs);
    if (!claim) {
      throw new Error(`Play after Pause (round trip): no claim answered before its first frame (${JSON.stringify(requests)}).`);
    }
    claimRoundTripMs = claim.answeredAtEpochMs - claim.startedAtEpochMs;
  }
  return {
    kind,
    pressToSoundMs: frame.resumeFirstFrameAtMs - pressedAtMs,
    claimRoundTripMs,
    // Diagnostics only: when the player showed it playing, and when this test read the sound.
    pressToShownPlayingMs: shownPlayingAtMs - pressedAtMs,
    pressToTestReadMs: readAtMs - pressedAtMs,
    pausedAtSeconds: before.currentTime,
    heardFromSeconds: frame.currentTime,
    evidence: {
      pcmFrames: evidence.pcmFrames,
      nonZeroSamples: evidence.nonZeroSamples,
      renderedFrameDelta: evidence.renderedFrameDelta,
    },
    claimRequests: requests.map(({ settled, ...record }) => ({
      ...record,
      startedAfterPressMs: record.startedAtEpochMs - pressedAtEpochMs,
    })),
  };
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeResumeSamples(samples) {
  const times = (kind) => samples.filter((sample) => sample.kind === kind).map((sample) => sample.pressToSoundMs);
  return {
    heldMedianMs: median(times('held')),
    roundTripMedianMs: median(times('round-trip')),
    heldMs: times('held'),
    roundTripMs: times('round-trip'),
    samples,
  };
}
