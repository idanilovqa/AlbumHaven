// Pure captured-occurrence scheduling. This owner never grants playback or owns audio.
export const TOP_PLAY_MODES = Object.freeze(['in_order', 'random_albums', 'random_songs', 'popular_songs']);

export function createTopQueuePlan(blocks, {mode = 'in_order', stopAfterAlbum = false, random = Math.random, popularity = []} = {}) {
  if (!Array.isArray(blocks) || !blocks.length || !TOP_PLAY_MODES.includes(mode)
      || typeof stopAfterAlbum !== 'boolean' || typeof random !== 'function') throw new TypeError('Invalid Top queue plan.');
  const albums = new Set(), occurrences = new Set();
  const canonical = Array.from(blocks, block => {
    if (!block || typeof block.id !== 'string' || !block.id || albums.has(block.id)
        || !Array.isArray(block.tracks) || !block.tracks.length) throw new TypeError('Invalid Top album block.');
    albums.add(block.id);
    const tracks = Array.from(block.tracks, id => {
      if (typeof id !== 'string' || !id || occurrences.has(id)) throw new TypeError('Invalid Top occurrence.');
      occurrences.add(id); return id;
    });
    return Object.freeze({id: block.id, tracks: Object.freeze(tracks)});
  });
  const albumByTrack = new Map(canonical.flatMap(block => block.tracks.map(id => [id, block.id])));
  const rank = new Map(), canonicalIndex = new Map([...occurrences].map((id, index) => [id, index]));
  if (!Array.isArray(popularity)) throw new TypeError('Invalid Top popularity.');
  for (const row of popularity) {
    if (!row || !occurrences.has(row.id) || rank.has(row.id) || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new TypeError('Invalid Top popularity.');
    }
    rank.set(row.id, row.count);
  }
  const popular = ids => [...ids].sort((left, right) => {
    const leftKnown = rank.has(left), rightKnown = rank.has(right);
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rank.get(left) !== rank.get(right)) return rank.get(left) > rank.get(right) ? -1 : 1;
    return canonicalIndex.get(left) - canonicalIndex.get(right);
  });
  const unavailable = new Set();
  let revision = 0, index = 0, visitedEnd = -1, order;
  const shuffled = values => {
    const result = [...values];
    for (let end = result.length - 1; end > 0; end--) {
      const sample = random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new TypeError('Invalid random sample.');
      const target = Math.floor(sample * (end + 1));
      [result[end], result[target]] = [result[target], result[end]];
    }
    return result;
  };
  function schedule(nextMode, prefix = []) {
    const visited = new Set(prefix), lastAlbum = albumByTrack.get(prefix.at(-1));
    const remaining = canonical.map(block => ({id: block.id, tracks: block.tracks.filter(id => !visited.has(id))}))
      .filter(block => block.tracks.length);
    // Finish the boundary album before entering any unvisited album. Previous
    // can move the cursor, but cannot erase the furthest visited prefix.
    const boundary = remaining.find(block => block.id === lastAlbum);
    let later = remaining.filter(block => block !== boundary);
    if (nextMode === 'random_albums') later = shuffled(later);
    const suffix = [...(boundary ? [boundary] : []), ...later].flatMap(block =>
      nextMode === 'random_songs' ? shuffled(block.tracks) : nextMode === 'popular_songs' ? popular(block.tracks) : block.tracks);
    return [...prefix, ...suffix];
  }
  order = schedule(mode);
  let snapshot;
  const publish = () => (snapshot = Object.freeze({revision, mode, stopAfterAlbum, currentIndex: index,
    visitedEnd, order: Object.freeze([...order]), currentId: order[index],
    currentAlbumId: albumByTrack.get(order[index]), unavailableIds: Object.freeze([...unavailable])}));
  function candidate({direction = 1, automatic = true} = {}) {
    if (![1, -1].includes(direction) || typeof automatic !== 'boolean') return null;
    let next = index + direction;
    while (next >= 0 && next < order.length && unavailable.has(order[next])) next += direction;
    if (next < 0 || next >= order.length) return null;
    if (automatic && direction > 0 && stopAfterAlbum
        && albumByTrack.get(order[next]) !== albumByTrack.get(order[index])) return null;
    return order[next];
  }
  publish();
  return Object.freeze({
    snapshot: () => snapshot,
    albumFor: id => albumByTrack.get(id) || null,
    candidate,
    // The native queue commits only an actually accepted occurrence. Merely
    // preparing continuity or previewing Next cannot advance this history.
    commit(id, expected = snapshot) {
      if (expected !== snapshot || typeof id !== 'string') return false;
      const next = order.indexOf(id);
      if (next < 0 || unavailable.has(id) || next !== index
          && id !== candidate({direction: next > index ? 1 : -1, automatic: false})) return false;
      index = next; visitedEnd = Math.max(visitedEnd, next); revision++; publish(); return true;
    },
    reject(id, expected = snapshot) {
      if (expected !== snapshot || typeof id !== 'string' || !id || !occurrences.has(id) || unavailable.has(id) || id !== order[index]
          && id !== candidate({automatic: false}) && id !== candidate({direction: -1, automatic: false})) return false;
      unavailable.add(id); revision++; publish(); return true;
    },
    configure({mode: nextMode = mode, stopAfterAlbum: nextStop = stopAfterAlbum} = {}, expected = snapshot) {
      if (expected !== snapshot || !TOP_PLAY_MODES.includes(nextMode) || typeof nextStop !== 'boolean') return false;
      if (nextMode === mode && nextStop === stopAfterAlbum) return true;
      const prefix = order.slice(0, Math.max(visitedEnd, index) + 1);
      const nextOrder = nextMode === mode ? order : schedule(nextMode, prefix);
      if (expected !== snapshot) return false;
      order = nextOrder; mode = nextMode; stopAfterAlbum = nextStop; revision++; publish(); return true;
    },
  });
}
