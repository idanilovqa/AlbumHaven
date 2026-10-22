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
function playlistQueueShuffleCopy(tracks, random = Math.random) {
  const values = [...tracks];
  for (let end = values.length - 1; end > 0; end--) {
    const target = Math.floor(random() * (end + 1));
    [values[end], values[target]] = [values[target], values[end]];
  }
  return values;
}
function playlistQueueOrder(tracks, shuffle, currentPath = '', currentItemId = null) {
  const values = [...tracks];
  if (!shuffle) return values;
  const index = values.findIndex(track => currentItemId ? track.playlistItemId === currentItemId : track.path === currentPath);
  const current = index >= 0 ? values.splice(index, 1)[0] : null;
  const shuffled = playlistQueueShuffleCopy(values);
  return current ? [current, ...shuffled] : shuffled;
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
  if (state.player.playbackQueue !== expectedQueue || !(next?.playlistId || next?.libraryMixRef)) throw new Error('The Playlist queue changed.');
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
    const index = next.playlistId ? playlistQueueNextIndex(next, String(state.player.current?.path || '')) : next.currentIndex + 1;
    const track = index >= 0 ? next.tracks[index] : null;
    if (track && typeof scheduleStreamingContinuity === 'function') {
      const pending = scheduleStreamingContinuity(track);
      if (typeof observeStreamingFacadeCallback === 'function') observeStreamingFacadeCallback(pending, 'playlist-queue-mode-error');
      else Promise.resolve(pending).catch(() => {});
    }
  }
  return next;
}

// Session-local Top provenance. Native queue shape is presentation only; only
// private source receipts can admit media or advance the occurrence cursor.
const TopPlaybackRuntime = (() => {
  const queues = new WeakMap(), tracks = new WeakMap();
  let serial = 0;
  const unavailable = () => Object.assign(new Error('This Top playback source is no longer available.'), {name: 'AbortError'});
  const entryFor = queue => queue && queues.get(queue);
  const recordFor = track => track && tracks.get(track);
  function owns(entry) {
    return entry.pending || state.player.playbackQueue === entry.queue
      || recordFor(state.player.current)?.entry === entry
      || (typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.referencesOrdinaryQueue(entry.queue));
  }
  function sync(entry) {
    const snapshot = entry.source.snapshot();
    entry.queue.tracks = snapshot.order.map(id => entry.values.get(id));
    entry.queue.currentIndex = snapshot.currentIndex;
    return snapshot;
  }
  function bind(entry, receipt) {
    const record = {entry, id: receipt.occurrenceId, receipt};
    tracks.set(receipt.payload, record);
    entry.values.set(record.id, receipt.payload);
    entry.prepared = receipt;
    sync(entry);
    return receipt.payload;
  }
  function dispose(entry) {
    if (!entry || entry.retired) return;
    const engine = typeof streamingEngineState === 'function' ? streamingEngineState() : null;
    const role = engine?.roles?.current, continuity = engine?.roles?.continuity;
    const pending = engine?.pendingContinuityTrack;
    const ownedReplacement = engine?.pendingSeek?.kind === 'replacement' && continuity
      && engine.pendingSeek.streamId === continuity.streamId && recordFor(continuity.track)?.entry === entry;
    const attempt = ownedReplacement ? engine.playbackAttempt
      : typeof captureStreamingPlaybackAttempt === 'function' ? captureStreamingPlaybackAttempt() : null;
    const incomingAttempt = engine?.playbackAttempt;
    entry.retired = true; entry.pending = false; entry.prepared = null; entry.starting = null;
    if (pending && recordFor(pending)?.entry === entry && engine.pendingContinuityTrack === pending) {
      engine.pendingContinuityTrack = null; engine.pendingContinuityOptions = null;
    }
    const ownsCurrent = role && recordFor(role.track)?.entry === entry;
    const ownsContinuity = continuity && recordFor(continuity.track)?.entry === entry;
    const stop = () => {
      if (!attempt || engine.roles.current !== role || !isStreamingPlaybackAttemptCurrent(attempt)) return;
      const pendingStop = stopStreamingPlayback('top-source-retired', {expectedAttempt: attempt});
      void pendingStop.catch(error => console.error('Top playback retirement failed', error));
    };
    if (ownedReplacement || ownsCurrent && attempt) stop();
    else if (ownsCurrent) retireStreamingOutgoingRole(role, incomingAttempt);
    else if (ownsContinuity && engine.roles.continuity === continuity
      && closeStreamingContinuityRole('top-source-retired') !== true) stop();
    entry.source?.dispose(); entry.onRetire?.();
  }
  function current(entry) {
    if (!entry || entry.retired) return false;
    return entry.source.isCurrent();
  }
  function describe(queue, index = null) {
    const entry = entryFor(queue);
    if (!entry) return null;
    if (!current(entry)) return Object.freeze({session: entry.serial, source: 'album-top',
      tracks: Object.freeze([]), albums: Object.freeze([]), index: -1, albumComplete: false,
      repeat: 'off', shuffle: false, ended: true, nativeQueue: queue, nativeTracks: Object.freeze([])});
    const value = sync(entry), position = index === null ? value.currentIndex : index;
    const ids = value.order, album = entry.source.albumFor(ids[position]);
    const albumCaptureComplete = Boolean(album) && !entry.partialAlbums.has(album);
    const albumComplete = albumCaptureComplete && !value.unavailableIds.some(id => entry.source.albumFor(id) === album);
    return Object.freeze({session: entry.serial, source: 'album-top', tracks: ids,
      albums: Object.freeze(ids.map(id => entry.source.albumFor(id))), index: position,
      albumCaptureComplete, albumComplete, repeat: 'off', shuffle: false,
      ended: position < 0 || position >= ids.length, nativeQueue: queue, nativeTracks: queue.tracks});
  }
  async function prepare(queue, options) {
    const entry = entryFor(queue);
    if (!current(entry)) throw unavailable();
    entry.prepared = null;
    const receipt = await entry.source.prepare(options);
    if (!current(entry)) throw unavailable();
    if (!receipt) {sync(entry); return null;}
    if (!entry.source.isReceiptCurrent(receipt, receipt.payload)) throw unavailable();
    return bind(entry, receipt);
  }
  function commit(track) {
    const record = recordFor(track), entry = record?.entry;
    if (!current(entry) || entry.prepared !== record.receipt
      || !entry.source.commit(record.receipt, track)) return false;
    entry.prepared = null; entry.pending = false; entry.starting = null; sync(entry); return true;
  }
  return Object.freeze({
    create({capture, createSource, isCurrent, onRetire}) {
      if (typeof createSource !== 'function' || typeof isCurrent !== 'function'
        || !Array.isArray(capture?.albums) || !capture.albums.length) throw new TypeError('Invalid Top queue.');
      const queue = {sourceKind: 'album-top', tracks: [], currentIndex: 0};
      const entry = {queue, serial: ++serial, pending: true, startAdmitted: false, retired: false, prepared: null, starting: null,
        values: new Map(), partialAlbums: new Set(), onRetire, source: null};
      for (const value of capture.unavailable_items || []) if (value.reason === 'tracks_unavailable') entry.partialAlbums.add(value.item_ref);
      for (const album of capture.albums) for (const occurrence of album.tracks) {
        const target = occurrence.native_target;
        const placeholder = Object.freeze({sourceKind: 'album-top', path: target.path,
          src: `/track?path=${encodeURIComponent(target.path)}`, title: target.title,
          artist: target.artist, album: target.album_title, albumRef: album.album_ref,
          durationSeconds: target.duration_seconds});
        entry.values.set(occurrence.queue_item_ref, placeholder);
        tracks.set(placeholder, {entry, id: occurrence.queue_item_ref, receipt: null});
      }
      queues.set(queue, entry);
      try {
        entry.source = createSource(() => {
          try {if (!entry.retired && isCurrent() === true && owns(entry)) return true;} catch {}
          dispose(entry); return false;
        });
        sync(entry);
        return queue;
      } catch (error) {dispose(entry); throw error;}
    },
    hasQueue: queue => queues.has(queue),
    hasBinding: track => tracks.has(track),
    isPayloadCurrent(track) {
      const record = recordFor(track);
      return !!record?.receipt && current(record.entry)
        && record.entry.source.aliasBinding(record.receipt.payload, track);
    },
    async start(queue, {signal} = {}) {
      const entry = entryFor(queue);
      if (!current(entry) || !entry.pending || entry.startAdmitted || signal?.aborted) return false;
      entry.startAdmitted = true;
      const previousEntry = entryFor(state.player.playbackQueue);
      const previous = previousEntry?.pending ? previousEntry.previousQueue : state.player.playbackQueue;
      entry.previousQueue = previous;
      state.player.playbackQueue = queue;
      let started = false, selectedToken = playerTrackSelectionToken;
      try {
        started = await playTrackFromPayload(queue.tracks[0], {signal, isCurrent: () => current(entry),
          onSelectionAdmitted: token => {selectedToken = token;}});
        return started;
      } finally {
        if (!started) {
          dispose(entry);
          if (state.player.playbackQueue === queue) state.player.playbackQueue = playerTrackSelectionToken === selectedToken ? previous : null;
        }
      }
    },
    isStarting: queue => Boolean(entryFor(queue)?.starting),
    hasOffset(queue, direction) {
      const entry = entryFor(queue);
      return current(entry) && entry.source.candidate({direction, automatic: false}) !== null;
    },
    currentIndex(queue) {const entry = entryFor(queue); return current(entry) ? entry.source.snapshot().currentIndex : -1;},
    describe,
    successor(context, automatic = true) {
      const entry = entryFor(context?.nativeQueue);
      if (!current(entry)) return context ? Object.freeze({...context, ended: true}) : null;
      const id = entry.source.candidate({direction: 1, automatic});
      return id === null ? Object.freeze({...context, ended: true})
        : describe(entry.queue, entry.source.snapshot().order.indexOf(id));
    },
    shouldStop(queue) {
      const entry = entryFor(queue);
      if (!current(entry)) return true;
      return entry.source.snapshot().stopAfterAlbum
        && entry.source.candidate({direction: 1, automatic: true}) === null;
    },
    prepare,
    async prepareContext(context, options) {
      const entry = entryFor(context?.nativeQueue), id = context?.tracks?.[context.index];
      if (!current(entry) || !id || context.source !== 'album-top') throw unavailable();
      const direction = id === entry.source.snapshot().currentId ? 0 : 1;
      return prepare(entry.queue, {...options, direction, occurrenceId: id});
    },
    contextForTrack(track) {
      const record = recordFor(track);
      return record && current(record.entry) ? describe(record.entry.queue, record.entry.source.snapshot().order.indexOf(record.id)) : null;
    },
    async prepareNext(queue = state.player.playbackQueue) {
      const entry = entryFor(queue), engine = streamingEngineState(), outgoing = engine.roles?.current;
      if (!current(entry) || entry.starting || !outgoing
        || state.player.loopActive || isPlaybackLockedByAnotherTab()) return null;
      const track = await prepare(queue, {direction: 1, automatic: true, isCurrent: () =>
        state.player.playbackQueue === queue && !state.player.loopActive && !isPlaybackLockedByAnotherTab()
        && (engine.roles.current === outgoing || engine.roles.current?.track === entry.prepared?.payload)});
      if (!track || !entry.source.isReceiptCurrent(entry.prepared, track)) return null;
      await scheduleStreamingContinuity(track);
      return track;
    },
    peek(queue) {
      const entry = entryFor(queue), receipt = entry?.prepared;
      return receipt && current(entry) && entry.source.isReceiptCurrent(receipt, receipt.payload) ? receipt.payload : null;
    },
    consume(queue) {
      const entry = entryFor(queue), receipt = entry?.prepared;
      if (!receipt || streamingEngineState().roles?.current?.track !== receipt.payload) return null;
      return commit(receipt.payload) ? receipt.payload : null;
    },
    async skip(queue, direction) {
      const entry = entryFor(queue);
      if (!current(entry) || ![-1, 1].includes(direction)) return false;
      const id = entry.source.candidate({direction, automatic: false});
      if (id === null) return false;
      return playTrackFromPayload(entry.values.get(id), {explicitQueueTransition: true});
    },
    configure(queue, options) {
      const entry = entryFor(queue), engine = streamingEngineState();
      if (!current(entry) || entry.starting || engine.pendingPromotion || engine.pendingSeek) return false;
      const before = entry.source.snapshot();
      if (!options || typeof options !== 'object'
        || options.mode !== undefined && !['in_order', 'random_albums', 'random_songs', 'popular_songs'].includes(options.mode)
        || options.stopAfterAlbum !== undefined && typeof options.stopAfterAlbum !== 'boolean') return false;
      if ((options.mode === undefined || options.mode === before.mode)
        && (options.stopAfterAlbum === undefined || options.stopAfterAlbum === before.stopAfterAlbum)) return true;
      if (!state.player.loopActive && engine.roles?.continuity && closeStreamingContinuityRole('top-queue-mode') !== true) return false;
      if (!entry.source.configure(options)) return false;
      entry.prepared = null; sync(entry);
      if (!state.player.loopActive) {engine.pendingContinuityTrack = null; engine.pendingContinuityOptions = null;}
      if (typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression()) ExplicitQueueRuntime.modeChanged(queue, queue);
      else if (!state.player.loopActive) {
        const pending = this.prepareNext(queue);
        if (typeof observeStreamingFacadeCallback === 'function') observeStreamingFacadeCallback(pending, 'top-queue-mode-error');
        else void pending.catch(() => {});
      }
      return true;
    },
    async prepareStart(track, options) {
      const record = recordFor(track), entry = record?.entry;
      if (!current(entry)) throw unavailable();
      const value = entry.source.snapshot();
      const direction = record.id === value.currentId ? 0
        : record.id === entry.source.candidate({direction: 1, automatic: false}) ? 1
          : record.id === entry.source.candidate({direction: -1, automatic: false}) ? -1 : null;
      if (direction === null) throw unavailable();
      const occurrenceId = direction === 0 && value.unavailableIds.includes(record.id)
        ? entry.source.candidate({direction: 1, automatic: false}) : record.id;
      const intent = {}; entry.starting = intent;
      try {
        const payload = await prepare(entry.queue, {...options, direction, automatic: false,
          ...(occurrenceId === null ? {} : {occurrenceId})});
        if (!payload && entry.starting === intent) entry.starting = null;
        return payload;
      } catch (error) {if (entry.starting === intent) entry.starting = null; throw error;}
    },
    receiptCurrent(track) {
      const record = recordFor(track);
      return !!record?.receipt && current(record.entry)
        && record.entry.prepared === record.receipt && record.entry.source.isReceiptCurrent(record.receipt, track);
    },
    commit,
    alias(original, clone) {
      const record = recordFor(original);
      if (!record?.receipt || !record.entry.source.aliasBinding(original, clone)) return false;
      tracks.set(clone, record); return true;
    },
    cancel(queue) {const entry = entryFor(queue); if (entry) {entry.prepared = null; entry.starting = null; entry.source.cancel();}},
    cancelStart(track) {
      const record = recordFor(track), entry = record?.entry;
      if (entry?.starting && entry.prepared === record.receipt) {entry.prepared = null; entry.starting = null; entry.source.cancel();}
    },
    dispose(queue) {dispose(entryFor(queue));},
  });
})();
function isTopPlaybackBoundPayload(track) {return TopPlaybackRuntime.hasBinding(track);}
