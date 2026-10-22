// This owner retains only a server-issued canonical snapshot. No Playlist
// tracks, queue state, inventory IDs or inferred album membership can save it.
const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && value.length <= 19 && !/[^0-9]/.test(value)
  && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n;
export {uuid as isPlaylistTopPreviewRef, revision as isPlaylistTopPreviewRevision};
const fail = message => new Error(message);
const freeze = value => value && typeof value === 'object' ? Object.freeze(Array.isArray(value)
  ? value.map(freeze) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)]))) : value;
export function projectPlaylistTopPreview(value, expected) {
  if (value?.preview_ref !== expected.request_key || value.source?.playlist_ref !== expected.playlist_ref
    || value.source.revision !== expected.revision || !uuid(value.preview_ref) || !uuid(value.source.playlist_ref)
    || !revision(value.source.revision) || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
    || typeof value.title !== 'string' || typeof value.description !== 'string'
    || !Array.isArray(value.albums) || value.albums.length > 5000 || !Array.isArray(value.report) || value.report.length > 5000)
    throw fail('The Album Top preview was not acknowledged.');
  const albums = value.albums.map(row => {
    if (!uuid(row?.album_ref) || typeof row.title !== 'string' || typeof row.artist !== 'string'
      || row.year !== null && (!Number.isInteger(row.year) || row.year < 1 || row.year > 9999)) throw fail('Invalid preview album.');
    return {album_ref: row.album_ref, title: row.title, artist: row.artist, year: row.year};
  });
  let position = 0;
  const report = value.report.map(row => {
    if (!uuid(row?.playlist_item_ref) || !Number.isSafeInteger(row.position) || row.position <= position
      || !['included', 'duplicate', 'unresolved', 'unsupported', 'unavailable'].includes(row.reason)) throw fail('Invalid preview source report.');
    position = row.position;
    return {playlist_item_ref: row.playlist_item_ref, position, reason: row.reason};
  });
  if (new Set(albums.map(row => row.album_ref)).size !== albums.length
    || new Set(report.map(row => row.playlist_item_ref)).size !== report.length
    || report.filter(row => row.reason === 'included').length !== albums.length) throw fail('Invalid preview membership.');
  return freeze({preview_ref: value.preview_ref, source: {playlist_ref: value.source.playlist_ref, revision: value.source.revision}, expires_at: value.expires_at,
    title: value.title, description: value.description, albums, report});
}

export function createPlaylistTopPreview({providers, scopeKey, playlistRef, sourceRevision, requestKey, isCurrent}) {
  if (!uuid(playlistRef) || !revision(sourceRevision) || !uuid(requestKey) || typeof isCurrent !== 'function') throw fail('Invalid preview source.');
  const listeners = new Set(), abort = new AbortController();
  let retired = false, saving = null, loading = null, command = null, uncertain = false;
  let state = freeze({scopeKey, status: 'idle', preview: null, title: '', description: '', save: {status: 'idle'}, error: null});
  const current = () => {
    if (retired) return false;
    try {if (isCurrent() !== true) retired = true;} catch {retired = true;}
    return !retired;
  };
  const publish = patch => {if (!current()) return; state = freeze({...state, ...patch}); for (const listener of [...listeners]) listener();};
  const options = () => ({scopeKey, signal: abort.signal});
  const captureCommand = freeze({playlist_ref: playlistRef, revision: sourceRevision, request_key: requestKey});
  const owner = {
    getSnapshot: () => state,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    isCurrent: current,
    edit(patch) {
      if (!current() || command || state.status !== 'ready') return false;
      const next = {};
      for (const key of ['title', 'description']) if (Object.hasOwn(patch, key) && typeof patch[key] === 'string') next[key] = patch[key];
      publish({...next, save: {status: 'idle'}}); return true;
    },
    load() {
      if (!current() || state.preview) return Promise.resolve(false);
      if (loading) return loading;
      loading = Promise.resolve().then(() => {
        if (!current()) return null;
        return providers.captureAlbumTopPreview(captureCommand, options());
      }).then(value => {
        if (!current() || value === null) return false;
        const preview = projectPlaylistTopPreview(value, captureCommand);
        publish({status: 'ready', preview, title: preview.title, description: preview.description}); return true;
      }).catch(error => {if (current()) publish({status: 'error', error: error.message}); return false;})
        .finally(() => {loading = null;});
      publish({status: 'loading', error: null});
      return loading;
    },
    save() {
      if (!current() || state.status !== 'ready' || !state.preview.albums.length) return Promise.resolve(null);
      if (saving) return saving;
      if (state.save.status === 'ready') return Promise.resolve(state.save.data);
      if (!command) {
        if (!state.title.trim() || state.title.trim().length > 100 || state.description.length > 1000) return Promise.resolve(null);
        command = freeze({request_key: requestKey, playlist_preview_ref: requestKey, title: state.title.trim(), description: state.description});
      }
      saving = Promise.resolve().then(() => current() ? providers.saveAlbumTopPreview(command, options()) : null)
        .then(receipt => {
          if (!current() || receipt === null) return null;
          if (receipt.action !== 'create' || receipt.request_key !== requestKey || !uuid(receipt.top_ref) || !revision(receipt.revision)) throw fail('Save was not acknowledged.');
          publish({save: {status: 'ready', data: {action: receipt.action, request_key: receipt.request_key,
            top_ref: receipt.top_ref, revision: receipt.revision}}}); return state.save.data;
        }).catch(error => {
          if (current()) {
            const rejected = error?.responseRejected === true && [400, 401, 403, 404, 409, 410, 413, 422].includes(error.status);
            uncertain ||= !rejected;
            if (!uncertain) command = null;
            publish({save: {status: uncertain ? 'uncertain' : 'error', error: error.message}});
          }
          return null;
        })
        .finally(() => {saving = null;});
      publish({save: {status: 'loading'}});
      return saving;
    },
    canLeave: () => current() && !['loading', 'uncertain'].includes(state.save.status),
    dispose() {
      if (retired) {abort.abort(); listeners.clear(); return;}
      const discard = current() && state.preview && !command;
      retired = true; abort.abort(); listeners.clear();
      // Retiring the client owner is immediate even if the best-effort server
      // tombstone fails. The discarded token is never accepted from history.
      if (discard) Promise.resolve().then(() => providers.discardAlbumTopPreview(requestKey, {scopeKey})).catch(() => {});
    },
  };
  return Object.freeze(owner);
}
