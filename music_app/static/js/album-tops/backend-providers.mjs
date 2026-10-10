// All network replies are bound to the authenticated native context and caller scope.
import {isProgressRevision, isManualProgress} from './progress.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const fail = (message, status = 409) => Object.assign(new Error(message), {status});
const abort = () => Object.assign(new Error('Album Top request was superseded.'), {name: 'AbortError'});
const actionNames = new Set(['library.browse.read', 'library.album_tops.create', 'library.album_tops.manage',
  'library.album_tops.items.manage', 'can_create', 'can_read', 'can_edit', 'can_rename', 'can_add', 'can_remove',
  'can_reorder', 'can_delete', 'can_share', 'can_view_sharing', 'can_request_edit', 'can_copy', 'can_manage_own_progress']);
const actions = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  .filter(([key, allowed]) => typeof allowed === 'boolean' && actionNames.has(key)));
function top(value) {
  if (!uuid(value?.top_ref) || !revision(value.revision) || typeof value.title !== 'string' || typeof value.description !== 'string'
    || !['private', 'server_shared'].includes(value.visibility)) throw fail('Invalid Album Top response.');
  return {top_ref: value.top_ref, title: value.title, description: value.description,
    revision: value.revision, visibility: value.visibility, allowed_actions: actions(value.allowed_actions)};
}
const cursorValue = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096;
const member = value => {
  if (!uuid(value?.account_ref) || ![value.display_name, value.username_display].every(name => name === null || typeof name === 'string')) throw fail('Invalid Album Top member.');
  return {account_ref: value.account_ref, display_name: value.display_name, username_display: value.username_display};
};
const editRequest = value => {
  if (!uuid(value?.request_ref) || !uuid(value.top_ref) || typeof value.title !== 'string'
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw fail('Invalid Album Top edit request.');
  return {...member(value), request_ref: value.request_ref, top_ref: value.top_ref, title: value.title, created_at: value.created_at};
};
function rows(values, project, key) {
  if (!Array.isArray(values) || values.length > 100) throw fail('Invalid Album Top page.');
  const result = values.map(project);
  if (new Set(result.map(row => row[key])).size !== result.length) throw fail('Duplicate Album Top page entry.');
  return result;
}
function pagePath(path, options, {limit = true, query = false} = {}) {
  if (options.cursor != null && !cursorValue(options.cursor)) throw fail('Invalid Album Top cursor.');
  const params = new URLSearchParams();
  if (limit) params.set('limit', '100');
  if (options.cursor) params.set('cursor', options.cursor);
  if (query) {
    if (typeof (options.q ?? '') !== 'string' || (options.q || '').length > 100) throw fail('Invalid Album Top search.');
    params.set('q', options.q ?? '');
  }
  return path + (params.size ? '?' + params.toString() : '');
}
export function createAlbumTopBackendProviders({transport, acceptsScope}) {
  let disposed = false;
  async function request(path, options, body) {
    const context = transport.context();
    if (disposed || !context || !acceptsScope(options.scopeKey)) throw fail('Album Top context unavailable.', 403);
    if (options.signal?.aborted) throw abort();
    const response = await transport.request(path, {signal: options.signal, expected: context,
      ...(body ? {method: 'POST', body} : {})});
    if (disposed || options.signal?.aborted || transport.context() !== context || !acceptsScope(options.scopeKey)) throw abort();
    if (response?.status !== 'ready' || response.context_ref !== context || !response.data || typeof response.data !== 'object') throw fail('Album Top response was not acknowledged.', 502);
    return response.data;
  }
  const access = async (ref, options, candidates) => {
    if (!uuid(ref)) throw fail('Invalid Album Top identity.');
    const data = await request(pagePath('/album-tops/' + ref + (candidates ? '/access-candidates' : '/access-grants'), options, {query: candidates}), options);
    if (data.top_ref !== ref || !revision(data.revision) || !cursorValue(data.next_cursor)
      || !candidates && !['private', 'server_shared'].includes(data.visibility)) throw fail('Invalid Album Top access page.');
    const key = candidates ? 'candidates' : 'grants';
    return {top_ref: ref, revision: data.revision, next_cursor: data.next_cursor,
      ...(!candidates ? {visibility: data.visibility} : {}), [key]: rows(data[key], value => {
        const person = member(value);
        if (value.grant_ref !== null && !uuid(value.grant_ref) || value.role !== null && value.role !== 'editor') throw fail('Invalid Album Top editor.');
        if (candidates) {
          if (!Number.isSafeInteger(value.account_id) || value.account_id <= 0 || !value.allowed_actions || !Object.hasOwn(value.allowed_actions, 'can_grant_editor') || typeof value.allowed_actions.can_grant_editor !== 'boolean') throw fail('Invalid Album Top candidate.');
          return {...person, account_id: value.account_id, grant_ref: value.grant_ref, role: value.role,
            allowed_actions: {can_grant_editor: value.allowed_actions.can_grant_editor}};
        }
        if (!uuid(value.grant_ref) || value.role !== 'editor' || typeof value.is_active !== 'boolean') throw fail('Invalid Album Top editor grant.');
        return {...person, grant_ref: value.grant_ref, role: value.role, is_active: value.is_active};
      }, 'account_ref')};
  };
  return {
    async readSharing(ref, options) {
      if (!uuid(ref)) throw fail('Invalid Album Top identity.');
      const data = await request(pagePath('/album-tops/' + ref + '/sharing', options, {limit: false}), options);
      if (data.top_ref !== ref || !revision(data.revision) || !['private', 'server_shared'].includes(data.visibility)
        || !['can_manage', 'can_request_edit', 'can_copy'].every(key => Object.hasOwn(data, key) && typeof data[key] === 'boolean')
        || !['none', 'pending', 'approved', 'declined'].includes(data.request_status) || !cursorValue(data.next_pending_cursor)) throw fail('Invalid Album Top sharing.');
      const pending_requests = rows(data.pending_requests, editRequest, 'request_ref');
      if (pending_requests.some(row => row.top_ref !== ref) || !data.can_manage && (pending_requests.length || data.next_pending_cursor)) throw fail('Invalid Album Top request scope.');
      return {top_ref: ref, revision: data.revision, visibility: data.visibility, can_manage: data.can_manage,
        can_request_edit: data.can_request_edit, can_copy: data.can_copy, request_status: data.request_status,
        pending_requests, next_pending_cursor: data.next_pending_cursor};
    },
    readAccessGrants: (ref, options) => access(ref, options, false),
    readAccessCandidates: (ref, options) => access(ref, options, true),
    async readEditRequests(options) {
      const data = await request(pagePath('/album-tops/edit-requests', options), options);
      if (!cursorValue(data.next_cursor)) throw fail('Invalid Album Top notification page.');
      return {requests: rows(data.requests, editRequest, 'request_ref'), next_cursor: data.next_cursor};
    },
    async list(options) {
      const result = {tops: [], allowed_actions: {}, next_cursor: null};
      const seen = new Set(), cursors = new Set(); let cursor = null;
      do {
        const data = await request('/album-tops?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), options);
        if (!Array.isArray(data.tops) || data.tops.length > 100 || data.next_cursor !== null && typeof data.next_cursor !== 'string') throw fail('Invalid Album Top directory.');
        for (const row of data.tops) {const entry = top(row); if (seen.has(entry.top_ref)) throw fail('Album Top directory changed.'); seen.add(entry.top_ref); result.tops.push(entry);}
        result.allowed_actions = actions(data.allowed_actions);
        if (data.next_cursor && cursors.has(data.next_cursor) || cursors.size >= 100 || result.tops.length > 10000) throw fail('Album Top directory is too large.');
        cursor = data.next_cursor; if (cursor) cursors.add(cursor);
      } while (cursor);
      return result;
    },
    async read(ref, options) {
      if (!uuid(ref)) throw fail('Invalid Album Top identity.');
      const data = await request('/album-tops/' + ref, options), result = top(data);
      if (result.top_ref !== ref || !Array.isArray(data.items) || data.items.length > 5000) throw fail('Invalid Album Top detail.');
      result.items = data.items.map(row => {
        if (!uuid(row?.ref) || !uuid(row.catalog_ref) || typeof row.title !== 'string' || typeof row.artist_display !== 'string') throw fail('Invalid Album Top album.');
        return {item_ref: row.ref, album_ref: row.catalog_ref, title: row.title, artist: row.artist_display,
          year: Number.isInteger(row.release_year) ? row.release_year : null, original_position: row.original_position, position: row.curator_position};
      });
      if (Object.hasOwn(data, 'top_viewer_overlay')) {
        const overlay = data.top_viewer_overlay, progress = overlay?.item_progress;
        if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)
          || !Object.hasOwn(overlay, 'item_progress') || !progress || typeof progress !== 'object' || Array.isArray(progress)
          || Object.keys(progress).length !== result.items.length
          || new Set(result.items.map(item => item.album_ref)).size !== result.items.length) throw fail('Invalid Album Top progress.');
        result.top_viewer_overlay = {item_progress: Object.fromEntries(result.items.map(item => {
          const row = Object.hasOwn(progress, item.album_ref) ? progress[item.album_ref] : null;
          if (!isManualProgress(row)) throw fail('Invalid Album Top progress.');
          return [item.album_ref, {progress_revision: row.progress_revision, manual_completed_at: row.manual_completed_at}];
        }))};
      }
      return result;
    },
    async execute(action, command, options) {
      const {top_ref, ...body} = command;
      if (!uuid(body.request_key) || !['create', 'save', 'add', 'remove', 'reorder', 'delete', 'visibility', 'grant_editor', 'revoke_editor', 'request_edit', 'decide_edit_request', 'copy', 'set_manual_completion'].includes(action) || action !== 'create' && !uuid(top_ref)) throw fail('Invalid Album Top command.');
      if (action === 'set_manual_completion' && (!uuid(body.album_ref) || !isProgressRevision(body.progress_revision)
        || typeof body.completed !== 'boolean' || Object.keys(body).length !== 4)) throw fail('Invalid Album Top progress command.');
      const data = await request(action === 'create' ? '/album-tops' : '/album-tops/' + top_ref + '/' + action, options, body);
      if (action === 'set_manual_completion') {
        if (data.top_ref !== top_ref || data.album_ref !== body.album_ref || data.action !== action
          || data.request_key !== body.request_key || !isManualProgress(data) || typeof data.changed !== 'boolean'
          || Object.hasOwn(data, 'revision') || (data.manual_completed_at !== null) !== body.completed
          || BigInt(data.progress_revision) !== BigInt(body.progress_revision) + (data.changed ? 1n : 0n)) throw fail('Album Top progress was not acknowledged.', 502);
        return {top_ref, album_ref: data.album_ref, action, request_key: data.request_key,
          progress_revision: data.progress_revision, manual_completed_at: data.manual_completed_at, changed: data.changed};
      }
      if (!uuid(data.top_ref) || !revision(data.revision) || data.action !== action || data.request_key !== body.request_key || !['create', 'copy'].includes(action) && data.top_ref !== top_ref
        || action === 'copy' && (data.source_top_ref !== top_ref || data.source_revision !== body.revision || data.top_ref === top_ref)) throw fail('Album Top write was not acknowledged.', 502);
      return {top_ref: data.top_ref, revision: data.revision, action, request_key: data.request_key,
        ...(action === 'copy' ? {source_top_ref: data.source_top_ref, source_revision: data.source_revision} : {})};
    },
    dispose() {disposed = true;},
  };
}
