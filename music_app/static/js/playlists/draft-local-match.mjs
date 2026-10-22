const empty = () => Object.freeze({rowKey: null, status: 'closed', candidates: Object.freeze([]), selectedKey: '', suggestionsComplete: false});
const sameSource = (a, b) => a?.kind === b?.kind && a?.ref === b?.ref && a?.revision === b?.revision;
const editable = state => Boolean(state.draftToken && state.canCreate && state.sourceResource.status === 'ready' && state.mutation.status === 'idle');
const readable = row => row?.source_readable === true && row.allowed_actions?.can_read === true && row.allowed_actions?.can_select === true;
const uncertain = value => value?.responseRejected !== true || !Number.isInteger(value.status) || value.status >= 500;
const failure = value => [401, 403, 'denied'].includes(value?.status) ? 'denied'
  : [409, 410, 'conflict'].includes(value?.status) ? 'conflict' : value?.status === 'unavailable' ? 'unavailable' : 'error';

// One explicit review belongs to one exact retained row and draft lifetime.
// Neither rendering a suggestion nor selecting it changes the source entry.
export function createDraftLocalMatchController({draft, providers, apply, deny}) {
  let state = empty(), opening = null, pending = null, disposed = false, applying = false;
  const listeners = new Set();
  const publish = patch => {state = Object.freeze({...state, ...patch}); for (const listener of [...listeners]) if (listeners.has(listener)) listener();};
  const close = () => {if (state.status === 'closed' && !opening && !pending) return; pending?.abort(); pending = null; opening = null; publish(empty());};
  const current = owner => {
    const value = draft.getSnapshot();
    return !disposed && opening === owner && readable(owner?.row) && editable(value) && value.draftToken === owner?.draftToken
      && value.scopeKey === owner.scopeKey && sameSource(value.source, owner.source)
      && value.entries.find(row => row.row_key === owner.row.row_key) === owner.row;
  };
  const unsubscribe = draft.subscribe(() => {if (!applying && opening && !current(opening)) close();});
  const options = owner => ({scopeKey: owner.scopeKey, source: owner.source, entry_ref: owner.row.entry_ref});
  const controller = {
    getSnapshot: () => state,
    subscribe(listener) {if (!disposed) listeners.add(listener); return () => listeners.delete(listener);},
    blocking: () => ['accepting', 'uncertain'].includes(state.status),
    available: () => !disposed && typeof providers().readPlaylistMatchCandidates === 'function' && typeof providers().acceptPlaylistMatch === 'function',
    open(rowKey) {
      if (!controller.available() || opening) return false;
      const value = draft.getSnapshot(), row = value.entries.find(row => row.row_key === rowKey);
      if (!editable(value) || !readable(row)) return false;
      opening = {draftToken: value.draftToken, scopeKey: value.scopeKey, source: value.source, row};
      publish({rowKey, status: row.availability === 'local' ? 'accepted' : 'idle', candidates: [], selectedKey: '', suggestionsComplete: false}); return true;
    },
    close,
    async load() {
      const owner = opening;
      if (!owner || !current(owner) || pending || ['accepted', 'uncertain'].includes(state.status)) return false;
      const request = new AbortController(); pending = request;
      publish({status: 'loading', candidates: [], selectedKey: '', suggestionsComplete: false});
      try {
        if (!current(owner) || pending !== request || request.signal.aborted) return false;
        const response = await providers().readPlaylistMatchCandidates({...options(owner), signal: request.signal});
        if (!current(owner) || pending !== request || request.signal.aborted) return false;
        const value = response?.data;
        if (response?.status !== 'ready' || value?.scopeKey !== owner.scopeKey || !sameSource(value.source, owner.source)
          || value.entry_ref !== owner.row.entry_ref || !Array.isArray(value.candidates)
          || value.candidates.length > 8 || typeof value.suggestions_complete !== 'boolean'
          || Array.from(value.candidates).some(row => !row || typeof row.key !== 'string' || !row.key
            || ['title', 'artist', 'album_title'].some(key => typeof row[key] !== 'string'))
          || new Set(value.candidates.map(row => row.key)).size !== value.candidates.length) throw new Error('Invalid local match review.');
        const candidates = value.candidates.map(row => Object.freeze({key: row.key, title: row.title, artist: row.artist,
          album_title: row.album_title, duration_seconds: Number.isFinite(row.duration_seconds) && row.duration_seconds >= 0 ? row.duration_seconds : null}));
        publish({status: 'ready', candidates: Object.freeze(candidates), suggestionsComplete: value.suggestions_complete}); return true;
      } catch (error) {
        if (current(owner) && pending === request && !request.signal.aborted) {
          if (failure(error) === 'denied') deny(); else publish({status: failure(error)});
        }
        return false;
      } finally {if (pending === request) pending = null;}
    },
    select(key) {
      if (!opening || !current(opening) || pending || state.status !== 'ready' || !state.candidates.some(row => row.key === key)) return false;
      publish({selectedKey: key}); return true;
    },
    async accept() {
      const owner = opening;
      if (!owner || !current(owner) || pending || !['ready', 'uncertain'].includes(state.status) || !state.selectedKey
        || !state.candidates.some(row => row.key === state.selectedKey)) return false;
      const request = new AbortController(); pending = request;
      const candidate_key = state.selectedKey; publish({status: 'accepting'});
      try {
        if (!current(owner) || pending !== request || request.signal.aborted) return false;
        const response = await providers().acceptPlaylistMatch({...options(owner), candidate_key, signal: request.signal});
        if (!current(owner) || pending !== request || request.signal.aborted) return false;
        let accepted; applying = true;
        try {accepted = apply(response, owner.row);} finally {applying = false;}
        if (!accepted) {if (!current(owner)) close(); throw new Error('The original source changed.');}
        owner.row = draft.getSnapshot().entries.find(row => row.row_key === state.rowKey);
        if (!current(owner)) {close(); return false;}
        publish({status: 'accepted', candidates: [], selectedKey: ''}); return true;
      } catch (error) {
        if (current(owner) && pending === request && !request.signal.aborted) {
          if (failure(error) === 'denied') deny();
          else if (uncertain(error)) publish({status: 'uncertain'});
          else publish({status: failure(error), candidates: [], selectedKey: ''});
        }
        return false;
      } finally {if (pending === request) pending = null;}
    },
    dispose() {if (disposed) return; disposed = true; unsubscribe(); close(); listeners.clear();},
  };
  return Object.freeze(controller);
}
