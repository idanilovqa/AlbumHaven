const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const frozen = value => Object.freeze(value);
export const MIX_ORDER_OPTIONS = frozen([['regular', 'In order'], ['shuffle', 'Shuffle'], ['unplayed_first', 'Unplayed first']].map(frozen));
export const mixOrder = value => MIX_ORDER_OPTIONS.some(([key]) => key === value);
export const mixRefreshStatus = value => ['idle', 'queued', 'running', 'complete', 'blocked', 'cancelled'].includes(value) ? value : 'idle';
export const mixRefreshError = value => ['not_configured', 'enqueue_unavailable', 'status_unavailable'].includes(value) ? value : null;

export function normalizeMixCoverage(value) {
  if (!record(value) || !Number.isSafeInteger(value.excluded_count) || value.excluded_count < 0
    || !Number.isSafeInteger(value.selected_count) || value.selected_count < 0) return frozen({});
  return frozen({selected_count: value.selected_count, excluded_count: value.excluded_count,
    reasons: frozen(Object.fromEntries(Object.entries(record(value.reasons) ? value.reasons : {})
      .filter(([key, count]) => ['missing_global_metric', 'mapping_mismatch', 'ambiguous_attribution', 'missing_group_identity',
        'missing_recording_identity', 'missing_provider_mapping', 'provider_unavailable'].includes(key)
        && Number.isSafeInteger(count) && count >= 0)))});
}

export function normalizeMixRecipe(value) {
  if (!record(value) || !['per_artist', 'per_album'].includes(value.selection_basis)
    || !Number.isSafeInteger(value.songs_per_group) || value.songs_per_group < 1 || value.songs_per_group > 5000
    || typeof value.auto_update !== 'boolean' || !mixOrder(value.playback_order ?? 'regular')) return null;
  return frozen({selection_basis: value.selection_basis, songs_per_group: value.songs_per_group,
    auto_update: value.auto_update, playback_order: value.playback_order ?? 'regular'});
}

const localId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) < 2n ** 63n;
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
export function normalizeArtistMixScope(value) {
  if (!exact(value, ['kind','artist_ids','memberships','album_order','categories','album_types']) || value.kind !== 'selected_artists'
    || !Array.isArray(value.artist_ids) || !value.artist_ids.length || value.artist_ids.length > 5000
    || !Array.isArray(value.memberships) || value.memberships.length !== value.artist_ids.length
    || !Array.isArray(value.album_order) || value.album_order.length > 5000
    || value.artist_ids.some(id => !localId(id)) || value.album_order.some(id => !localId(id))
    || new Set(value.artist_ids).size !== value.artist_ids.length || new Set(value.album_order).size !== value.album_order.length) return null;
  const categories=['main_library','new_arrivals','hoard'], types=['studio','ep','live','demo','compilation','single'];
  if(!Array.isArray(value.categories)||!Array.isArray(value.album_types)
    ||value.categories.some(item=>!categories.includes(item))||value.album_types.some(item=>!types.includes(item))
    ||new Set(value.categories).size!==value.categories.length||new Set(value.album_types).size!==value.album_types.length)return null;
  const members = new Map();
  for (const item of value.memberships) {
    if (!exact(item, ['artist_id','basis']) || !value.artist_ids.includes(item.artist_id)
      || !['primary_credit','family_credit'].includes(item.basis) || members.has(item.artist_id)) return null;
    members.set(item.artist_id, item.basis);
  }
  const ids = [...value.artist_ids].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return frozen({kind:'selected_artists',artist_ids:frozen(ids),
    memberships:frozen(ids.map(artist_id => frozen({artist_id,basis:members.get(artist_id)}))),
    album_order:frozen([...value.album_order]),categories:frozen(categories.filter(item=>value.categories.includes(item))),
    album_types:frozen(types.filter(item=>value.album_types.includes(item)))});
}

export function captureArtistMixScope(groups, albums, filters) {
  if(!record(filters))return null;
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(albums)) return null;
  const members = new Map(), available = new Set(), albumOrder = [];
  for (const group of groups) {
    const scope = normalizeArtistMixScope({...group?.popular_selection_scope,categories:filters.categories,album_types:filters.album_types});
    if (!scope) return null;
    for (const item of scope.memberships) {
      if (!members.has(item.artist_id) || item.basis === 'primary_credit') members.set(item.artist_id,item.basis);
    }
    for (const id of scope.album_order) available.add(id);
  }
  for (const album of albums) {
    // Decimal string IDs are projected by the server. Names/keys are never fallback IDs.
    const id = album?.popular_album_id;
    if (!localId(id) || !available.has(id)) return null;
    if (!albumOrder.includes(id)) albumOrder.push(id);
  }
  return normalizeArtistMixScope({kind:'selected_artists',artist_ids:[...members.keys()],
    memberships:[...members].map(([artist_id,basis])=>({artist_id,basis})),album_order:albumOrder,
    categories:filters.categories,album_types:filters.album_types});
}

export function mixSourceProtocol(value) {
  if (!record(value) || value.provider !== 'lastfm' || value.metric !== 'overall_scrobbles') return null;
  if (value.version === 1 && value.source === 'whole_library') return 'library_mix_selection_v1';
  if (value.version === 2 && value.source === 'artist_selection' && normalizeArtistMixScope(value.scope)) return 'artist_popular_selection_v1';
  return null;
}

