import {BASE, PROTOCOL, SCOPE, hex, sourceCursor, historyCursor, validateQuery, validateSources, validateHistory, readBoundedJSON} from './contract.mjs';
import {ENHANCED_PROTOCOL,ENHANCED_FAMILY,enhancedCursor,validateEnhancedHistory} from './enhanced-contract.mjs';

// This transport is account-only and read-only, despite POST for bounded
// context/CSRF-protected commands. It does not reuse the import source creator,
// library private transport, native action resolver, or scrobble retry seam.
export function createFoobarHistoryProvider({fetch, contextRoot, allows, isCurrent}) {
  if (typeof fetch !== 'function' || !contextRoot || typeof allows !== 'function' || typeof isCurrent !== 'function')
    throw new TypeError('Foobar history transport is unavailable.');
  const expected = contextRoot.dataset.accountFoobarContext;
  const listeners = new Set(), pending = new Set();
  let disposed = false, retired = false;
  const failure = (code, status) => Object.assign(new Error('Foobar history could not be read.'), {code, status});
  const aborted = () => Object.assign(new Error('Foobar history read was superseded.'), {name: 'AbortError'});
  function retire() {
    if (disposed || retired) return;
    retired = true;
    for (const abort of pending) abort.abort();
    pending.clear();
    for (const listener of [...listeners]) {try {listener();} catch { /* Retirement continues for every owner. */ }}
  }
  function current() {
    if (disposed || retired) return false;
    try {return hex(expected) && contextRoot.isConnected === true
      && contextRoot.dataset.accountFoobarContext === expected && contextRoot.dataset.accountFoobarScope === SCOPE
      && allows('account.self.foobar.read') === true && isCurrent() === true && !disposed && !retired;}
    catch {return false;}
  }
  function assertCurrent(signal) {
    if (!current()) {retire(); throw failure('stale_context', 409);}
    if (signal?.aborted) throw aborted();
  }
  async function request(operation, body, signal, validate, protocol=PROTOCOL) {
    assertCurrent(signal);
    const abort = new AbortController(); pending.add(abort);
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) abort.abort();
    const timeout = setTimeout(cancel, 60000);
    const live = () => assertCurrent(abort.signal);
    try {
      live();
      const response = await fetch(BASE + '/history/' + operation, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-AlbumHaven-Foobar-Context': expected},
        body: JSON.stringify({version: protocol, ...body}),
      });
      // Retire on real HTTP denial even if the body is HTML or cannot decode.
      if ([401, 403].includes(response.status)) {retire(); throw failure(response.status === 401 ? 'authentication_required' : 'forbidden', response.status);}
      live();
      const value = await readBoundedJSON(response, live);
      live();
      if (!response.ok) {
        const codes = ['authentication_required', 'forbidden', 'stale_context', 'stale_history_context', 'stale_history', 'invalid_history_request', 'unavailable','history_unavailable'];
        let code = value?.protocol === protocol && codes.includes(value.error) ? value.error : 'unavailable';
        if(code==='stale_history_context')code='stale_context';
        if (['authentication_required', 'forbidden', 'stale_context'].includes(code)) retire();
        throw failure(code, response.status);
      }
      const accepted = validate(value); live(); return accepted;
    } catch (error) {
      if (!disposed && !retired && !current()) retire();
      throw error;
    } finally {clearTimeout(timeout); signal?.removeEventListener('abort', cancel); abort.abort(); pending.delete(abort);}
  }
  return Object.freeze({
    subscribe(listener) {if (disposed || typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener);},
    readSources({cursor = null, signal} = {}) {
      assertCurrent(signal); const accepted = cursor === null ? null : sourceCursor(cursor, expected);
      return request('sources', {cursor: accepted}, signal, value => validateSources(value, expected, accepted));
    },
    readHistory({source_ref, family, mode, cursor = null, signal} = {}) {
      if(family===ENHANCED_FAMILY){
        assertCurrent(signal);
        // Reuse the established source/mode validators without reinterpreting
        // aggregate projections as timestamp entries.
        validateQuery({source_ref,family:'standard',mode});
        const query={source_ref,family,mode},accepted=enhancedCursor(cursor,expected,query);
        return request('enhanced',{source_ref,view:mode==='individual'?'entries':'records',cursor:accepted},
          signal,value=>validateEnhancedHistory(value,expected,query,accepted),ENHANCED_PROTOCOL);
      }
      assertCurrent(signal); const query = validateQuery({source_ref, family, mode});
      const accepted = cursor === null ? null : historyCursor(cursor, expected, query);
      return request('list', {...query, cursor: accepted}, signal, value => validateHistory(value, expected, query, accepted));
    },
    retire,
    dispose() {if (disposed) return; retire(); disposed = true; listeners.clear();},
  });
}
