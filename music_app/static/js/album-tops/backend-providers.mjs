import {createCurrentTopListeningProvider} from './current-listening-provider.mjs';
// All network replies are bound to the authenticated native context and caller scope.
import {isProgressRevision, isManualProgress, isTopActivity, projectCompleteTopProgress} from './progress.mjs';
import {isPublicationRevision, projectOwnerPublication, projectPublicationReceipt} from './publication.mjs';
import {createSourceImportProviders} from './source-import-provider.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const fail = (message, status = 409) => Object.assign(new Error(message), {status});
const abort = () => Object.assign(new Error('Album Top request was superseded.'), {name: 'AbortError'});
// Match the existing command and publication-preview route body limit.
const MAX_TOP_COMMAND_BYTES = 512 * 1024;
const actionNames = new Set(['library.browse.read', 'library.album_tops.create', 'library.album_tops.manage',
  'library.album_tops.items.manage', 'can_create', 'can_read', 'can_edit', 'can_rename', 'can_add', 'can_remove',
  'can_reorder', 'can_delete', 'can_share', 'can_view_sharing', 'can_request_edit', 'can_copy', 'can_manage_own_progress', 'can_set_activity']);
const actions = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  .filter(([key, allowed]) => typeof allowed === 'boolean' && actionNames.has(key)));
function activityOverlay(value) {
  if (!Object.hasOwn(value, 'top_viewer_overlay')) return {};
  const overlay = value.top_viewer_overlay;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw fail('Invalid Album Top overlay.');
  if (!Object.hasOwn(overlay, 'activity')) return {};
  if (!isTopActivity(overlay.activity)) throw fail('Invalid Album Top activity.');
  return {top_viewer_overlay: {activity: {active: overlay.activity.active, activity_revision: overlay.activity.activity_revision}}};
}
function artistScope(value) {
  if (!keysAre(value, ['root_artist_id', 'mode'])) throw fail('Invalid Album Top Artist scope.');
  const {root_artist_id: id, mode} = value;
  if (typeof id !== 'string' || id.trim() !== id || !/^[1-9][0-9]{0,18}$/.test(id)
    || id.length === 19 && id > '9223372036854775807' || !['artist', 'family'].includes(mode)) throw fail('Invalid Album Top Artist scope.');
  return Object.freeze({root_artist_id: id, mode});
}
function top(value) {
  if (!uuid(value?.top_ref) || !revision(value.revision) || typeof value.title !== 'string' || typeof value.description !== 'string'
    || !['private', 'server_shared'].includes(value.visibility)) throw fail('Invalid Album Top response.');
  if (Object.hasOwn(value, 'type') && (typeof value.type !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(value.type))
    || Object.hasOwn(value, 'source_locked') && typeof value.source_locked !== 'boolean') throw fail('Invalid Album Top editing eligibility.');
  return {top_ref: value.top_ref, title: value.title, description: value.description,
    revision: value.revision, visibility: value.visibility, allowed_actions: actions(value.allowed_actions), ...activityOverlay(value),
    ...(Object.hasOwn(value, 'artist_scope') ? {artist_scope: artistScope(value.artist_scope)} : {}),
    ...(Object.hasOwn(value, 'type') ? {type: value.type} : {}),
    ...(Object.hasOwn(value, 'source_locked') ? {source_locked: value.source_locked} : {})};
}
const cursorValue = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096;
const localId = value => Number.isSafeInteger(value) && value > 0;
function sourceLabel(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const characters = Array.from(value);
  return characters.length <= 1000 && characters.every(character => {
    const code = character.codePointAt(0); return code < 0xd800 || code > 0xdfff;
  });
}
function publicationSource(value) {
  if (!localId(value?.selected_local_album_id) || !uuid(value.selected_source_ref)
    || !sourceLabel(value.title) || !sourceLabel(value.artist)
    || value.year !== null && (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999)) throw fail('Invalid Album Top publication source.');
  return {selected_local_album_id: value.selected_local_album_id, selected_source_ref: value.selected_source_ref,
    title: value.title, artist: value.artist, year: value.year};
}
function albumSummary(value) {
  if (!localId(value?.local_album_id) || value.album_ref !== null && !uuid(value.album_ref)
    || typeof value.title !== 'string' || typeof value.artist !== 'string'
    || value.year !== null && (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999)) throw fail('Invalid Album Top search result.');
  return {local_album_id: value.local_album_id, album_ref: value.album_ref, title: value.title, artist: value.artist, year: value.year};
}
function scopedAlbumSummary(value, scopeKey) {
  const row = albumSummary(value);
  if (!Object.hasOwn(value, 'creation_metadata')) return row;
  const metadata = value.creation_metadata, library = nativeBrowseScope(scopeKey)[1];
  if (!keysAre(metadata, ['release_type', 'rating_state', 'rating', 'artwork_url'])
    || metadata.release_type !== null && !['studio', 'ep', 'live', 'demo', 'compilation', 'single'].includes(metadata.release_type)
    || !['available', 'unavailable'].includes(metadata.rating_state)
    || metadata.rating !== null && (!Number.isInteger(metadata.rating) || metadata.rating < 1 || metadata.rating > 10)
    || metadata.rating_state === 'unavailable' && metadata.rating !== null
    || metadata.artwork_url !== null && metadata.artwork_url !== '/library/album-artwork/inventory-album:' + library + ':' + row.local_album_id) {
    throw fail('Invalid Album Top creation metadata.');
  }
  return {...row, creation_metadata: Object.freeze({release_type: metadata.release_type,
    rating_state: metadata.rating_state, rating: metadata.rating, artwork_url: metadata.artwork_url})};
}
function draftItem(value) {
  if (!uuid(value?.album_ref) || value.item_ref !== null && !uuid(value.item_ref)) throw fail('Invalid Album Top draft.');
  const hasLocal = Object.hasOwn(value, 'selected_local_album_id'), hasSource = Object.hasOwn(value, 'selected_source_ref');
  if (hasLocal !== hasSource || hasLocal && (!localId(value.selected_local_album_id) || !uuid(value.selected_source_ref))) throw fail('Invalid Album Top source binding.');
  return {item_ref: value.item_ref, album_ref: value.album_ref,
    ...(hasSource ? {selected_local_album_id: value.selected_local_album_id, selected_source_ref: value.selected_source_ref} : {})};
}
function draftItems(values) {
  if (!Array.isArray(values) || values.length > 5000) throw fail('Invalid Album Top draft.');
  const result = values.map(draftItem), retained = result.filter(row => row.item_ref !== null);
  if (new Set(result.map(row => row.album_ref)).size !== result.length || new Set(retained.map(row => row.item_ref)).size !== retained.length) throw fail('Duplicate Album Top draft item.');
  return result;
}
const member = value => {
  if (!uuid(value?.account_ref) || ![value.display_name, value.username_display].every(name => name === null || typeof name === 'string')) throw fail('Invalid Album Top member.');
  return {account_ref: value.account_ref, display_name: value.display_name, username_display: value.username_display};
};
const editRequest = value => {
  if (!uuid(value?.request_ref) || !uuid(value.top_ref) || typeof value.title !== 'string'
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw fail('Invalid Album Top edit request.');
  return {...member(value), request_ref: value.request_ref, top_ref: value.top_ref, title: value.title, created_at: value.created_at};
};
function rows(values, project, key) {
  if (!Array.isArray(values) || values.length > 100) throw fail('Invalid Album Top page.');
  const result = values.map(project);
  if (new Set(result.map(row => row[key])).size !== result.length) throw fail('Duplicate Album Top page entry.');
  return result;
}
function pagePath(path, options, {limit = true, query = false} = {}) {
  if (options.cursor != null && !cursorValue(options.cursor)) throw fail('Invalid Album Top cursor.');
  const params = new URLSearchParams();
  if (limit) params.set('limit', '100');
  if (options.cursor) params.set('cursor', options.cursor);
  if (query) {
    if (typeof (options.q ?? '') !== 'string' || (options.q || '').length > 100) throw fail('Invalid Album Top search.');
    params.set('q', options.q ?? '');
  }
  return path + (params.size ? '?' + params.toString() : '');
}
// Remote facts are display metadata and opaque selectors, never working authority.
const canonicalUUID = value => typeof value === 'string' && value.length === 36 && uuid(value);
const nonzeroUUID = value => canonicalUUID(value) && value !== '00000000-0000-0000-0000-000000000000';
const hex = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const remoteRevision = value => isPublicationRevision(value) && !/[^0-9]/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const count = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const nativeId = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && !/[^0-9]/.test(value) && BigInt(value) <= 9223372036854775807n;
function nativeBrowseScope(scopeKey) {
  let scope;
  try {scope = JSON.parse(scopeKey);} catch {throw fail('Invalid Album Top native browse scope.');}
  if (!Array.isArray(scope) || scope.length !== 4 || !nativeId(scope[0]) || !nativeId(scope[1])
    || !hex(scope[2]) || !count(scope[3])) throw fail('Invalid Album Top native browse scope.');
  return scope;
}
function nativeInventoryReference(value, library, kind = 'album') {
  const parts = typeof value === 'string' ? value.split(':') : [];
  return parts.length === 3 && parts[0] === 'inventory-' + kind && nativeId(parts[1]) && nativeId(parts[2]) && parts[1] === library;
}
// Match runtime/resource-selection.js nativeAlbumReference exactly. This is a
// private hydration key, never a canonical catalog identity or playback grant.
const nativeAlbumReference = value => typeof value === 'string' && value.length > 0
  && value === value.trim() && !/^\u0085|\u0085$/u.test(value) && [...value].length <= 16384
  && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
function nativeAlbum(value, library, remote) {
  if (value === null) return null;
  const ref = value?.inventory_album_ref;
  if (remote || !keysAre(value, ['inventory_album_ref', 'artwork_url', 'allowed_actions'])
    || !nativeInventoryReference(ref, library)
    || value.artwork_url !== null && value.artwork_url !== '/library/album-artwork/' + ref
    || !keysAre(value.allowed_actions, ['can_view_details']) || value.allowed_actions.can_view_details !== true) throw fail('Invalid Album Top native album.');
  // A browse hint is not a playback grant or an authoritative publication source.
  return {inventory_album_ref: ref, artwork_url: value.artwork_url, allowed_actions: {can_view_details: true}};
}
const nativeSourceFields = ['revision', 'item_ref', 'catalog_ref', 'inventory_album_ref', 'inventory_track_ref', 'canonical_track_ref'];
function nativePlaybackSource(value, library, status = 502) {
  if (!keysAre(value, nativeSourceFields)) throw fail('Invalid Album Top playback source.', status);
  const source = {...value};
  if (!nativeId(source.revision) || !canonicalUUID(source.item_ref) || !canonicalUUID(source.catalog_ref)
    || !nativeInventoryReference(source.inventory_album_ref, library)
    || !nativeInventoryReference(source.inventory_track_ref, library, 'track')
    || !nativeAlbumReference(source.canonical_track_ref)) throw fail('Invalid Album Top playback source.', status);
  return source;
}
function nativePlaybackTarget(value, inventoryTrackRef) {
  if (!keysAre(value, ['track_ref', 'path', 'title', 'artist', 'album_title', 'duration_seconds', 'inventory_track_ref'])) {
    throw fail('Invalid Album Top playback target.', 502);
  }
  const target = {...value};
  // Match the existing native play owner: metadata may be null; no browse hint
  // or synthesized playback flag grants entry to this private target boundary.
  if (target.inventory_track_ref !== inventoryTrackRef || typeof target.path !== 'string' || !target.path
    || target.path.length > 4096 || target.track_ref !== target.path
    || ['title', 'artist', 'album_title'].some(key => target[key] !== null && (typeof target[key] !== 'string' || target[key].length > 4096))
    || target.duration_seconds !== null && (!Number.isFinite(target.duration_seconds) || target.duration_seconds < 0)) {
    throw fail('Invalid Album Top playback target.', 502);
  }
  return target;
}
function nativeQueuePopularity(value) {
  if (value === null) return null;
  if (!keysAre(value, ['provider', 'metric', 'count', 'observed_at']) || value.provider !== 'lastfm'
    || value.metric !== 'overall_scrobbles' || !Number.isSafeInteger(value.count) || value.count < 0
    || typeof value.observed_at !== 'string' || !/(?:Z|\+00:00)$/.test(value.observed_at)) {
    throw fail('Invalid Album Top popularity.', 502);
  }
  try {timestamp(value.observed_at);} catch {throw fail('Invalid Album Top popularity.', 502);}
  return {provider: value.provider, metric: value.metric, count: value.count, observed_at: value.observed_at};
}
function nativeListeningSelection(value) {
  if (!keysAre(value, ['version', 'selection_ref', 'membership_revision'])
      || value.version !== 'local-edition-selection-v1'
      || !canonicalUUID(value.selection_ref) || value.selection_ref === '00000000-0000-0000-0000-000000000000'
      || typeof value.membership_revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.membership_revision)) {
    throw fail('Invalid Album Top listening selection.', 502);
  }
  return Object.freeze({...value});
}
function nativeQueue(value, captured, library) {
  if (!keysAre(value, ['top_ref', 'revision', 'albums', 'unavailable_items'])) throw fail('Invalid Album Top native queue.', 502);
  const data = {...value};
  if (data.top_ref !== captured.top_ref || data.revision !== captured.revision
    || !Array.isArray(data.albums) || data.albums.length > 5000
    || !Array.isArray(data.unavailable_items) || data.unavailable_items.length > 5000) throw fail('Invalid Album Top native queue.', 502);
  const members = new Set(), catalogs = new Set(), occurrences = new Set(), inventoryAlbums = new Map(), inventoryTracks = new Map();
  const albums = [];
  for (const value of data.albums) {
    if (!keysAre(value, ['item_ref', 'catalog_ref', 'inventory_album_ref', 'album_ref', 'tracks'])
      && !keysAre(value, ['item_ref', 'catalog_ref', 'inventory_album_ref', 'album_ref', 'tracks', 'listening_selection'])) throw fail('Invalid Album Top queue album.', 502);
    const album = {...value};
    if (Object.hasOwn(album, 'listening_selection')) album.listening_selection = nativeListeningSelection(album.listening_selection);
    if (!canonicalUUID(album.item_ref) || members.has(album.item_ref) || !canonicalUUID(album.catalog_ref) || catalogs.has(album.catalog_ref)
      || !nativeInventoryReference(album.inventory_album_ref, library) || !nativeAlbumReference(album.album_ref)
      || !Array.isArray(album.tracks) || !album.tracks.length || album.tracks.length > 5000
      || occurrences.size + album.tracks.length > 5000
      || inventoryAlbums.has(album.inventory_album_ref) && inventoryAlbums.get(album.inventory_album_ref) !== album.album_ref) {
      throw fail('Invalid Album Top queue album.', 502);
    }
    members.add(album.item_ref); catalogs.add(album.catalog_ref); inventoryAlbums.set(album.inventory_album_ref, album.album_ref);
    const tracks = [];
    for (const value of album.tracks) {
      if (!keysAre(value, ['queue_item_ref', 'source', 'native_target'])
        && !keysAre(value, ['queue_item_ref', 'source', 'native_target', 'popularity'])) throw fail('Invalid Album Top queue track.', 502);
      const track = {...value}, source = nativePlaybackSource(track.source, library);
      const occurrence = source.item_ref + ':' + source.inventory_track_ref.split(':')[2];
      const binding = JSON.stringify([source.inventory_album_ref, source.canonical_track_ref]);
      if (source.revision !== captured.revision || source.item_ref !== album.item_ref || source.catalog_ref !== album.catalog_ref
        || source.inventory_album_ref !== album.inventory_album_ref || track.queue_item_ref !== occurrence || occurrences.has(occurrence)
        || inventoryTracks.has(source.inventory_track_ref) && inventoryTracks.get(source.inventory_track_ref) !== binding) {
        throw fail('Invalid Album Top queue occurrence.', 502);
      }
      occurrences.add(occurrence); inventoryTracks.set(source.inventory_track_ref, binding);
      tracks.push({queue_item_ref: occurrence, source, native_target: nativePlaybackTarget(track.native_target, source.inventory_track_ref),
        ...(Object.hasOwn(track, 'popularity') ? {popularity: nativeQueuePopularity(track.popularity)} : {})});
    }
    albums.push({...album, tracks});
  }
  const reported = new Set(), unavailable_items = [];
  for (const value of data.unavailable_items) {
    if (!keysAre(value, ['item_ref', 'reason'])) throw fail('Invalid Album Top unavailable item.', 502);
    const item = {...value};
    if (!canonicalUUID(item.item_ref) || reported.has(item.item_ref)
      || !['remote_summary', 'ambiguous_edition', 'unavailable', 'tracks_unavailable'].includes(item.reason)
      || members.has(item.item_ref) && item.reason !== 'tracks_unavailable') throw fail('Invalid Album Top unavailable item.', 502);
    reported.add(item.item_ref); unavailable_items.push(item);
  }
  if (new Set([...members, ...reported]).size > 5000) throw fail('Invalid Album Top queue membership.', 502);
  return {top_ref: captured.top_ref, revision: captured.revision, albums, unavailable_items};
}
const remoteFail = () => fail('Invalid Album Top remote response.', 502);
function destination(value) {
  if (keysAre(value, ['kind', 'draft_ref']) && value.kind === 'create' && nonzeroUUID(value.draft_ref)) return {kind: 'create', draft_ref: value.draft_ref};
  if (keysAre(value, ['kind', 'top_ref', 'revision']) && value.kind === 'top' && nonzeroUUID(value.top_ref) && remoteRevision(value.revision)) return {kind: 'top', top_ref: value.top_ref, revision: value.revision};
  throw fail('Invalid Album Top remote destination.');
}
function remoteSummary(value) {
  const date = value?.first_release_date;
  let validDate = date === null;
  if (typeof date === 'string' && [4, 7, 10].includes(date.length) && /^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$/.test(date)) {
    const [year, month = 1, day = 1] = date.split('-').map(Number);
    const parsed = new Date(0); parsed.setUTCFullYear(year, month - 1, day); parsed.setUTCHours(0, 0, 0, 0);
    validDate = year >= 1 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }
  if (value?.source_kind !== 'remote_summary' || value.provider !== 'musicbrainz' || value.entity_kind !== 'release-group'
    || !nonzeroUUID(value.release_group_id) || !sourceLabel(value.title) || !sourceLabel(value.artist_display) || !validDate
    || ![null, 'Album', 'Single', 'EP', 'Broadcast', 'Other'].includes(value.primary_type)
    || value.metadata_coverage !== 'album_summary_only' || value.track_metadata_status !== 'unavailable' || value.track_count !== null) throw remoteFail();
  return {source_kind: 'remote_summary', provider: 'musicbrainz', entity_kind: 'release-group', release_group_id: value.release_group_id,
    title: value.title, artist_display: value.artist_display, first_release_date: date, primary_type: value.primary_type,
    metadata_coverage: 'album_summary_only', track_metadata_status: 'unavailable', track_count: null};
}
function sourceSelector(value, {retained = true, local = false} = {}) {
  if (local && keysAre(value, ['kind']) && value.kind === 'unselected') return {kind: 'unselected'};
  if (local && keysAre(value, ['kind', 'selected_local_album_id', 'selected_source_ref']) && value.kind === 'local'
    && localId(value.selected_local_album_id) && canonicalUUID(value.selected_source_ref)) return {kind: 'local', selected_local_album_id: value.selected_local_album_id, selected_source_ref: value.selected_source_ref};
  const field = value?.kind === 'remote_acquisition' ? 'acquisition_ref' : retained && value?.kind === 'remote_retained' ? 'admission_ref' : null;
  if (!field || !keysAre(value, ['kind', field, 'evidence_version']) || !nonzeroUUID(value[field]) || !hex(value.evidence_version)) throw fail('Invalid Album Top remote selection.');
  return {kind: value.kind, [field]: value[field], evidence_version: value.evidence_version};
}
function typedSelections(values, retained, localOnly = false) {
  if (!Array.isArray(values) || !values.length || values.length > 5000) throw fail('Invalid Album Top selections.');
  const seen = new Set(); let remote = false;
  const result = Array.from(values).map(value => {
    const local = keysAre(value, ['kind', 'album_ref']) && value.kind === 'local_catalog' && canonicalUUID(value.album_ref);
    const row = local ? {kind: 'local_catalog', album_ref: value.album_ref} : sourceSelector(value, {retained});
    remote ||= !local;
    const identity = row.kind + ':' + (row.album_ref || row.acquisition_ref || row.admission_ref);
    if (seen.has(identity)) throw fail('Duplicate Album Top selection.'); seen.add(identity); return row;
  });
  if (!remote && !localOnly) throw fail('Use the existing local Album Top command.');
  return result;
}
function typedItems(values, read = false) {
  if (!Array.isArray(values) || values.length > 5000) throw fail('Invalid Album Top typed draft.');
  const albums = new Set(), items = new Set(), remote = new Set();
  return values.map(value => {
    const kind = value?.kind, keys = kind === 'existing' ? ['kind', 'item_ref', 'album_ref', 'source'] : kind === 'new_local' ? ['kind', 'album_ref', 'source'] : kind === 'new_remote' ? ['kind', 'source'] : [];
    if (!keys.length || !keysAre(value, keys) || read && kind !== 'existing'
      || kind === 'existing' && (!canonicalUUID(value.item_ref) || items.has(value.item_ref))
      || kind !== 'new_remote' && (!canonicalUUID(value.album_ref) || albums.has(value.album_ref))) throw fail('Invalid Album Top typed draft.');
    const source = sourceSelector(value.source, {local: true});
    const isRemote = source.kind.startsWith('remote_');
    if (kind === 'new_remote' && !isRemote || kind === 'new_local' && isRemote || read && source.kind === 'remote_acquisition') throw fail('Invalid Album Top draft source.');
    if (isRemote) {const key = source.kind + ':' + (source.acquisition_ref || source.admission_ref); if (remote.has(key)) throw fail('Duplicate Album Top remote source.'); remote.add(key);}
    if (kind === 'existing') items.add(value.item_ref);
    if (kind !== 'new_remote') albums.add(value.album_ref);
    return {kind, ...(kind === 'existing' ? {item_ref: value.item_ref} : {}), ...(kind !== 'new_remote' ? {album_ref: value.album_ref} : {}), source};
  });
}
const capacityFields = ['legacy_initialized', 'legacy_inspected', 'counts_complete', 'actor_pending_count', 'actor_pending_bytes', 'actor_reservations', 'physical_parents',
  'actor_pending_slots_available', 'actor_pending_bytes_available', 'actor_reservation_slots_available', 'physical_parent_slots_available',
  'attempt_slots_remaining', 'pending_slots_available', 'pending_bytes_available', 'reservation_slots_available', 'worst_case_new_acquisitions'];
const parentCapacity = new Set(['attempt_slots_remaining', 'pending_slots_available', 'pending_bytes_available', 'reservation_slots_available']);
function remoteCapacity(value) {
  if (!keysAre(value, capacityFields)) throw remoteFail();
  const result = {};
  for (const key of capacityFields) {
    const item = value[key];
    if (['legacy_initialized', 'counts_complete'].includes(key) ? typeof item !== 'boolean' : !(parentCapacity.has(key) && item === null) && !count(item)) throw remoteFail();
    result[key] = item;
  }
  if (result.legacy_initialized !== result.counts_complete) throw remoteFail();
  return result;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) throw remoteFail();
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(?:Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!parts || parts[0] !== value || !Number.isFinite(Date.parse(value))) throw remoteFail();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number), calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || Number(parts[8] || 0) > 23 || Number(parts[9] || 0) > 59) throw remoteFail();
  return value;
}
const timestampFraction = value => (/\.(\d{1,6})/.exec(value)?.[1] || '').padEnd(6, '0');
function remoteParent(value) {
  if (!nonzeroUUID(value?.preparation_ref) || !nonzeroUUID(value.form_ref) || !['ready', 'accepting', 'draining', 'expired', 'closed'].includes(value.state)
    || !count(value.attempt_count, 512) || !count(value.pending_count, 512) || !count(value.pending_bytes, 8388608) || !count(value.reservation_count, 2)
    || value.reservation_count > value.pending_count || value.pending_count > value.attempt_count) throw remoteFail();
  const created = timestamp(value.created_at), accepts = timestamp(value.accepts_until), expires = timestamp(value.fully_expires_at);
  if (Date.parse(accepts) - Date.parse(created) !== 1800000 || Date.parse(expires) - Date.parse(created) !== 3600000
    || timestampFraction(created) !== timestampFraction(accepts) || timestampFraction(created) !== timestampFraction(expires)) throw remoteFail();
  return {preparation_ref: value.preparation_ref, form_ref: value.form_ref, state: value.state, created_at: created, accepts_until: accepts, fully_expires_at: expires,
    attempt_count: value.attempt_count, pending_count: value.pending_count, pending_bytes: value.pending_bytes, reservation_count: value.reservation_count, capacity: remoteCapacity(value.capacity)};
}
function remoteRefusal(value) {
  if (!['maintenance_required', 'limit'].includes(value?.state) || !['legacy_initialization', 'parents', 'attempts', 'reservations', 'pending'].includes(value.resource)
    || value.error !== (value.state === 'maintenance_required' ? 'remote_preparation_maintenance_required' : 'remote_acquisition_limit')) throw remoteFail();
  return {state: value.state, resource: value.resource, error: value.error, capacity: remoteCapacity(value.capacity)};
}

export function createAlbumTopBackendProviders({transport, acceptsScope}) {
  let disposed = false;
  let remoteIdentity = null;
  function nativeLifetime(options, unchanged) {
    const {scopeKey, signal, isCurrent} = options, scope = nativeBrowseScope(scopeKey);
    if (typeof isCurrent !== 'function') throw fail('Invalid Album Top native source.');
    let retired = false, checking = false;
    const owned = () => {
      const live = () => !retired && !disposed && !signal?.aborted && options.scopeKey === scopeKey
        && options.signal === signal && options.isCurrent === isCurrent && unchanged();
      try {
        return live() && transport.context() === scope[2]
          && typeof transport.generation === 'function' && transport.generation() === scope[3] && live();
      } catch {return false;}
    };
    const current = () => {
      // Scope/source callbacks and transport reads may synchronously navigate.
      // Once stale or reentrant, this exact request can never be revived.
      if (checking || retired) {retired = true; return false;}
      checking = true;
      try {
        if (!owned() || acceptsScope(scopeKey) !== true || !owned() || isCurrent() !== true || !owned()) retired = true;
      } catch {retired = true;} finally {checking = false;}
      return !retired;
    };
    return {scope, signal, current};
  }
  function remoteContext() {
    if (disposed || typeof transport.generation !== 'function' || typeof transport.requestAlbumTopRemote !== 'function') throw fail('Album Top remote context unavailable.', 409);
    const context = transport.context(), generation = transport.generation();
    if (!hex(context) || !count(generation)) throw fail('Album Top remote context unavailable.', 409);
    if (!remoteIdentity || remoteIdentity.context !== context || remoteIdentity.generation !== generation) remoteIdentity = Object.freeze({context, generation});
    return remoteIdentity;
  }
  async function remoteRequest(path, options, body) {
    const identity = options.remoteContext;
    const owned = () => {
      if (disposed || !identity) return false;
      try {
        const currentIdentity = remoteContext();
        return !disposed && identity === currentIdentity;
      } catch {return false;}
    };
    const current = () => {
      if (!owned() || !acceptsScope(options.scopeKey) || !owned()) return false;
      // Scope acceptance can synchronously render or navigate. Check the
      // captured form after that callback, then finish with owned identity.
      const accepted = options.isCurrent === undefined || typeof options.isCurrent === 'function' && options.isCurrent() === true;
      return accepted && owned();
    };
    if (!current() || options.signal?.aborted) throw abort();
    if (body !== undefined && new TextEncoder().encode(JSON.stringify(body)).byteLength > 4096) throw Object.assign(fail('Album Top remote request exceeds the server limit.', 413), {code: 'command_too_large'});
    let response;
    try {
      response = await transport.requestAlbumTopRemote(path, {signal: options.signal, expected: identity.context,
        expectedGeneration: identity.generation, isCurrent: current, ...(body === undefined ? {} : {method: 'POST', body})});
    } catch (error) {
      // The exact transport already pins consumed denial to its old generation
      // before invalidating that generation. Do not erase it with a later check.
      if (disposed) throw abort();
      if (error?.responseRejected === true && [401, 403].includes(error.status)) throw error;
      if (!current() || options.signal?.aborted) throw abort();
      throw error;
    }
    if (!current() || options.signal?.aborted) throw abort();
    if (response?.status !== 'ready' || response.context_ref !== identity.context || !object(response.data)
      || response.data.context_ref !== identity.context) throw remoteFail();
    return response.data;
  }

  async function request(path, options, body) {
    const context = transport.context();
    if (disposed || !context || !acceptsScope(options.scopeKey)) throw fail('Album Top context unavailable.', 403);
    if (options.signal?.aborted) throw abort();
    if (body && new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_TOP_COMMAND_BYTES) {
      throw Object.assign(fail('Album Top request exceeds the server size limit.', 413), {code: 'command_too_large'});
    }
    const response = await transport.request(path, {signal: options.signal, expected: context,
      ...(body ? {method: 'POST', body} : {})});
    if (disposed || options.signal?.aborted || transport.context() !== context || !acceptsScope(options.scopeKey)) throw abort();
    if (response?.status !== 'ready' || response.context_ref !== context || !response.data || typeof response.data !== 'object') throw fail('Album Top response was not acknowledged.', 502);
    return response.data;
  }
  const access = async (ref, options, candidates) => {
    if (!uuid(ref)) throw fail('Invalid Album Top identity.');
    const data = await request(pagePath('/album-tops/' + ref + (candidates ? '/access-candidates' : '/access-grants'), options, {query: candidates}), options);
    if (data.top_ref !== ref || !revision(data.revision) || !cursorValue(data.next_cursor)
      || !candidates && !['private', 'server_shared'].includes(data.visibility)) throw fail('Invalid Album Top access page.');
    const key = candidates ? 'candidates' : 'grants';
    return {top_ref: ref, revision: data.revision, next_cursor: data.next_cursor,
      ...(!candidates ? {visibility: data.visibility} : {}), [key]: rows(data[key], value => {
        const person = member(value);
        if (value.grant_ref !== null && !uuid(value.grant_ref) || value.role !== null && !['viewer', 'editor'].includes(value.role)) throw fail('Invalid Album Top access role.');
        if ((value.grant_ref === null) !== (value.role === null)) throw fail('Invalid Album Top access role.');
        if (!Number.isSafeInteger(value.account_id) || value.account_id <= 0) throw fail('Invalid Album Top member.');
        if (candidates) {
          if (!value.allowed_actions || !['can_grant_viewer', 'can_grant_editor'].every(key => Object.hasOwn(value.allowed_actions, key) && typeof value.allowed_actions[key] === 'boolean')) throw fail('Invalid Album Top candidate.');
          return {...person, account_id: value.account_id, grant_ref: value.grant_ref, role: value.role,
            allowed_actions: {can_grant_editor: value.allowed_actions.can_grant_editor, can_grant_viewer: value.allowed_actions.can_grant_viewer}};
        }
        if (!uuid(value.grant_ref) || !['viewer', 'editor'].includes(value.role) || typeof value.is_active !== 'boolean') throw fail('Invalid Album Top access grant.');
        return {...person, account_id: value.account_id, grant_ref: value.grant_ref, role: value.role, is_active: value.is_active};
      }, 'account_ref')};
  };
  return {
    ...createCurrentTopListeningProvider({transport, acceptsScope, isDisposed: () => disposed}),
    remoteContext,
    ...createSourceImportProviders({request}),
    async searchRemoteAlbums(payload, options) {
      const scoped = Object.hasOwn(payload || {}, 'artist_scope');
      if (!keysAre(payload, scoped ? ['destination', 'title', 'artist', 'artist_scope'] : ['destination', 'title', 'artist']) || typeof payload.title !== 'string' || !payload.title.trim() || Array.from(payload.title).length > 100
        || typeof payload.artist !== 'string' || Array.from(payload.artist).length > 100 || /[\u0000-\u001f\u007f]/.test(payload.title + payload.artist)
        || Array.from(payload.title + payload.artist).some(char => char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff)) throw fail('Invalid Album Top remote search.');
      const target = destination(payload.destination), body = {destination: target, title: payload.title, artist: payload.artist};
      if (scoped) {
        if (target.kind !== 'create') throw fail('Invalid Album Top remote search.');
        body.artist_scope = artistScope(payload.artist_scope);
      }
      const data = await remoteRequest('/album-top-catalog/remote-search', options, body);
      if (!same(destination(data.destination), target) || data.limit !== 10 || !Array.isArray(data.candidates) || data.candidates.length > data.limit) throw remoteFail();
      const candidates = data.candidates.map(remoteSummary);
      if (new Set(candidates.map(row => row.release_group_id)).size !== candidates.length) throw remoteFail();
      return {context_ref: data.context_ref, destination: target, limit: data.limit, candidates};
    },
    async beginRemotePreparation(payload, options) {
      if (!keysAre(payload, ['destination', 'form_ref']) || !nonzeroUUID(payload.form_ref)) throw fail('Invalid Album Top preparation.');
      const target = destination(payload.destination);
      if (target.kind === 'create' && target.draft_ref !== payload.form_ref) throw fail('Invalid Album Top draft identity.');
      const data = await remoteRequest('/album-top-catalog/remote-preparations', options, {destination: target, form_ref: payload.form_ref});
      if (data.version !== 2) throw remoteFail();
      if (['maintenance_required', 'limit'].includes(data.state)) return {version: 2, context_ref: data.context_ref, ...remoteRefusal(data)};
      const result = remoteParent(data);
      if (result.state !== 'ready' || result.form_ref !== payload.form_ref || !same(destination(data.destination), target)) throw remoteFail();
      return {version: 2, context_ref: data.context_ref, destination: target, ...result};
    },
    async acquireRemoteAlbum(payload, options) {
      const scoped = Object.hasOwn(payload || {}, 'artist_scope');
      const keys = ['version', 'preparation_ref', 'request_key', 'destination', 'release_group_id'];
      if (!keysAre(payload, scoped ? [...keys, 'artist_scope'] : keys) || payload.version !== 2
        || !nonzeroUUID(payload.preparation_ref) || !nonzeroUUID(payload.request_key) || !nonzeroUUID(payload.release_group_id)) throw fail('Invalid Album Top acquisition.');
      const target = destination(payload.destination), body = {version: 2, preparation_ref: payload.preparation_ref, request_key: payload.request_key, destination: target, release_group_id: payload.release_group_id};
      if (scoped) {
        if (target.kind !== 'create') throw fail('Invalid Album Top acquisition.');
        body.artist_scope = artistScope(payload.artist_scope);
      }
      const data = await remoteRequest('/album-top-catalog/remote-acquisitions', options, body);
      if (data.version !== 2 || data.preparation_ref !== body.preparation_ref || data.request_key !== body.request_key || !same(destination(data.destination), target)) throw remoteFail();
      const common = {version: 2, context_ref: data.context_ref, preparation_ref: data.preparation_ref, request_key: data.request_key, destination: target};
      if (['maintenance_required', 'limit'].includes(data.state)) return {...common, ...remoteRefusal(data)};
      if (data.state === 'in_flight' && data.retry_after_seconds === 1) return {...common, state: data.state, retry_after_seconds: 1};
      if (data.state === 'failed' && ['provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed'].includes(data.error)) return {...common, state: data.state, error: data.error};
      if (!nonzeroUUID(data.acquisition_ref) || !hex(data.evidence_version)) throw remoteFail();
      if (data.state === 'consumed') {
        if (!nonzeroUUID(data.consumed_top_ref) || !remoteRevision(data.consumed_revision) || !nonzeroUUID(data.operation_request_key)
          || target.kind === 'top' && (data.consumed_top_ref !== target.top_ref || BigInt(data.consumed_revision) !== BigInt(target.revision) + 1n)) throw remoteFail();
        return {...common, state: 'consumed', acquisition_ref: data.acquisition_ref, evidence_version: data.evidence_version,
          consumed_top_ref: data.consumed_top_ref, consumed_revision: data.consumed_revision, operation_request_key: data.operation_request_key};
      }
      if (data.state !== 'pending') throw remoteFail();
      const album = remoteSummary(data.album);
      if (album.release_group_id !== body.release_group_id) throw remoteFail();
      const projection = {};
      if (scoped || target.kind === 'top' && Object.hasOwn(data, 'artist_scope_preview')) {
        if (!Object.hasOwn(data, 'artist_scope_preview')) throw remoteFail();
        const value = data.artist_scope_preview;
        if (value === null) projection.artist_scope_preview = null;
        else {
          if (!keysAre(value, ['artist_scope', 'evidence_version', 'main_artist_match'])
            || value.evidence_version !== data.evidence_version || ![true, false, null].includes(value.main_artist_match)) throw remoteFail();
          const scope = artistScope(value.artist_scope);
          if (scoped && !same(scope, body.artist_scope)) throw remoteFail();
          projection.artist_scope_preview = Object.freeze({artist_scope: scope,
            evidence_version: value.evidence_version, main_artist_match: value.main_artist_match});
        }
      }
      return {...common, state: 'pending', acquisition_ref: data.acquisition_ref, evidence_version: data.evidence_version,
        expires_at: timestamp(data.expires_at), album, ...projection};
    },
    async readRemotePreparationState(options) {
      const data = await remoteRequest('/album-top-catalog/remote-preparations', options);
      if (data.version !== 2 || data.state !== 'status' || typeof data.maintenance_required !== 'boolean' || !Array.isArray(data.parents) || data.parents.length > 32) throw remoteFail();
      const parents = data.parents.map(remoteParent);
      if (parents.some(row => row.state === 'ready') || new Set(parents.map(row => row.preparation_ref)).size !== parents.length) throw remoteFail();
      return {version: 2, context_ref: data.context_ref, state: 'status', sql_now: timestamp(data.sql_now),
        capacity: remoteCapacity(data.capacity), parents, maintenance_required: data.maintenance_required};
    },
    async maintainRemotePreparations(payload, options) {
      if (!keysAre(payload, ['mode']) || !['reclaim', 'discard_legacy'].includes(payload.mode)) throw fail('Invalid Album Top maintenance.');
      const data = await remoteRequest('/album-top-catalog/remote-preparations/maintain', options, {mode: payload.mode});
      if (data.version !== 2 || !['progress', 'complete'].includes(data.state) || !['legacy_initialization', 'legacy_cleanup', 'discard_legacy', 'expired_reservations', 'expired_facts', 'parent_reclamation', 'none'].includes(data.branch)
        || !count(data.inspected, 1024) || !count(data.removed_facts, 512) || !count(data.removed_attempts, 512) || !count(data.released_bytes, 8388608) || typeof data.more_work !== 'boolean') throw remoteFail();
      return {version: 2, context_ref: data.context_ref, state: data.state, branch: data.branch, inspected: data.inspected, removed_facts: data.removed_facts,
        removed_attempts: data.removed_attempts, released_bytes: data.released_bytes, more_work: data.more_work, capacity: remoteCapacity(data.capacity)};
    },
    async closeRemotePreparation(ref, options) {
      if (!nonzeroUUID(ref)) throw fail('Invalid Album Top preparation.');
      const data = await remoteRequest('/album-top-catalog/remote-preparations/' + ref + '/close', options, {});
      if (data.version !== 2 || data.state !== 'closed' || data.preparation_ref !== ref || !count(data.removed_attempts, 512) || !count(data.removed_facts, 512) || !count(data.released_bytes, 8388608)) throw remoteFail();
      return {version: 2, context_ref: data.context_ref, state: 'closed', preparation_ref: ref, removed_attempts: data.removed_attempts,
        removed_facts: data.removed_facts, released_bytes: data.released_bytes, capacity: remoteCapacity(data.capacity)};
    },
    async searchAlbums(options) {
      const q = options.q ?? '';
      if (typeof q !== 'string' || q.length > 100 || q.includes('\0') || options.topRef != null && !uuid(options.topRef)
        || options.cursor != null && !cursorValue(options.cursor)) throw fail('Invalid Album Top search.');
      if (!q.trim()) return {albums: [], next_cursor: null};
      const path = pagePath('/album-top-catalog/search', {...options, q: q.trim()}, {query: true})
        + (options.topRef ? '&top_ref=' + encodeURIComponent(options.topRef) : '');
      const data = await request(path, options);
      if (!cursorValue(data.next_cursor)) throw fail('Invalid Album Top search cursor.');
      return {albums: rows(data.albums, albumSummary, 'local_album_id'), next_cursor: data.next_cursor};
    },
    async listScopedAlbums(options) {
      const scopeKey = options.scopeKey;
      const hasScope = Object.hasOwn(options, 'artistScope'), saved = options.topRef != null;
      if (hasScope === saved || saved && !canonicalUUID(options.topRef)) throw fail('Invalid Album Top scoped destination.');
      const scope = hasScope ? artistScope(options.artistScope) : null;
      const q = Object.hasOwn(options, 'q') ? options.q : '';
      if (typeof q !== 'string' || q.length > 100 || q.includes('\0')
        || Array.from(q).some(character => character.length === 1 && /[\ud800-\udfff]/.test(character))) throw fail('Invalid Album Top search.');
      const path = pagePath('/album-top-catalog/search', {...options, q: q.trim()}, {query: true})
        + (saved ? '&top_ref=' + encodeURIComponent(options.topRef)
          : '&root_artist_id=' + encodeURIComponent(scope.root_artist_id) + '&scope_mode=' + scope.mode);
      const data = await request(path, options);
      if (!cursorValue(data.next_cursor)) throw fail('Invalid Album Top search cursor.');
      return {albums: rows(data.albums, value => scopedAlbumSummary(value, scopeKey), 'local_album_id'), next_cursor: data.next_cursor};
    },
    async admitAlbum(albumId, options) {
      if (!localId(albumId) || options.topRef != null && !uuid(options.topRef)) throw fail('Invalid Album Top album identity.');
      const hasScope = Object.hasOwn(options, 'artistScope');
      if (hasScope && options.topRef != null) throw fail('Invalid Album Top scoped destination.');
      const scope = hasScope ? artistScope(options.artistScope) : null;
      const path = options.topRef ? '/album-tops/' + options.topRef + '/catalog/inventory' : '/album-top-catalog/inventory';
      const data = await request(path, options, {album_id: albumId, ...(scope ? {artist_scope: scope} : {})});
      if (!uuid(data.album_ref)) throw fail('Invalid Album Top admission.');
      return {album_ref: data.album_ref};
    },
    async preview(ref, payload, options) {
      if (!uuid(ref) || !revision(payload?.revision)) throw fail('Invalid Album Top preview.');
      if (Object.hasOwn(payload, 'item_selections') || payload.items?.some(row => row?.source_kind === 'remote_summary' || row?.source?.kind?.startsWith('remote_'))) throw Object.assign(fail('Remote Album Top publication is unavailable.'), {code: 'remote_publication_unavailable'});
      const items = draftItems(payload.items);
      if (items.some(row => !row.selected_source_ref)) throw fail('Album Top publication source evidence is unavailable.');
      const data = await request('/album-tops/' + ref + '/publication-preview', options, {revision: payload.revision, items});
      if (data.top_ref !== ref || data.revision !== payload.revision || typeof data.evidence_revision !== 'string'
        || !/^[0-9a-f]{64}$/.test(data.evidence_revision)
        || JSON.stringify(draftItems(data.items)) !== JSON.stringify(items)) throw fail('Album Top preview no longer matches this draft.');
      return {top_ref: ref, revision: data.revision, evidence_revision: data.evidence_revision,
        items: data.items.map((row, index) => {
          if (typeof row.title !== 'string' || typeof row.artist !== 'string' || row.year !== null && (!Number.isInteger(row.year) || row.year < 1 || row.year > 9999)
            || !Number.isSafeInteger(row.track_count) || row.track_count < 0 || row.track_count > 5000) throw fail('Invalid Album Top preview metadata.');
          return {...items[index], title: row.title, artist: row.artist, year: row.year, track_count: row.track_count};
        })};
    },
    async readPublicationSources(ref, itemRef, options) {
      const {albumRef, revision: expectedRevision, cursor} = options, limit = options.limit === undefined ? 100 : options.limit;
      if (!uuid(ref) || !uuid(itemRef) || !uuid(albumRef) || !isPublicationRevision(expectedRevision)
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || cursor != null && !cursorValue(cursor)) throw fail('Invalid Album Top publication source query.');
      const params = new URLSearchParams({revision: expectedRevision, limit: String(limit)});
      if (cursor) params.set('cursor', cursor);
      const data = await request('/album-tops/' + ref + '/items/' + itemRef + '/publication-sources?' + params.toString(), options);
      if (data.top_ref !== ref || data.item_ref !== itemRef || data.album_ref !== albumRef || data.revision !== expectedRevision
        || !Array.isArray(data.sources) || data.sources.length > limit || !cursorValue(data.next_cursor)
        || data.next_cursor !== null && data.next_cursor === cursor) throw fail('Invalid Album Top publication source page.');
      const sources = data.sources.map(publicationSource), seen = new Set();
      for (let index = 0; index < sources.length; index++) {
        const row = sources[index], previous = sources[index - 1];
        if (seen.has(row.selected_source_ref) || previous && (previous.selected_local_album_id > row.selected_local_album_id
          || previous.selected_local_album_id === row.selected_local_album_id && previous.selected_source_ref >= row.selected_source_ref)) throw fail('Invalid Album Top publication source order.');
        seen.add(row.selected_source_ref);
      }
      return {top_ref: ref, revision: data.revision, item_ref: itemRef, album_ref: data.album_ref, sources, next_cursor: data.next_cursor};
    },
    async readSharing(ref, options) {
      if (!uuid(ref)) throw fail('Invalid Album Top identity.');
      const data = await request(pagePath('/album-tops/' + ref + '/sharing', options, {limit: false}), options);
      if (data.top_ref !== ref || !isPublicationRevision(data.revision) || !['private', 'server_shared'].includes(data.visibility)
        || !['can_manage', 'can_request_edit', 'can_copy'].every(key => Object.hasOwn(data, key) && typeof data[key] === 'boolean')
        || !['none', 'pending', 'approved', 'declined'].includes(data.request_status) || !cursorValue(data.next_pending_cursor)) throw fail('Invalid Album Top sharing.');
      const pending_requests = rows(data.pending_requests, editRequest, 'request_ref');
      if (pending_requests.some(row => row.top_ref !== ref) || !data.can_manage && (pending_requests.length || data.next_pending_cursor)) throw fail('Invalid Album Top request scope.');
      return {top_ref: ref, revision: data.revision, visibility: data.visibility, can_manage: data.can_manage,
        can_request_edit: data.can_request_edit, can_copy: data.can_copy, request_status: data.request_status,
        pending_requests, next_pending_cursor: data.next_pending_cursor,
        ...(Object.hasOwn(data, 'publication') ? {publication: projectOwnerPublication(data.publication)} : {})};
    },
    readAccessGrants: (ref, options) => access(ref, options, false),
    readAccessCandidates: (ref, options) => access(ref, options, true),
    async readEditRequests(options) {
      const data = await request(pagePath('/album-tops/edit-requests', options), options);
      if (!cursorValue(data.next_cursor)) throw fail('Invalid Album Top notification page.');
      return {requests: rows(data.requests, editRequest, 'request_ref'), next_cursor: data.next_cursor};
    },
    async list(options) {
      const result = {tops: [], allowed_actions: {}, next_cursor: null};
      const seen = new Set(), cursors = new Set(); let cursor = null;
      do {
        const data = await request('/album-tops?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), options);
        if (!Array.isArray(data.tops) || data.tops.length > 100 || data.next_cursor !== null && typeof data.next_cursor !== 'string') throw fail('Invalid Album Top directory.');
        for (const row of data.tops) {const entry = top(row); if (seen.has(entry.top_ref)) throw fail('Album Top directory changed.'); seen.add(entry.top_ref); result.tops.push(entry);}
        result.allowed_actions = actions(data.allowed_actions);
        if (data.next_cursor && cursors.has(data.next_cursor) || cursors.size >= 100 || result.tops.length > 10000) throw fail('Album Top directory is too large.');
        cursor = data.next_cursor; if (cursor) cursors.add(cursor);
      } while (cursor);
      return result;
    },
    async read(ref, options) {
      if (!uuid(ref)) throw fail('Invalid Album Top identity.');
      const scopeKey = options.scopeKey;
      const data = await request('/album-tops/' + ref, options), result = top(data);
      if (result.top_ref !== ref || !Array.isArray(data.items) || data.items.length > 5000
        || Object.hasOwn(data, 'next_cursor') && data.next_cursor !== null) throw fail('Invalid Album Top detail.');
      const nativeScope = data.items.some(row => row?.native_album != null) ? nativeBrowseScope(scopeKey) : null;
      const nativeCurrent = () => !disposed && !options.signal?.aborted && options.scopeKey === scopeKey
        && transport.context() === nativeScope[2] && typeof transport.generation === 'function' && transport.generation() === nativeScope[3];
      const requireNativeScope = () => {
        if (nativeScope && (!nativeCurrent() || !acceptsScope(scopeKey) || !nativeCurrent())) throw abort();
      };
      requireNativeScope();
      result.items = data.items.map(row => {
        if (!uuid(row?.ref) || !uuid(row.catalog_ref) || typeof row.title !== 'string' || typeof row.artist_display !== 'string') throw fail('Invalid Album Top album.');
        if (Object.hasOwn(row, 'source_kind') && row.source_kind !== 'remote_summary') throw remoteFail();
        const summary = row.source_kind === 'remote_summary' ? remoteSummary(row) : null;
        return {item_ref: row.ref, album_ref: row.catalog_ref, title: row.title, artist: row.artist_display,
          year: summary ? summary.first_release_date ? Number(summary.first_release_date.slice(0, 4)) : null : Number.isInteger(row.release_year) ? row.release_year : null,
          original_position: row.original_position, position: row.curator_position, ...(summary || {}),
          ...(Object.hasOwn(row, 'native_album') ? {native_album: nativeAlbum(row.native_album, nativeScope?.[1], Boolean(summary))} : {})};
      });
      const remoteItems = result.items.filter(row => row.source_kind === 'remote_summary');
      if (remoteItems.length && (!remoteRevision(result.revision) || result.items.some(row => !canonicalUUID(row.item_ref) || !canonicalUUID(row.album_ref))
        || new Set(result.items.map(row => row.item_ref)).size !== result.items.length
        || new Set(result.items.map(row => row.album_ref)).size !== result.items.length
        || new Set(remoteItems.map(row => row.release_group_id)).size !== remoteItems.length)) throw remoteFail();
      if (Object.hasOwn(data, 'edit_draft')) {
        const draft = data.edit_draft, mixed = result.items.some(row => row.source_kind === 'remote_summary');
        if (!object(draft) || typeof draft.publication_preview_required !== 'boolean'
          || Object.hasOwn(draft, 'items') === Object.hasOwn(draft, 'item_selections')
          || mixed !== Object.hasOwn(draft, 'item_selections')) throw fail('Invalid Album Top editing projection.');
        const items = mixed ? typedItems(draft.item_selections, true) : draftItems(draft.items);
        if (items.length !== result.items.length || items.some((row, index) => row.item_ref !== result.items[index].item_ref || row.album_ref !== result.items[index].album_ref
          || mixed && ((row.source.kind === 'remote_retained') !== (result.items[index].source_kind === 'remote_summary')))) throw fail('Invalid Album Top editing projection.');
        result.edit_draft = {...(mixed ? {item_selections: items} : {items}), publication_preview_required: draft.publication_preview_required};
      }
      if (Object.hasOwn(data, 'top_viewer_overlay')) {
        const overlay = data.top_viewer_overlay, progress = overlay?.item_progress;
        if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)
          || !Object.hasOwn(overlay, 'item_progress') || !progress || typeof progress !== 'object' || Array.isArray(progress)
          || Object.keys(progress).length !== result.items.length
          || new Set(result.items.map(item => item.album_ref)).size !== result.items.length) throw fail('Invalid Album Top progress.');
        result.top_viewer_overlay = {...result.top_viewer_overlay, item_progress: Object.fromEntries(result.items.map(item => {
          const row = Object.hasOwn(progress, item.album_ref) ? progress[item.album_ref] : null;
          if (!isManualProgress(row)) throw fail('Invalid Album Top progress.');
          return [item.album_ref, {progress_revision: row.progress_revision, manual_completed_at: row.manual_completed_at}];
        }))};
      }
      // This endpoint returns all Top members; list/search pages cannot supply this count.
      result.completion_summary = projectCompleteTopProgress(result.items, result.top_viewer_overlay?.item_progress);
      requireNativeScope();
      return result;
    },
    async resolveNativeAlbum(payload, options) {
      const fields = ['top_ref', 'item_ref', 'revision', 'album_ref', 'inventory_album_ref'];
      if (!keysAre(payload, fields)) throw fail('Invalid Album Top native source.');
      const source = {...payload};
      const {scope, signal, current} = nativeLifetime(options,
        () => keysAre(payload, fields) && fields.every(key => payload[key] === source[key]));
      if (!canonicalUUID(source.top_ref) || !canonicalUUID(source.item_ref) || !canonicalUUID(source.album_ref)
        || !nativeId(source.revision) || !nativeInventoryReference(source.inventory_album_ref, scope[1])) throw fail('Invalid Album Top native source.');
      if (!current()) throw abort();
      const params = new URLSearchParams({revision: source.revision, inventory_album_ref: source.inventory_album_ref});
      // The existing guarded private transport owns rejected-I/O/denial and
      // context retirement; do not replace its policy error after it retires.
      const response = await transport.request('/album-tops/' + source.top_ref + '/items/' + source.item_ref
        + '/native-target?' + params.toString(), {signal, expected: scope[2], isCurrent: current});
      if (!current()) throw abort();
      if (response?.status !== 'ready' || response.context_ref !== scope[2]
        || !keysAre(response.data, ['top_ref', 'item_ref', 'revision', 'catalog_ref', 'inventory_album_ref', 'native_target'])) throw fail('Invalid Album Top native target.', 502);
      const data = response.data, target = data.native_target, albumKey = target?.album_ref;
      if (data.top_ref !== source.top_ref || data.item_ref !== source.item_ref || data.revision !== source.revision
        || data.catalog_ref !== source.album_ref || data.inventory_album_ref !== source.inventory_album_ref
        || !keysAre(target, ['album_ref', 'allowed_actions']) || !nativeAlbumReference(albumKey)
        || !keysAre(target.allowed_actions, ['can_view_details', 'can_play_album'])
        || target.allowed_actions.can_view_details !== true || target.allowed_actions.can_play_album !== false) throw fail('Invalid Album Top native target.', 502);
      const result = {...source, native_target: {album_ref: albumKey,
        allowed_actions: {can_view_details: true, can_play_album: false}}};
      if (!current()) throw abort();
      return result;
    },
    async captureNativeQueue(payload, options) {
      const fields = ['top_ref', 'revision'];
      if (!keysAre(payload, fields)) throw fail('Invalid Album Top queue source.');
      const captured = {...payload};
      const {scope, signal, current} = nativeLifetime(options,
        () => keysAre(payload, fields) && fields.every(key => payload[key] === captured[key]));
      if (!canonicalUUID(captured.top_ref) || !nativeId(captured.revision)) throw fail('Invalid Album Top queue source.');
      if (!current()) throw abort();
      // Only the server's locked curator membership determines this capture.
      const response = await transport.request('/album-tops/' + captured.top_ref + '/native-queue',
        {method: 'POST', body: {revision: captured.revision}, signal, expected: scope[2], isCurrent: current});
      if (!current()) throw abort();
      if (response?.status !== 'ready' || response.context_ref !== scope[2]) throw fail('Invalid Album Top native queue.', 502);
      const result = nativeQueue(response.data, captured, scope[1]);
      if (!current()) throw abort();
      return result;
    },
    async resolveNativePlayback(payload, options) {
      const fields = ['top_ref', 'source'];
      if (!keysAre(payload, fields)) throw fail('Invalid Album Top playback source.');
      const {top_ref, source: original} = payload;
      let source;
      const {scope, signal, current} = nativeLifetime(options, () => keysAre(payload, fields)
        && payload.top_ref === top_ref && payload.source === original && keysAre(original, nativeSourceFields)
        && nativeSourceFields.every(key => original[key] === source[key]));
      if (!canonicalUUID(top_ref)) throw fail('Invalid Album Top playback source.');
      source = nativePlaybackSource(original, scope[1], 409);
      if (!current()) throw abort();
      const response = await transport.request('/album-tops/' + top_ref + '/native-playback-target',
        {method: 'POST', body: {...source}, signal, expected: scope[2], isCurrent: current});
      if (!current()) throw abort();
      if (response?.status !== 'ready' || response.context_ref !== scope[2]
        || !keysAre(response.data, ['top_ref', 'source', 'native_target'])) throw fail('Invalid Album Top playback response.', 502);
      const data = {...response.data}, fresh = nativePlaybackSource(data.source, scope[1]);
      if (data.top_ref !== top_ref || !nativeSourceFields.every(key => fresh[key] === source[key])) throw fail('Album Top playback identity changed.', 502);
      const result = {top_ref, source: fresh, native_target: nativePlaybackTarget(data.native_target, source.inventory_track_ref)};
      if (!current()) throw abort();
      return result;
    },
    async execute(action, command, options) {
      const {top_ref, ...body} = command;
      if (!uuid(body.request_key) || !['create', 'save', 'enable_external', 'revoke_external', 'add', 'remove', 'reorder', 'delete', 'visibility', 'grant_editor', 'grant_viewer', 'revoke_editor', 'request_edit', 'decide_edit_request', 'copy', 'set_manual_completion', 'set_activity'].includes(action) || action !== 'create' && !uuid(top_ref)) throw fail('Invalid Album Top command.');
      const scoped = Object.hasOwn(body, 'artist_scope');
      if (scoped) {
        if (action !== 'create' || Object.hasOwn(body, 'source_review') || Object.hasOwn(body, 'playlist_preview_ref')) throw fail('Invalid Album Top scoped command.');
        body.artist_scope = artistScope(body.artist_scope);
      }
      const hasSelections = Object.hasOwn(body, 'selections'), hasItems = Object.hasOwn(body, 'item_selections');
      if (hasSelections || hasItems || Object.hasOwn(body, 'draft_ref')) {
        if (!nonzeroUUID(body.request_key) || action !== 'create' && !nonzeroUUID(top_ref)) throw fail('Invalid Album Top mixed identity.');
        if (action !== 'create' && !remoteRevision(body.revision)) throw fail('Invalid Album Top mixed revision.');
        if (hasSelections && (!['create', 'add'].includes(action) || hasItems || Object.hasOwn(body, 'album_refs'))
          || hasItems && (action !== 'save' || Object.hasOwn(body, 'items'))
          || Object.hasOwn(body, 'draft_ref') && (action !== 'create' || !hasSelections)) throw fail('Invalid Album Top mixed command.');
        if (hasSelections) {
          if (action === 'create' && !nonzeroUUID(body.draft_ref)) throw fail('Invalid Album Top draft identity.');
          body.selections = typedSelections(body.selections, action !== 'create', scoped && action === 'create');
        }
        if (hasItems) body.item_selections = typedItems(body.item_selections);
      }
      if (action === 'enable_external' || action === 'revoke_external') {
        const keys = action === 'enable_external' ? ['request_key', 'revision', 'items', 'evidence_revision'] : ['request_key', 'revision'];
        if (!isPublicationRevision(body.revision) || Object.keys(body).length !== keys.length
          || !keys.every(key => Object.hasOwn(body, key))) throw fail('Invalid Album Top publication command.');
        if (action === 'enable_external') {
          if (typeof body.evidence_revision !== 'string' || !/^[0-9a-f]{64}$/.test(body.evidence_revision)) throw fail('Invalid Album Top publication evidence.');
          body.items = draftItems(body.items);
          if (body.items.some(row => row.item_ref === null || !row.selected_source_ref)) throw fail('Invalid Album Top saved publication selection.');
        }
      }
      if (action === 'set_manual_completion' && (!uuid(body.album_ref) || !isProgressRevision(body.progress_revision)
        || typeof body.completed !== 'boolean' || Object.keys(body).length !== 4)) throw fail('Invalid Album Top progress command.');
      if (action === 'set_activity' && (!isTopActivity(body) || Object.keys(body).length !== 3)) throw fail('Invalid Album Top activity command.');
      const data = await request(action === 'create' ? '/album-tops' : '/album-tops/' + top_ref + '/' + action, options, body);
      if (action === 'set_activity') {
        if (data.top_ref !== top_ref || data.action !== action || data.request_key !== body.request_key
          || !isTopActivity(data) || typeof data.changed !== 'boolean' || data.active !== body.active
          || Object.hasOwn(data, 'revision')
          || BigInt(data.activity_revision) !== BigInt(body.activity_revision) + (data.changed ? 1n : 0n)) throw fail('Album Top activity was not acknowledged.', 502);
        return {top_ref, action, request_key: data.request_key, active: data.active,
          activity_revision: data.activity_revision, changed: data.changed};
      }
      if (action === 'set_manual_completion') {
        if (data.top_ref !== top_ref || data.album_ref !== body.album_ref || data.action !== action
          || data.request_key !== body.request_key || !isManualProgress(data) || typeof data.changed !== 'boolean'
          || Object.hasOwn(data, 'revision') || (data.manual_completed_at !== null) !== body.completed
          || BigInt(data.progress_revision) !== BigInt(body.progress_revision) + (data.changed ? 1n : 0n)) throw fail('Album Top progress was not acknowledged.', 502);
        return {top_ref, album_ref: data.album_ref, action, request_key: data.request_key,
          progress_revision: data.progress_revision, manual_completed_at: data.manual_completed_at, changed: data.changed};
      }
      if (!uuid(data.top_ref) || !revision(data.revision) || data.action !== action || data.request_key !== body.request_key || !['create', 'copy'].includes(action) && data.top_ref !== top_ref
        || action === 'copy' && (data.source_top_ref !== top_ref || data.source_revision !== body.revision || data.top_ref === top_ref)) throw fail('Album Top write was not acknowledged.', 502);
      if ((hasSelections || hasItems) && (!nonzeroUUID(data.top_ref) || !remoteRevision(data.revision)
        || (action === 'create' ? data.revision !== '1' : BigInt(data.revision) !== BigInt(body.revision) + 1n))) throw fail('Album Top mixed write was not acknowledged.', 502);
      if (action === 'create' && hasSelections && data.draft_ref !== body.draft_ref) throw fail('Album Top draft was not acknowledged.', 502);
      const publication = Object.hasOwn(data, 'publication') ? projectPublicationReceipt(data.publication) : undefined;
      if ((action === 'enable_external' || action === 'revoke_external')
        && (!isPublicationRevision(data.revision) || BigInt(data.revision) !== BigInt(body.revision) + 1n
          || publication?.state !== (action === 'enable_external' ? 'enabled' : 'revoked'))) throw fail('Album Top publication was not acknowledged.', 502);
      return {top_ref: data.top_ref, revision: data.revision, action, request_key: data.request_key,
        ...(action === 'copy' ? {source_top_ref: data.source_top_ref, source_revision: data.source_revision} : {}),
        ...(action === 'create' && hasSelections ? {draft_ref: data.draft_ref} : {}),
        ...(publication ? {publication} : {})};
    },
    dispose() {disposed = true;},
  };
}
