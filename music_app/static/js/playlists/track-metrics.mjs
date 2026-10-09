import {normalizePlaylistFacts} from './filters.mjs';
import {trackLoveHtml} from '../home-friends/track-preference.mjs';

// Personal plays and supplied global popularity are separate display facts.
// Love alone can consume the native preference controller's current state;
// numeric display facts never grant mutation or playback authority.
const columns = Object.freeze([
  {key: 'love_tier', label: 'Love', width: '60px'},
  {key: 'track_rating', label: 'Rating', width: '112px', hideWhenNarrow: true},
  {key: 'play_count', label: 'Plays', width: '72px'},
  {key: 'popularity_count', label: 'Popularity', width: '100px'},
  {key: 'duration', label: 'Length', width: '72px'},
].map(column => Object.freeze({...column, sortable: column.key !== 'track_rating', type: 'number'})));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function playlistTrackMetricColumns({includeRating = true} = {}) {
  return includeRating ? columns : columns.filter(column => column.key !== 'track_rating');
}

export function getPlaylistTrackMetricValue(row, key, preference = null) {
  const facts = normalizePlaylistFacts(row);
  if (key === 'love_tier') {
    const tier = row?.source_readable !== false && !(own(row?.allowed_actions, 'can_read') && row.allowed_actions.can_read === false)
      && ['off', 'loved', 'obsessed'].includes(preference?.love_tier) ? preference.love_tier : facts.love_tier;
    return tier === null ? null : ['off', 'loved', 'obsessed'].indexOf(tier);
  }
  if (key === 'duration') return facts.duration_seconds;
  return ['track_rating', 'play_count', 'popularity_count'].includes(key) ? facts[key] : null;
}

export function playlistTrackMetricCells(runtime, row, preferenceState) {
  const facts = normalizePlaylistFacts(row), escape = runtime.escapeHtml;
  const countCell = (value, label) => ({content: `<span class="album-track-table__metric" title="${escape(label)}">${escape(value === null ? '–' : value)}</span>`});
  const rating = facts.track_rating, ratingLabel = rating === null ? 'Track rating unavailable' : `Track rating: ${rating} out of 5`;
  const ratingHtml = rating !== null && typeof runtime.ratingHtml === 'function'
    ? runtime.ratingHtml({value: rating, maximum: 5, label: ratingLabel})
    : `<span role="img" aria-label="${escape(ratingLabel)}">${rating === null ? '–' : `${rating}/5`}</span>`;
  const seconds = facts.duration_seconds;
  const readable = row !== null && typeof row === 'object' && !Array.isArray(row) && row.source_readable !== false
    && !(own(row.allowed_actions, 'can_read') && row.allowed_actions.can_read === false);
  // Legacy native rows can supply a length label without numeric seconds. It
  // remains display-only and cannot become a duration or sorting authority.
  const durationDisplay = readable && own(row, 'duration_display') && typeof row.duration_display === 'string' ? row.duration_display.trim() : '';
  const length = seconds === null ? durationDisplay || '–' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return {
    love_tier: {content: trackLoveHtml(runtime, row, preferenceState)},
    track_rating: {content: `<div class="album-track-table__rating" title="${escape(ratingLabel)} · Rating editing is unavailable.">${ratingHtml}</div>`},
    play_count: countCell(facts.play_count, facts.play_count === null ? 'Personal plays unavailable' : 'Your play count'),
    popularity_count: countCell(facts.popularity_count, facts.popularity_count === null ? 'Global popularity unavailable' : 'Global popularity count'),
    duration: {content: `<span class="track-duration">${escape(length)}</span>`},
  };
}
