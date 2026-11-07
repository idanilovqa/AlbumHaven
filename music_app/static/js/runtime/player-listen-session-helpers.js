const MIN_RECORDED_LISTEN_SECONDS = 10;
// How far short of its duration a track's heard audio may fall and still have been heard to the end.
const HEARD_TO_END_TOLERANCE_SECONDS = 0.25;
// Last.fm never scrobbles a track this short, however much of it was heard.
const MAX_UNSCROBBLABLE_DURATION_SECONDS = 30;
// Last.fm counts a listen after half the track or four minutes, whichever comes first.
const MAX_SCROBBLE_THRESHOLD_SECONDS = 240;
const PLAYBACK_SESSION_REQUEST_TIMEOUT_MS = 10000;
// Transient now-playing and scrobble failures back off from about five seconds to at most five minutes.
const LISTEN_WRITE_RETRY_BASE_MS = 5000;
const LISTEN_WRITE_RETRY_MAX_MS = 300000;
// The server's answer when this account has no Last.fm session.
const LASTFM_UNAVAILABLE_ERROR = 'account_scoped_scrobble_unavailable';
let measuredPlaybackDeviceId = '';
const pendingPlaybackSessionRequests = new Set();

function newMeasuredPlaybackId() {
  if (typeof crypto === 'undefined') return '';
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== 'function') return '';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function getMeasuredPlaybackDeviceId() {
  if (measuredPlaybackDeviceId) return measuredPlaybackDeviceId;
  const key = 'album-haven-playback-device-id';
  const stored = typeof getLocalStorageItem === 'function' ? getLocalStorageItem(key) : '';
  measuredPlaybackDeviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored || '')
    ? stored : newMeasuredPlaybackId();
  if (measuredPlaybackDeviceId && typeof setLocalStorageItem === 'function') setLocalStorageItem(key, measuredPlaybackDeviceId);
  return measuredPlaybackDeviceId;
}

function breakMeasuredListenSegment(session) {
  if (session?.measurement) session.measurement.contiguous = 0;
}

function recordMeasuredStreamingFrames(roleState, message, sampleRate) {
  if (!roleState || !Number.isInteger(message?.frames) || message.frames <= 0
      || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
  if (!roleState.measuredListenSession) {
    if (roleState.role === 'continuity' && roleState.continuityOptions?.kind === 'queued-next') {
      roleState.measuredListenSession = createListenSession(roleState.track);
    } else {
      const current = state.player.listenSession || ensureListenSession();
      if (!current || String(current.track?.path || '') !== String(roleState.track?.path || '')) return;
      roleState.measuredListenSession = current;
    }
  }
  const session = roleState.measuredListenSession;
  if (!session?.measurement || ['pending', 'done', 'failed'].includes(session.completionState)) return;
  const elapsed = message.frames / sampleRate;
  session.measurement.total += elapsed;
  session.measurement.contiguous += elapsed;
  session.measurement.longest = Math.max(session.measurement.longest, session.measurement.contiguous);
}

function buildMeasuredCompletionFields(session, { advance = false, finalized = false } = {}) {
  const measurement = session?.measurement;
  if (!measurement?.deviceId || !measurement.sessionId) return {};
  if (advance) measurement.sequence = (Number(measurement.sequence) || 0) + 1;
  measurement.finalized = Boolean(measurement.finalized || finalized);
  return {
    measurement_version: 'rendered-pcm-v1', device_id: measurement.deviceId,
    session_id: measurement.sessionId, sequence: Number(measurement.sequence) || 0, finalized: measurement.finalized,
    measured_listened_seconds: Math.round(measurement.total * 1000) / 1000,
    max_measured_contiguous_seconds: Math.round(measurement.longest * 1000) / 1000,
  };
}

function getListenSessionDuration(session) {
  const duration = Number(session?.duration_seconds || 0);
  if (duration > 0) return duration;
  return Number(getPlayerPlaybackSnapshot().duration) || 0;
}

function getListenScrobbleThreshold(durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (!duration) return 0;
  if (duration <= MAX_UNSCROBBLABLE_DURATION_SECONDS) return Infinity;
  return Math.min(duration * 0.5, MAX_SCROBBLE_THRESHOLD_SECONDS);
}

function totalListenedSeconds(session) {
  return (Array.isArray(session?.segments) ? session.segments : []).reduce((sum, segment) => (
    sum + Math.max(0, Number(segment?.end_seconds || 0) - Number(segment?.start_seconds || 0))
  ), 0);
}

function longestListenedSegmentSeconds(session) {
  return (Array.isArray(session?.segments) ? session.segments : []).reduce((maxValue, segment) => {
    const span = Math.max(0, Number(segment?.end_seconds || 0) - Number(segment?.start_seconds || 0));
    return Math.max(maxValue, span);
  }, 0);
}

function shouldPersistListenSession(session) {
  // A measured listen is judged on its measured audio alone, as the server judges it.
  const listened = session?.measurement ? Number(session.measurement.total) || 0
    : Math.max(totalListenedSeconds(session), longestListenedSegmentSeconds(session));
  if (listened > MIN_RECORDED_LISTEN_SECONDS) return true;
  // A track of ten seconds or less is recorded once it was heard to its end.
  const duration = getListenSessionDuration(session);
  return duration > 0 && duration <= MIN_RECORDED_LISTEN_SECONDS && listened > 0
    && listened >= duration - HEARD_TO_END_TOLERANCE_SECONDS;
}

function clearListenPauseMarker(session) {
  if (!session) return;
  session.paused_at = '';
  session.paused_at_unix_ms = 0;
  session.pause_offset_seconds = 0;
}

function markListenSessionPaused(currentTime = null) {
  const session = state.player.listenSession;
  if (!session) return;
  breakMeasuredListenSegment(session);
  session.paused_at = isoNow();
  session.paused_at_unix_ms = Date.now();
  session.pause_offset_seconds = Math.max(0, Number(currentTime == null ? getPlayerPlaybackSnapshot().currentTime : currentTime) || 0);
}

function canScrobbleListenSession(session) {
  const duration = getListenSessionDuration(session);
  if (!duration) return false;
  const threshold = getListenScrobbleThreshold(duration);
  if (session?.measurement) {
    return session.measurement.total >= threshold || session.measurement.longest >= threshold;
  }
  return totalListenedSeconds(session) >= threshold || longestListenedSegmentSeconds(session) >= threshold;
}

function buildNowPlayingPayload(track, session = null) {
  if (!track) return null;
  const activeSession = session || state.player.listenSession;
  return {
    ...buildMeasuredCompletionFields(activeSession),
    ...(typeof getPlaybackClaimContext === 'function' ? getPlaybackClaimContext() : {}),
    path: String(track.path || ''),
    title: String(track.title || ''),
    artist: String(track.artist || ''),
    album: String(track.album || ''),
    album_artist: String(track.artist || ''),
    cover_path: String(track.coverPath || ''),
    duration_seconds: Math.round((Number(activeSession?.duration_seconds || getPlayerPlaybackSnapshot().duration || 0) || 0) * 1000) / 1000,
    started_at: String(activeSession?.started_at || isoNow()),
    started_at_unix: Number(activeSession?.started_at_unix || unixNowSeconds()) || unixNowSeconds(),
    track_number: String(track.trackNumber || ''),
    request_origin: buildPlaybackRequestOrigin(),
  };
}

function buildPlaybackRequestOrigin() {
  const originId = typeof getPlaybackOwnershipTabId === 'function'
    ? String(getPlaybackOwnershipTabId() || '')
    : '';
  return {
    client_kind: 'private_web',
    origin_type: 'browser_tab',
    origin_id: originId,
  };
}

// Inside a native-playback APK, Android builds and sends every listen write itself.
function isListenRecordedNatively() {
  return typeof isAndroidNativePlayback === 'function' && isAndroidNativePlayback();
}

function listenWriteClockMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function listenWriteRetryJitter() {
  return Math.random();
}

/** `Retry-After` as milliseconds from now: delay-seconds or an HTTP date; null when absent or invalid. */
function parseRetryAfterMs(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = text ? Date.parse(text) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function playbackSessionError(response, data) {
  const error = new Error(data?.error || 'Playback sync failed');
  error.status = Number(response.status) || 0;
  error.code = String(data?.error || '');
  error.retryAfterMs = parseRetryAfterMs(response.headers?.get?.('Retry-After'));
  return error;
}

/**
 * A failed now-playing or scrobble write: Last.fm not connected stops both for the listen; a
 * network failure, timeout, 429 or 5xx (including the server's 503 for a transient Last.fm
 * failure) is retried with backoff; any other answer is final.
 */
function noteListenWriteFailure(session, effect, error) {
  if (!session) return;
  const status = Number(error?.status) || 0;
  if (status === 409 && error?.code === LASTFM_UNAVAILABLE_ERROR) {
    session.lastfmUnavailable = true;
    return;
  }
  const retry = (session.writeRetries ||= {})[effect] ||= { attempts: 0, at: 0, final: false };
  if (status && status !== 429 && status < 500) {
    retry.final = true;
    return;
  }
  retry.attempts += 1;
  const backoff = LISTEN_WRITE_RETRY_BASE_MS * 2 ** Math.min(retry.attempts - 1, 16);
  const jittered = Math.min(LISTEN_WRITE_RETRY_MAX_MS, Math.round(backoff * (0.8 + 0.4 * listenWriteRetryJitter())));
  retry.at = listenWriteClockMs() + (Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : jittered);
}

/**
 * Whether a now-playing or scrobble write may be sent now. A listen whose claim reports that
 * scrobbling is unavailable sends neither, as after the server's 409; its completions still go.
 */
function isListenWriteDue(session, effect) {
  if (session && typeof isScrobblingUnavailableAtClaim === 'function' && isScrobblingUnavailableAtClaim()) {
    session.lastfmUnavailable = true;
  }
  if (session?.lastfmUnavailable) return false;
  const retry = session?.writeRetries?.[effect];
  return !retry || (!retry.final && listenWriteClockMs() >= retry.at);
}

/** A start or resume retries a backed-off write at its next trigger. */
function retryListenWritesNow(session) {
  Object.values(session?.writeRetries || {}).forEach((retry) => { retry.at = 0; });
}

async function postPlaybackSession(url, payload) {
  const claim = typeof getPlaybackClaimContext === 'function' ? getPlaybackClaimContext() : {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYBACK_SESSION_REQUEST_TIMEOUT_MS);
  const promise = (async () => {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ...claim }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) throw playbackSessionError(response, data);
    return data;
  })();
  const pending = { claimToken: claim.claimToken, promise };
  pendingPlaybackSessionRequests.add(pending);
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
    pendingPlaybackSessionRequests.delete(pending);
  }
}

async function drainPlaybackSessionRequests(claimToken) {
  while (claimToken) {
    const pending = [...pendingPlaybackSessionRequests].filter(request => request.claimToken === claimToken);
    if (!pending.length) return;
    await Promise.allSettled(pending.map(request => request.promise));
  }
}

function ensureListenSession(track = null) {
  if (state.player.listenSession) return state.player.listenSession;
  const activeTrack = track || state.player.current;
  if (!activeTrack) return null;
  startListenSession(activeTrack);
  return state.player.listenSession;
}

async function resumeListenSessionPlayback(track = null, currentTime = null) {
  const session = ensureListenSession(track);
  if (!session) return null;
  clearListenPauseMarker(session);
  beginListenSegment(currentTime);
  return session;
}

function beginListenSegment(currentTime = null) {
  const session = ensureListenSession();
  if (!session || session.segmentActive) return;
  const startSeconds = Math.max(0, Number(currentTime == null ? getPlayerPlaybackSnapshot().currentTime : currentTime) || 0);
  session.segmentActive = true;
  session.activeSegmentStartSeconds = startSeconds;
}

function closeListenSegment(currentTime = null, session = state.player.listenSession) {
  breakMeasuredListenSegment(session);
  if (!session || !session.segmentActive) return;
  const endSeconds = Math.max(0, Number(currentTime == null ? getPlayerPlaybackSnapshot().currentTime : currentTime) || 0);
  const startSeconds = Math.max(0, Number(session.activeSegmentStartSeconds || 0));
  session.segmentActive = false;
  session.activeSegmentStartSeconds = 0;
  if (endSeconds <= startSeconds) return;
  session.segments.push({
    start_seconds: Math.round(startSeconds * 1000) / 1000,
    end_seconds: Math.round(endSeconds * 1000) / 1000,
  });
}

function maybeSendNowPlaying(track, session) {
  if (isListenRecordedNatively()) return Promise.resolve(false);
  if (session?.nowPlayingPromise) return session.nowPlayingPromise;
  if (session?.nowPlayingSent) return Promise.resolve(true);
  if (session && !isListenWriteDue(session, 'now-playing')) return Promise.resolve(false);
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) {
    return Promise.resolve(false);
  }
  const payload = buildNowPlayingPayload(track, session);
  if (!payload?.artist || !payload?.title) return Promise.resolve(false);
  const nowPlayingPromise = postPlaybackSession('/playback/session/now-playing', payload).then(() => {
    if (session) session.nowPlayingSent = true;
    return true;
  }).catch((error) => {
    noteListenWriteFailure(session, 'now-playing', error);
    console.warn('[AlbumHaven][Lastfm] Failed to update now playing.', error);
    return false;
  }).finally(() => {
    if (session?.nowPlayingPromise === nowPlayingPromise) {
      session.nowPlayingPromise = null;
    }
  });
  if (session) session.nowPlayingPromise = nowPlayingPromise;
  return nowPlayingPromise;
}

/** A now-playing that failed transiently is sent again once its backoff elapses. */
function maybeRetryNowPlaying(session) {
  if (!session?.writeRetries?.['now-playing']?.attempts) return Promise.resolve(false);
  return maybeSendNowPlaying(session.track, session);
}

async function maybeScrobbleListenSession(session) {
  if (!session) return false;
  if (session.scrobblePromise) return session.scrobblePromise;
  if (session.scrobbled || !canScrobbleListenSession(session)) return false;
  if (session.scrobblePending || !isListenWriteDue(session, 'scrobble')) return false;
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) return false;
  session.scrobblePending = true;
  session.scrobblePayload ||= {
    ...buildNowPlayingPayload(session.track, session),
    ...buildMeasuredCompletionFields(session, { advance: true }),
    total_listened_seconds: Math.round(totalListenedSeconds(session) * 1000) / 1000,
    max_contiguous_seconds: Math.round(longestListenedSegmentSeconds(session) * 1000) / 1000,
  };
  const scrobblePromise = postPlaybackSession(
    '/playback/session/scrobble',
    session.scrobblePayload,
  ).then(() => {
    session.scrobbled = true;
    return true;
  }).catch((error) => {
    noteListenWriteFailure(session, 'scrobble', error);
    console.warn('[AlbumHaven][Lastfm] Failed to scrobble track.', error);
    return false;
  }).finally(() => {
    session.scrobblePending = false;
    if (session.scrobblePromise === scrobblePromise) {
      session.scrobblePromise = null;
    }
  });
  session.scrobblePromise = scrobblePromise;
  return scrobblePromise;
}

function startListenSession(track) {
  state.player.listenSession = createListenSession(track);
}

function createListenSession(track) {
  if (!track || isListenRecordedNatively()) return null;
  return {
    measurement: { deviceId: getMeasuredPlaybackDeviceId(), sessionId: newMeasuredPlaybackId(), total: 0, contiguous: 0, longest: 0 },
    track: {
      path: String(track.path || ''),
      title: String(track.title || ''),
      artist: String(track.artist || ''),
      album: String(track.album || ''),
      coverPath: String(track.coverPath || ''),
      trackNumber: String(track.trackNumber || ''),
    },
    started_at: isoNow(),
    started_at_unix: unixNowSeconds(),
    ended_at: '',
    duration_seconds: 0,
    segments: [],
    segmentActive: false,
    activeSegmentStartSeconds: 0,
    paused_at: '',
    paused_at_unix_ms: 0,
    pause_offset_seconds: 0,
    scrobbled: false,
    scrobblePending: false,
    nowPlayingSent: false,
    nowPlayingPromise: null,
    completionState: '',
  };
}

async function finalizeListenSession(reason, options = {}) {
  const session = options.session || state.player.listenSession;
  if (!session || session.completionState === 'pending' || session.completionState === 'done') return;
  if (state.player.listenSession === session) {
    state.player.listenSession = null;
  }
  session.completionState = 'pending';
  if (session.nowPlayingPromise) await Promise.resolve(session.nowPlayingPromise).catch(() => {});
  if (options.skipCloseSegment !== true) {
    closeListenSegment(options.currentTime, session);
  }
  session.duration_seconds = Math.round((Number(options.duration == null ? getPlayerPlaybackSnapshot().duration : options.duration) || 0) * 1000) / 1000;
  session.ended_at = String(options.endedAtOverride || (session.segmentActive ? isoNow() : (session.paused_at || isoNow())));
  const totalListened = Math.round(totalListenedSeconds(session) * 1000) / 1000;
  const maxContiguous = Math.round(longestListenedSegmentSeconds(session) * 1000) / 1000;
  const finishedFully = Boolean(options.finishedFully);
  const skipped = !finishedFully && reason !== 'stopped';
  if (!shouldPersistListenSession(session)) {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    if (state.player.listenSession === session) {
      state.player.listenSession = null;
    }
    return;
  }
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    if (state.player.listenSession === session) {
      state.player.listenSession = null;
    }
    return;
  }
  const scrobbleEligible = canScrobbleListenSession(session);
  if (scrobbleEligible && !session.scrobbled) {
    // The listen's end is its last chance: a backed-off scrobble is sent once more without waiting.
    retryListenWritesNow(session);
    await maybeScrobbleListenSession(session);
  }
  const payload = session.completionPayload || {
    ...buildNowPlayingPayload(session.track, session),
    ...buildMeasuredCompletionFields(session, { advance: true, finalized: true }),
    ended_at: session.ended_at,
    duration_seconds: session.duration_seconds,
    total_listened_seconds: totalListened,
    max_contiguous_seconds: maxContiguous,
    finished_fully: finishedFully,
    skipped,
    completion_reason: String(reason || ''),
    scrobble_eligible: scrobbleEligible,
    scrobbled: Boolean(session.scrobbled),
    segments: session.segments.map((segment) => ({
      start_seconds: Number(segment.start_seconds || 0),
      end_seconds: Number(segment.end_seconds || 0),
    })),
  };
  session.completionPayload = payload;
  try {
    await postPlaybackSession('/playback/session/complete', payload);
    session.completionState = 'done';
  } catch (error) {
    session.completionState = 'failed';
    console.warn('[AlbumHaven][Playback] Failed to persist listen session.', error);
  }
  if (state.player.listenSession === session) {
    state.player.listenSession = null;
  }
  clearListenPauseMarker(session);
}

function getTrackIdentity(track) {
  return `${String(track?.path || '')}::${String(track?.src || '')}`;
}

async function persistPausedListenSession(session = state.player.listenSession) {
  if (!session) return false;
  const claimToken = typeof getPlaybackClaimContext === 'function' ? getPlaybackClaimContext().claimToken : null;
  await Promise.all([session.nowPlayingPromise, session.scrobblePromise]);
  if (session !== state.player.listenSession
      || (typeof getPlaybackClaimContext === 'function' && claimToken !== getPlaybackClaimContext().claimToken)
      || !shouldPersistListenSession(session)
      || (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects())) return false;
  session.scrobblePayload = null;
  const payload = {
    ...buildNowPlayingPayload(session.track, session),
    ...buildMeasuredCompletionFields(session, { advance: true, finalized: true }),
    ended_at: session.paused_at || isoNow(),
    total_listened_seconds: Math.round(totalListenedSeconds(session) * 1000) / 1000,
    max_contiguous_seconds: Math.round(longestListenedSegmentSeconds(session) * 1000) / 1000,
    finished_fully: false,
    skipped: false,
    completion_reason: 'paused',
    scrobble_eligible: canScrobbleListenSession(session),
    scrobbled: Boolean(session.scrobbled),
    segments: session.segments.map(segment => ({
      start_seconds: Number(segment.start_seconds || 0), end_seconds: Number(segment.end_seconds || 0),
    })),
  };
  await postPlaybackSession('/playback/session/complete', payload);
  return true;
}

function flushListenSessionOnUnload(reason = 'unload', playbackSnapshot = null) {
  if (reason !== 'pagehide') return false;
  const snapshot = playbackSnapshot || getPlayerPlaybackSnapshot();
  const session = state.player.listenSession;
  if (!session || session.completionState === 'pending' || session.completionState === 'done') {
    return typeof stagePlaybackOwnershipHandoff === 'function'
      ? stagePlaybackOwnershipHandoff(null, snapshot) : false;
  }
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    state.player.listenSession = null;
    return false;
  }
  if (typeof stagePlaybackOwnershipHandoff !== 'function') {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    state.player.listenSession = null;
    return false;
  }
  closeListenSegment(snapshot.currentTime);
  session.duration_seconds = Math.round((Number(snapshot.duration) || Number(session.duration_seconds) || 0) * 1000) / 1000;
  session.ended_at = session.paused_at || isoNow();
  session.completionState = 'pending';
  const completion = shouldPersistListenSession(session) ? {
    ...buildNowPlayingPayload(session.track, session),
    ...buildMeasuredCompletionFields(session, { advance: true, finalized: true }),
    ended_at: session.ended_at,
    duration_seconds: session.duration_seconds,
    total_listened_seconds: Math.round(totalListenedSeconds(session) * 1000) / 1000,
    max_contiguous_seconds: Math.round(longestListenedSegmentSeconds(session) * 1000) / 1000,
    finished_fully: false,
    skipped: true,
    completion_reason: String(reason || 'unload'),
    scrobble_eligible: canScrobbleListenSession(session),
    scrobbled: Boolean(session.scrobbled),
    segments: session.segments.map((segment) => ({
      start_seconds: Number(segment.start_seconds || 0),
      end_seconds: Number(segment.end_seconds || 0),
    })),
  } : null;
  const accepted = stagePlaybackOwnershipHandoff(
    completion?.measurement_version ? completion : null,
    snapshot,
  );
  session.completionState = 'done';
  clearListenPauseMarker(session);
  state.player.listenSession = null;
  return accepted;
}
