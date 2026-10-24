// Account-only display read model. Full projections are retained for at most
// five pages; checkpoints contain only request cursors, never hidden rows.
export const HISTORY_WINDOW_PAGES = 5, HISTORY_PAGE_SIZE = 20;
export function createFoobarHistoryController({provider}) {
  if (!provider || typeof provider.readSources !== 'function' || typeof provider.readHistory !== 'function')
    throw new TypeError('Foobar history provider is unavailable.');
  const listeners = new Set();
  let disposed = false, retired = false, sourceSequence = 0, historySequence = 0;
  let sourceAbort = null, historyAbort = null, checkpoints = [null], revision = null;
  const emptyWindow = () => ({page: null, pages: Object.freeze([]), pageNumber: 0,
    firstPage: 0, lastPage: 0, hasNewer: false, hasOlder: false, direction: null});
  let state = Object.freeze({sourcesStatus: 'idle', sources: Object.freeze([]), sourceCursor: null,
    selectedSource: null, family: 'standard', mode: 'grouped', status: 'idle',
    ...emptyWindow(), error: '', sourcesError: ''});
  const publish = patch => {
    if (disposed) return;
    state = Object.freeze({...state, ...patch});
    for (const listener of [...listeners]) {try {listener(state);} catch { /* Retirement cannot be blocked by a view. */ }}
  };
  const clear = () => {checkpoints = [null]; revision = null; return emptyWindow();};
  const stopHistory = () => {historySequence++; historyAbort?.abort(); historyAbort = null;};
  const stopSources = () => {sourceSequence++; sourceAbort?.abort(); sourceAbort = null;};
  function retire() {
    if (disposed || retired) return;
    retired = true; stopHistory(); stopSources();
    publish({sourcesStatus: 'retired', sources: Object.freeze([]), sourceCursor: null, selectedSource: null,
      status: 'retired', ...clear(), sourcesError: '', error: 'This account session changed. Reload to read Foobar history.'});
  }
  const release = provider.subscribe?.(retire);
  const current = () => !disposed && !retired;
  function failure(error) {
    if (['stale_context', 'forbidden', 'authentication_required'].includes(error?.code)) {retire(); return null;}
    if (error?.code === 'stale_history')
      return {status: 'stale', message: 'This source changed. Refresh the selected source from its first page.'};
    return {status: 'unavailable', message: 'Foobar history is unavailable. Refresh to try again; no listening history has been inferred.'};
  }
  async function loadSources({next = false} = {}) {
    if (!current() || state.sourcesStatus === 'loading' || next && !state.sourceCursor) return;
    const cursor = next ? state.sourceCursor : null;
    stopSources(); if (!next) stopHistory();
    const token = sourceSequence, abort = new AbortController(); sourceAbort = abort;
    publish({sourcesStatus: 'loading', sourcesError: '', ...(!next
      ? {selectedSource: null, ...clear(), status: 'idle', error: ''} : {})});
    try {
      if (!current() || token !== sourceSequence) return;
      const page = await provider.readSources({cursor, signal: abort.signal});
      if (!current() || token !== sourceSequence) return;
      publish({sourcesStatus: page.items.length ? 'ready' : 'empty', sources: page.items,
        sourceCursor: page.next_cursor, sourcesError: ''});
    } catch (error) {
      if (!current() || token !== sourceSequence) return;
      const result = failure(error); if (!result) return;
      publish({sourcesStatus: result.status, sources: Object.freeze([]), sourceCursor: null, sourcesError: result.message});
    } finally {if (token === sourceSequence) sourceAbort = null;}
  }
  async function loadHistory({next = false, newer = false, start = false, canCommit} = {}) {
    if (!current() || !state.selectedSource || state.status === 'loading') return;
    const navigation = next || newer || start;
    if (navigation && (state.status !== 'ready' || next && !state.hasOlder || newer && !state.hasNewer)) return;
    const source = state.selectedSource, family = state.family, mode = state.mode;
    const index = next ? state.lastPage + 1 : newer ? state.firstPage - 1 : 0;
    const enhanced=family==='local_entries';
    const cursor = navigation ? enhanced
      ?next?state.pages.at(-1)?.page.next_cursor:newer?state.pages[0]?.page.previous_cursor:null
      :checkpoints[index] : null;
    if (navigation && cursor === undefined) return;
    const previous = state.pages, pinned = revision;
    stopHistory(); const token = historySequence, abort = new AbortController(); historyAbort = abort;
    if (!navigation) publish({...clear(), status: 'loading', error: ''});
    else publish({status: 'loading', error: ''});
    try {
      if (!current() || token !== historySequence) return;
      const page = await provider.readHistory({source_ref: source.source_ref, family, mode, cursor, signal: abort.signal});
      if (!current() || token !== historySequence) return;
      if (navigation && page.source_revision !== pinned)
        throw Object.assign(new Error('Source changed.'), {code: 'stale_history'});
      // The server protocol requires every continuing page to contain 20 rows.
      // Permit an empty terminal page at the cap, but never claim cap == end.
      const rowCap = mode === 'individual' ? 200000 : 100000;
      if (!enhanced&&(index * HISTORY_PAGE_SIZE + page.items.length > rowCap
        || page.next_cursor && (page.items.length !== HISTORY_PAGE_SIZE || (index + 1) * HISTORY_PAGE_SIZE > rowCap))
      )throw new Error('Source history exceeds the bounded protocol.');
      // A replay at the same revision must keep its saved continuation. The
      // provider also enforces strict ordering after the exact request cursor.
      const cursorKey = value => value === null ? null : JSON.stringify([
        value.context_ref, value.source_ref, value.source_revision, value.family,
        value.mode, value.sort_key, value.kind, value.observation_ref]);
      if (!enhanced&&(page.next_cursor && cursorKey(page.next_cursor) === cursorKey(cursor)
        || checkpoints[index + 1] !== undefined && cursorKey(checkpoints[index + 1]) !== cursorKey(page.next_cursor))
      )throw new Error('History checkpoint changed or repeated.');
      const entry = Object.freeze({index, page});
      const pages = Object.freeze(next ? [...previous, entry].slice(-HISTORY_WINDOW_PAGES)
        : newer ? [entry, ...previous].slice(0, HISTORY_WINDOW_PAGES) : [entry]);
      const identities = pages.flatMap(value => value.page.items.map(row => row.observation_ref + ":" + row.kind));
      if (new Set(identities).size !== identities.length) throw new Error('Duplicate history boundary.');
      // A view can decline an automatic eviction if the user moved during I/O.
      if (navigation && typeof canCommit === 'function' && !canCommit(pages)) {
        publish({status: 'ready'}); return;
      }
      revision = page.source_revision;
      if(!enhanced){
        if (page.next_cursor) checkpoints[index + 1] = page.next_cursor;
        else checkpoints.length = index + 1;
      }
      const first = pages[0], last = pages.at(-1);
      publish({status: pages.some(value => value.page.items.length) ? 'ready' : 'empty', pages,
        page: Object.freeze({...last.page, items: Object.freeze(pages.flatMap(value => value.page.items))}),
        pageNumber: index + 1, firstPage: first.index, lastPage: last.index,
        hasNewer: enhanced?first.page.previous_cursor!==null:first.index > 0, hasOlder: last.page.next_cursor !== null,
        direction: next ? 'older' : newer ? 'newer' : 'start', error: ''});
    } catch (error) {
      if (!current() || token !== historySequence) return;
      const result = failure(error); if (!result) return;
      publish({status: result.status, ...clear(), error: result.message});
    } finally {if (token === historySequence) historyAbort = null;}
  }
  function changeView(key, value, choices) {
    if (!current() || !choices.includes(value) || state[key] === value) return;
    stopHistory(); publish({[key]: value, status: 'idle', ...clear(), error: ''});
    if (state.selectedSource) void loadHistory();
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener) {if (disposed || typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener);},
    initialize() {if (state.sourcesStatus === 'idle') return loadSources();},
    loadSources, loadHistory,
    selectSource(source_ref) {
      if (!current() || !['ready', 'empty'].includes(state.sourcesStatus)) return;
      const source = state.sources.find(item => item.source_ref === source_ref);
      if (!source || state.selectedSource?.source_ref === source_ref) return;
      stopHistory(); publish({selectedSource: source, status: 'idle', ...clear(), error: ''});
      void loadHistory();
    },
    setFamily(value) {changeView('family', value, ['standard', 'enhanced','local_entries']);},
    setMode(value) {changeView('mode', value, ['grouped', 'individual']);},
    retire,
    dispose() {if (disposed) return; stopSources(); stopHistory(); disposed = true; release?.(); listeners.clear();
      state = Object.freeze({...state, ...clear(), sources: Object.freeze([]), selectedSource: null, status: 'retired', sourcesStatus: 'retired'});},
  });
}
