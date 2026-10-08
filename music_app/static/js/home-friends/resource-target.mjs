// Canonical catalog targets only. Account profile identity has a separate owner.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const freeze = Object.freeze;
const grant = (value, name) => object(value) && Object.hasOwn(value, name) && value[name] === true;

export function detailOrigin(value) {
  if (!object(value) || !['recent', 'activity', 'playlist', 'comparison'].includes(value.source)) return null;
  const playlist = value.source === 'playlist';
  if (value.account_ref != null && !reference(value.account_ref)) return null;
  if (value.source === 'recent' && value.account_ref != null) return null;
  if (!playlist && (!['albums', 'artists', 'tracks', 'listens'].includes(value.kind)
    || !['week', 'month', 'six', 'year', 'all'].includes(value.period))) return null;
  if (playlist && !reference(value.playlist_ref)) return null;
  if (value.snapshot_ref != null && !reference(value.snapshot_ref)) return null;
  return freeze({source: value.source, account_ref: value.account_ref ?? null,
    ...(!playlist ? {kind: value.kind, period: value.period} : {playlist_ref: value.playlist_ref}),
    ...(value.snapshot_ref == null ? {} : {snapshot_ref: value.snapshot_ref})});
}

export function detailSelection(value) {
  if (!object(value) || !['album', 'artist'].includes(value.kind) || !reference(value.ref)) return null;
  const origin = value.origin == null ? null : detailOrigin(value.origin);
  if (value.origin != null && !origin) return null;
  const native = nativeActions(value.native_actions, value.kind);
  return freeze({kind: value.kind, ref: value.ref,
    allowed_actions: freeze({can_view_details: grant(value.allowed_actions, 'can_view_details')}),
    ...(origin ? {origin} : {}),
    ...(native ? {native_actions: native} : {})});
}

export function nativeActions(value, kind = 'album') {
  if (!object(value)) return null;
  if (kind === 'artist') return reference(value.artist_ref) ? freeze({artist_ref: value.artist_ref,
    allowed_actions: freeze({can_open_artist_gallery: grant(value.allowed_actions, 'can_open_artist_gallery')})}) : null;
  if (!reference(value.album_ref)) return null;
  const canOpen = grant(value.allowed_actions, 'can_open_album');
  return freeze({album_ref: value.album_ref, allowed_actions: freeze({
    can_open_album: canOpen, can_play_album: canOpen && grant(value.allowed_actions, 'can_play_album'),
    ...(Object.hasOwn(value.allowed_actions || {}, 'can_view_artwork')
      ? {can_view_artwork: canOpen && grant(value.allowed_actions, 'can_view_artwork')} : {}),
    ...(Object.hasOwn(value.allowed_actions || {}, 'can_open_album_page')
      ? {can_open_album_page: canOpen && grant(value.allowed_actions, 'can_open_album_page')} : {}),
  })});
}
export function detailSelectionKey(value) {
  const selection = detailSelection(value);
  return selection ? JSON.stringify(selection) : '';
}
export function matchingDetail(data, selection) {
  const target = detailSelection(selection);
  return !!target && data?.kind === target.kind && data.ref === target.ref
    && (!target.origin || JSON.stringify(detailOrigin(data.origin)) === JSON.stringify(target.origin));
}
