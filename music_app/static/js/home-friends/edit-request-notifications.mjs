// The native notification registry owns presentation; this producer owns only
// actor-scoped pending edit requests, independently of the visible resource page.
export function createEditRequestNotifications({runtime, notifications, providers, onOpen, onDenied, sourceName, label, typeLabel, resourceKey, acceptsScope = () => true}) {
  let owner = null, disposed = false, configured = providers;
  const current = token => !disposed && owner === token && runtime.snapshot().authenticated === true
    && runtime.snapshot().scopeKey === token.scopeKey && acceptsScope(token.scopeKey);
  async function refresh(token = owner) {
    if (!token || !current(token) || typeof configured?.readEditRequests !== 'function') return;
    if (token.loading) {token.queued = true; return;}
    token.loading = true;
    const request = new AbortController(); token.request = request;
    const read = configured.readEditRequests;
    try {
      const records = [], cursors = new Set(), identities = new Set(); let cursor = null;
      do {
        const response = await read({scopeKey: token.scopeKey, cursor, signal: request.signal});
        if (!current(token) || request.signal.aborted || configured.readEditRequests !== read) return;
        for (const row of response.requests) {
          if (identities.has(row.request_ref) || !row[resourceKey]) throw new Error('Invalid edit request page.');
          identities.add(row.request_ref); records.push(row);
        }
        cursor = response.next_cursor;
        if (records.length > 10000 || cursors.size >= 100) throw new Error('Edit request feed is too large.');
        if (cursor && cursors.has(cursor)) throw new Error('Repeated edit request page.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      token.records = new Map(records.map(row => [row.request_ref, row]));
      token.source.replace(records.map(row => ({id: row.request_ref, title: row.title,
        byline: `${row.display_name || row.username_display || 'Library member'} requested edit access`,
        typeLabel, createdAt: row.created_at, read: token.read.has(row.request_ref)})), {status: records.length ? 'ready' : 'empty'});
    } catch (error) {
      if (current(token) && !request.signal.aborted) {
        const denied = [401, 403].includes(error?.status);
        token.records.clear(); token.source.replace([], {status: denied ? 'denied' : 'error'});
        if (denied) onDenied?.(token.scopeKey, error);
      }
    } finally {if (current(token)) {token.loading = false; if (token.queued) {token.queued = false; refresh(token);}}}
  }
  function retire() {const previous = owner; owner = null; previous?.request?.abort(); previous?.source?.dispose();}
  function sync() {
    const shell = runtime.snapshot();
    if (disposed || !shell.authenticated || !shell.scopeKey || !acceptsScope(shell.scopeKey)) {retire(); return;}
    if (owner?.scopeKey === shell.scopeKey) return;
    retire();
    const token = {scopeKey: shell.scopeKey, records: new Map(), read: new Set(), loading: false}; owner = token;
    token.source = notifications.registerSource({name: sourceName, label,
      scopeKey: token.scopeKey, isCurrent: () => current(token), onShow: () => token.source ? refresh(token) : undefined,
      onOpen: requestRef => {
        const row = token.records.get(requestRef);
        if (!current(token) || !row || token.opening) return false;
        const requestCurrent = () => current(token) && token.records.get(requestRef)?.[resourceKey] === row[resourceKey];
        token.opening = true;
        Promise.resolve().then(() => requestCurrent() ? onOpen(row, requestCurrent) : false).then(opened => {
          if (opened !== false && requestCurrent()) token.read.add(requestRef);
        }).catch(() => {}).finally(() => {token.opening = false; refresh(token);});
        return true;
      }});
    // An open drawer can call onShow before registerSource returns. Start the
    // initial read only after its source exists, including synchronous failures.
    refresh(token);
  }
  const unsubscribe = runtime.subscribe(sync); sync();
  return {refresh: () => refresh(), configure(next) {configured = next; retire(); sync();},
    dispose() {disposed = true; unsubscribe(); retire();}};
}
