import {queueOccurrences} from './queue-provenance.mjs';
// Authenticated transport adapter. Actor/context evidence and inventory links
// remain private here; components receive only lifecycle-scoped projections.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const inventory = value => typeof value === 'string' && /^inventory-track:[1-9][0-9]*:[1-9][0-9]*$/.test(value);
// A denial is evidence only for the exact capture invocation which observed it.
// Recovery, identity checks and subsequent source projection cannot forge it.
const queueCaptureDenials = new WeakMap();
export function isQueueSourceCaptureDenial(error, token) {
  return typeof token === 'symbol' && error !== null && typeof error === 'object' && queueCaptureDenials.get(error) === token;
}
const granted = value => value?.allowed_actions?.can_read === true && value?.allowed_actions?.can_use_for_playlist === true;
const fail = (message, status = 409) => Object.assign(new Error(message), {status});
const aborted = () => Object.assign(new Error('Playlist request superseded.'), {name: 'AbortError'});
const tuple = source => ({kind: source.kind, ref: source.ref, revision: source.revision});
const same = (a, b) => a?.kind === b?.kind && a?.ref === b?.ref && a?.revision === b?.revision;
const sourceProtocols = new Set(['library_selection_v1', 'complete_inventory_selection_v1', 'complete_activity_selection_v1', 'missing_playlist_selection_v1']);
const visibilityModes = ['private', 'server_shared'];
function preferences(value) {
  if (typeof value?.remember_order_mode !== 'boolean' || !['regular', 'shuffle'].includes(value.last_order_mode)
    || value.effective_order_mode !== (value.remember_order_mode ? value.last_order_mode : 'regular') || !revision(value.revision)) throw fail('Invalid Playlist preferences.');
  return {remember_order_mode: value.remember_order_mode, last_order_mode: value.last_order_mode,
    effective_order_mode: value.effective_order_mode, revision: value.revision};
}

export function createPlaylistBackendProviders({transport, runtime} = {}) {
  let owner = null, actor = null, ordinary = null, ordinaryExpiresAt = 0, disposed = false;
  const sources = new Map(), revisions = new Map(), operations = new Map(), uncertain = new Map(), sharing = new Map();
  function clear() {owner = null; actor = null; ordinary = null; ordinaryExpiresAt = 0; sources.clear(); revisions.clear(); operations.clear(); uncertain.clear(); sharing.clear();}
  const unsubscribe = transport.subscribe?.(clear);
  const acceptsScope = scopeKey => typeof runtime.acceptsPrivateScope === 'function'
    ? runtime.acceptsPrivateScope(scopeKey) === true : typeof runtime.snapshot === 'function' && runtime.snapshot().scopeKey === scopeKey;
  const owns = token => owner === JSON.parse(token)[0];
  function identity(scopeKey) {
    if (disposed || typeof scopeKey !== 'string' || !scopeKey || !acceptsScope(scopeKey)) throw fail('Playlist context unavailable.', 403);
    const context = transport.context();
    if (!context) throw fail('Playlist context unavailable.', 403);
    if (context !== owner) {clear(); owner = context;}
    return JSON.stringify([context, scopeKey]);
  }
  function active(token, signal) {
    const [context, scopeKey] = JSON.parse(token);
    if (signal?.aborted || owner !== context || context !== transport.context() || !acceptsScope(scopeKey)) throw aborted();
  }
  function acceptActor(value) {
    if (!Number.isSafeInteger(value?.account_id) || value.account_id < 1 || !Number.isSafeInteger(value.library_id) || value.library_id < 1) throw fail('Invalid Playlist actor.');
    if (actor && (actor.account_id !== value.account_id || actor.library_id !== value.library_id)) throw fail('Playlist actor changed.', 403);
    actor = {account_id: value.account_id, library_id: value.library_id};
  }
  function sourceData(response, token, signal, expected = null) {
    active(token, signal);
    const data = response?.data;
    const missing = data?.source_protocol === 'missing_playlist_selection_v1';
    const kind = missing ? 'playlist' : data?.source_protocol === 'complete_activity_selection_v1' ? 'activity' : 'library';
    if (response?.status !== 'ready' || !sourceProtocols.has(data?.source_protocol) || data.mode !== (missing ? 'missing' : 'ordinary')
      || data.source?.kind !== kind || !uuid(data.source.ref)
      || !(missing ? revision(data.source.revision) : uuid(data.source.revision)) || !granted(data)
      || expected && !same(data.source, expected)) throw fail('Playlist source was not acknowledged.');
    acceptActor(data.actor_scope);
    sources.set(data.source.ref, {source: tuple(data.source), protocol: data.source_protocol,
      ...(missing && uuid(data.capture_ref) ? {capture_ref: data.capture_ref} : {})});
    return data;
  }
  function descriptor(data) {return {...tuple(data.source), source_protocol: data.source_protocol, allowed_actions: {...data.allowed_actions}};}
  function projection(data, scopeKey) {
    const {actor_scope, context_ref, capture_ref, ...safe} = data;
    return {...safe, scopeKey, ...(Array.isArray(data.entries) ? {entries: data.entries.map(({inventory_track_ref, ...row}) => row)} : {})};
  }
  async function begin(options) {
    const token = identity(options.scopeKey);
    active(token, options.signal);
    // Directory refresh and an open draft retain their exact source. Only a
    // deliberate new opening may replace an expired source, after resolving
    // any uncertain Create still owned by that source.
    const opening = options.renewExpired === true;
    const recovered = opening ? await recoverCreate(options) : null;
    active(token, options.signal);
    // The caller confirms the old receipt before presenting another empty form.
    if (recovered) return {...ordinary, recovered_creation: recovered};
    const renew = opening && ordinary && ordinaryExpiresAt <= Date.now();
    if (ordinary && !renew) return ordinary;
    const response = await transport.request('/playlists/creation-source/current', {signal: options.signal, expected: JSON.parse(token)[0]});
    const data = sourceData(response, token, options.signal);
    const expiresAt = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (data.source_protocol !== 'library_selection_v1' || data.page_size !== 100 || data.max_selected_entries !== 5000
      || data.max_command_bytes !== 524288 || !Number.isFinite(expiresAt)) throw fail('Unsupported Playlist source.');
    ordinary = descriptor(data); ordinaryExpiresAt = expiresAt; return ordinary;
  }
  function rememberRevisions(payload) {
    for (const row of [...(payload?.playlist_index?.playlists || []), ...(payload?.destinations || []), ...(payload?.playlist_detail ? [payload.playlist_detail] : [])]) {
      if (uuid(row.playlist_id) && revision(row.revision)) revisions.set(row.playlist_id, row.revision);
    }
  }
  function receipt(value, operation) {
    if (operation.action === 'playlist_preferences') {
      if (value?.ok !== true || value.action !== operation.action || value.request_key !== operation.key || typeof value.changed !== 'boolean') throw fail('Playlist preferences were not acknowledged.');
      return {ok: true, action: value.action, request_key: value.request_key, changed: value.changed,
        preferences: preferences(value.preferences), scopeKey: operation.scopeKey};
    }
    if (value?.ok !== true || value.action !== operation.action || value.request_key !== operation.key || !uuid(value.playlist_id)
      || (operation.action === 'copy' ? value.source_playlist_id !== operation.playlist_id || value.playlist_id === operation.playlist_id
        : operation.playlist_id && value.playlist_id !== operation.playlist_id) || !revision(value.revision) || typeof value.changed !== 'boolean'
      || !actor || value.actor_scope?.account_id !== actor.account_id || value.actor_scope?.library_id !== actor.library_id) throw fail('Playlist mutation was not acknowledged.');
    revisions.set(value.playlist_id, value.revision);
    const {actor_scope, context_ref, ...safe} = value;
    return {...safe, scopeKey: operation.scopeKey};
  }
  function result(value, operation, scopeKey = operation.scopeKey) {
    const scoped = {...value, scopeKey};
    return operation.action === 'create' ? {status: 'ready', data: scoped} : scoped;
  }
  async function reconcile(operation, signal, scopeKey = operation.scopeKey) {
    const token = JSON.stringify([JSON.parse(operation.owner)[0], scopeKey]);
    active(token, signal);
    const base = operation.action === 'playlist_preferences' ? '/account/playlist-preferences/operations' : '/playlists/operations';
    const response = await transport.request(`${base}/${encodeURIComponent(operation.key)}`, {signal});
    active(token, signal);
    if (response.status === 'unknown') throw fail('Playlist result is still unknown. Check again before trying another change.', 'unknown');
    if (response.status !== 'committed') throw fail('The original request status could not be verified.', 502);
    const acknowledged = receipt(response.receipt, operation);
    operation.receipt = acknowledged; uncertain.delete(operation.target);
    return result(acknowledged, operation, scopeKey);
  }
  async function recoverCreate(options) {
    const token = identity(options.scopeKey);
    active(token, options.signal);
    const pending = [...uncertain.values()].find(operation => operation.action === 'create');
    if (!pending) return null;
    const response = await reconcile(pending, options.signal, options.scopeKey);
    active(token, options.signal); return response.data;
  }
  function pendingOperation(options) {
    const aliases = {savePlaylist: ['save'], addTracks: ['add'], saveSharing: ['visibility'],
      setPlaylistEditor: ['grant_editor', 'revoke_editor'], saveDefaultSort: ['default_sort'], deletePlaylist: ['delete'],
      requestEditAccess: ['request_edit'], decideEditRequest: ['decide_edit_request'], copyPlaylist: ['copy'],
      create: ['create'], playlist_preferences: ['playlist_preferences']};
    const actions = aliases[options.action] || [options.action];
    return [...uncertain.values()].find(operation => (options.request_key ? operation.key === options.request_key
      : actions.includes(operation.action) && (operation.action === 'create' || operation.action === 'playlist_preferences'
        || operation.playlist_id === options.playlist_id))) || null;
  }
  async function retryOriginal(options) {
    const token = identity(options.scopeKey), operation = pendingOperation(options);
    if (!operation || !operation.command) throw fail('No uncertain original request is available.', 409);
    if (operation.retrying) throw fail('The original request is already being checked.', 409);
    operation.retrying = true;
    try {
    try {
      const acknowledged = await reconcile(operation, options.signal, options.scopeKey);
      if (operation.action === 'playlist_preferences') runtime.acceptPlaylistPreferences?.(acknowledged);
      return acknowledged;
    }
    catch (error) {if (error?.status !== 'unknown') throw error;}
    active(token, options.signal);
    // Only this explicitly invoked UI action may resend. The immutable original
    // bytes/key are reused after a fresh authoritative unknown check.
    const command = operation.command;
    try {
      const response = await transport.request(command.path, {method: command.method,
        body: JSON.parse(command.body), signal: options.signal, expected: JSON.parse(token)[0]});
      active(token, options.signal);
      const value = receipt(operation.action === 'create' ? response?.status === 'ready' ? response.data : null : response, operation);
      operation.receipt = value; uncertain.delete(operation.target);
      const acknowledged = result(value, operation, options.scopeKey);
      if (operation.action === 'playlist_preferences') runtime.acceptPlaylistPreferences?.(acknowledged);
      return acknowledged;
    } catch (error) {
      if (owns(token) && error?.responseRejected === true && typeof error.status === 'number' && error.status < 500) uncertain.delete(operation.target);
      throw error;
    }
    } finally {operation.retrying = false;}
  }
  async function mutate(action, options, path, method, fields) {
    const account = action === 'playlist_preferences';
    const token = identity(options.scopeKey), target = account ? 'account:playlist-preferences' : action === 'create' ? `create:${options.source?.ref}` : options.playlist_id;
    active(token, options.signal);
    const semantic = JSON.stringify([path, fields]);
    const unresolved = action === 'create' ? [...uncertain.values()].find(operation => operation.action === 'create') : uncertain.get(target);
    if (unresolved) {
      const resolved = await reconcile(unresolved, options.signal, options.scopeKey);
      // Reconciliation reports the original command only, never an unrelated edit.
      if (unresolved.action !== action || unresolved.semantic !== semantic
        || options.request_key && options.request_key !== unresolved.key) throw fail('Previous Playlist change confirmed. Refresh before changing it again.');
      return resolved;
    }
    const key = options.request_key ?? globalThis.crypto?.randomUUID?.();
    if (!uuid(key) || action !== 'create' && (!account && !uuid(options.playlist_id) || !revision(fields.revision)) || !account && !actor) throw fail('Refresh the Playlist before changing it.');
    if (operations.has(key)) {
      const prior = operations.get(key);
      if (prior.action !== action || prior.target !== target || prior.semantic !== semantic) throw fail('Playlist request key already used.');
      return prior.receipt ? result(prior.receipt, prior, options.scopeKey) : reconcile(prior, options.signal, options.scopeKey);
    }
    const operation = {key, action, playlist_id: options.playlist_id, target, scopeKey: options.scopeKey,
      owner: token, semantic, receipt: null};
    operations.set(key, operation);
    const body = {...fields, request_key: key};
    operation.command = Object.freeze({path, method, body: JSON.stringify(body)});
    if (new TextEncoder().encode(JSON.stringify(body)).length > 524288) throw fail('Playlist command is too large.', 413);
    uncertain.set(target, operation);
    try {
      const response = await transport.request(path, {method, body, signal: options.signal, expected: JSON.parse(token)[0]});
      active(token, options.signal);
      const value = receipt(action === 'create' ? response?.status === 'ready' ? response.data : null : response, operation);
      operation.receipt = value; uncertain.delete(target); return result(value, operation);
    } catch (error) {
      if (!owns(token)) throw error;
      if (action === 'create' && same(ordinary, options.source) && error?.code === 'source_expired') ordinaryExpiresAt = 0;
      // A definite structured rejection cannot have committed. Network failure,
      // abort or an invalid successful acknowledgement remains ambiguous.
      if (error?.responseRejected === true && typeof error.status === 'number' && error.status < 500) {
        uncertain.delete(target); throw error;
      }
      uncertain.set(target, operation);
      if (options.signal?.aborted) throw error;
      return reconcile(operation, options.signal, options.scopeKey);
    }
  }
  return Object.freeze({
    hasPendingPlaylistOperation(options) {try {identity(options.scopeKey); return Boolean(pendingOperation(options));} catch {return false;}},
    retryPlaylistOperation: retryOriginal,
    dispose() {disposed = true; unsubscribe?.(); clear();},
    async readPlaylists(options) {
      const token = identity(options.scopeKey), payload = await runtime.readPlaylists(options);
      active(token, options.signal); rememberRevisions(payload);
      const destinations = await transport.request('/playlists/destinations', {signal: options.signal});
      active(token, options.signal);
      if (!['ready', 'empty'].includes(destinations.status) || !Array.isArray(destinations.data?.destinations)) throw fail('Invalid Playlist destinations.');
      acceptActor(destinations.data.actor_scope); rememberRevisions(destinations.data);
      if (payload?.playlist_actions?.can_create !== true || payload.playlist_creation_protocol !== 'library_selection_v1') return payload;
      const source = await begin(options); active(token, options.signal);
      return {...payload, playlist_creation_source: source};
    },
    async readPlaylistDestinations(options) {
      const token = identity(options.scopeKey), response = await transport.request('/playlists/destinations', {signal: options.signal});
      active(token, options.signal);
      if (!['ready', 'empty'].includes(response.status) || !Array.isArray(response.data?.destinations)) throw fail('Invalid Playlist destinations.');
      acceptActor(response.data.actor_scope); rememberRevisions(response.data);
      return {status: response.status, data: projection(response.data, options.scopeKey)};
    },
    beginPlaylistCreationSource: begin,
    recoverPlaylistCreation: recoverCreate,
    async beginPlaylistSelectionSource(options) {
      const token = identity(options.scopeKey), refs = options.track_refs;
      if (!Array.isArray(refs) || !refs.length || refs.length > 5000 || refs.some(value => !inventory(value)) || new Set(refs).size !== refs.length) throw fail('This selection cannot be added.', 400);
      const recovered = await recoverCreate(options);
      if (recovered) return {recovered_creation: recovered};
      active(token, options.signal);
      const response = await transport.request('/playlists/creation-source/selection', {method: 'POST', body: {track_refs: refs}, signal: options.signal, expected: JSON.parse(token)[0]});
      const data = sourceData(response, token, options.signal);
      if (data.source_protocol !== 'complete_inventory_selection_v1' || data.entries_complete !== true || !Array.isArray(data.entries)
        || data.entries.length !== refs.length || data.entries.some((row, index) => row.inventory_track_ref !== refs[index])) throw fail('Selected Playlist source changed.');
      return {source: descriptor(data), entry_refs: data.entries.map(row => row.entry_ref)};
    },
    async beginPlaylistQueueSource(options) {
      const token = identity(options.scopeKey), occurrences = queueOccurrences(options.occurrences);
      if (!occurrences) throw fail('This Queue selection cannot be added.', 400);
      if (options.recoverCreate === true) {
        const recovered = await recoverCreate(options);
        if (recovered) return {recovered_creation: recovered};
      }
      active(token, options.signal);
      const refs = [...new Set(occurrences.map(item => item.track_ref))];
      let response;
      try {
        response = await transport.request('/playlists/creation-source/queue', {method: 'POST', body: {occurrences}, signal: options.signal, expected: JSON.parse(token)[0]});
      } catch (error) {
        active(token, options.signal);
        if ([403, 404].includes(error?.status) && typeof options.source_capture_token === 'symbol') {
          const denial = Object.assign(new Error(error.message || 'Queue source access denied.'),
            {status: error.status, code: error.code, responseRejected: error.responseRejected, cause: error});
          queueCaptureDenials.set(denial, options.source_capture_token);
          throw denial;
        }
        throw error;
      }
      const data = sourceData(response, token, options.signal);
      if (data.source_protocol !== 'complete_inventory_selection_v1' || data.source?.kind !== 'library'
        || data.entries_complete !== true || !Array.isArray(data.entries) || data.entries.length !== refs.length
        || data.entries.some((row, index) => row.inventory_track_ref !== refs[index] || !uuid(row.entry_ref))) throw fail('Selected Queue source changed.');
      const entry_refs = data.entries.map(row => row.entry_ref);
      sources.set(data.source.ref, {...sources.get(data.source.ref), queueGuard: {refs, entry_refs}});
      return {source: descriptor(data), entry_refs};
    },
    async beginPlaylistActivitySource(options) {
      const token = identity(options.scopeKey), refs = options.row_refs, origin = options.origin;
      if (!Array.isArray(refs) || !refs.length || refs.length > 5000 || refs.some(value => typeof value !== 'string' || !/^activity_[0-9a-f]{64}$/.test(value))
        || new Set(refs).size !== refs.length || !['own', 'friend'].includes(origin?.audience)
        || (origin.audience === 'own' ? origin.subject_ref !== null : !uuid(origin.subject_ref))
        || !['tracks', 'listens'].includes(origin.kind) || !['week', 'month', 'six', 'year', 'all'].includes(origin.period)
        || typeof origin.snapshot_ref !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(origin.snapshot_ref)) throw fail('This activity selection cannot be added.', 400);
      const recovered = await recoverCreate(options);
      if (recovered) return {recovered_creation: recovered};
      active(token, options.signal);
      const response = await transport.request('/playlists/creation-source/activity', {method: 'POST', expected: JSON.parse(token)[0], signal: options.signal,
        body: {origin: {audience: origin.audience, subject_ref: origin.subject_ref, kind: origin.kind, period: origin.period, snapshot_ref: origin.snapshot_ref}, row_refs: refs}});
      const data = sourceData(response, token, options.signal);
      if (data.source_protocol !== 'complete_activity_selection_v1' || data.entries_complete !== true || !Array.isArray(data.entries)
        || data.entries.length !== refs.length || data.entries.some((row, index) => row.source_row_ref !== refs[index]
          || row.inventory_track_ref !== null && !inventory(row.inventory_track_ref))) throw fail('Selected activity source changed.');
      return {source: descriptor(data), entry_refs: data.entries.map(row => row.entry_ref)};
    },
    async readPlaylistCreationSource(options) {
      const token = identity(options.scopeKey);
      if (options.mode === 'missing' && options.source?.kind === 'playlist' && uuid(options.source.ref) && revision(options.source.revision)) {
        const known = sources.get(options.source.ref), retained = options.retain_capture === true;
        const capture = retained && same(known?.source, options.source) ? known.capture_ref : null;
        if (retained && !uuid(capture)) throw fail('The retained Missing source is unavailable. Open a new Inspect session.', 409);
        const response = await transport.request(transport.query(`/playlists/${encodeURIComponent(options.source.ref)}/missing-source`, {
          revision: options.source.revision, ...(retained ? {capture_ref: capture} : {})}), {signal: options.signal});
        const data = response?.data;
        if (!uuid(data?.capture_ref) || retained && data.capture_ref !== capture) throw fail('Missing source capture changed.', 409);
        sourceData(response, token, options.signal, options.source);
        if (data.source_protocol !== 'missing_playlist_selection_v1' || data.entries_complete !== true || !Array.isArray(data.entries)
          || !retained && !data.entries.length || data.entries.some(row => row.availability !== 'missing'
            && !(retained && row.availability === 'local' && row.match_state === 'accepted'))) throw fail('Missing Playlist source unavailable.');
        return {status: 'ready', data: projection(data, options.scopeKey)};
      }
      const known = sources.get(options.source?.ref);
      if (!known || !same(known.source, options.source) || options.mode !== 'ordinary') return {status: 'unavailable', data: null};
      const isPaged = known.protocol === 'library_selection_v1';
      let response;
      try {
        response = await transport.request(transport.query(isPaged ? '/playlists/creation-source/entries' : '/playlists/creation-source/complete', {
          source_ref: known.source.ref, source_revision: known.source.revision,
          ...(isPaged ? {q: options.q || '', cursor: options.cursor, limit: 100}
            : known.protocol === 'complete_activity_selection_v1' ? {source_protocol: known.protocol} : {})}), {signal: options.signal});
      } catch (error) {
        if (owns(token) && same(ordinary, known.source) && error?.code === 'source_expired') ordinaryExpiresAt = 0;
        throw error;
      }
      const data = sourceData(response, token, options.signal, known.source);
      if (data.source_protocol !== known.protocol || data.entries_complete !== !isPaged) throw fail('Playlist source protocol changed.');
      return {status: 'ready', data: projection(data, options.scopeKey)};
    },
    createPlaylistFromSelection(options) {
      identity(options.scopeKey);
      const known = sources.get(options.source?.ref);
      if (!known || !same(known.source, options.source) || options.mode !== (known.protocol === 'missing_playlist_selection_v1' ? 'missing' : 'ordinary')
        || options.source_protocol !== known.protocol) throw fail('Playlist source unavailable.', 409);
      return mutate('create', options, '/playlists', 'POST', {source_protocol: known.protocol, mode: options.mode, source: tuple(known.source),
        title: options.title, description: options.description, entry_refs: options.entry_refs});
    },
    savePlaylist(options) {
      identity(options.scopeKey);
      return mutate('save', options, `/playlists/${encodeURIComponent(options.playlist_id)}`, 'PATCH', {
        title: options.title, description: options.description, revision: options.revision,
        ...(options.item_order ? {item_order: options.item_order} : {})});
    },
    addTracks(options) {
      identity(options.scopeKey);
      if (!Array.isArray(options.track_refs) || options.track_refs.some(value => !inventory(value))) throw fail('Unrepresentable Playlist selection.', 400);
      let guard;
      if (Object.hasOwn(options, 'source_guard')) {
        const value = options.source_guard, known = sources.get(value?.source?.ref);
        if (value?.source_protocol !== 'complete_inventory_selection_v1' || !known?.queueGuard || !same(value.source, known.source)
          || JSON.stringify(value.entry_refs) !== JSON.stringify(known.queueGuard.entry_refs)
          || JSON.stringify(options.track_refs) !== JSON.stringify(known.queueGuard.refs)) throw fail('Invalid retained Queue source.', 400);
        guard = {source_protocol: value.source_protocol, source: tuple(value.source), entry_refs: [...value.entry_refs]};
      }
      return mutate('add', options, `/playlists/${encodeURIComponent(options.playlist_id)}/items`, 'POST', {
        track_refs: options.track_refs, revision: options.revision || revisions.get(options.playlist_id), ...(guard ? {source_guard: guard} : {})});
    },
    saveDefaultSort(options) {
      identity(options.scopeKey);
      const sort = options.sort;
      if (sort !== null && (!['love_tier', 'play_count', 'popularity_count', 'duration'].includes(sort?.key)
        || !['asc', 'desc'].includes(sort.direction))) throw fail('Invalid Playlist default sort.', 400);
      return mutate('default_sort', options, `/playlists/${encodeURIComponent(options.playlist_id)}/default-sort`, 'POST', {
        sort: sort === null ? null : {key: sort.key, direction: sort.direction}, revision: options.revision || revisions.get(options.playlist_id)});
    },
    deletePlaylist(options) {
      identity(options.scopeKey);
      return mutate('delete', options, `/playlists/${encodeURIComponent(options.playlist_id)}`, 'DELETE', {revision: options.revision});
    },
    requestEditAccess(options) {
      identity(options.scopeKey);
      return mutate('request_edit', options, `/playlists/${encodeURIComponent(options.playlist_id)}/edit-requests`, 'POST', {revision: options.revision});
    },
    decideEditRequest(options) {
      identity(options.scopeKey);
      if (!uuid(options.request_ref) || !['approve', 'decline'].includes(options.decision)) throw fail('Invalid edit request.', 400);
      return mutate('decide_edit_request', options, `/playlists/${encodeURIComponent(options.playlist_id)}/edit-requests/${encodeURIComponent(options.request_ref)}/decision`,
        'POST', {revision: options.revision, decision: options.decision});
    },
    copyPlaylist(options) {
      identity(options.scopeKey);
      return mutate('copy', options, `/playlists/${encodeURIComponent(options.playlist_id)}/copy`, 'POST', {revision: options.revision});
    },
    async readEditRequests(options) {
      const token = identity(options.scopeKey);
      const value = await transport.request(transport.query('/playlists/edit-requests', {cursor: options.cursor, limit: 50}), {signal: options.signal});
      active(token, options.signal); acceptActor(value.actor_scope);
      if (!Array.isArray(value.requests) || value.requests.some(row => !uuid(row.request_ref) || !uuid(row.playlist_id)
        || !uuid(row.account_ref) || typeof row.title !== 'string' || typeof row.display_name !== 'string'
        || typeof row.username_display !== 'string' || typeof row.created_at !== 'string')
        || value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !value.next_cursor)) throw fail('Invalid edit request notifications.');
      return {requests: value.requests.map(({request_ref, playlist_id, title, account_ref, display_name, username_display, created_at}) =>
        ({request_ref, playlist_id, title, account_ref, display_name, username_display, created_at})), next_cursor: value.next_cursor, scopeKey: options.scopeKey};
    },
    async readSharing(options) {
      const token = identity(options.scopeKey), playlist = options.playlist_id;
      if (!uuid(playlist)) throw fail('Invalid Playlist.');
      if (options.q !== undefined && (typeof options.q !== 'string' || options.q.length > 100)
        || options.cursor != null && (typeof options.cursor !== 'string' || !options.cursor)) throw fail('Invalid Playlist recipient search.', 400);
      const base = `/playlists/${encodeURIComponent(playlist)}`;
      const summary = await transport.request(`${base}/sharing`, {signal: options.signal});
      active(token, options.signal); acceptActor(summary.actor_scope);
      if (summary.playlist_id !== playlist || !revision(summary.revision) || !visibilityModes.includes(summary.visibility)
        || ['can_manage', 'can_request_edit', 'can_copy'].some(key => typeof summary[key] !== 'boolean')
        || !['none', 'pending', 'approved', 'declined'].includes(summary.request_status) || !Array.isArray(summary.pending_requests)
        || summary.pending_requests.some(row => !uuid(row.request_ref) || row.playlist_id !== playlist || !uuid(row.account_ref)
          || typeof row.display_name !== 'string' || typeof row.username_display !== 'string' || typeof row.created_at !== 'string')) throw fail('Invalid Playlist sharing.');
      const shared = {can_request_edit: summary.can_request_edit, can_copy: summary.can_copy,
        request_status: summary.request_status, pending_requests: summary.pending_requests.map(row => ({...row}))};
      if (!summary.can_manage) {
        sharing.delete(playlist); revisions.set(playlist, summary.revision);
        return {status: 'ready', data: {...shared, visibility: summary.visibility, revision: summary.revision,
          can_manage: false, people: [], next_cursor: null, scopeKey: options.scopeKey}};
      }
      let pendingCursor = summary.next_pending_cursor; const seenPages = new Set();
      while (pendingCursor) {
        if (typeof pendingCursor !== 'string' || seenPages.has(pendingCursor)) throw fail('Invalid request continuation.');
        seenPages.add(pendingCursor);
        const page = await transport.request(transport.query(`${base}/sharing`, {cursor: pendingCursor}), {signal: options.signal});
        active(token, options.signal); acceptActor(page.actor_scope);
        if (page.playlist_id !== playlist || page.revision !== summary.revision || page.can_manage !== true
          || !Array.isArray(page.pending_requests) || page.pending_requests.some(row => !uuid(row.request_ref)
            || row.playlist_id !== playlist || !uuid(row.account_ref) || typeof row.display_name !== 'string'
            || typeof row.username_display !== 'string')) throw fail('Playlist requests changed.');
        shared.pending_requests.push(...page.pending_requests); pendingCursor = page.next_pending_cursor;
      }
      const grants = await transport.request(`${base}/access-grants`, {signal: options.signal});
      active(token, options.signal);
      if (grants.playlist_id !== playlist || grants.revision !== summary.revision || !revision(grants.revision) || !visibilityModes.includes(grants.visibility)
        || !Array.isArray(grants.grants) || grants.grants.some(row => !uuid(row.grant_ref) || !uuid(row.account_ref) || !Number.isSafeInteger(row.account_id) || row.account_id < 1 || row.role !== 'editor'
          || typeof row.display_name !== 'string' || typeof row.username_display !== 'string' || typeof row.is_active !== 'boolean')
        || new Set(grants.grants.map(row => row.grant_ref)).size !== grants.grants.length
        || new Set(grants.grants.map(row => row.account_id)).size !== grants.grants.length) throw fail('Invalid Playlist grants.');
      acceptActor(grants.actor_scope);
      const candidates = await transport.request(transport.query(`${base}/access-candidates`, {q: options.q || '', cursor: options.cursor, limit: 50}), {signal: options.signal});
      active(token, options.signal);
      if (candidates.playlist_id !== playlist || candidates.revision !== grants.revision || !Array.isArray(candidates.candidates)
        || candidates.next_cursor !== null && (typeof candidates.next_cursor !== 'string' || !candidates.next_cursor)
        || candidates.candidates.some(row => !uuid(row.account_ref) || !Number.isSafeInteger(row.account_id) || row.account_id < 1
          || typeof row.display_name !== 'string' || typeof row.username_display !== 'string'
          || row.grant_ref !== null && (!uuid(row.grant_ref) || row.role !== 'editor')
          || row.grant_ref === null && row.role !== null || typeof row.allowed_actions?.can_grant_editor !== 'boolean')
        || new Set(candidates.candidates.map(row => row.account_ref)).size !== candidates.candidates.length
        || new Set(candidates.candidates.map(row => row.account_id)).size !== candidates.candidates.length) throw fail('Invalid Playlist recipients.');
      acceptActor(candidates.actor_scope);
      const people = candidates.candidates.map(row => {
        const grant = grants.grants.find(item => item.account_id === row.account_id);
        if ((grant?.grant_ref || null) !== row.grant_ref || grant && grant.account_ref !== row.account_ref) throw fail('Playlist recipients changed.');
        return {account_ref: row.account_ref, display_name: row.display_name, username_display: row.username_display,
          selected: Boolean(grant), can_edit: Boolean(grant) || row.allowed_actions.can_grant_editor, role: 'editor'};
      });
      const authority = new Map(candidates.candidates.map(row => [row.account_ref, {account_id: row.account_id, grant_ref: row.grant_ref, can_grant: row.allowed_actions.can_grant_editor}]));
      for (const grant of grants.grants) if (!candidates.candidates.some(row => row.account_id === grant.account_id)) {
        const account_ref = grant.account_ref;
        people.push({account_ref, display_name: grant.display_name, username_display: grant.username_display,
          selected: true, can_edit: true, role: 'editor', is_active: grant.is_active});
        authority.set(account_ref, {account_id: grant.account_id, grant_ref: grant.grant_ref, can_grant: false});
      }
      sharing.set(playlist, {revision: grants.revision, authority}); revisions.set(playlist, grants.revision);
      return {status: 'ready', data: {...shared, visibility: grants.visibility, revision: grants.revision, can_manage: true,
        people, next_cursor: candidates.next_cursor, scopeKey: options.scopeKey}};
    },
    saveSharing(options) {
      identity(options.scopeKey);
      const known = sharing.get(options.playlist_id);
      if (!known || known.revision !== options.revision || !visibilityModes.includes(options.visibility)) throw fail('Refresh Playlist sharing before changing it.');
      return mutate('visibility', options, `/playlists/${encodeURIComponent(options.playlist_id)}/visibility`, 'PATCH', {
        visibility: options.visibility, revision: options.revision});
    },
    setPlaylistEditor(options) {
      identity(options.scopeKey);
      const known = sharing.get(options.playlist_id), person = known?.authority.get(options.account_ref);
      if (!known || known.revision !== options.revision || !person || typeof options.selected !== 'boolean'
        || options.selected && !person.can_grant || !options.selected && !person.grant_ref) throw fail('Refresh Playlist recipients before changing them.');
      const base = `/playlists/${encodeURIComponent(options.playlist_id)}/access-grants`;
      return options.selected ? mutate('grant_editor', options, base, 'POST', {account_id: person.account_id, role: 'editor', revision: options.revision})
        : mutate('revoke_editor', options, `${base}/${encodeURIComponent(person.grant_ref)}`, 'DELETE', {revision: options.revision});
    },
    async readPlaylistPreferences(options) {
      const token = identity(options.scopeKey), response = await transport.request('/account/playlist-preferences', {signal: options.signal});
      active(token, options.signal);
      return {preferences: preferences(response.preferences), scopeKey: options.scopeKey};
    },
    async savePlaylistPreferences(options) {
      const token = identity(options.scopeKey);
      const fields = {revision: options.revision};
      if (Object.hasOwn(options, 'remember_order_mode')) {
        if (typeof options.remember_order_mode !== 'boolean') throw fail('Invalid Playlist preferences.', 400);
        fields.remember_order_mode = options.remember_order_mode;
      }
      if (Object.hasOwn(options, 'last_order_mode')) {
        if (!['regular', 'shuffle'].includes(options.last_order_mode)) throw fail('Invalid Playlist preferences.', 400);
        fields.last_order_mode = options.last_order_mode;
      }
      if (Object.keys(fields).length === 1) throw fail('No Playlist preference change.', 400);
      const result = await mutate('playlist_preferences', options, '/account/playlist-preferences', 'PUT', fields);
      active(token, options.signal);
      runtime.acceptPlaylistPreferences?.(result);
      return result;
    },
    reconcilePlaylistOperation(options) {
      identity(options.scopeKey);
      const operation = operations.get(options.request_key);
      if (!operation || operation.action !== options.action) throw fail('Playlist operation unavailable.');
      return reconcile(operation, options.signal, options.scopeKey);
    },
  });
}
