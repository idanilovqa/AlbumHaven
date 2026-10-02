import { albums, artists, albumSeeds } from './fixture-data.mjs';

export function activity(who, kind, factor) {
  if (kind === 'albums') return albums.filter(a => a.mock.counts[who] > 0).map(a => ({ id:a.id, title:a.name, artist:a.album_artist, album:a, count:a.mock.counts[who]*factor }));
  if (kind === 'artists') return artists.map(a => ({ id:a.id, title:a.name, artist:a.genre, album:albums.find(album => album.mock.artist_id === a.id), count:albumSeeds.filter(seed => seed.artist === a.id).reduce((sum, seed) => sum+(seed.counts[who]||0), 0)*factor })).filter(row => row.count > 0);
  return albums.flatMap(album => album.tracks.map((track, index) => { const total=album.mock.counts[who]||0; return { id:track.path, title:track.title, artist:album.album_artist, album, track, count:(Math.floor(total/album.tracks.length)+(index<total%album.tracks.length?1:0))*factor }; })).filter(row => row.count > 0);
}

export function comparisonDirection(left, right) {
  const validCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!validCount(left) || !validCount(right)) return null;
  return left < right ? -1 : left > right ? 1 : 0;
}

// Code-unit ordering makes equal-count rows independent of input order and locale.
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const titleOf = row => String(row.title ?? '');

function positiveRowsById(rows) {
  const indexed = new Map();
  for (const row of rows) {
    if (typeof row.count !== 'number' || !Number.isFinite(row.count) || row.count <= 0) continue;
    const previous = indexed.get(row.id);
    // Repeated IDs represent one item, not additional listening. Prefer the
    // greatest observed count, then title, without modifying either source row.
    if (!previous || row.count > previous.count ||
        (row.count === previous.count && compareText(titleOf(row), titleOf(previous)) < 0)) {
      indexed.set(row.id, row);
    }
  }
  return indexed;
}

export function comparisonPairs(leftRows, rightRows, { sort = 'combined', ascending = false, commonOnly = false } = {}) {
  const left = positiveRowsById(leftRows), right = positiveRowsById(rightRows);
  const ids = new Set([...left.keys(), ...right.keys()]);
  const pairs = [...ids]
    .filter(id => !commonOnly || (left.has(id) && right.has(id)))
    .map(id => ({ id, left: left.get(id), right: right.get(id) }));
  const score = pair => sort === 'yours' ? (pair.left?.count ?? 0)
    : sort === 'friend' ? (pair.right?.count ?? 0)
      : (pair.left?.count ?? 0) + (pair.right?.count ?? 0);
  return pairs.sort((a, b) => (ascending ? 1 : -1) * (score(a) - score(b))
    || compareText(titleOf(a.left || a.right), titleOf(b.left || b.right))
    || compareText(String(a.id), String(b.id)));
}
