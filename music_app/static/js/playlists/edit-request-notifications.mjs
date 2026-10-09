// The shared notification drawer reads actor-scoped requests even off Playlists.
export function createPlaylistEditNotifications({runtime, notifications, providers, onOpen}) {
  let owner = null, disposed = false, configured = providers;
  const current = token => !disposed && owner === token && runtime.snapshot().authenticated === true
    && runtime.snapshot().scopeKey === token.scopeKey;
  async function refresh(token = owner) {
    if (!token || !current(token) || token.loading || typeof configured?.readEditRequests !== 'function') return;
    token.loading = true;
    const request = new AbortController(); token.request = request;
    const read = configured.readEditRequests;
    try {
      const records = [], cursors = new Set(); let cursor = null;
      do {
        const response = await read({scopeKey: token.scopeKey, cursor, signal: request.signal});
        if (!current(token) || request.signal.aborted || configured.readEditRequests !== read) return;
        records.push(...response.requests); cursor = response.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated edit request page.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      token.records = new Map(records.map(row => [row.request_ref, row]));
      token.source.replace(records.map(row => ({id: row.request_ref, title: row.title,
        byline: `${row.display_name || row.username_display || 'Library member'} requested edit access`,
        typeLabel: 'Playlist', createdAt: row.created_at, read: token.read.has(row.request_ref)})), {status: records.length ? 'ready' : 'empty'});
    } catch (error) {
      if (current(token) && !request.signal.aborted) {token.records.clear(); token.source.replace([], {status: error?.status === 403 ? 'denied' : 'error'});}
    } finally {if (current(token)) token.loading = false;}
  }
  function retire() {const previous = owner; owner = null; previous?.request?.abort(); previous?.source?.dispose();}
  function sync() {
    const shell = runtime.snapshot();
    if (disposed || !shell.authenticated || !shell.scopeKey) {retire(); return;}
    if (owner?.scopeKey === shell.scopeKey) return;
    retire();
    const token = {scopeKey: shell.scopeKey, records: new Map(), read: new Set(), loading: false}; owner = token;
    token.source = notifications.registerSource({name: 'playlist-edit-requests', label: 'Playlist edit requests',
      scopeKey: token.scopeKey, isCurrent: () => current(token), onShow: () => refresh(token),
      onOpen: requestRef => {
        const row = token.records.get(requestRef);
        if (!current(token) || !row || token.opening) return false;
        const requestCurrent = () => current(token) && token.records.get(requestRef)?.playlist_id === row.playlist_id;
        token.opening = true;
        Promise.resolve().then(() => requestCurrent() ? onOpen(row, requestCurrent) : false).then(opened => {
          if (opened !== false && requestCurrent()) token.read.add(requestRef);
        }).catch(() => {}).finally(() => {token.opening = false; refresh(token);});
        return true;
      }});
    refresh(token);
  }
  const unsubscribe = runtime.subscribe(sync); sync();
  return {refresh: () => refresh(), configure(next) {configured = next; retire(); sync();},
    dispose() {disposed = true; unsubscribe(); retire();}};
}
