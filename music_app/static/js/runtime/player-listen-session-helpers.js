const MIN_RECORDED_LISTEN_SECONDS = 10;
const LISTEN_SESSION_LONG_PAUSE_MS = 60 * 60 * 1000;
let measuredPlaybackDeviceId = '';

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
  return {
    measurement_version: 'rendered-pcm-v1', device_id: measurement.deviceId,
    session_id: measurement.sessionId, sequence: Number(measurement.sequence) || 0, finalized,
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
  if (duration < 600) return duration * 0.5;
  return 300;
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
  return Math.max(totalListenedSeconds(session), longestListenedSegmentSeconds(session), Number(session?.measurement?.total) || 0) > MIN_RECORDED_LISTEN_SECONDS;
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

function hasListenSessionExceededPauseThreshold(session) {
  return Boolean(
    session
    && Number(session.paused_at_unix_ms || 0) > 0
    && (Date.now() - Number(session.paused_at_unix_ms || 0)) >= LISTEN_SESSION_LONG_PAUSE_MS
  );
}

function canScrobbleListenSession(session) {
  const duration = getListenSessionDuration(session);
  if (!duration) return false;
  const threshold = getListenScrobbleThreshold(duration);
  return totalListenedSeconds(session) >= threshold || longestListenedSegmentSeconds(session) >= threshold;
}

function buildNowPlayingPayload(track, session = null) {
  if (!track) return null;
  const activeSession = session || state.player.listenSession;
  return {
    ...buildMeasuredCompletionFields(activeSession),
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

async function postPlaybackSession(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Playback sync failed');
  }
  return data;
}

function ensureListenSession(track = null) {
  if (state.player.listenSession) return state.player.listenSession;
  const activeTrack = track || state.player.current;
  if (!activeTrack) return null;
  startListenSession(activeTrack);
  return state.player.listenSession;
}

async function maybeSplitListenSessionAfterLongPause(track = null) {
  const session = state.player.listenSession;
  if (!hasListenSessionExceededPauseThreshold(session)) return false;
  const finishedSession = session;
  const resumeTrack = track || finishedSession.track || state.player.current;
  state.player.listenSession = null;
  await finalizeListenSession('long-pause-timeout', {
    session: finishedSession,
    currentTime: Number(finishedSession.pause_offset_seconds || 0),
    duration: Number(finishedSession.duration_seconds || getPlayerPlaybackSnapshot().duration) || 0,
    endedAtOverride: String(finishedSession.paused_at || ''),
    skipCloseSegment: true,
  });
  if (resumeTrack) {
    startListenSession(resumeTrack);
  }
  return true;
}

async function resumeListenSessionPlayback(track = null, currentTime = null) {
  const split = await maybeSplitListenSessionAfterLongPause(track);
  const session = ensureListenSession(track);
  if (!session) return null;
  if (split) {
    for (const role of Object.values(state.player.streaming?.roles || {})) {
      if (role && (role.role === 'current' || role.continuityOptions?.kind !== 'queued-next')
          && String(role.track?.path || '') === String(session.track?.path || '')) role.measuredListenSession = session;
    }
  }
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
  if (session?.nowPlayingPromise) return session.nowPlayingPromise;
  if (session?.nowPlayingSent) return Promise.resolve(true);
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) {
    return Promise.resolve(false);
  }
  const payload = buildNowPlayingPayload(track, session);
  if (!payload?.artist || !payload?.title) return Promise.resolve(false);
  const nowPlayingPromise = postPlaybackSession('/playback/session/now-playing', payload).then(() => {
    if (session) session.nowPlayingSent = true;
    return true;
  }).catch((error) => {
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

async function maybeScrobbleListenSession(session) {
  if (!session) return false;
  if (session.scrobblePromise) return session.scrobblePromise;
  if (session.scrobbled || !canScrobbleListenSession(session)) return false;
  if (session.scrobblePending) return false;
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
  if (!track) return null;
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

function flushListenSessionOnUnload(reason = 'unload') {
  const session = state.player.listenSession;
  if (!session || session.completionState === 'pending' || session.completionState === 'done') return false;
  if (typeof canEmitPlaybackSessionSideEffects === 'function' && !canEmitPlaybackSessionSideEffects()) {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    state.player.listenSession = null;
    return false;
  }
  closeListenSegment();
  session.duration_seconds = Math.round((Number(getPlayerPlaybackSnapshot().duration) || Number(session.duration_seconds) || 0) * 1000) / 1000;
  session.ended_at = session.paused_at || isoNow();
  if (!shouldPersistListenSession(session)) {
    session.completionState = 'done';
    clearListenPauseMarker(session);
    state.player.listenSession = null;
    return false;
  }
  session.completionState = 'pending';
  const payload = {
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
  };
  try {
    if (navigator?.sendBeacon) {
      const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/playback/session/complete', body);
      if (!payload.measurement_version && payload.scrobble_eligible && !payload.scrobbled) {
        navigator.sendBeacon('/playback/session/scrobble', new Blob([JSON.stringify(buildNowPlayingPayload(session.track, session))], { type: 'application/json' }));
      }
    }
  } catch (_error) {
    // Ignore unload delivery errors.
  }
  session.completionState = 'done';
  clearListenPauseMarker(session);
  state.player.listenSession = null;
  return true;
}
