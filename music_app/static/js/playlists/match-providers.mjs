import {normalizeCreationResult} from './creation.mjs';

// Match authority never leaves this adapter. React receives presentation keys,
// original metadata and explicit acceptance state, never inventory identities.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const inventory = value => typeof value === 'string' && /^inventory-track:[1-9][0-9]*:[1-9][0-9]*$/.test(value);
const tuple = value => ({kind: value.kind, ref: value.ref, revision: value.revision});
const same = (a, b) => a?.kind === b?.kind && a?.ref === b?.ref && a?.revision === b?.revision;
const fail = (status = 409) => Object.assign(new Error('This local match is unavailable. Review the current choices.'), {status});
const aborted = () => Object.assign(new Error('Local match review superseded.'), {name: 'AbortError'});

export function createPlaylistMatchProviders({transport, runtime} = {}) {
  let generation = 0, serial = 0, disposed = false, actor = null, review = null;
  const clear = () => {generation++; actor = null; review = null;};
  const unsubscribe = transport.subscribe?.(clear);
  const accepts = scope => typeof runtime.acceptsPrivateScope === 'function' && runtime.acceptsPrivateScope(scope) === true;
  function identity(options) {
    const context = transport.context();
    if (disposed || !context || typeof options.scopeKey !== 'string' || !options.scopeKey || !accepts(options.scopeKey)) throw fail(403);
    if (!['playlist', 'activity'].includes(options.source?.kind) || !uuid(options.source.ref)
      || (options.source.kind === 'playlist' ? typeof options.source.revision !== 'string' || !/^[1-9][0-9]*$/.test(options.source.revision) : !uuid(options.source.revision))
      || !uuid(options.entry_ref)) throw fail(400);
    return {context, scopeKey: options.scopeKey, generation, source: tuple(options.source), entry_ref: options.entry_ref};
  }
  function active(owner, signal) {
    if (disposed || signal?.aborted || owner.generation !== generation || owner.context !== transport.context() || !accepts(owner.scopeKey)) throw aborted();
  }
  function dataOf(response, owner, signal) {
    active(owner, signal);
    const data = response?.data;
    if (response?.status !== 'ready' || response.ok === false || !same(data?.source, owner.source) || data.entry_ref !== owner.entry_ref
      || !Number.isSafeInteger(data.actor_scope?.account_id) || data.actor_scope.account_id < 1
      || !Number.isSafeInteger(data.actor_scope?.library_id) || data.actor_scope.library_id < 1) throw fail();
    if (actor && (actor.account_id !== data.actor_scope.account_id || actor.library_id !== data.actor_scope.library_id)) throw fail(403);
    actor = {account_id: data.actor_scope.account_id, library_id: data.actor_scope.library_id};
    return data;
  }
  return Object.freeze({
    async readPlaylistMatchCandidates(options) {
      const owner = identity(options), current = {owner, candidates: new Map(), pending: false}; review = current;
      active(owner, options.signal);
      const response = await transport.request('/playlists/creation-source/match-candidates', {method: 'POST',
        body: {source: owner.source, entry_ref: owner.entry_ref}, signal: options.signal, expected: owner.context});
      const data = dataOf(response, owner, options.signal);
      if (review !== current) throw aborted();
      if (!uuid(data.review_ref) || data.suggestion_scope !== 'bounded_local_inventory' || typeof data.suggestions_complete !== 'boolean'
        || !Array.isArray(data.candidates) || data.candidates.length > 8
        || Array.from(data.candidates).some(row => !uuid(row?.candidate_ref) || !inventory(row.inventory_track_ref)
          || !row.inventory_track_ref.startsWith(`inventory-track:${actor.library_id}:`)
          || ['title', 'artist', 'album_title'].some(key => typeof row[key] !== 'string')
          || row.duration_seconds !== null && (!Number.isFinite(row.duration_seconds) || row.duration_seconds < 0))
        || new Set(data.candidates.map(row => row.candidate_ref)).size !== data.candidates.length
        || new Set(data.candidates.map(row => row.inventory_track_ref)).size !== data.candidates.length) throw fail();
      current.review_ref = data.review_ref;
      const prefix = ++serial;
      const candidates = data.candidates.map((row, index) => {
        const key = `local-match:${prefix}:${index}`;
        current.candidates.set(key, {candidate_ref: row.candidate_ref, inventory_track_ref: row.inventory_track_ref});
        return {key, title: row.title, artist: row.artist, album_title: row.album_title, duration_seconds: row.duration_seconds};
      });
      return {status: 'ready', data: {scopeKey: owner.scopeKey, source: owner.source, entry_ref: owner.entry_ref,
        candidates, suggestions_complete: data.suggestions_complete}};
    },
    async acceptPlaylistMatch(options) {
      const owner = identity(options), current = review, candidate = current?.candidates.get(options.candidate_key);
      if (!current || !candidate || current.pending || current.owner.generation !== owner.generation || current.owner.context !== owner.context
        || current.owner.scopeKey !== owner.scopeKey || !same(current.owner.source, owner.source) || current.owner.entry_ref !== owner.entry_ref) throw fail();
      active(owner, options.signal); current.pending = true;
      try {
        const response = await transport.request('/playlists/creation-source/accept-match', {method: 'POST',
          body: {source: owner.source, entry_ref: owner.entry_ref, review_ref: current.review_ref, candidate_ref: candidate.candidate_ref},
          signal: options.signal, expected: owner.context});
        const data = dataOf(response, owner, options.signal);
        if (review !== current) throw aborted();
        if (data.entry?.entry_ref !== owner.entry_ref || data.entry.inventory_track_ref !== candidate.inventory_track_ref
          || data.entry.availability !== 'local' || data.entry.match_state !== 'accepted'
          || data.entry.allowed_actions?.can_read !== true || data.entry.allowed_actions?.can_select !== true) throw fail();
        const allowed_actions = {can_read: true, can_use_for_playlist: true};
        const context = {scopeKey: owner.scopeKey, mode: 'missing', canCreate: true, source: {...owner.source, allowed_actions, ...(owner.source.kind === 'activity' ? {source_protocol: 'missing_activity_selection_v1'} : {})}};
        const normalized = normalizeCreationResult({status: 'ready', data: {...context,
          allowed_actions, ...(owner.source.kind === 'activity' ? {source_protocol: 'missing_activity_selection_v1'} : {}), entries_complete: true, entries: [data.entry]}}, context);
        if (normalized.status !== 'ready') throw fail();
        return {status: 'ready', data: {scopeKey: owner.scopeKey, source: owner.source, entry_ref: owner.entry_ref, entry: normalized.data.entries[0]}};
      } finally {current.pending = false;}
    },
    dispose() {disposed = true; unsubscribe?.(); clear();},
  });
}
