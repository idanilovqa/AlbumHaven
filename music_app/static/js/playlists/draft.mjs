import {buildCreationRequest as buildSourceCreationRequest, normalizeCreationDescriptor, normalizeCreationResult} from './creation.mjs';
import {DEFAULT_PLAYLIST_FILTERS, normalizePlaylistFilters, matchesPlaylistFilters, playlistFiltersActive} from './filters.mjs';
import {playlistText} from './model.mjs';
import {createDraftLocalMatchController} from './draft-local-match.mjs';

const buildCreationRequest = (data, options) => buildSourceCreationRequest(data, {...options,
  allowAcceptedMatches: Boolean(options.context?.draftToken)});

// A missing Playlist is a local presentation until Save is acknowledged. Only
// authenticated occurrence references cross the item-aware creation boundary.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const field = (value, key) => own(value, key) ? value[key] : undefined;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ref = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const opaque = value => ref(value) && !/[\\/]|^(?:file|https?):/i.test(value) ? value : null;
const grant = (value, key) => own(value, 'allowed_actions') && own(value.allowed_actions, key) && value.allowed_actions[key] === true;
const freeze = value => {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
};
const resource = (status = 'unavailable', data = null) => freeze({status, data});
const idle = () => ({status: 'idle', request_key: null, data: null});
const providerNames = ['readPlaylistCreationSource', 'createPlaylistFromSelection', 'reconcilePlaylistOperation',
  'retryPlaylistOperation', 'hasPendingPlaylistOperation', 'readPlaylistMatchCandidates', 'acceptPlaylistMatch'];
const providerSet = value => Object.fromEntries(providerNames.map(name => [name, typeof field(value, name) === 'function' ? value[name] : null]));
const folded = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
const tuple = source => ({kind: source.kind, ref: source.ref, revision: source.revision});
const sameSource = (left, right) => left?.kind === right?.kind && left?.ref === right?.ref && left?.revision === right?.revision;
const eligible = row => row.source_readable === true && opaque(row.entry_ref)
  && grant(row, 'can_read') && grant(row, 'can_select') && (row.availability !== 'local' || row.match_state === 'accepted');
const sourceContext = value => ({scopeKey: ref(field(value, 'scopeKey')), mode: 'missing',
  source: normalizeCreationDescriptor(field(value, 'source')), canCreate: field(value, 'canCreate') === true,
  canCreateAlbumTop: field(value, 'canCreateAlbumTop') === true});
const authorized = state => Boolean(state.canCreate && state.scopeKey && state.source?.kind === 'playlist');
const ready = state => authorized(state) && state.sourceResource?.status === 'ready';
const failure = value => [401, 403, 'denied'].includes(value?.status) ? 'denied'
  : [409, 'conflict'].includes(value?.status) ? 'conflict' : value?.status === 'unavailable' ? 'unavailable' : 'error';
const defaults = () => ({query: '', availability: 'all', ...DEFAULT_PLAYLIST_FILTERS});
const empty = () => freeze({draftToken: null, scopeKey: null, mode: 'missing', source: null, canCreate: false,
  canCreateAlbumTop: false, sourceResource: resource(), title: '', description: '', entries: [], retained_parent_albums: [],
  selectedKeys: [], query: '', filters: defaults(), mutation: idle(), dirty: false});

function preparedState(prepared) {
  const context = sourceContext(prepared);
  if (!record(prepared) || field(prepared, 'mode') !== 'missing' || !opaque(field(prepared, 'draftToken')) || !authorized(context)
    || !Array.isArray(field(prepared, 'entries'))) return null;
  const data = {scopeKey: context.scopeKey, mode: 'missing', source: tuple(context.source),
    ...(prepared.source_protocol ? {source_protocol: prepared.source_protocol} : {}),
    allowed_actions: context.source.allowed_actions, entries_complete: true,
    entries: prepared.entries.map(row => record(row) ? {...row, added_at: row.added_at_ms, last_listened_at: row.last_listened_at_ms} : row),
    retained_parent_albums: field(prepared, 'retained_parent_albums') ?? []};
  const normalized = normalizeCreationResult({status: 'ready', data}, context);
  if (normalized.status !== 'ready') return null;
  const entries = normalized.data.entries;
  if (!buildCreationRequest(normalized.data, {context, title: field(prepared, 'title'), description: field(prepared, 'description'),
    selectedKeys: entries.map(row => row.row_key), request_key: 'validation-only'})) return null;
  return freeze({...empty(), ...context, draftToken: prepared.draftToken, title: prepared.title, description: prepared.description,
    sourceResource: normalized, entries, retained_parent_albums: normalized.data.retained_parent_albums});
}

export function projectMissingPlaylistDraft(state, now = Date.now()) {
  const authoredEntries = ready(state) ? state.entries.filter(eligible) : [];
  const query = folded(state.query), selected = new Set(state.selectedKeys || []), filters = state.filters || defaults();
  const entries = authoredEntries.filter(row => (!query || folded([row.title, row.artist, row.album_title].join(' ')).includes(query))
    && (filters.availability === 'all' || filters.availability === row.availability) && matchesPlaylistFilters(row, filters, now));
  const selectedEntries = authoredEntries.filter(row => selected.has(row.row_key));
  const unfiltered = !query && filters.availability === 'all' && !playlistFiltersActive(filters);
  return freeze({entries, authoredEntries, selectedEntries, selectedCount: selectedEntries.length,
    visibleSelectedCount: entries.filter(row => selected.has(row.row_key)).length, unfiltered,
    canEdit: ready(state) && state.mutation.status === 'idle',
    canReorder: ready(state) && state.mutation.status === 'idle' && unfiltered && authoredEntries.length > 1});
}

export function missingPlaylistDraftText(state) {
  return playlistText(projectMissingPlaylistDraft(state).authoredEntries, {missingOnly: true});
}

export function missingPlaylistDraftTopIntent(state) {
  if (!ready(state) || state.canCreateAlbumTop !== true || state.mutation.status !== 'idle') return null;
  const entries = state.entries.filter(eligible), seen = new Set(), album_refs = [];
  for (const row of entries) {
    const parent = row.parent_album;
    if (parent?.state !== 'known' || !opaque(parent.album_ref) || !grant(parent, 'can_read')) continue;
    // Retained evidence can authorize a supplied known parent. It never supplies
    // a guessed parent for an unresolved original or a removed occurrence.
    const evidence = [parent, ...state.retained_parent_albums.filter(value => value.album_ref === parent.album_ref
      && (value.entry_refs === null || value.entry_refs.includes(row.entry_ref)))];
    if (!evidence.some(value => grant(value, 'can_read') && grant(value, 'can_create_album_top')) || seen.has(parent.album_ref)) continue;
    seen.add(parent.album_ref); album_refs.push(parent.album_ref);
  }
  return album_refs.length ? freeze({scopeKey: state.scopeKey, source: tuple(state.source), album_refs}) : null;
}

export function createMissingPlaylistDraftController({prepared, providers = {}} = {}) {
  let state = preparedState(prepared) || empty(), supplied = providerSet(providers), disposed = false, retired = !state.draftToken;
  let version = 0, pendingRead = null, pendingWrite = null, sourcePaused = false, submittedRequest = null;
  let authoredRefs = state.entries.map(row => row.entry_ref);
  const listeners = new Set();
  const publish = patch => {
    if (disposed) return;
    state = freeze({...state, ...patch});
    for (const listener of [...listeners]) if (!disposed && listeners.has(listener)) listener();
  };
  const invalidate = () => {version++; pendingRead?.abort(); pendingWrite?.abort(); pendingRead = null; pendingWrite = null;};
  const active = (generation, request, channel) => !disposed && !retired && generation === version && !request.signal.aborted
    && (channel === 'read' ? pendingRead : pendingWrite) === request;
  const editable = () => !disposed && !retired && ready(state) && state.mutation.status === 'idle';
  const uncertainMutation = () => state.mutation.status === 'loading' ? {...state.mutation, status: 'error'} : state.mutation;
  const clear = (status = 'denied', mutation = idle()) => {
    invalidate(); retired = true; sourcePaused = false; authoredRefs = []; submittedRequest = null;
    publish({...empty(), sourceResource: resource(status), mutation});
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Draft subscription requires a listener.');
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext(value = {}) {
      if (disposed || retired) return false;
      const next = sourceContext(value);
      if (!authorized(next) || state.scopeKey !== next.scopeKey || state.source?.kind !== next.source?.kind || state.source?.ref !== next.source?.ref) {
        clear('denied'); return true;
      }
      if (!sameSource(state.source, next.source)) {
        const mutation = uncertainMutation(); invalidate(); sourcePaused = false;
        publish({...next, entries: [], retained_parent_albums: [], selectedKeys: [], sourceResource: resource('conflict'), mutation}); return true;
      }
      if (sourcePaused) {
        sourcePaused = false; publish({...next, sourceResource: resource('refresh_required')}); return true;
      }
      if (state.canCreateAlbumTop !== next.canCreateAlbumTop) {publish({canCreateAlbumTop: next.canCreateAlbumTop}); return true;}
      return false;
    },
    configure(next = {}) {
      if (disposed || retired) return false;
      const replacement = providerSet(next);
      if (providerNames.every(name => supplied[name] === replacement[name])) return false;
      supplied = replacement; clear('unavailable'); return true;
    },
    pauseSource(status = 'loading') {
      if (disposed || retired || !['loading', 'error', 'unavailable', 'refresh_required'].includes(status)
        || sourcePaused && state.sourceResource.status === status) return false;
      const mutation = uncertainMutation(); invalidate(); sourcePaused = true;
      publish({entries: [], retained_parent_albums: [], selectedKeys: [], sourceResource: resource(status), mutation}); return true;
    },
    async refresh() {
      const read = field(supplied, 'readPlaylistCreationSource');
      if (disposed || retired || sourcePaused || !authorized(state) || state.mutation.request_key || typeof read !== 'function') return false;
      pendingRead?.abort();
      const request = new AbortController(), generation = version, context = state;
      pendingRead = request;
      publish({entries: [], retained_parent_albums: [], selectedKeys: [], sourceResource: resource('loading')});
      try {
        if (!active(generation, request, 'read')) return false;
        const response = await read({scopeKey: context.scopeKey, mode: 'missing', source: freeze(tuple(context.source)), retain_capture: true, signal: request.signal});
        if (!active(generation, request, 'read')) return false;
        const normalized = normalizeCreationResult(response, context);
        if (normalized.status === 'denied') {clear('denied'); return false;}
        if (normalized.status !== 'ready') {publish({sourceResource: normalized}); return false;}
        const byRef = new Map(normalized.data.entries.filter(eligible).map(row => [row.entry_ref, row]));
        const entries = authoredRefs.map(entryRef => byRef.get(entryRef)).filter(Boolean);
        authoredRefs = entries.map(row => row.entry_ref);
        publish({sourceResource: normalized, entries, retained_parent_albums: normalized.data.retained_parent_albums});
        return active(generation, request, 'read');
      } catch (error) {
        if (active(generation, request, 'read')) {
          const status = failure(error);
          if (status === 'denied') clear(status); else publish({sourceResource: resource(status)});
        }
        return false;
      } finally {if (pendingRead === request) pendingRead = null;}
    },
    edit(patch) {
      if (!editable() || !record(patch)) return false;
      const title = own(patch, 'title') ? patch.title : state.title, description = own(patch, 'description') ? patch.description : state.description;
      if (typeof title !== 'string' || title.length > 100 || typeof description !== 'string' || description.length > 1000) return false;
      publish({title, description, dirty: true}); return true;
    },
    setQuery(query) {
      if (!editable() || typeof query !== 'string') return false;
      publish({query}); return true;
    },
    setFilters(patch) {
      if (!editable() || !record(patch)) return false;
      const merged = {...state.filters, ...patch};
      const availability = ['all', 'local', 'missing', 'unresolved'].includes(merged.availability) ? merged.availability : 'all';
      publish({filters: {...normalizePlaylistFilters(merged), availability}}); return true;
    },
    select(key) {
      if (!editable() || key !== null && !state.entries.some(row => row.row_key === key && eligible(row))) return false;
      publish({selectedKeys: key === null ? [] : [key]}); return true;
    },
    toggle(key) {
      if (!editable() || !state.entries.some(row => row.row_key === key && eligible(row))) return false;
      publish({selectedKeys: state.selectedKeys.includes(key) ? state.selectedKeys.filter(value => value !== key) : [...state.selectedKeys, key]}); return true;
    },
    selectVisible(selected) {
      if (!editable() || typeof selected !== 'boolean') return false;
      const keys = new Set(state.selectedKeys);
      for (const row of projectMissingPlaylistDraft(state).entries) {if (selected) keys.add(row.row_key); else keys.delete(row.row_key);}
      publish({selectedKeys: [...keys]}); return true;
    },
    remove(keys = state.selectedKeys) {
      if (!editable()) return false;
      const requested = typeof keys === 'string' ? [keys] : keys;
      if (!Array.isArray(requested) || !requested.length || Array.from(requested).some(key => !state.entries.some(row => row.row_key === key))) return false;
      const removed = new Set(requested), entries = state.entries.filter(row => !removed.has(row.row_key));
      authoredRefs = entries.map(row => row.entry_ref);
      publish({entries, selectedKeys: state.selectedKeys.filter(key => !removed.has(key)), dirty: true}); return true;
    },
    reorder(keys) {
      if (!editable() || !projectMissingPlaylistDraft(state).canReorder || !Array.isArray(keys) || keys.length !== state.entries.length
        || new Set(keys).size !== keys.length) return false;
      const byKey = new Map(state.entries.map(row => [row.row_key, row]));
      const entries = Array.from(keys, key => byKey.get(key));
      if (entries.some(row => !row)) return false;
      authoredRefs = entries.map(row => row.entry_ref);
      publish({entries, dirty: true}); return true;
    },
    exportText: () => disposed || retired ? '' : missingPlaylistDraftText(state),
    topIntent: () => disposed || retired ? null : missingPlaylistDraftTopIntent(state),
    canSave() {
      return editable() && !controller.localMatch.blocking() && typeof field(supplied, 'createPlaylistFromSelection') === 'function'
        && Boolean(buildCreationRequest(state.sourceResource.data, {context: state, title: state.title, description: state.description,
          selectedKeys: state.entries.map(row => row.row_key), request_key: 'validation-only'}));
    },
    async save() {
      if (!controller.canSave()) return false;
      if (typeof globalThis.crypto?.randomUUID !== 'function') {
        publish({mutation: {status: 'unavailable', request_key: null, data: null}}); return false;
      }
      const request_key = globalThis.crypto.randomUUID();
      const payload = buildCreationRequest(state.sourceResource.data, {context: state, title: state.title, description: state.description,
        selectedKeys: state.entries.map(row => row.row_key), request_key});
      if (!payload) return false;
      submittedRequest = payload;
      pendingRead?.abort(); pendingRead = null;
      const request = new AbortController(), generation = version; pendingWrite = request;
      publish({mutation: {status: 'loading', request_key, data: null}});
      try {
        if (!active(generation, request, 'write')) return false;
        const response = await supplied.createPlaylistFromSelection({...payload, signal: request.signal});
        if (!active(generation, request, 'write')) return false;
        const value = field(response, 'data');
        const acknowledged = field(response, 'status') === 'ready' && field(response, 'ok') !== false && record(value)
          && field(value, 'scopeKey') === payload.scopeKey && field(value, 'request_key') === request_key
          && opaque(field(value, 'playlist_id')) && value.playlist_id !== state.draftToken && ref(field(value, 'revision'));
        const data = acknowledged ? freeze({scopeKey: value.scopeKey, request_key, playlist_id: value.playlist_id, revision: value.revision}) : null;
        if (!data && failure(response) === 'denied') {clear('denied', {status: 'denied', request_key, data: null}); return false;}
        publish({mutation: {status: data ? 'ready' : failure(response), request_key, data}});
        return active(generation, request, 'write') ? data || false : false;
      } catch (error) {
        if (active(generation, request, 'write')) {
          const status = failure(error);
          if (status === 'denied') clear('denied', {status, request_key, data: null});
          else publish({mutation: {status, request_key, data: null}});
        }
        return false;
      } finally {if (pendingWrite === request) pendingWrite = null;}
    },
    canReconcile() {
      return !disposed && !retired && Boolean(submittedRequest) && !pendingWrite
        && ['error', 'conflict', 'unavailable'].includes(state.mutation.status) && typeof supplied.reconcilePlaylistOperation === 'function';
    },
    canRetryOriginal() {
      return controller.canReconcile() && typeof supplied.retryPlaylistOperation === 'function'
        && supplied.hasPendingPlaylistOperation?.({...submittedRequest, action: 'create'}) === true;
    },
    async reconcile({retry = false} = {}) {
      if (!controller.canReconcile() || retry && !controller.canRetryOriginal()) return false;
      const payload = submittedRequest, request_key = payload.request_key;
      const request = new AbortController(), generation = version; pendingWrite = request;
      publish({mutation: {status: 'loading', request_key, data: null}});
      try {
        if (!active(generation, request, 'write')) return false;
        const response = await supplied[retry ? 'retryPlaylistOperation' : 'reconcilePlaylistOperation']({...payload, action: 'create', signal: request.signal});
        if (!active(generation, request, 'write')) return false;
        const value = response?.data;
        const acknowledged = response?.status === 'ready' && response.ok !== false && record(value)
          && value.scopeKey === payload.scopeKey && value.request_key === request_key
          && opaque(value.playlist_id) && value.playlist_id !== state.draftToken && ref(value.revision);
        const data = acknowledged ? freeze({scopeKey: value.scopeKey, request_key, playlist_id: value.playlist_id, revision: value.revision}) : null;
        publish({mutation: {status: data ? 'ready' : 'error', request_key, data}});
        return data || false;
      } catch (error) {
        if (active(generation, request, 'write')) {
          const status = failure(error);
          if (status === 'denied') clear('denied', {status, request_key, data: null});
          else publish({mutation: {status, request_key, data: null}});
        }
        return false;
      } finally {if (pendingWrite === request) pendingWrite = null;}
    },
    dispose() {
      if (disposed) return;
      controller.localMatch.dispose();
      invalidate(); disposed = true; retired = true; authoredRefs = []; state = empty(); supplied = {}; listeners.clear();
    },
  };
  controller.localMatch = createDraftLocalMatchController({draft: controller, providers: () => supplied, deny: () => clear('denied'),
    apply(response, original) {
      const value = response?.data, entry = value?.entry;
      if (!editable() || response?.status !== 'ready' || value?.scopeKey !== state.scopeKey || !sameSource(value.source, state.source)
        || value.entry_ref !== original.entry_ref || state.entries.find(row => row.row_key === original.row_key) !== original
        || !entry || entry.availability !== 'local' || entry.match_state !== 'accepted' || !eligible(entry)) return false;
      // Acceptance may change only the local-resolution facts. Original title,
      // artist, album and all other normalized source facts remain unchanged.
      const fields = Object.keys(original).filter(key => !['availability', 'match_state'].includes(key));
      if (fields.some(key => JSON.stringify(entry[key]) !== JSON.stringify(original[key]))
        || Object.keys(entry).some(key => !Object.hasOwn(original, key) && key !== 'match_state')) {
        // A fresh authority check can redact a formerly readable parent. Do not
        // keep stale source facts visible or replace originals with match data.
        invalidate();
        publish({entries: [], retained_parent_albums: [], selectedKeys: [], sourceResource: resource('conflict')});
        return false;
      }
      const matched = freeze({...original, availability: 'local', match_state: 'accepted'});
      const replace = row => row === original || row.row_key === original.row_key ? matched : row;
      publish({entries: state.entries.map(replace), sourceResource: resource('ready', {...state.sourceResource.data,
        entries: state.sourceResource.data.entries.map(replace)}), dirty: true});
      return true;
    }});
  return Object.freeze(controller);
}
