import {resource, safeServerArtworkUrl} from '../home-friends/model.mjs';
import {confirmedMissingRow} from './missing-source.mjs';
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
const tuple = value => record(value) && ['library', 'playlist'].includes(field(value, 'kind'))
  && opaque(field(value, 'ref')) && ref(field(value, 'revision'))
  ? {kind: value.kind, ref: value.ref, revision: value.revision} : null;
const sameSource = (a, b) => a?.kind === b?.kind && a?.ref === b?.ref && a?.revision === b?.revision;
const sourceMatchesMode = (source, mode) => source?.kind === (mode === 'ordinary' ? 'library' : mode === 'missing' ? 'playlist' : null);
const permittedContext = context => Boolean(ref(field(context, 'scopeKey')) && field(context, 'canCreate') === true
  && normalizeCreationDescriptor(field(context, 'source')) && sourceMatchesMode(context.source, field(context, 'mode')));

export function normalizeCreationDescriptor(value) {
  const source = tuple(value);
  return source && sourceGranted(value) ? freeze({...source, allowed_actions: actions(value, SOURCE_ACTIONS)}) : null;
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
function entry(value, index) {
  if (!grant(value, 'can_read')) return {row_key: `projection:${index}`, entry_ref: null,
    canonical_track_ref: null, title: 'Unavailable track', artist: '', album_title: '',
    track_number: null, disc_number: null, duration_seconds: null, artwork_url: null,
    metadata_state: 'unknown', availability: 'unresolved', source_readable: false,
    allowed_actions: {can_read: false, can_select: false}, parent_album: null};
  const entryRef = field(value, 'entry_ref') ?? null;
  return {row_key: entryRef === null ? `projection:${index}` : `entry:${entryRef}`, entry_ref: entryRef,
    canonical_track_ref: opaque(field(value, 'canonical_track_ref')),
    title: text(field(value, 'title')), artist: text(field(value, 'artist')), album_title: text(field(value, 'album_title')),
    track_number: integer(field(value, 'track_number')), disc_number: integer(field(value, 'disc_number')),
    ...normalizePlaylistFacts(value), duration_seconds: number(field(value, 'duration_seconds')), artwork_url: safeServerArtworkUrl(field(value, 'artwork_url')),
    metadata_state: ['current', 'last_known'].includes(field(value, 'metadata_state')) ? value.metadata_state : 'unknown',
    availability: availability(field(value, 'availability')), source_readable: true,
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
  if (field(data, 'entries_complete') !== true) return resource('incomplete');
  try {
    const seen = new Set();
    const entries = denseRows(field(data, 'entries')).map((value, index) => {
      const entryRef = field(value, 'entry_ref') ?? null;
      if (entryRef !== null && (!opaque(entryRef) || seen.has(entryRef))) throw new TypeError('Invalid occurrence identity.');
      if (entryRef !== null) seen.add(entryRef);
      return entry(value, index);
    });
    const retained = denseRows(field(data, 'retained_parent_albums') ?? [])
      .filter(value => grant(value, 'can_read') && opaque(field(value, 'album_ref'))
        && (!own(value, 'state') || value.state === 'known')).map(value => ({...parent(value, true),
          entry_refs: field(value, 'entry_refs') == null ? null : Array.isArray(value.entry_refs)
            ? [...new Set(value.entry_refs.filter(entryRef => opaque(entryRef) && entries.some(row => row.entry_ref === entryRef && row.source_readable)))] : []}));
    return resource('ready', freeze({scopeKey: data.scopeKey, mode: data.mode, source,
      allowed_actions: actions(data, SOURCE_ACTIONS), entries_complete: true, entries, retained_parent_albums: retained}));
  } catch { return resource('error'); }
}

const eligible = (row, mode) => row.source_readable === true && opaque(row.entry_ref)
  && grant(row, 'can_read') && grant(row, 'can_select') && (mode !== 'missing' || confirmedMissingRow(row));
const groupKey = row => row.parent_album?.state === 'known' ? `album:${row.parent_album.album_ref}` : `occurrence:${row.row_key}`;

export function projectCreationState(state) {
  const data = state?.sourceResource?.status === 'ready' ? state.sourceResource.data : null;
  const rows = (data?.entries || []).filter(row => state.mode !== 'missing' || confirmedMissingRow(row));
  const byKey = new Map(rows.map(row => [row.row_key, row]));
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
    entries = rows.filter(row => !query || folded([row.title, row.artist, row.album_title].join(' ')).includes(query));
    entries.sort((a, b) => {
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
    selectedCount: selectedEntries.length, visibleSelectedCount: entries.filter(row => selected.has(row.row_key)).length});
}

export function buildCreationRequest(data, {context, title, description, selectedKeys, request_key} = {}) {
  if (!permittedContext(context) || !validMetadata({title, description}) || !ref(request_key)
    || !record(data) || field(data, 'scopeKey') !== context.scopeKey || field(data, 'mode') !== context.mode
    || !sameSource(field(data, 'source'), context.source) || !sourceGranted(data) || field(data, 'entries_complete') !== true
    || !Array.isArray(data.entries) || !Array.isArray(selectedKeys) || new Set(selectedKeys).size !== selectedKeys.length) return null;
  if (Array.from(data.entries).some((row, index) => !own(data.entries, index) || !record(row) || !ref(field(row, 'row_key')))
    || Array.from(selectedKeys).some((key, index) => !own(selectedKeys, index) || typeof key !== 'string')
    || new Set(data.entries.map(row => row.row_key)).size !== data.entries.length) return null;
  const byKey = new Map(data.entries.map(row => [row.row_key, row]));
  const selected = Array.from(selectedKeys, key => byKey.get(key));
  if (selected.some(row => !row || !eligible(row, context.mode)) || context.mode === 'missing' && !selected.length) return null;
  const refs = selected.map(row => row.entry_ref);
  if (new Set(refs).size !== refs.length) return null;
  return freeze({scopeKey: context.scopeKey, playlist_id: null, mode: context.mode, source: tuple(context.source),
    title, description, entry_refs: refs, request_key});
}

export function canSubmitCreation(state) {
  return state?.mutation?.status === 'idle' && state?.sourceResource?.status === 'ready'
    && Boolean(buildCreationRequest(state.sourceResource.data, {context: state, title: state.title,
      description: state.description, selectedKeys: state.selectedKeys, request_key: 'validation-only'}));
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
    canCreateAlbumTop: field(state, 'canCreateAlbumTop') === true,
    title: state.title, description: state.description, entries,
    retained_parent_albums: normalized.data.retained_parent_albums});
}

const idle = () => ({status: 'idle', request_key: null, data: null});
const initial = (context = {}) => freeze({scopeKey: context.scopeKey ?? null, mode: own(context, 'mode') ? context.mode : 'ordinary',
  source: context.source ?? null, canCreate: context.canCreate === true, canCreateAlbumTop: context.canCreateAlbumTop === true,
  sourceResource: resource(), mutation: idle(),
  title: '', description: '', query: '', tab: 'all', selectedKeys: [], reviewKey: null, dirty: false});
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
    seedAvailable = false, sourceReads = 0;
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
      invalidate(); sourceReads = revisionOnly ? 1 : 0; baseSelection = []; selectInitialMissing = !revisionOnly; sourcePaused = false;
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
      publish({sourceResource: resource(status), selectedKeys: [], reviewKey: null, mutation,
        dirty: Boolean(state.title || state.description)});
      return true;
    },
    async load() {
      if (disposed || sourcePaused || state.mutation.status !== 'idle') return false;
      if (!permittedContext(state)) {clearDenied('denied'); return false;}
      if (!configured()) {publish({sourceResource: resource()}); return false;}
      pendingRead?.abort();
      const request = new AbortController(), version = generation, context = state;
      pendingRead = request; baseSelection = []; seedAvailable = false; sourceReads++;
      publish({sourceResource: resource('loading'), selectedKeys: [], reviewKey: null, dirty: Boolean(state.title || state.description)});
      try {
        if (!current(version, request, 'read')) return false;
        const response = await read({scopeKey: context.scopeKey, mode: context.mode, source: freeze(tuple(context.source)), signal: request.signal});
        if (!current(version, request, 'read')) return false;
        const result = normalizeCreationResult(response, context);
        if (result.status === 'denied') {clearDenied('denied'); return false;}
        const seen = new Set();
        baseSelection = result.status === 'ready' && selectInitialMissing && state.mode === 'missing'
          ? result.data.entries.filter(row => {
            if (!eligible(row, state.mode)) return false;
            const key = row.canonical_track_ref ? `canonical:${row.canonical_track_ref}` : `entry:${row.entry_ref}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          }).map(row => row.row_key) : [];
        if (result.status === 'ready') selectInitialMissing = false;
        seedAvailable = result.status === 'ready' && sourceReads === 1 && state.mode === 'ordinary';
        publish({sourceResource: result, selectedKeys: baseSelection, reviewKey: null, dirty: Boolean(state.title || state.description)});
        return current(version, request, 'read') && result.status === 'ready';
      } catch (error) {
        if (current(version, request, 'read')) {
          if (failureStatus(error) === 'denied') clearDenied('denied');
          else publish({sourceResource: resource(failureStatus(error))});
        }
        return false;
      } finally {if (pendingRead === request) pendingRead = null;}
    },
    // Only the first complete ordinary-source admission can be seeded. The
    // caller must retain the exact read snapshot across its source checks;
    // a reload, source pause or user selection retires that one-time receipt.
    seed(entryRefs, sourceResource) {
      if (!editable() || !seedAvailable || state.mode !== 'ordinary' || state.sourceResource.status !== 'ready'
        || sourceResource !== state.sourceResource || !Array.isArray(entryRefs) || !entryRefs.length
        || Array.from(entryRefs).some(value => !opaque(value)) || new Set(entryRefs).size !== entryRefs.length) return false;
      const byRef = new Map(state.sourceResource.data.entries.map(row => [row.entry_ref, row]));
      const rows = entryRefs.map(value => byRef.get(value));
      if (rows.some(row => !row || !eligible(row, 'ordinary'))) return false;
      seedAvailable = false;
      baseSelection = rows.map(row => row.row_key);
      publish({selectedKeys: baseSelection, tab: 'selected', dirty: Boolean(state.title || state.description)});
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
      if (!editable() || typeof query !== 'string') return false;
      publish({query, tab: 'all'}); return true;
    },
    setTab(tab) {
      if (!editable() || !['all', 'selected'].includes(tab)) return false;
      publish({tab}); return true;
    },
    toggle(key) {
      if (!editable() || state.sourceResource.status !== 'ready') return false;
      const row = state.sourceResource.data.entries.find(row => row.row_key === key);
      if (!row || !eligible(row, state.mode)) return false;
      seedAvailable = false;
      const selectedKeys = state.selectedKeys.includes(key) ? state.selectedKeys.filter(value => value !== key) : [...state.selectedKeys, key];
      publish({selectedKeys, dirty: dirty(state.title, state.description, selectedKeys)}); return true;
    },
    selectVisible(selected) {
      if (!editable() || typeof selected !== 'boolean' || state.sourceResource.status !== 'ready') return false;
      seedAvailable = false;
      const visible = projectCreationState(state).entries.filter(row => eligible(row, state.mode)).map(row => row.row_key);
      const keys = new Set(state.selectedKeys);
      for (const key of visible) {if (selected) keys.add(key); else keys.delete(key);}
      const selectedKeys = [...keys];
      publish({selectedKeys, dirty: dirty(state.title, state.description, selectedKeys)}); return true;
    },
    review(key) {
      if (disposed || key !== null && (state.sourceResource.status !== 'ready'
        || !state.sourceResource.data.entries.some(row => row.row_key === key && row.source_readable === true
          && (state.mode !== 'missing' || confirmedMissingRow(row))))) return false;
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
        description: state.description, selectedKeys: state.selectedKeys, request_key});
      if (!payload) return false;
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
          if (status === 'denied') clearDenied('denied');
          if (current(version, request, 'write')) publish({mutation: {status, request_key, data: null}});
        }
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
