import {DEFAULT_PLAYLIST_FILTERS, normalizePlaylistFacts, normalizePlaylistFilters, matchesPlaylistFilters, playlistFiltersActive} from './filters.mjs';
import {normalizeCreationDescriptor} from './creation.mjs';
import {detailSelection} from '../home-friends/resource-target.mjs';

// Transient playlist presentation. The authenticated server remains the identity,
// permission and persistence owner; this module has no transport or storage.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
export const playlistDraft = (state, id = state.selectedPlaylistId) => own(state.drafts, id) ? state.drafts[id] : null;
export const playlistFilters = (state, id = state.selectedPlaylistId) => own(state.filters, id) ? state.filters[id] : defaultFilters;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const ref = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const granted = (resource, key) => own(resource?.allowed_actions, key) && resource.allowed_actions[key] === true;
const ACTIONS = ['can_open', 'can_play', 'can_edit', 'can_rename', 'can_reorder', 'can_add', 'can_share',
  'can_export', 'can_create', 'can_create_album_top', 'can_create_sample', 'can_view_details', 'can_review_matches', 'can_accept_match', 'can_save_default_sort', 'can_delete'];
const grants = source => Object.freeze(Object.fromEntries(ACTIONS.map(key => [key, own(source, key) && source[key] === true])));
const freeze = value => {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
};
const resource = (status = 'unavailable', data = null) => Object.freeze({status, data});
const idle = () => Object.freeze({status: 'idle', action: null, playlist_id: null});
const initial = scopeKey => freeze({scopeKey, resource: resource(), selectedPlaylistId: null, drafts: {}, filters: {}, mutation: idle()});
const failStatus = error => [401, 403].includes(error?.status) ? 'denied' : 'error';
const GRANT_BY_ACTION = Object.freeze({savePlaylist: 'can_edit', addTracks: 'can_add', createPlaylist: 'can_create',
  createAlbumTop: 'can_create_album_top', createSamplePlaylist: 'can_create_sample', saveSharing: 'can_share',
  setPlaylistEditor: 'can_share', saveDefaultSort: 'can_save_default_sort', deletePlaylist: 'can_delete'});

function unique(values, key) {
  if (!Array.isArray(values)) throw new TypeError('Expected playlist rows.');
  const ids = new Set();
  return Array.from(values, value => {
    if (!record(value) || !ref(value[key]) || ids.has(value[key])) throw new TypeError('Expected unique playlist identities.');
    ids.add(value[key]); return value;
  });
}
function directoryItem(value) {
  return freeze({playlist_id: value.playlist_id, title: text(value.title), description: text(value.description),
    visibility: text(value.visibility), item_count: count(value.item_count), playlist_kind: text(value.playlist_kind),
    allowed_actions: grants(value.allowed_actions)});
}
function track(value, index) {
  if (!record(value)) throw new TypeError('Invalid playlist track.');
  const itemId = ref(value.playlist_item_id);
  const readable = value.source_readable !== false && !(own(value.allowed_actions, 'can_read') && value.allowed_actions.can_read === false);
  if (!readable) return freeze({row_key: itemId ? `item:${itemId}` : `projection:${index}`, playlist_item_id: itemId,
    title: 'Unavailable track', artist: '', secondary_artist: '', album_title: '', duration_display: '',
    availability: 'unresolved', source_readable: false, allowed_actions: grants()});
  // Projection-only keys are never passed to item mutations or used as media refs.
  return freeze({row_key: itemId ? `item:${itemId}` : `projection:${index}`, playlist_item_id: itemId,
    source_readable: true, playlist_position: count(value.playlist_position),
    title: text(value.title), artist: text(value.artist), secondary_artist: text(value.secondary_artist),
    album_title: text(value.album_title), album_ref: ref(value.album_ref), track_number: count(value.track_number),
    album_target: value.album_target?.kind === 'album' ? detailSelection(value.album_target) : null,
    artist_target: value.artist_target?.kind === 'artist' ? detailSelection(value.artist_target) : null,
    disc_number: count(value.disc_number), artwork_url: text(value.artwork_url), metadata_state: ['current', 'last_known'].includes(value.metadata_state) ? value.metadata_state : 'unknown',
    duration_seconds: count(value.duration_seconds), duration_display: text(value.duration_display),
    source_ref: ref(value.source_ref), source_label: text(value.source_label), source_kind: text(value.source_kind),
    availability: ['local', 'missing', 'unresolved'].includes(value.availability) ? value.availability : 'unresolved',
    ...normalizePlaylistFacts(value), allowed_actions: grants(value.allowed_actions)});
}
export function normalizePlaylistPayload(payload) {
  if (!record(payload) || !record(payload.playlist_sidebar)) throw new TypeError('Missing playlist projection.');
  const sidebar = unique(payload.playlist_sidebar.items, 'playlist_id').map(directoryItem);
  const index = payload.playlist_index;
  const items = record(index) ? unique(index.playlists, 'playlist_id').map(directoryItem) : sidebar;
  let detail = null;
  if (own(payload, 'playlist_detail')) {
    const value = payload.playlist_detail;
    if (!record(value) || !ref(value.playlist_id) || !Array.isArray(value.track_rows)) throw new TypeError('Invalid playlist detail.');
    const rows = Array.from(value.track_rows, track), ids = rows.map(row => row.playlist_item_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate playlist items.');
    detail = freeze({...directoryItem(value), revision: ref(value.revision), track_rows: rows,
      items_complete: value.items_complete === true,
      saved_default_sort: record(value.saved_default_sort) && ['love_tier', 'play_count', 'popularity_count', 'duration'].includes(value.saved_default_sort.key)
        && ['asc', 'desc'].includes(value.saved_default_sort.direction)
        ? {key: value.saved_default_sort.key, direction: value.saved_default_sort.direction} : null,
      missing_playlist_creation_source: normalizeCreationDescriptor(own(value, 'missing_playlist_creation_source') ? value.missing_playlist_creation_source : null),
      author_order: own(value.active_sort, 'key') && value.active_sort.key === 'playlist_position'
        && own(value.active_sort, 'direction') && value.active_sort.direction === 'asc', query: text(value.query)});
  }
  if (!record(index) && !detail) throw new TypeError('Missing playlist content.');
  return freeze({items, detail, allowed_actions: grants(own(payload, 'playlist_actions') ? payload.playlist_actions : null),
    playlist_creation_source: normalizeCreationDescriptor(own(payload, 'playlist_creation_source') ? payload.playlist_creation_source : null)});
}
function readResult(value, selected) {
  const expectedEmpty = value?.status === 'empty';
  if (record(value) && own(value, 'status')) {
    if (['denied', 'unavailable'].includes(value.status)) return resource(value.status);
    if (!['ready', 'empty'].includes(value.status)) throw new TypeError('Invalid playlist status.');
    if (value.status === 'empty' && value.data === null && !selected) return resource('empty', freeze({items: [], detail: null, allowed_actions: grants()}));
    value = value.data;
  }
  const data = normalizePlaylistPayload(value);
  if (expectedEmpty && (data.items.length || data.detail?.track_rows.length)) throw new TypeError('Inconsistent empty playlist projection.');
  if (selected && data.detail?.playlist_id !== selected) return resource('unavailable', freeze({...data, detail: null}));
  if (!selected && data.detail) throw new TypeError('Unexpected playlist detail.');
  return resource(data.detail || data.items.length ? 'ready' : 'empty', data);
}
export function normalizeSharing(value) {
  if (!record(value) || !['private', 'server_shared'].includes(value.visibility) || !ref(value.revision)
    || value.next_cursor !== null && !ref(value.next_cursor)) throw new TypeError('Invalid sharing projection.');
  const sourcePeople = unique(value.people, 'account_ref');
  if (sourcePeople.some(person => person.role !== 'editor')) throw new TypeError('Invalid sharing role.');
  const people = sourcePeople.map(person => freeze({account_ref: person.account_ref,
    display_name: text(person.display_name), username_display: text(person.username_display), selected: person.selected === true, is_active: person.is_active !== false,
    role: 'editor', can_edit: own(person, 'can_edit') && person.can_edit === true}));
  return freeze({visibility: value.visibility, revision: value.revision, next_cursor: value.next_cursor, people,
    can_manage: own(value, 'can_manage') && value.can_manage === true});
}
export const defaultFilters = Object.freeze({query: '', availability: 'all', ...DEFAULT_PLAYLIST_FILTERS});
export const hasPlaylistFilters = filters => Boolean(text(filters?.query).trim() || filters?.availability && filters.availability !== 'all' || playlistFiltersActive(filters));
export function visiblePlaylistRows(detail, draft, filters = defaultFilters, now = Date.now(), factsFor = row => row) {
  if (!detail) return [];
  const positions = new Map((draft?.item_order || []).map((id, index) => [id, index]));
  const rows = positions.size ? [...detail.track_rows].sort((a, b) => (positions.get(a.playlist_item_id) ?? Infinity) - (positions.get(b.playlist_item_id) ?? Infinity)) : detail.track_rows;
  const query = text(filters.query).trim().toLocaleLowerCase();
  return rows.filter(row => (!query || [row.title, row.artist, row.secondary_artist, row.album_title].join(' ').toLocaleLowerCase().includes(query))
    && (!filters.availability || filters.availability === 'all' || row.availability === filters.availability)
    && matchesPlaylistFilters(factsFor(row), filters, now));
}
export function playlistText(rows, {missingOnly = false} = {}) {
  // Unresolved source originals belong in missing-only review. Only an explicit
  // confirmed local match is omitted; title similarity never establishes one.
  const clean = value => text(value).replace(/[\r\n\t]+/g, ' ').trim();
  return rows.filter(row => row.source_readable !== false && (!missingOnly || row.availability !== 'local')).map(row =>
    [clean(row.artist), clean(row.title)].filter(Boolean).join(' - ') + (row.album_title ? ` [${clean(row.album_title)}]` : '')).join('\n');
}
export function validMetadata(value) {
  return record(value) && own(value, 'title') && own(value, 'description') && typeof value.title === 'string'
    && Boolean(value.title.trim()) && value.title.length <= 100 && typeof value.description === 'string' && value.description.length <= 1000;
}
// Both destination-first editing and the selected-track picker use this existing
// unique-ref writer contract. This is not an occurrence or idempotency API.
export function playlistAddRequest(value) {
  return Array.isArray(value) && value.length && !Array.from(value).some(id => !ref(id))
    && new Set(value).size === value.length ? {track_refs: [...value]} : null;
}
export function playlistWriteAcknowledged(response) {
  return record(response) && (response.status === 'ready' && response.ok !== false
    || response.ok === true && !own(response, 'status'));
}
export async function dispatchPlaylistAdd(write, request) {
  const data = playlistAddRequest(request?.track_refs);
  if (!data || typeof write !== 'function') throw new TypeError('Invalid playlist Add request.');
  return write({scopeKey: request.scopeKey, playlist_id: request.playlist_id, ...data,
    ...(request.revision ? {revision: request.revision} : {}),
    ...(request.source_guard ? {source_guard: request.source_guard} : {}), signal: request.signal});
}
export function draftDirty(detail, draft) {
  return Boolean(detail && draft && (draft.title !== detail.title || draft.description !== detail.description
    || draft.item_order && draft.item_order.some((id, index) => id !== detail.track_rows[index]?.playlist_item_id)));
}

export function createPlaylistController({readPlaylists, providers = {}} = {}) {
  let configured = {...providers}, state = initial(null), disposed = false, sequence = 0, lifecycleVersion = 0, sharing = null;
  const pending = new Map(), listeners = new Set();
  const publish = patch => {if (!disposed) {state = freeze({...state, ...patch}); listeners.forEach(listener => listener());}};
  const abort = channel => {pending.get(channel)?.abort(); pending.delete(channel);};
  const abortAll = () => {sharing = null; for (const channel of [...pending.keys()]) abort(channel); sequence++;};
  const begin = channel => {abort(channel); const controller = new AbortController(); pending.set(channel, controller); return controller;};
  const current = (channel, controller, scope = state.scopeKey) => !disposed && !controller.signal.aborted && pending.get(channel) === controller && scope === state.scopeKey;
  const reader = () => typeof configured.readPlaylists === 'function' ? configured.readPlaylists : readPlaylists;
  const detail = () => state.resource.data?.detail;
  const permission = action => granted(action === 'createPlaylist' ? state.resource.data : detail(), GRANT_BY_ACTION[action]);
  const setRead = next => {
    sharing = null;
    let drafts = state.drafts;
    if (next.status === 'denied') drafts = {};
    else if (next.data?.detail) {
      const saved = next.data.detail, previous = playlistDraft(state, saved.playlist_id);
      if (previous) drafts = {...drafts, [saved.playlist_id]: {...previous,
        conflict: previous.base_title !== saved.title || previous.base_description !== saved.description
          || previous.base_revision !== saved.revision || Boolean(previous.item_order && previous.base_order.join('\0') !== saved.track_rows.map(row => row.playlist_item_id).join('\0'))}};
    }
    publish({resource: next, drafts});
  };
  async function load({afterMutation = false} = {}) {
    if (disposed || state.mutation.status === 'loading' && !afterMutation) return false;
    const read = reader(), selected = state.selectedPlaylistId;
    if (typeof read !== 'function') {setRead(resource('unavailable')); return false;}
    const request = begin('read'), scopeKey = state.scopeKey;
    publish({resource: resource('loading')});
    try {
      if (!current('read', request, scopeKey)) return false;
      const value = await read({scopeKey, playlist_id: selected, signal: request.signal});
      if (!current('read', request, scopeKey)) return false;
      setRead(readResult(value, selected)); return true;
    } catch (error) {if (current('read', request, scopeKey)) setRead(resource(failStatus(error))); return false;}
    finally {if (pending.get('read') === request) pending.delete('read');}
  }
  const controller = {
    getSnapshot: () => state,
    getLifecycleVersion: () => lifecycleVersion,
    subscribe(listener) {if (typeof listener !== 'function') throw new TypeError('Playlist subscription requires a listener.'); if (!disposed) listeners.add(listener); return () => listeners.delete(listener);},
    setScope(scopeKey) {if (!disposed && state.scopeKey !== scopeKey) {lifecycleVersion++; abortAll(); state = initial(scopeKey); listeners.forEach(listener => listener());}},
    configure(next = {}) {
      if (disposed) return;
      if (!record(next)) throw new TypeError('Playlist providers must be an object.');
      if (Object.keys({...configured, ...next}).every(key => configured[key] === next[key])) return;
      configured = {...next}; lifecycleVersion++; abortAll(); state = initial(state.scopeKey); listeners.forEach(listener => listener());
    },
    load,
    suspend() {if (!disposed) {lifecycleVersion++; abortAll(); publish({selectedPlaylistId: null, resource: resource(), mutation: idle()});}},
    accept(payload, playlistId = null) {
      if (disposed || playlistId !== null && !ref(playlistId)) return false;
      abort('read');
      // A fresh native projection may revoke access while a mutation is pending.
      abort('mutation'); abort('sharing'); sharing = null; sequence++;
      const version = sequence, scopeKey = state.scopeKey;
      publish({selectedPlaylistId: playlistId, mutation: idle()});
      if (disposed || version !== sequence || scopeKey !== state.scopeKey) return false;
      try {setRead(readResult(payload, playlistId)); return true;} catch {setRead(resource('error')); return false;}
    },
    select(playlistId, {load: shouldLoad = true, fromNavigation = false} = {}) {
      if (disposed || !fromNavigation && state.mutation.status === 'loading' || playlistId !== null && !ref(playlistId)) return false;
      if (!fromNavigation && playlistId !== null && !state.resource.data?.items.some(item => item.playlist_id === playlistId && granted(item, 'can_open'))) return false;
      if (playlistId === state.selectedPlaylistId) return true;
      abortAll(); const version = sequence, scopeKey = state.scopeKey;
      publish({selectedPlaylistId: playlistId, resource: resource('loading'), mutation: idle()});
      if (disposed || version !== sequence || scopeKey !== state.scopeKey) return false;
      if (shouldLoad) load(); return true;
    },
    available(action) {return own(GRANT_BY_ACTION, action) && permission(action) && typeof configured[action] === 'function';},
    edit(patch) {
      const value = detail();
      if (!value || !granted(value, 'can_edit') || state.mutation.status === 'loading' || !record(patch)) return false;
      const previous = playlistDraft(state, value.playlist_id) || {title: value.title, description: value.description,
        base_title: value.title, base_description: value.description, base_revision: value.revision,
        base_order: value.track_rows.map(row => row.playlist_item_id), conflict: false};
      const next = {...previous};
      if (own(patch, 'title')) {if (!granted(value, 'can_rename') || typeof patch.title !== 'string' || patch.title.length > 100) return false; next.title = patch.title;}
      if (own(patch, 'description')) {if (typeof patch.description !== 'string' || patch.description.length > 1000) return false; next.description = patch.description;}
      publish({drafts: {...state.drafts, [value.playlist_id]: next}, mutation: idle()}); return true;
    },
    reorder(itemOrder) {
      const value = detail();
      if (!value || !granted(value, 'can_edit') || !granted(value, 'can_reorder') || !value.items_complete
        || !value.author_order || hasPlaylistFilters(playlistFilters(state))
        || state.mutation.status === 'loading' || !Array.isArray(itemOrder)) return false;
      const ids = value.track_rows.map(row => row.playlist_item_id);
      if (ids.some(id => !id) || itemOrder.length !== ids.length || new Set(itemOrder).size !== ids.length || Array.from(itemOrder).some(id => !ids.includes(id))) return false;
      const version = sequence, scopeKey = state.scopeKey;
      if (!controller.edit({}) || disposed || sequence !== version || state.scopeKey !== scopeKey || detail() !== value) return false;
      publish({drafts: {...state.drafts, [value.playlist_id]: {...playlistDraft(state, value.playlist_id), item_order: [...itemOrder]}}}); return true;
    },
    discard(playlistId = state.selectedPlaylistId) {
      if (disposed || state.mutation.status === 'loading') return false;
      const drafts = {...state.drafts}; delete drafts[playlistId]; publish({drafts, mutation: idle()}); return true;
    },
    filter(patch) {
      if (disposed || !state.selectedPlaylistId || !record(patch)) return;
      const previous = playlistFilters(state);
      const next = {...normalizePlaylistFilters({...previous, ...patch}), query: own(patch, 'query') ? text(patch.query).slice(0, 200) : previous.query,
        availability: own(patch, 'availability') && ['all', 'local', 'missing', 'unresolved'].includes(patch.availability) ? patch.availability : previous.availability};
      publish({filters: {...state.filters, [state.selectedPlaylistId]: next}});
    },
    async readSharing({signal, q = '', cursor = null} = {}) {
      if (typeof configured.readSharing !== 'function') return resource();
      if (!detail() || !granted(detail(), 'can_share')) return resource('denied');
      sharing = null;
      const request = begin('sharing'), scopeKey = state.scopeKey, playlist_id = state.selectedPlaylistId;
      const cancel = () => request.abort(); signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) request.abort();
      try {
        if (!current('sharing', request, scopeKey)) return resource();
        const value = await configured.readSharing({scopeKey, playlist_id, q, cursor, signal: request.signal});
        if (!current('sharing', request, scopeKey) || playlist_id !== state.selectedPlaylistId) return resource();
        if (['denied', 'unavailable'].includes(value?.status)) return resource(value.status);
        if (own(value, 'status') && value.status !== 'ready') throw new TypeError('Invalid sharing status.');
        const data = normalizeSharing(own(value, 'status') ? value.data : value);
        sharing = {playlist_id, data};
        return resource('ready', data);
      } catch (error) {return resource(current('sharing', request, scopeKey) ? failStatus(error) : 'unavailable');}
      finally {signal?.removeEventListener('abort', cancel); if (pending.get('sharing') === request) pending.delete('sharing');}
    },
    canRetryMutation() {
      return !disposed && ['error', 'unavailable'].includes(state.mutation.status)
        && state.mutation.playlist_id === state.selectedPlaylistId
        && typeof configured.retryPlaylistOperation === 'function'
        && configured.hasPendingPlaylistOperation?.({scopeKey: state.scopeKey, playlist_id: state.mutation.playlist_id,
          action: state.mutation.action}) === true;
    },
    async retryMutation() {
      if (!controller.canRetryMutation()) return false;
      const {action, playlist_id} = state.mutation, scopeKey = state.scopeKey;
      const request = begin('mutation'), version = ++sequence;
      const active = () => current('mutation', request, scopeKey) && version === sequence;
      const result = status => publish({mutation: {status, action, playlist_id}});
      result('loading');
      try {
        const response = await configured.retryPlaylistOperation({scopeKey, playlist_id, action, signal: request.signal});
        if (!active()) return false;
        if (!playlistWriteAcknowledged(response)) throw new TypeError('Original mutation was not acknowledged.');
        if (action === 'deletePlaylist') {
          const drafts = {...state.drafts}, filters = {...state.filters}; delete drafts[playlist_id]; delete filters[playlist_id];
          publish({selectedPlaylistId: null, drafts, filters});
        }
        await load({afterMutation: true});
        if (!active()) return false;
        const latest = detail(), draft = playlistDraft(state, playlist_id);
        // A later typed edit survives recovery of an earlier committed command.
        if (latest?.playlist_id === playlist_id && draft && !draftDirty(latest, draft)) {
          const drafts = {...state.drafts}; delete drafts[playlist_id]; publish({drafts});
        }
        result('ready'); return true;
      } catch (error) {if (active()) {if (failStatus(error) === 'denied') setRead(resource('denied')); if (active()) result(failStatus(error));} return false;}
      finally {if (pending.get('mutation') === request) pending.delete('mutation');}
    },
    async mutate(action, value) {
      if (disposed || state.mutation.status === 'loading' || !own(GRANT_BY_ACTION, action)) return false;
      const playlist_id = state.selectedPlaylistId, saved = detail();
      const result = status => publish({mutation: {status, action, playlist_id}});
      if (!permission(action)) {result('denied'); return false;}
      if (typeof configured[action] !== 'function') {result('unavailable'); return false;}
      let data;
      if (action === 'savePlaylist') {
        const draft = playlistDraft(state, playlist_id);
        if (!draft || draft.conflict || !draftDirty(saved, draft) || !validMetadata(draft)
          || draft.title !== saved.title && !granted(saved, 'can_rename')
          || draft.item_order && (!granted(saved, 'can_reorder') || !saved.items_complete || !saved.author_order)) {result('error'); return false;}
        data = {title: draft.title.trim(), description: draft.description, revision: draft.base_revision,
          ...(draft.item_order ? {item_order: [...draft.item_order]} : {})};
      } else if (action === 'createPlaylist') {
        if (!validMetadata(value)) {result('error'); return false;}
        data = {title: value.title.trim(), description: value.description};
      } else if (action === 'addTracks') {
        data = playlistAddRequest(value);
        if (!data) {result('error'); return false;}
        data.revision = saved.revision;
      } else if (action === 'saveSharing' || action === 'setPlaylistEditor') {
        const currentSharing = sharing?.playlist_id === playlist_id ? sharing.data : null;
        if (!currentSharing?.can_manage) {result('denied'); return false;}
        if (currentSharing.revision !== saved.revision) {result('error'); return false;}
        if (action === 'saveSharing') {
          if (!record(value) || !['private', 'server_shared'].includes(value.visibility)) {result('error'); return false;}
          data = {visibility: value.visibility, revision: currentSharing.revision};
        } else {
          const person = currentSharing.people.find(row => row.account_ref === value?.account_ref);
          if (!person?.can_edit || typeof value?.selected !== 'boolean' || person.selected === value.selected) {result('denied'); return false;}
          data = {account_ref: person.account_ref, selected: value.selected, revision: currentSharing.revision};
        }
      } else if (action === 'saveDefaultSort') {
        if (!record(value) || value.sort !== null && (!['love_tier', 'play_count', 'popularity_count', 'duration'].includes(value.sort?.key)
          || !['asc', 'desc'].includes(value.sort.direction))) {result('error'); return false;}
        data = {sort: value.sort === null ? null : {key: value.sort.key, direction: value.sort.direction}, revision: saved.revision};
      } else if (action === 'deletePlaylist') {
        data = {revision: saved.revision};
      } else data = {};
      const write = configured[action];
      abort('read'); const request = begin('mutation'), scopeKey = state.scopeKey, version = ++sequence;
      const active = () => current('mutation', request, scopeKey) && version === sequence;
      result('loading');
      try {
        if (!active()) return false;
        const input = {scopeKey, playlist_id: action === 'createPlaylist' ? null : playlist_id, ...data, signal: request.signal};
        const response = await (action === 'addTracks' ? dispatchPlaylistAdd(write, input) : write(input));
        if (!active()) return false;
        if (['denied', 'unavailable'].includes(response?.status)) {
          if (response.status === 'denied') setRead(resource('denied'));
          if (active()) result(response.status); return false;
        }
        if (!playlistWriteAcknowledged(response)) {result('error'); return false;}
        if (action === 'savePlaylist' || ['saveDefaultSort', 'saveSharing', 'setPlaylistEditor'].includes(action)
          && playlistDraft(state, playlist_id) && !draftDirty(saved, playlistDraft(state, playlist_id))) {
          const drafts = {...state.drafts}; delete drafts[playlist_id]; publish({drafts});
        }
        if (action === 'deletePlaylist') {
          const drafts = {...state.drafts}, filters = {...state.filters}; delete drafts[playlist_id]; delete filters[playlist_id];
          publish({selectedPlaylistId: null, drafts, filters});
        }
        if (!active()) return false;
        await load({afterMutation: true});
        if (!active()) return false;
        result('ready'); return true;
      } catch (error) {
        if (active()) {if (failStatus(error) === 'denied') setRead(resource('denied')); if (active()) result(failStatus(error));}
        return false;
      } finally {if (pending.get('mutation') === request) pending.delete('mutation');}
    },
    dispose() {if (!disposed) {lifecycleVersion++; abortAll(); disposed = true; state = initial(null); listeners.clear();}},
  };
  return Object.freeze(controller);
}
