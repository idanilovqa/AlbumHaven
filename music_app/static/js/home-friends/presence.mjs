// One browser player lifetime publishes only its own fresh playback state.
// Server grants and lease ownership remain authoritative; failures never affect playback.
export function createPresencePublisher({transport, readPlayback, subscribe, playerRef, schedule = setTimeout, cancel = clearTimeout}) {
  let disposed = false, timer = null, pending = false, dirty = false, sequence = 0, source = null, token = null, context = null, playbackEpoch = 0, blockedEpoch = null;
  const reset = () => {source = null; token = null; context = null;};
  async function refresh() {
    if (disposed) return;
    if (pending) {dirty = true; return;}
    const startedEpoch = playbackEpoch;
    pending = true;
    if (timer !== null) cancel(timer); timer = null;
    try {
      const current = readPlayback(), stamp = transport.context();
      if (context !== stamp) {reset(); context = stamp;}
      if (!/^inventory-track:[1-9]\d*:[1-9]\d*$/.test(current?.track_ref || '') || current.state !== 'playing') {
        if (token) await transport.request('/playback/session/presence', {method: 'POST', expected: stamp,
          body: {presence_ref: token, sequence: ++sequence, state: current?.state === 'paused' ? 'paused' : 'stopped'}});
        reset();
      } else {
        if (blockedEpoch === playbackEpoch) return;
        if (source !== current.track_ref || !token) {
          const result = await transport.request('/playback/session/presence-source', {method: 'POST', expected: stamp,
            body: {track_ref: current.track_ref, player_ref: playerRef, sequence: ++sequence}});
          if (disposed || transport.context() !== stamp) return;
          token = result.data?.presence_ref; source = current.track_ref;
          if (typeof token !== 'string' || !token) throw new Error('Invalid presence receipt.');
        }
        const fresh = readPlayback();
        const state = fresh?.track_ref === source && fresh.state === 'playing' ? 'playing' : fresh?.state === 'paused' ? 'paused' : 'stopped';
        await transport.request('/playback/session/presence', {method: 'POST', expected: stamp,
          body: {presence_ref: token, sequence: ++sequence, state}});
        if (state !== 'playing') reset();
      }
    } catch {reset(); blockedEpoch = startedEpoch;}
    finally {
      pending = false;
      if (!disposed) {const delay = dirty ? 0 : 5000; dirty = false; timer = schedule(refresh, delay);}
    }
  }
  const unsubscribe = subscribe?.(() => {playbackEpoch++; refresh();}), unsubscribeContext = transport.subscribe?.(refresh);
  refresh();
  return {refresh, dispose() {disposed = true; if (timer !== null) cancel(timer); unsubscribe?.(); unsubscribeContext?.(); reset();}};
}

export function currentPresence(result, subjectRef, now = Date.now()) {
  const data = result?.status === 'ready' ? result.data : null;
  if (!data || data.subject_ref !== subjectRef || data.state !== 'playing' || typeof data.occurrence_ref !== 'string'
    || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now
    || !Number.isFinite(Date.parse(data.observed_at)) || Date.parse(data.observed_at) > now + 5000
    || now - Date.parse(data.observed_at) > 15000 || Date.parse(data.expires_at) - Date.parse(data.observed_at) > 15000
    || data.row?.kind !== 'track' || data.row?.source_readable !== true) return null;
  return data;
}
