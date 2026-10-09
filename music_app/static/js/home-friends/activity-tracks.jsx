import {safeServerArtworkUrl} from './model.mjs';
import {trackLoveHtml, paintTrackLoveCell} from './track-preference.mjs';

export const isActivityTrack = row => ['track', 'listen'].includes(row?.kind);
export const readableActivityTrack = row => isActivityTrack(row) && row.source_readable !== false;
export const playableActivityTrack = (runtime, row, context) => readableActivityTrack(row) && row.availability !== 'missing'
  && typeof runtime.trackIntent === 'function' && typeof runtime.canTrackIntent === 'function'
  && runtime.canTrackIntent('play', row, context) === true;

// Compose the native compact row, artbox and action owners. Only public display
// fields cross this boundary; native playback retains track/path authority.
export function activityTrackRow(runtime, row, index, context, cells) {
  const escape = runtime.escapeHtml, readable = readableActivityTrack(row);
  const title = readable ? row.title || 'Unknown track' : 'Unavailable track';
  const native = runtime.albumTrackRow?.({title, secondary_artist: readable ? row.secondary_artist : '',
    availability: row.availability}, index);
  const url = readable ? safeServerArtworkUrl(row.artwork_url) : null;
  const artwork = runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${title} artwork`,
    coverHtml: url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async">` : ''});
  const availability = readable ? {local: 'Local', missing: 'Missing', unresolved: 'Needs review'}[row.availability] || 'Unavailable' : 'Unavailable';
  return {key: row.id, className: native?.className || 'album-track-table__row', tabIndex: readable ? 0 : -1,
    ariaDisabled: !readable, dataAttributes: {'home-activity-row': row.id}, cells: {...cells,
      number: {content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escape(index + 1)}</span>`
        + runtime.actionHtml({icon: 'play', className: 'album-track-table__play', ariaLabel: `Play ${title}`, title: 'Play track',
          presentation: 'bare', hidden: row.availability === 'missing', disabled: !playableActivityTrack(runtime, row, context), attributes: {'data-home-activity-play': '1'}}) + '</span>'},
      title: {content: `<div class="home-detail__release">${artwork}${native?.cells?.title?.content || `<span class="album-track-table__title">${escape(title)}</span>`}</div>`
        + runtime.actionHtml({icon: 'more', ariaLabel: `Select ${title}`, title: 'Show track information', presentation: 'bare',
          disabled: !readable, attributes: {'data-home-activity-select': row.id}})},
      availability: {content: escape(availability)},
      love: {content: trackLoveHtml(runtime, row)},
    }};
}

// Player and Love notifications paint existing rows. Selection has its own
// shared owner; neither replaces native double-click targets or focused controls.
export function paintActivityTracks(host, runtime, rows, context, love) {
  host.querySelector('.album-track-table')?.setAttribute('data-playing-animation', 'enabled');
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const node of host.querySelectorAll('[data-home-activity-row]')) {
    const row = byId.get(node.dataset.homeActivityRow);
    if (!row) continue;
    const playback = readableActivityTrack(row) ? runtime.trackPlayback?.(row, context) : null;
    const current = playback?.isCurrent === true, playing = current && playback?.isPlaying === true;
    if (current) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
    node.classList.toggle('album-track-table__row--current', current);
    node.classList.toggle('album-track-table__row--playing', playing);
    // Animation preference remains owned by the native playback projection.
    node.classList.toggle('album-track-table__row--animated', playing && playback?.playingAnimation === true);
    const play = node.querySelector('[data-home-activity-play]');
    if (play) {
      play.hidden = row.availability === 'missing';
      play.disabled = !playableActivityTrack(runtime, row, context);
      play.setAttribute('aria-disabled', String(play.disabled));
    }
    const cell = node.querySelector('[data-track-love-cell]');
    if (cell) paintTrackLoveCell(cell, runtime, row, love.get(row));
  }
}
