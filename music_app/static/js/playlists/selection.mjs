import {resource, safeServerArtworkUrl} from '../home-friends/model.mjs';
import {detailSelection} from '../home-friends/detail-projection.mjs';

export const playlistSourceReadable = row => row?.source_readable === true
  && !(Object.hasOwn(row.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read === false);
const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// A display-only copy of the current authorized row. No native media reference,
// playback permission, private path or cached source object crosses this seam.
export function playlistTrackSummary(row) {
  if (!row) return resource();
  if (!playlistSourceReadable(row)) return resource('denied');
  return resource('ready', Object.freeze({
    title: text(row.title), artist: text(row.artist), secondary_artist: text(row.secondary_artist),
    album_title: text(row.album_title), artwork_url: safeServerArtworkUrl(row.artwork_url),
    track_number: count(row.track_number), disc_number: count(row.disc_number),
    duration_seconds: typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)
      && row.duration_seconds >= 0 ? row.duration_seconds : null,
    duration_display: text(row.duration_display), source_label: text(row.source_label), source_kind: text(row.source_kind),
    metadata_state: ['current', 'last_known'].includes(row.metadata_state) ? row.metadata_state : 'unknown',
    availability: ['local', 'missing'].includes(row.availability) ? row.availability : 'unresolved',
  }));
}

// Album text, track identity and native open/play rights cannot authorize this
// independent read-only projection. The server must supply its canonical ref.
export function playlistAlbumSelection(row) {
  if (!playlistSourceReadable(row)) return null;
  if (row.album_target != null) return row.album_target.kind === 'album' ? detailSelection(row.album_target) : null;
  return detailSelection({kind: 'album', ref: row.album_ref, allowed_actions: row.allowed_actions});
}

// Artist display text never supplies catalog identity or account identity.
export function playlistArtistSelection(row) {
  return playlistSourceReadable(row) && row.artist_target?.kind === 'artist' ? detailSelection(row.artist_target) : null;
}
