import {resource, safeServerArtworkUrl} from '../home-friends/model.mjs';
import {normalizePlaylistFacts} from './filters.mjs';

// One unsaved form session. Authenticated providers own source identity,
// permissions, atomic persistence and idempotency; there is no transport here.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const ref = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const opaque = value => ref(value) && !/[\\/]|^(?:file|https?):/i.test(value) ? value : null;
const field = (value, key) => own(value, key) ? value[key] : undefined;
const validMetadata = value => typeof value.title === 'string' && Boolean(value.title.trim())
  && value.title.length <= 100 && typeof value.description === 'string' && value.description.length <= 1000;
const grant = (value, key) => record(value) && own(value, 'allowed_actions')
  && record(value.allowed_actions) && own(value.allowed_actions, key) && value.allowed_actions[key] === true;
const freeze = value => {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
};
const actions = (value, names) => Object.fromEntries(names.map(name => [name, grant(value, name)]));
const SOURCE_ACTIONS = ['can_read', 'can_use_for_playlist'];
const sourceGranted = value => SOURCE_ACTIONS.every(key => grant(value, key));
const availability = value => ['local', 'missing'].includes(value) ? value : 'unresolved';
const completeness = value => ['complete', 'incomplete'].includes(value) ? value : 'unknown';
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const folded = value => text(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const normalizedQuery = value => text(value).trim().replace(/\s+/g, ' ');
const tuple = value => record(value) && ['library', 'playlist', 'activity'].includes(field(value, 'kind'))
  && opaque(field(value, 'ref')) && ref(field(value, 'revision'))
  ? {kind: value.kind, ref: value.ref, revision: value.revision} : null;
const sameSource = (a, b) => a?.kind === b?.kind && a?.ref === b?.ref && a?.revision === b?.revision;
const sourceMatchesMode = (source, mode) => mode === 'ordinary' ? ['library', 'activity'].includes(source?.kind) : mode === 'missing' && source?.kind === 'playlist';
const PAGED_PROTOCOL = 'library_selection_v1';
const paged = value => value?.source_protocol === PAGED_PROTOCOL && value?.entries_complete === false;
const permittedContext = context => Boolean(ref(field(context, 'scopeKey')) && field(context, 'canCreate') === true
  && normalizeCreationDescriptor(field(context, 'source')) && sourceMatchesMode(context.source, field(context, 'mode')));

export function normalizeCreationDescriptor(value) {
  const source = tuple(value);
  return source && sourceGranted(value) ? freeze({...source, allowed_actions: actions(value, SOURCE_ACTIONS),
    ...(own(value, 'source_protocol') ? {source_protocol: value.source_protocol} : {})}) : null;
}

function denseRows(value) {
  if (!Array.isArray(value)) throw new TypeError('Invalid creation rows.');
  return Array.from(value, (row, index) => {
    if (!own(value, index) || !record(row)) throw new TypeError('Invalid creation row.');
    return row;
  });
}
function parent(value, retained = false) {
  const albumRef = opaque(field(value, 'album_ref'));
  const state = albumRef && (retained || field(value, 'state') === 'known') ? 'known'
    : field(value, 'state') === 'ambiguous' ? 'ambiguous' : 'unknown';
  return {state, album_ref: state === 'known' ? albumRef : null,
    title: text(field(value, 'title')), artist: text(field(value, 'artist')), year: integer(field(value, 'year')),
    availability: availability(field(value, 'availability')), completeness: completeness(field(value, 'completeness')),
    allowed_actions: actions(value, ['can_read', 'can_view_details', 'can_create_album_top'])};
}
function entry(value, index, isPaged = false) {
  if (!grant(value, 'can_read')) return {row_key: `projection:${index}`, entry_ref: null,
    canonical_track_ref: null, title: 'Unavailable track', artist: '', album_title: '',
    track_number: null, disc_number: null, duration_seconds: null, artwork_url: null,
    metadata_state: 'unknown', availability: 'unresolved', source_readable: false,
    allowed_actions: {can_read: false, can_select: false}, parent_album: null};
  const entryRef = field(value, 'entry_ref') ?? null;
  return {row_key: isPaged ? `selection:${value.selection_ref}` : entryRef === null ? `projection:${index}` : `entry:${entryRef}`, entry_ref: entryRef,
    ...(isPaged ? {selection_ref: value.selection_ref} : {}),
    canonical_track_ref: opaque(field(value, 'canonical_track_ref')),
    title: text(field(value, 'title')), artist: text(field(value, 'artist')), album_title: text(field(value, 'album_title')),
    track_number: integer(field(value, 'track_number')), disc_number: integer(field(value, 'disc_number')),
    ...normalizePlaylistFacts(value), duration_seconds: number(field(value, 'duration_seconds')), artwork_url: safeServerArtworkUrl(field(value, 'artwork_url')),
    metadata_state: ['current', 'last_known'].includes(field(value, 'metadata_state')) ? value.metadata_state : 'unknown',
    availability: availability(field(value, 'availability')), source_readable: true,
    match_state: field(value, 'availability') === 'local' && field(value, 'match_state') === 'accepted' ? 'accepted' : null,
    allowed_actions: actions(value, ['can_read', 'can_select']), parent_album: parent(field(value, 'parent_album'))};
}

export function normalizeCreationResult(value, context) {
  if (!permittedContext(context)) return resource('denied');
  if ([401, 403].includes(value?.status)) return resource('denied');
  if (['denied', 'unavailable'].includes(field(value, 'status'))) return resource(value.status);
  if (field(value, 'status') !== 'ready' || field(value, 'ok') === false || !record(field(value, 'data'))) return resource('error');
  const data = value.data, source = tuple(field(data, 'source'));
  if (!source || !ref(field(data, 'scopeKey')) || !['ordinary', 'missing'].includes(field(data, 'mode'))) return resource('error');
  if (data.scopeKey !== context.scopeKey || data.mode !== context.mode
    || source.kind !== context.source.kind || source.ref !== context.source.ref) return resource('error');
  if (!sourceGranted(data)) return resource('denied');
  if (source.revision !== context.source.revision) return resource('conflict');
  const isPaged = paged(data) && context.mode === 'ordinary';
  if (!isPaged && field(data, 'entries_complete') !== true) return resource('incomplete');
  if (data.source_protocol === PAGED_PROTOCOL && !isPaged
    || context.source.source_protocol && context.source.source_protocol !== data.source_protocol) return resource('error');
  try {
    if (isPaged && (typeof data.query !== 'string' || data.query.length > 200 || !opaque(data.search_revision)
      || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 100 || typeof data.has_more !== 'boolean'
      || (data.has_more ? !opaque(data.next_cursor) : data.next_cursor !== null)
      || !Array.isArray(data.entries) || data.entries.length > data.limit)) throw new TypeError('Invalid source page.');
    const seen = new Set(), selections = new Set();
    const entries = denseRows(field(data, 'entries')).map((value, index) => {
      const entryRef = field(value, 'entry_ref') ?? null;
      if (entryRef !== null && (!opaque(entryRef) || seen.has(entryRef))) throw new TypeError('Invalid occurrence identity.');
      if (entryRef !== null) seen.add(entryRef);
      if (isPaged && (!opaque(value.selection_ref) || selections.has(value.selection_ref) || !opaque(entryRef))) throw new TypeError('Invalid selection identity.');
      if (isPaged) selections.add(value.selection_ref);
      return entry(value, index, isPaged);
    });
    const retained = denseRows(field(data, 'retained_parent_albums') ?? [])
      .filter(value => grant(value, 'can_read') && opaque(field(value, 'album_ref'))
        && (!own(value, 'state') || value.state === 'known')).map(value => ({...parent(value, true),
          entry_refs: field(value, 'entry_refs') == null ? null : Array.isArray(value.entry_refs)
            ? [...new Set(value.entry_refs.filter(entryRef => opaque(entryRef) && entries.some(row => row.entry_ref === entryRef && row.source_readable)))] : []}));
    return resource('ready', freeze({scopeKey: data.scopeKey, mode: data.mode, source,
      allowed_actions: actions(data, SOURCE_ACTIONS), entries_complete: !isPaged, entries, retained_parent_albums: retained,
      ...(data.source_protocol ? {source_protocol: data.source_protocol} : {}),
      ...(isPaged ? {query: data.query, search_revision: data.search_revision, limit: data.limit,
        has_more: data.has_more, next_cursor: data.next_cursor, max_selected_entries: 5000, max_command_bytes: 524288} : {})}));
  } catch { return resource('error'); }
}

const eligible = (row, mode) => row.source_readable === true && opaque(row.entry_ref)
  && grant(row, 'can_read') && grant(row, 'can_select') && (mode !== 'missing' || row.availability !== 'local');
const groupKey = row => row.parent_album?.state === 'known' ? `album:${row.parent_album.album_ref}` : `occurrence:${row.row_key}`;

export function projectCreationState(state) {
  const data = state?.sourceResource?.status === 'ready' ? state.sourceResource.data : null;
  const rows = (data?.entries || []).filter(row => state.mode !== 'missing' || row.availability !== 'local');
  const byKey = new Map((paged(data) ? state.pinnedEntries || [] : rows).map(row => [row.row_key, row]));
  const selectedEntries = [...new Set(state?.selectedKeys || [])].map(key => byKey.get(key)).filter(row => row && eligible(row, state.mode));
  const selected = new Set(selectedEntries.map(row => row.row_key)), query = folded(state?.query);
  const groupFacts = new Map();
  for (const row of rows) {
    const key = groupKey(row), prior = groupFacts.get(key);
    const fact = row.availability === 'missing' || row.parent_album?.completeness === 'incomplete' ? 'incomplete'
      : row.parent_album?.completeness || 'unknown';
    groupFacts.set(key, prior === 'incomplete' || fact === 'incomplete' ? 'incomplete'
      : prior === 'unknown' || fact === 'unknown' ? 'unknown' : fact);
  }
  let entries = selectedEntries;
  if (state?.tab !== 'selected') {
    const order = new Map(rows.map((row, index) => [row.row_key, index]));
    const first = new Map();
    for (const row of rows) if (!first.has(groupKey(row))) first.set(groupKey(row), order.get(row.row_key));
    entries = paged(data) ? [...rows] : rows.filter(row => !query || folded([row.title, row.artist, row.album_title].join(' ')).includes(query));
    if (!paged(data)) entries.sort((a, b) => {
      const exact = Number(Boolean(query) && folded(b.title) === query) - Number(Boolean(query) && folded(a.title) === query);
      if (exact) return exact;
      const known = Number(b.parent_album?.state === 'known') - Number(a.parent_album?.state === 'known');
      if (known) return known;
      const year = a.parent_album?.state === 'known'
        ? (rows[first.get(groupKey(a))].parent_album.year ?? Infinity) - (rows[first.get(groupKey(b))].parent_album.year ?? Infinity) : 0;
      return (Number.isNaN(year) ? 0 : year) || first.get(groupKey(a)) - first.get(groupKey(b)) || order.get(a.row_key) - order.get(b.row_key);
    });
  }
  // Consecutive groups preserve Selected order and exact-title search priority.
  const groups = [];
  for (const row of entries) {
    const key = groupKey(row), previous = groups[groups.length - 1];
    if (previous?.identity === key) previous.entries.push(row);
    else groups.push({identity: key, key: `${key}:run:${groups.length}`, parent_album: row.parent_album,
      entries: [row], completeness: groupFacts.get(key)});
  }
  return freeze({entries, groups: groups.map(({identity, ...group}) => group), selectedEntries,
    selectedCount: selectedEntries.length, duplicateCount: selectedEntries.length - new Set(selectedEntries.map(row => row.entry_ref)).size, visibleSelectedCount: entries.filter(row => selected.has(row.row_key)).length});
}

export function buildCreationRequest(data, {context, title, description, selectedKeys, pinnedEntries, request_key, allowAcceptedMatches = false} = {}) {
  if (!permittedContext(context) || !validMetadata({title, description}) || !ref(request_key)
    || !record(data) || field(data, 'scopeKey') !== context.scopeKey || field(data, 'mode') !== context.mode
    || !sameSource(field(data, 'source'), context.source) || !sourceGranted(data) || !(field(data, 'entries_complete') === true || paged(data) && context.mode === 'ordinary')
    || !Array.isArray(data.entries) || !Array.isArray(selectedKeys) || new Set(selectedKeys).size !== selectedKeys.length) return null;
  if (Array.from(data.entries).some((row, index) => !own(data.entries, index) || !record(row) || !ref(field(row, 'row_key')))
    || Array.from(selectedKeys).some((key, index) => !own(selectedKeys, index) || typeof key !== 'string')
    || new Set(data.entries.map(row => row.row_key)).size !== data.entries.length) return null;
  const rows = paged(data) ? pinnedEntries : data.entries;
  if (!Array.isArray(rows) || selectedKeys.length > 5000 || rows.some(row => !record(row) || !ref(row.row_key))) return null;
  const byKey = new Map(rows.map(row => [row.row_key, row]));
  const selected = Array.from(selectedKeys, key => byKey.get(key));
  if (selected.some(row => !row || !(eligible(row, context.mode) || allowAcceptedMatches === true && context.mode === 'missing'
    && row.match_state === 'accepted' && row.availability === 'local' && eligible(row, 'ordinary')))
    || context.mode === 'missing' && !selected.length) return null;
  const occurrenceRefs = selected.map(row => row.entry_ref);
  if (new Set(occurrenceRefs).size !== occurrenceRefs.length
    && !(context.mode === 'ordinary' && selected.every(row => occurrenceRefs.indexOf(row.entry_ref) === occurrenceRefs.lastIndexOf(row.entry_ref) || row.seed_occurrence === true))) return null;
  const refs = [...new Set(occurrenceRefs)];
  const request = {scopeKey: context.scopeKey, playlist_id: null, mode: context.mode, source: tuple(context.source),
    title, description, entry_refs: refs, request_key, ...(data.source_protocol ? {source_protocol: data.source_protocol} : {})};
  if (new TextEncoder().encode(JSON.stringify(request)).length > 524288) return null;
  return freeze(request);
}

export function canSubmitCreation(state) {
  return state?.mutation?.status === 'idle' && state?.sourceResource?.status === 'ready'
    && Boolean(buildCreationRequest(state.sourceResource.data, {context: state, title: state.title,
      description: state.description, selectedKeys: state.selectedKeys, pinnedEntries: state.pinnedEntries, request_key: 'validation-only'}));
}

let presentationSerial = 0;
// The fallback is only a per-document UI namespace, never an operation key.
const presentationNonce = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
// This packet is presentation state, never a persisted Playlist or provider ID.
// The same item-aware source validation used by Save also guards preparation.
export function prepareMissingDraft(state, {draftToken} = {}) {
  if (state?.mode !== 'missing' || !canSubmitCreation(state)) return null;
  const source = normalizeCreationDescriptor(state.source);
  const supplied = state.sourceResource.data;
  const normalized = normalizeCreationResult({status: 'ready', data: {...supplied,
    entries: supplied.entries.map(row => ({...row, added_at: row.added_at_ms, last_listened_at: row.last_listened_at_ms}))}}, state);
  if (!source || normalized.status !== 'ready') return null;
  const byKey = new Map(normalized.data.entries.map(row => [row.row_key, row]));
  const entries = state.selectedKeys.map(key => byKey.get(key));
  if (entries.some(row => !row || !eligible(row, 'missing'))) return null;
  const token = draftToken === undefined ? `missing-draft:${presentationNonce}:${++presentationSerial}` : opaque(draftToken);
  if (!token) return null;
  return freeze({draftToken: token, scopeKey: state.scopeKey, mode: 'missing', source, canCreate: true,
    ...(normalized.data.source_protocol ? {source_protocol: normalized.data.source_protocol} : {}),
    canCreateAlbumTop: field(state, 'canCreateAlbumTop') === true,
    title: state.title, description: state.description, entries,
    retained_parent_albums: normalized.data.retained_parent_albums});
}

const idle = () => ({status: 'idle', request_key: null, data: null});
const initial = (context = {}) => freeze({scopeKey: context.scopeKey ?? null, mode: own(context, 'mode') ? context.mode : 'ordinary',
  source: context.source ?? null, canCreate: context.canCreate === true, canCreateAlbumTop: context.canCreateAlbumTop === true,
  sourceResource: resource(), mutation: idle(),
  title: '', description: '', query: '', tab: 'all', selectedKeys: [], pinnedEntries: [], pageStatus: 'idle', selectionLimit: false, reviewKey: null, dirty: false});
const failureStatus = value => [401, 403].includes(value?.status) || value?.status === 'denied' ? 'denied'
  : value?.status === 409 || value?.status === 'conflict' ? 'conflict' : value?.status === 'unavailable' ? 'unavailable' : 'error';

function acknowledgement(value, request) {
  if (field(value, 'status') !== 'ready' || field(value, 'ok') === false || !record(field(value, 'data'))) return null;
  const data = value.data;
  if (!['scopeKey', 'request_key', 'playlist_id', 'revision'].every(key => ref(field(data, key)))
    || data.scopeKey !== request.scopeKey || data.request_key !== request.request_key || !opaque(data.playlist_id)) return null;
  return freeze({scopeKey: data.scopeKey, request_key: data.request_key, playlist_id: data.playlist_id, revision: data.revision});
}

export function createPlaylistCreationController({providers = {}} = {}) {
  const read = field(providers, 'readPlaylistCreationSource'), write = field(providers, 'createPlaylistFromSelection');
  const configured = () => typeof read === 'function' && (state.mode === 'missing' || typeof write === 'function');
  let state = initial(), disposed = false, generation = 0, pendingRead = null, pendingWrite = null,
    baseSelection = [], selectInitialMissing = true, sourcePaused = false, preparedState = null, preparedDraft = null,
    seedAvailable = false, sourceReads = 0, submittedRequest = null, pageCursors = new Set();
  const listeners = new Set();
  const publish = patch => {
    if (disposed) return;
    preparedState = null; preparedDraft = null;
    state = freeze({...state, ...patch});
    for (const listener of [...listeners]) if (!disposed && listeners.has(listener)) listener();
  };
  const invalidate = () => {
    generation++; seedAvailable = false; pendingRead?.abort(); pendingWrite?.abort(); pendingRead = null; pendingWrite = null;
  };
  const current = (version, request, channel) => !disposed && generation === version && !request.signal.aborted
    && (channel === 'read' ? pendingRead : pendingWrite) === request;
  const editable = () => !disposed && state.mutation.status === 'idle' && configured() && permittedContext(state);
  const dirty = (title, description, selectedKeys) => Boolean(title || description
    || selectedKeys.length !== baseSelection.length || selectedKeys.some((key, index) => key !== baseSelection[index]));
  const clearDenied = status => {
    baseSelection = []; sourcePaused = false;
    publish({...initial({scopeKey: state.scopeKey, mode: state.mode, canCreate: false}), sourceResource: resource(status)});
  };
  const expireSource = (mutation = state.mutation) => {
    invalidate(); baseSelection = []; pageCursors.clear(); selectInitialMissing = false;
    publish({sourceResource: resource('expired'), selectedKeys: [], pinnedEntries: [], reviewKey: null,
      query: '', pageStatus: 'idle', selectionLimit: false, mutation, dirty: Boolean(state.title || state.description)});
  };
  const selectionPatch = selectedKeys => {
    const data = state.sourceResource.data;
    if (!paged(data)) return {selectedKeys};
    const prior = new Map(state.pinnedEntries.map(row => [row.row_key, row]));
    const visible = new Map(data.entries.map(row => [row.row_key, row]));
    return {selectedKeys, pinnedEntries: selectedKeys.map(key => prior.get(key) || visible.get(key)).filter(Boolean)};
  };
  async function loadPage({query = state.query, append = false} = {}) {
    if (!editable() || sourcePaused || !paged(state.sourceResource.data)) return false;
    const previous = state.sourceResource.data, cursor = append ? previous.next_cursor : null;
    if (append && (!previous.has_more || state.pageStatus === 'loading' || previous.query !== normalizedQuery(query))) return false;
    pendingRead?.abort();
    const request = new AbortController(), version = generation, context = state;
    pendingRead = request;
    if (!append) pageCursors = new Set();
    publish({pageStatus: 'loading', reviewKey: null, ...(append ? {} : {
      sourceResource: resource('ready', freeze({...previous, entries: [], has_more: false, next_cursor: null}))})});
    try {
      if (!current(version, request, 'read')) return false;
      const response = await read({scopeKey: context.scopeKey, mode: context.mode, source: freeze(tuple(context.source)),
        q: query, cursor, signal: request.signal});
      if (!current(version, request, 'read')) return false;
      const result = normalizeCreationResult(response, context);
      if (result.status === 'denied') {clearDenied('denied'); return false;}
      if (result.status !== 'ready' || !paged(result.data) || result.data.query !== normalizedQuery(query)
        || append && result.data.search_revision !== previous.search_revision
        || result.data.has_more && pageCursors.has(result.data.next_cursor)) {
        publish({pageStatus: result.status === 'conflict' ? 'conflict' : 'error'}); return false;
      }
      // Server ordering wins. Reobservations replace only the visible facts;
      // selected immutable entry receipts are retained separately until deselected.
      const rows = append ? [...previous.entries] : [], seen = new Set(rows.map(row => row.selection_ref));
      for (const row of result.data.entries) {
        if (!seen.has(row.selection_ref)) {rows.push(row); seen.add(row.selection_ref);}
        else rows[rows.findIndex(value => value.selection_ref === row.selection_ref)] = row;
      }
      if (result.data.has_more) pageCursors.add(result.data.next_cursor);
      publish({sourceResource: resource('ready', freeze({...result.data, entries: rows})), pageStatus: 'idle'});
      return true;
    } catch (error) {
      if (current(version, request, 'read')) {
        if (error?.code === 'source_expired') expireSource();
        else if (failureStatus(error) === 'denied') clearDenied('denied');
        else publish({pageStatus: failureStatus(error)});
      }
      return false;
    } finally {if (pendingRead === request) pendingRead = null;}
  }
  const controller = {
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Creation subscription requires a listener.');
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext(value = {}) {
      if (disposed) return false;
      const next = {scopeKey: ref(field(value, 'scopeKey')), mode: ['ordinary', 'missing'].includes(field(value, 'mode')) ? value.mode : null,
        source: normalizeCreationDescriptor(field(value, 'source')), canCreate: field(value, 'canCreate') === true,
        canCreateAlbumTop: field(value, 'canCreateAlbumTop') === true};
      if (state.scopeKey === next.scopeKey && state.mode === next.mode && sameSource(state.source, next.source)
        && state.canCreate === next.canCreate) {
        if (state.sourceResource.status === 'expired') return false;
        if (!sourcePaused || !permittedContext(next)) {
          if (state.canCreateAlbumTop === next.canCreateAlbumTop) return false;
          publish({canCreateAlbumTop: next.canCreateAlbumTop}); return true;
        }
        sourcePaused = false;
        publish({canCreateAlbumTop: next.canCreateAlbumTop, sourceResource: resource('refresh_required')}); return true;
      }
      const revisionOnly = permittedContext(state) && permittedContext(next) && state.scopeKey === next.scopeKey
        && state.mode === next.mode && state.source.kind === next.source.kind && state.source.ref === next.source.ref
        && state.source.revision !== next.source.revision;
      const metadata = revisionOnly ? {title: state.title, description: state.description, dirty: Boolean(state.title || state.description)} : {};
      const mutation = revisionOnly && state.mutation.request_key
        ? {...state.mutation, status: state.mutation.status === 'loading' ? 'error' : state.mutation.status} : idle();
      invalidate(); if (!revisionOnly) submittedRequest = null;
      sourceReads = revisionOnly ? 1 : 0; baseSelection = []; selectInitialMissing = !revisionOnly; sourcePaused = false;
      publish({...initial(next), ...metadata, mutation,
        sourceResource: resource(!permittedContext(next) ? 'denied' : revisionOnly ? 'conflict' : 'unavailable')});
      return true;
    },
    pauseSource(status = 'loading') {
      if (disposed || !permittedContext(state) || !['loading', 'error', 'unavailable', 'refresh_required'].includes(status)
        || sourcePaused && state.sourceResource.status === status) return false;
      const mutation = state.mutation.status === 'loading'
        ? {status: 'error', request_key: state.mutation.request_key, data: null} : state.mutation;
      invalidate(); sourceReads = Math.max(sourceReads, 1); sourcePaused = true; baseSelection = []; selectInitialMissing = false;
      publish({sourceResource: resource(status), selectedKeys: [], pinnedEntries: [], pageStatus: 'idle', selectionLimit: false, reviewKey: null, mutation,
        dirty: Boolean(state.title || state.description)});
      return true;
    },
    async load() {
      if (disposed || sourcePaused || state.sourceResource.status === 'expired' || state.mutation.status !== 'idle') return false;
      if (!permittedContext(state)) {clearDenied('denied'); return false;}
      if (!configured()) {publish({sourceResource: resource()}); return false;}
      pendingRead?.abort();
      const request = new AbortController(), version = generation, context = state;
      pendingRead = request; baseSelection = []; seedAvailable = false; sourceReads++;
      publish({sourceResource: resource('loading'), selectedKeys: [], pinnedEntries: [], pageStatus: 'idle', selectionLimit: false,
        query: '', reviewKey: null, dirty: Boolean(state.title || state.description)});
      try {
        if (!current(version, request, 'read')) return false;
        const response = await read({scopeKey: context.scopeKey, mode: context.mode, source: freeze(tuple(context.source)), signal: request.signal});
        if (!current(version, request, 'read')) return false;
        const result = normalizeCreationResult(response, context);
        if (result.status === 'denied') {clearDenied('denied'); return false;}
        baseSelection = result.status === 'ready' && selectInitialMissing && state.mode === 'missing'
          ? result.data.entries.filter(row => eligible(row, state.mode)).map(row => row.row_key) : [];
        if (result.status === 'ready') selectInitialMissing = false;
        seedAvailable = result.status === 'ready' && sourceReads === 1 && state.mode === 'ordinary';
        pageCursors = new Set(result.status === 'ready' && paged(result.data) && result.data.has_more ? [result.data.next_cursor] : []);
        publish({sourceResource: result, selectedKeys: baseSelection, reviewKey: null, dirty: Boolean(state.title || state.description)});
        return current(version, request, 'read') && result.status === 'ready';
      } catch (error) {
        if (current(version, request, 'read')) {
          if (error?.code === 'source_expired') expireSource();
          else if (failureStatus(error) === 'denied') clearDenied('denied');
          else publish({sourceResource: resource(failureStatus(error))});
        }
        return false;
      } finally {if (pendingRead === request) pendingRead = null;}
    },
    // Only the first complete ordinary-source admission can be seeded. The
    // caller must retain the exact read snapshot across its source checks;
    // a reload, source pause or user selection retires that one-time receipt.
    seed(entryRefs, sourceResource, {preserveOccurrences = false} = {}) {
      if (!editable() || !seedAvailable || state.mode !== 'ordinary' || state.sourceResource.status !== 'ready'
        || state.sourceResource.data.entries_complete !== true
        || sourceResource !== state.sourceResource || !Array.isArray(entryRefs) || !entryRefs.length
        || entryRefs.length > 5000 || Array.from(entryRefs).some(value => !opaque(value))
        || !preserveOccurrences && new Set(entryRefs).size !== entryRefs.length) return false;
      const byRef = new Map(state.sourceResource.data.entries.map(row => [row.entry_ref, row]));
      const rows = entryRefs.map(value => byRef.get(value));
      if (rows.some(row => !row || !eligible(row, 'ordinary'))) return false;
      seedAvailable = false;
      const repeated = new Set(entryRefs).size !== entryRefs.length;
      const occurrences = repeated ? rows.map((row, index) => ({...row, row_key: `initial:${index}:${row.entry_ref}`, seed_occurrence: true})) : rows;
      const seeded = new Set(entryRefs);
      const nextSource = repeated ? resource('ready', {...state.sourceResource.data,
        entries: [...occurrences, ...state.sourceResource.data.entries.filter(row => !seeded.has(row.entry_ref))]}) : state.sourceResource;
      baseSelection = occurrences.map(row => row.row_key);
      publish({sourceResource: nextSource, selectedKeys: baseSelection, tab: 'selected', dirty: Boolean(state.title || state.description)});
      return true;
    },
    edit(patch) {
      if (!editable() || !record(patch)) return false;
      const title = own(patch, 'title') ? patch.title : state.title;
      const description = own(patch, 'description') ? patch.description : state.description;
      if (typeof title !== 'string' || title.length > 100 || typeof description !== 'string' || description.length > 1000) return false;
      publish({title, description, dirty: dirty(title, description, state.selectedKeys)}); return true;
    },
    setQuery(query) {
      if (!editable() || typeof query !== 'string' || query.length > 200 || /\x00/.test(query)) return false;
      if (state.query === query) return true;
      publish({query, tab: 'all'});
      if (paged(state.sourceResource.data)) void loadPage({query});
      return true;
    },
    loadMore: () => loadPage({append: true}),
    retryPage: () => loadPage(),
    setTab(tab) {
      if (!editable() || !['all', 'selected'].includes(tab)) return false;
      publish({tab}); return true;
    },
    toggle(key) {
      if (!editable() || state.sourceResource.status !== 'ready') return false;
      const row = state.sourceResource.data.entries.find(row => row.row_key === key)
        || state.pinnedEntries.find(row => row.row_key === key);
      if (!row || !eligible(row, state.mode)) return false;
      seedAvailable = false;
      const selectedKeys = state.selectedKeys.includes(key) ? state.selectedKeys.filter(value => value !== key) : [...state.selectedKeys, key];
      if (selectedKeys.length > 5000) {publish({selectionLimit: true}); return false;}
      publish({...selectionPatch(selectedKeys), selectionLimit: false, dirty: dirty(state.title, state.description, selectedKeys)}); return true;
    },
    selectVisible(selected) {
      if (!editable() || typeof selected !== 'boolean' || state.sourceResource.status !== 'ready') return false;
      seedAvailable = false;
      const visible = projectCreationState(state).entries.filter(row => eligible(row, state.mode)).map(row => row.row_key);
      const keys = new Set(state.selectedKeys);
      for (const key of visible) {if (selected) keys.add(key); else keys.delete(key);}
      const selectedKeys = [...keys];
      if (selectedKeys.length > 5000) {publish({selectionLimit: true}); return false;}
      publish({...selectionPatch(selectedKeys), selectionLimit: false, dirty: dirty(state.title, state.description, selectedKeys)}); return true;
    },
    review(key) {
      if (disposed || key !== null && (state.sourceResource.status !== 'ready'
        || ![...state.sourceResource.data.entries, ...state.pinnedEntries].some(row => row.row_key === key && row.source_readable === true
          && (state.mode !== 'missing' || row.availability !== 'local')))) return false;
      publish({reviewKey: key}); return true;
    },
    prepareDraft(options) {
      if (sourcePaused || !editable()) return null;
      if (preparedState === state && (!options?.draftToken || options.draftToken === preparedDraft?.draftToken)) return preparedDraft;
      preparedState = state; preparedDraft = prepareMissingDraft(state, options);
      return preparedDraft;
    },
    async submit() {
      if (state.mode !== 'ordinary' || sourcePaused || !editable() || !canSubmitCreation(state)) return false;
      // A random operation token is not a track or playlist identity. No weak
      // synthesized fallback may silently defeat provider-side idempotency.
      if (typeof globalThis.crypto?.randomUUID !== 'function') {publish({mutation: {status: 'unavailable', request_key: null, data: null}}); return false;}
      const request_key = globalThis.crypto.randomUUID();
      const payload = buildCreationRequest(state.sourceResource.data, {context: state, title: state.title,
        description: state.description, selectedKeys: state.selectedKeys, pinnedEntries: state.pinnedEntries, request_key});
      if (!payload) return false;
      submittedRequest = payload;
      pendingRead?.abort(); pendingRead = null;
      const request = new AbortController(), version = generation;
      pendingWrite = request;
      publish({mutation: {status: 'loading', request_key, data: null}});
      try {
        if (!current(version, request, 'write')) return false;
        const response = await write({...payload, signal: request.signal});
        if (!current(version, request, 'write')) return false;
        const data = acknowledgement(response, payload);
        if (!data && failureStatus(response) === 'denied') {
          clearDenied('denied');
          if (current(version, request, 'write')) publish({mutation: {status: 'denied', request_key, data: null}});
          return false;
        }
        publish({mutation: {status: data ? 'ready' : failureStatus(response), request_key, data}});
        return current(version, request, 'write') ? data || false : false;
      } catch (error) {
        if (current(version, request, 'write')) {
          const status = failureStatus(error);
          if (error?.code === 'source_expired') {expireSource({status: 'conflict', request_key, data: null}); return false;}
          if (status === 'denied') clearDenied('denied');
          if (current(version, request, 'write')) publish({mutation: {status, request_key, data: null}});
        }
        return false;
      } finally {if (pendingWrite === request) pendingWrite = null;}
    },
    canRetryOriginal() {
      return !disposed && permittedContext(state) && Boolean(submittedRequest) && state.mutation.status !== 'loading'
        && typeof field(providers, 'retryPlaylistOperation') === 'function'
        && field(providers, 'hasPendingPlaylistOperation')?.({...submittedRequest, action: 'create'}) === true;
    },
    retryOriginal() {return controller.reconcile({retry: true});},
    async reconcile({retry = false} = {}) {
      if (disposed || !submittedRequest || pendingWrite || !['error', 'conflict', 'unavailable'].includes(state.mutation.status)
        || typeof providers[retry ? 'retryPlaylistOperation' : 'reconcilePlaylistOperation'] !== 'function') return false;
      const payload = submittedRequest, request = new AbortController(), version = generation;
      pendingWrite = request;
      publish({mutation: {status: 'loading', request_key: payload.request_key, data: null}});
      try {
        if (!current(version, request, 'write')) return false;
        const response = await providers[retry ? 'retryPlaylistOperation' : 'reconcilePlaylistOperation']({...payload, action: 'create', signal: request.signal});
        if (!current(version, request, 'write')) return false;
        const data = acknowledgement(response, payload);
        publish({mutation: {status: data ? 'ready' : 'error', request_key: payload.request_key, data}});
        return data || false;
      } catch (error) {
        if (current(version, request, 'write')) {const status = failureStatus(error); if (status === 'denied') clearDenied('denied'); publish({mutation: {status, request_key: payload.request_key, data: null}});}
        return false;
      } finally {if (pendingWrite === request) pendingWrite = null;}
    },
    dispose() {
      if (disposed) return;
      invalidate(); disposed = true; state = initial(); baseSelection = []; preparedState = null; preparedDraft = null; listeners.clear();
    },
  };
  return Object.freeze(controller);
}
