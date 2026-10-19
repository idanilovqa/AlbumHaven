// Exact server recipe identities. Never round-trip a PostgreSQL bigint through Number.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const descriptorKeys = ['version', 'root_artist_id', 'scope_mode'];
const recipeKeys = [...descriptorKeys, 'source', 'auto_update', 'playback_order'];
export function normalizeArtistLovedDescriptor(value) {
  if (!exact(value, descriptorKeys) || value.version !== 1 || typeof value.root_artist_id !== 'string'
    || !/^[1-9][0-9]{0,18}$/.test(value.root_artist_id)
    || value.root_artist_id.length === 19 && value.root_artist_id > '9223372036854775807'
    || !['artist', 'family'].includes(value.scope_mode)) return null;
  return Object.freeze({version: 1, root_artist_id: value.root_artist_id, scope_mode: value.scope_mode});
}
export function normalizeArtistLovedRecipe(value) {
  if (!exact(value, recipeKeys) || value.source !== 'artist_loved' || value.auto_update !== true
    || !['regular', 'shuffle', 'unplayed_first'].includes(value.playback_order)) return null;
  const descriptor = normalizeArtistLovedDescriptor(Object.fromEntries(descriptorKeys.map(key => [key, value[key]])));
  return descriptor && Object.freeze({...descriptor, source: 'artist_loved', auto_update: true, playback_order: value.playback_order});
}
export function normalizeArtistLovedLaunch(value) {
  if (!exact(value, ['context_ref', 'artist_ref', 'descriptor']) || typeof value.context_ref !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.context_ref) || typeof value.artist_ref !== 'string' || !value.artist_ref.trim()
    || /[\x00-\x1f\x7f]/.test(value.artist_ref)) return null;
  const descriptor = normalizeArtistLovedDescriptor(value.descriptor);
  return descriptor && Object.freeze({context_ref: value.context_ref, artist_ref: value.artist_ref, descriptor});
}
export function normalizeSavedArtistLovedRecipe(value) {
  if (!exact(value, [...recipeKeys, 'last_evaluated_at', 'root_state', 'refresh_status'])
    || !['current', 'last_computed', 'owner_refresh_required', 'unavailable', 'too_large'].includes(value.refresh_status)
    || !['present', 'root_missing'].includes(value.root_state) || typeof value.last_evaluated_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T/.test(value.last_evaluated_at) || !Number.isFinite(Date.parse(value.last_evaluated_at))) return null;
  const recipe = normalizeArtistLovedRecipe(Object.fromEntries(recipeKeys.map(key => [key, value[key]])));
  return recipe && Object.freeze({...recipe, last_evaluated_at: value.last_evaluated_at,
    root_state: value.root_state, refresh_status: value.refresh_status});
}
