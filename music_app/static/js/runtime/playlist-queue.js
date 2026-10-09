/* Playlist order/repeat is queue-local. The existing streaming player keeps
   audio, decoder roles, clock, transport and continuity promotion ownership. */
function playlistQueueCurrentIndex(queue, currentPath, currentItemId = state.player.current?.playlistItemId) {
  if (!queue?.playlistId || !Array.isArray(queue.tracks) || !queue.tracks.length) return -1;
  if (currentItemId) {
    const exact = queue.tracks.findIndex(track => track.playlistItemId === currentItemId && track.path === currentPath);
    if (exact >= 0) return exact;
  }
  const index = queue.currentIndex;
  if (Number.isSafeInteger(index) && index >= 0 && index < queue.tracks.length && queue.tracks[index].path === currentPath) return index;
  const matches = queue.tracks.map((track, offset) => track.path === currentPath ? offset : -1).filter(offset => offset >= 0);
  return matches.length === 1 ? matches[0] : -1;
}
function playlistQueueNextIndex(queue, currentPath) {
  if (!queue?.playlistId || !Array.isArray(queue.tracks) || !queue.tracks.length) return null;
  const current = playlistQueueCurrentIndex(queue, currentPath);
  if (current < 0) return -1;
  if (queue.repeatMode === 'one') return current;
  if (current + 1 < queue.tracks.length) return current + 1;
  return queue.repeatMode === 'all' ? 0 : -1;
}
function playlistQueueOrder(tracks, shuffle, currentPath = '', currentItemId = null) {
  const values = [...tracks];
  if (!shuffle) return values;
  const index = values.findIndex(track => currentItemId ? track.playlistItemId === currentItemId : track.path === currentPath);
  const current = index >= 0 ? values.splice(index, 1)[0] : null;
  for (let end = values.length - 1; end > 0; end--) {
    const target = Math.floor(Math.random() * (end + 1));
    [values[end], values[target]] = [values[target], values[end]];
  }
  return current ? [current, ...values] : values;
}
function replacePlaylistQueueModes(queue, {shuffle = queue?.shuffle === true, repeat = queue?.repeatMode || 'off'} = {}) {
  if (state.player.playbackQueue !== queue || !queue?.playlistId || typeof shuffle !== 'boolean'
    || !['off', 'all', 'one'].includes(repeat)) throw new Error('The Playlist queue changed.');
  const currentPath = String(state.player.current?.path || '');
  if (shuffle === (queue.shuffle === true) && repeat === (queue.repeatMode || 'off')) return queue;
  const currentIndex = playlistQueueCurrentIndex(queue, currentPath), current = queue.tracks[currentIndex];
  if (!current) throw new Error('The current Playlist occurrence is unavailable.');
  const tracks = shuffle === (queue.shuffle === true) ? queue.tracks
    : playlistQueueOrder(queue.regularTracks || queue.tracks, shuffle, currentPath, current.playlistItemId);
  const next = {...queue, regularTracks: queue.regularTracks || queue.tracks, tracks, shuffle, repeatMode: repeat,
    currentIndex: current.playlistItemId ? tracks.findIndex(track => track.playlistItemId === current.playlistItemId) : tracks.indexOf(current)};
  return commitPlaylistQueue(next, queue);
}
function commitPlaylistQueue(next, expectedQueue) {
  if (state.player.playbackQueue !== expectedQueue || !next?.playlistId) throw new Error('The Playlist queue changed.');
  const engine = typeof streamingEngineState === 'function' ? streamingEngineState() : null;
  if (engine?.pendingPromotion || engine?.roles?.current?.boundaryNotified) throw new Error('Wait for the current track transition before changing queue mode.');
  const loopOwned = state.player.loopActive === true;
  if (!loopOwned && engine?.roles?.continuity && (typeof closeStreamingContinuityRole !== 'function'
    || closeStreamingContinuityRole('playlist-queue-mode') !== true)) throw new Error('Queue mode change was not accepted.');
  state.player.playbackQueue = next;
  const explicitProgression = typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression();
  if (explicitProgression) ExplicitQueueRuntime.modeChanged(expectedQueue, next);
  if (engine && !loopOwned && !explicitProgression) {
    engine.pendingContinuityTrack = null; engine.pendingContinuityOptions = null;
    const index = playlistQueueNextIndex(next, String(state.player.current?.path || '')), track = index >= 0 ? next.tracks[index] : null;
    if (track && typeof scheduleStreamingContinuity === 'function') {
      const pending = scheduleStreamingContinuity(track);
      if (typeof observeStreamingFacadeCallback === 'function') observeStreamingFacadeCallback(pending, 'playlist-queue-mode-error');
      else Promise.resolve(pending).catch(() => {});
    }
  }
  return next;
}
