// All network replies are bound to the authenticated native context and caller scope.
import {isProgressRevision, isManualProgress, isTopActivity, projectCompleteTopProgress} from './progress.mjs';
import {isPublicationRevision, projectOwnerPublication, projectPublicationReceipt} from './publication.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const fail = (message, status = 409) => Object.assign(new Error(message), {status});
const abort = () => Object.assign(new Error('Album Top request was superseded.'), {name: 'AbortError'});
// Match the existing command and publication-preview route body limit.
const MAX_TOP_COMMAND_BYTES = 512 * 1024;
const actionNames = new Set(['library.browse.read', 'library.album_tops.create', 'library.album_tops.manage',
  'library.album_tops.items.manage', 'can_create', 'can_read', 'can_edit', 'can_rename', 'can_add', 'can_remove',
  'can_reorder', 'can_delete', 'can_share', 'can_view_sharing', 'can_request_edit', 'can_copy', 'can_manage_own_progress', 'can_set_activity']);
const actions = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  .filter(([key, allowed]) => typeof allowed === 'boolean' && actionNames.has(key)));
function activityOverlay(value) {
  if (!Object.hasOwn(value, 'top_viewer_overlay')) return {};
  const overlay = value.top_viewer_overlay;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw fail('Invalid Album Top overlay.');
  if (!Object.hasOwn(overlay, 'activity')) return {};
  if (!isTopActivity(overlay.activity)) throw fail('Invalid Album Top activity.');
  return {top_viewer_overlay: {activity: {active: overlay.activity.active, activity_revision: overlay.activity.activity_revision}}};
}
function top(value) {
  if (!uuid(value?.top_ref) || !revision(value.revision) || typeof value.title !== 'string' || typeof value.description !== 'string'
    || !['private', 'server_shared'].includes(value.visibility)) throw fail('Invalid Album Top response.');
  if (Object.hasOwn(value, 'type') && (typeof value.type !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(value.type))
    || Object.hasOwn(value, 'source_locked') && typeof value.source_locked !== 'boolean') throw fail('Invalid Album Top editing eligibility.');
  return {top_ref: value.top_ref, title: value.title, description: value.description,
    revision: value.revision, visibility: value.visibility, allowed_actions: actions(value.allowed_actions), ...activityOverlay(value),
    ...(Object.hasOwn(value, 'type') ? {type: value.type} : {}),
    ...(Object.hasOwn(value, 'source_locked') ? {source_locked: value.source_locked} : {})};
}
const cursorValue = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096;
const localId = value => Number.isSafeInteger(value) && value > 0;
function sourceLabel(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const characters = Array.from(value);
  return characters.length <= 1000 && characters.every(character => {
    const code = character.codePointAt(0); return code < 0xd800 || code > 0xdfff;
  });
}
function publicationSource(value) {
  if (!localId(value?.selected_local_album_id) || !uuid(value.selected_source_ref)
    || !sourceLabel(value.title) || !sourceLabel(value.artist)
    || value.year !== null && (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999)) throw fail('Invalid Album Top publication source.');
  return {selected_local_album_id: value.selected_local_album_id, selected_source_ref: value.selected_source_ref,
    title: value.title, artist: value.artist, year: value.year};
}
function albumSummary(value) {
  if (!localId(value?.local_album_id) || value.album_ref !== null && !uuid(value.album_ref)
    || typeof value.title !== 'string' || typeof value.artist !== 'string'
    || value.year !== null && (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999)) throw fail('Invalid Album Top search result.');
  return {local_album_id: value.local_album_id, album_ref: value.album_ref, title: value.title, artist: value.artist, year: value.year};
}
function draftItem(value) {
  if (!uuid(value?.album_ref) || value.item_ref !== null && !uuid(value.item_ref)) throw fail('Invalid Album Top draft.');
  const hasLocal = Object.hasOwn(value, 'selected_local_album_id'), hasSource = Object.hasOwn(value, 'selected_source_ref');
  if (hasLocal !== hasSource || hasLocal && (!localId(value.selected_local_album_id) || !uuid(value.selected_source_ref))) throw fail('Invalid Album Top source binding.');
  return {item_ref: value.item_ref, album_ref: value.album_ref,
    ...(hasSource ? {selected_local_album_id: value.selected_local_album_id, selected_source_ref: value.selected_source_ref} : {})};
}
function draftItems(values) {
  if (!Array.isArray(values) || values.length > 5000) throw fail('Invalid Album Top draft.');
  const result = values.map(draftItem), retained = result.filter(row => row.item_ref !== null);
  if (new Set(result.map(row => row.album_ref)).size !== result.length || new Set(retained.map(row => row.item_ref)).size !== retained.length) throw fail('Duplicate Album Top draft item.');
  return result;
}
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
    if (body && new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_TOP_COMMAND_BYTES) {
      throw Object.assign(fail('Album Top request exceeds the server size limit.', 413), {code: 'command_too_large'});
    }
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
        if (value.grant_ref !== null && !uuid(value.grant_ref) || value.role !== null && !['viewer', 'editor'].includes(value.role)) throw fail('Invalid Album Top access role.');
        if ((value.grant_ref === null) !== (value.role === null)) throw fail('Invalid Album Top access role.');
        if (!Number.isSafeInteger(value.account_id) || value.account_id <= 0) throw fail('Invalid Album Top member.');
        if (candidates) {
          if (!value.allowed_actions || !['can_grant_viewer', 'can_grant_editor'].every(key => Object.hasOwn(value.allowed_actions, key) && typeof value.allowed_actions[key] === 'boolean')) throw fail('Invalid Album Top candidate.');
          return {...person, account_id: value.account_id, grant_ref: value.grant_ref, role: value.role,
            allowed_actions: {can_grant_editor: value.allowed_actions.can_grant_editor, can_grant_viewer: value.allowed_actions.can_grant_viewer}};
        }
        if (!uuid(value.grant_ref) || !['viewer', 'editor'].includes(value.role) || typeof value.is_active !== 'boolean') throw fail('Invalid Album Top access grant.');
        return {...person, account_id: value.account_id, grant_ref: value.grant_ref, role: value.role, is_active: value.is_active};
      }, 'account_ref')};
  };
  return {
    async searchAlbums(options) {
      const q = options.q ?? '';
      if (typeof q !== 'string' || q.length > 100 || q.includes('\0') || options.topRef != null && !uuid(options.topRef)
        || options.cursor != null && !cursorValue(options.cursor)) throw fail('Invalid Album Top search.');
      if (!q.trim()) return {albums: [], next_cursor: null};
      const path = pagePath('/album-top-catalog/search', {...options, q: q.trim()}, {query: true})
        + (options.topRef ? '&top_ref=' + encodeURIComponent(options.topRef) : '');
      const data = await request(path, options);
      if (!cursorValue(data.next_cursor)) throw fail('Invalid Album Top search cursor.');
      return {albums: rows(data.albums, albumSummary, 'local_album_id'), next_cursor: data.next_cursor};
    },
    async admitAlbum(albumId, options) {
      if (!localId(albumId) || options.topRef != null && !uuid(options.topRef)) throw fail('Invalid Album Top album identity.');
      const path = options.topRef ? '/album-tops/' + options.topRef + '/catalog/inventory' : '/album-top-catalog/inventory';
      const data = await request(path, options, {album_id: albumId});
      if (!uuid(data.album_ref)) throw fail('Invalid Album Top admission.');
      return {album_ref: data.album_ref};
    },
    async preview(ref, payload, options) {
      if (!uuid(ref) || !revision(payload?.revision)) throw fail('Invalid Album Top preview.');
      const items = draftItems(payload.items);
      if (items.some(row => !row.selected_source_ref)) throw fail('Album Top publication source evidence is unavailable.');
      const data = await request('/album-tops/' + ref + '/publication-preview', options, {revision: payload.revision, items});
      if (data.top_ref !== ref || data.revision !== payload.revision || typeof data.evidence_revision !== 'string'
        || !/^[0-9a-f]{64}$/.test(data.evidence_revision)
        || JSON.stringify(draftItems(data.items)) !== JSON.stringify(items)) throw fail('Album Top preview no longer matches this draft.');
      return {top_ref: ref, revision: data.revision, evidence_revision: data.evidence_revision,
        items: data.items.map((row, index) => {
          if (typeof row.title !== 'string' || typeof row.artist !== 'string' || row.year !== null && (!Number.isInteger(row.year) || row.year < 1 || row.year > 9999)
            || !Number.isSafeInteger(row.track_count) || row.track_count < 0 || row.track_count > 5000) throw fail('Invalid Album Top preview metadata.');
          return {...items[index], title: row.title, artist: row.artist, year: row.year, track_count: row.track_count};
        })};
    },
    async readPublicationSources(ref, itemRef, options) {
      const {albumRef, revision: expectedRevision, cursor} = options, limit = options.limit === undefined ? 100 : options.limit;
      if (!uuid(ref) || !uuid(itemRef) || !uuid(albumRef) || !isPublicationRevision(expectedRevision)
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || cursor != null && !cursorValue(cursor)) throw fail('Invalid Album Top publication source query.');
      const params = new URLSearchParams({revision: expectedRevision, limit: String(limit)});
      if (cursor) params.set('cursor', cursor);
      const data = await request('/album-tops/' + ref + '/items/' + itemRef + '/publication-sources?' + params.toString(), options);
      if (data.top_ref !== ref || data.item_ref !== itemRef || data.album_ref !== albumRef || data.revision !== expectedRevision
        || !Array.isArray(data.sources) || data.sources.length > limit || !cursorValue(data.next_cursor)
        || data.next_cursor !== null && data.next_cursor === cursor) throw fail('Invalid Album Top publication source page.');
      const sources = data.sources.map(publicationSource), seen = new Set();
      for (let index = 0; index < sources.length; index++) {
        const row = sources[index], previous = sources[index - 1];
        if (seen.has(row.selected_source_ref) || previous && (previous.selected_local_album_id > row.selected_local_album_id
          || previous.selected_local_album_id === row.selected_local_album_id && previous.selected_source_ref >= row.selected_source_ref)) throw fail('Invalid Album Top publication source order.');
        seen.add(row.selected_source_ref);
      }
      return {top_ref: ref, revision: data.revision, item_ref: itemRef, album_ref: data.album_ref, sources, next_cursor: data.next_cursor};
    },
    async readSharing(ref, options) {
      if (!uuid(ref)) throw fail('Invalid Album Top identity.');
      const data = await request(pagePath('/album-tops/' + ref + '/sharing', options, {limit: false}), options);
      if (data.top_ref !== ref || !isPublicationRevision(data.revision) || !['private', 'server_shared'].includes(data.visibility)
        || !['can_manage', 'can_request_edit', 'can_copy'].every(key => Object.hasOwn(data, key) && typeof data[key] === 'boolean')
        || !['none', 'pending', 'approved', 'declined'].includes(data.request_status) || !cursorValue(data.next_pending_cursor)) throw fail('Invalid Album Top sharing.');
      const pending_requests = rows(data.pending_requests, editRequest, 'request_ref');
      if (pending_requests.some(row => row.top_ref !== ref) || !data.can_manage && (pending_requests.length || data.next_pending_cursor)) throw fail('Invalid Album Top request scope.');
      return {top_ref: ref, revision: data.revision, visibility: data.visibility, can_manage: data.can_manage,
        can_request_edit: data.can_request_edit, can_copy: data.can_copy, request_status: data.request_status,
        pending_requests, next_pending_cursor: data.next_pending_cursor,
        ...(Object.hasOwn(data, 'publication') ? {publication: projectOwnerPublication(data.publication)} : {})};
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
      if (result.top_ref !== ref || !Array.isArray(data.items) || data.items.length > 5000
        || Object.hasOwn(data, 'next_cursor') && data.next_cursor !== null) throw fail('Invalid Album Top detail.');
      result.items = data.items.map(row => {
        if (!uuid(row?.ref) || !uuid(row.catalog_ref) || typeof row.title !== 'string' || typeof row.artist_display !== 'string') throw fail('Invalid Album Top album.');
        return {item_ref: row.ref, album_ref: row.catalog_ref, title: row.title, artist: row.artist_display,
          year: Number.isInteger(row.release_year) ? row.release_year : null, original_position: row.original_position, position: row.curator_position};
      });
      if (Object.hasOwn(data, 'edit_draft')) {
        const draft = data.edit_draft, items = draftItems(draft?.items);
        if (typeof draft.publication_preview_required !== 'boolean' || items.length !== result.items.length
          || items.some((row, index) => row.item_ref !== result.items[index].item_ref || row.album_ref !== result.items[index].album_ref)) throw fail('Invalid Album Top editing projection.');
        result.edit_draft = {items, publication_preview_required: draft.publication_preview_required};
      }
      if (Object.hasOwn(data, 'top_viewer_overlay')) {
        const overlay = data.top_viewer_overlay, progress = overlay?.item_progress;
        if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)
          || !Object.hasOwn(overlay, 'item_progress') || !progress || typeof progress !== 'object' || Array.isArray(progress)
          || Object.keys(progress).length !== result.items.length
          || new Set(result.items.map(item => item.album_ref)).size !== result.items.length) throw fail('Invalid Album Top progress.');
        result.top_viewer_overlay = {...result.top_viewer_overlay, item_progress: Object.fromEntries(result.items.map(item => {
          const row = Object.hasOwn(progress, item.album_ref) ? progress[item.album_ref] : null;
          if (!isManualProgress(row)) throw fail('Invalid Album Top progress.');
          return [item.album_ref, {progress_revision: row.progress_revision, manual_completed_at: row.manual_completed_at}];
        }))};
      }
      // This endpoint returns all Top members; list/search pages cannot supply this count.
      result.completion_summary = projectCompleteTopProgress(result.items, result.top_viewer_overlay?.item_progress);
      return result;
    },
    async execute(action, command, options) {
      const {top_ref, ...body} = command;
      if (!uuid(body.request_key) || !['create', 'save', 'enable_external', 'revoke_external', 'add', 'remove', 'reorder', 'delete', 'visibility', 'grant_editor', 'grant_viewer', 'revoke_editor', 'request_edit', 'decide_edit_request', 'copy', 'set_manual_completion', 'set_activity'].includes(action) || action !== 'create' && !uuid(top_ref)) throw fail('Invalid Album Top command.');
      if (action === 'enable_external' || action === 'revoke_external') {
        const keys = action === 'enable_external' ? ['request_key', 'revision', 'items', 'evidence_revision'] : ['request_key', 'revision'];
        if (!isPublicationRevision(body.revision) || Object.keys(body).length !== keys.length
          || !keys.every(key => Object.hasOwn(body, key))) throw fail('Invalid Album Top publication command.');
        if (action === 'enable_external') {
          if (typeof body.evidence_revision !== 'string' || !/^[0-9a-f]{64}$/.test(body.evidence_revision)) throw fail('Invalid Album Top publication evidence.');
          body.items = draftItems(body.items);
          if (body.items.some(row => row.item_ref === null || !row.selected_source_ref)) throw fail('Invalid Album Top saved publication selection.');
        }
      }
      if (action === 'set_manual_completion' && (!uuid(body.album_ref) || !isProgressRevision(body.progress_revision)
        || typeof body.completed !== 'boolean' || Object.keys(body).length !== 4)) throw fail('Invalid Album Top progress command.');
      if (action === 'set_activity' && (!isTopActivity(body) || Object.keys(body).length !== 3)) throw fail('Invalid Album Top activity command.');
      const data = await request(action === 'create' ? '/album-tops' : '/album-tops/' + top_ref + '/' + action, options, body);
      if (action === 'set_activity') {
        if (data.top_ref !== top_ref || data.action !== action || data.request_key !== body.request_key
          || !isTopActivity(data) || typeof data.changed !== 'boolean' || data.active !== body.active
          || Object.hasOwn(data, 'revision')
          || BigInt(data.activity_revision) !== BigInt(body.activity_revision) + (data.changed ? 1n : 0n)) throw fail('Album Top activity was not acknowledged.', 502);
        return {top_ref, action, request_key: data.request_key, active: data.active,
          activity_revision: data.activity_revision, changed: data.changed};
      }
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
      const publication = Object.hasOwn(data, 'publication') ? projectPublicationReceipt(data.publication) : undefined;
      if ((action === 'enable_external' || action === 'revoke_external')
        && (!isPublicationRevision(data.revision) || BigInt(data.revision) !== BigInt(body.revision) + 1n
          || publication?.state !== (action === 'enable_external' ? 'enabled' : 'revoked'))) throw fail('Album Top publication was not acknowledged.', 502);
      return {top_ref: data.top_ref, revision: data.revision, action, request_key: data.request_key,
        ...(action === 'copy' ? {source_top_ref: data.source_top_ref, source_revision: data.source_revision} : {}),
        ...(publication ? {publication} : {})};
    },
    dispose() {disposed = true;},
  };
}
