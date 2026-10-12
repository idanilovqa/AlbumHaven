import {detailSelection} from './resource-target.mjs';

// Provider-owned account/history projections. This module has no transport or
// persistence: optional integrations must supply authenticated providers.
export function resource(status = 'unavailable', data = null) {
  return Object.freeze({ status, data });
}

const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function metric(value) {
  return validNumber(value) ? String(value) : '–';
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.trim().length > 0;
const text = value => typeof value === 'string' ? value : '';
const nullableNumber = value => validNumber(value) ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const freeze = Object.freeze;
const invalid = () => { throw new TypeError('Invalid Home/Friends provider response.'); };
const HISTORY_PAGE_SIZE = 100;

function activityPagination(data, rowCount) {
  if (!Object.hasOwn(data, 'pagination') || data.pagination == null) return null;
  const value = data.pagination;
  if (!object(value) || !['mode', 'page', 'page_size', 'total_rows'].every(key => Object.hasOwn(value, key))
    || value.mode !== 'numbered' || value.page_size !== HISTORY_PAGE_SIZE
    || !Number.isSafeInteger(value.page) || value.page < 1
    || !Number.isSafeInteger(value.total_rows) || value.total_rows < 0) invalid();
  const totalPages = Math.max(1, Math.ceil(value.total_rows / HISTORY_PAGE_SIZE));
  if (value.page > totalPages || rowCount !== Math.min(HISTORY_PAGE_SIZE,
    Math.max(0, value.total_rows - (value.page - 1) * HISTORY_PAGE_SIZE)) || data.next_cursor != null) invalid();
  return freeze({ mode: 'numbered', page: value.page, page_size: HISTORY_PAGE_SIZE, total_rows: value.total_rows });
}

function activityNavigation(data = null, mode = null, query = null) {
  const pagination = data?.pagination;
  return freeze({ mode: pagination ? 'numbered' : mode ?? (data?.next_cursor ? 'progressive' : 'none'),
    status: 'idle', query, page: pagination?.page ?? null, pageSize: HISTORY_PAGE_SIZE,
    totalPages: pagination ? Math.max(1, Math.ceil(pagination.total_rows / HISTORY_PAGE_SIZE)) : null,
    totalRows: pagination?.total_rows ?? null, loadedCount: data?.rows.length ?? 0,
    hasMore: !pagination && !!data?.next_cursor, requestedPage: null });
}

// Server-owned image references cannot smuggle active, local-file, data, or
// foreign blob schemes into either the image renderer or the native lightbox.
export function safeAvatarUrl(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const relative = value.startsWith('/') && !value.startsWith('//');
  if (!relative && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value, 'https://avatar.invalid');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch (_error) { return null; }
}

export function safeServerArtworkUrl(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\u0000-\u0020\u007f]/.test(value) ? value : null;
}

export function validAvatarFile(value) {
  return typeof Blob === 'function' && value instanceof Blob && typeof value.name === 'string'
    && ['image/png', 'image/jpeg', 'image/webp'].includes(value.type)
    && value.size > 0 && value.size <= 5 * 1024 * 1024;
}

export function validProfileDraft(value) {
  return object(value) && ['display_name', 'handle', 'bio'].every(key => Object.hasOwn(value, key) && typeof value[key] === 'string')
    && value.display_name.trim().length > 0 && value.display_name.length <= 50
    && /^[A-Za-z0-9_]{3,30}$/.test(value.handle) && value.bio.length <= 240;
}

export function validMemberQuery(value) {
  return typeof value === 'string' && value.length <= 100 && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function actions(value, names) {
  return freeze(Object.fromEntries(names.map(name => [name, object(value) && Object.hasOwn(value, name) && value[name] === true])));
}
function rows(value, normalize, key) {
  if (!Array.isArray(value)) invalid();
  const result = Array.from(value, row => { if (!object(row)) invalid(); return normalize(row); });
  if (key && new Set(result.map(row => row[key])).size !== result.length) invalid();
  return freeze(result);
}
const relationships = ['none', 'incoming_pending', 'outgoing_pending', 'accepted', 'blocked', 'self'];
function personFields(row) {
  return { account_ref: Object.hasOwn(row, 'account_ref') && reference(row.account_ref) ? row.account_ref : null, display_name: text(row.display_name),
    handle: text(row.handle), bio: text(row.bio), avatar_url: safeAvatarUrl(row.avatar_url) };
}
// A route or a fetched profile is never a source grant. Resolve the person only
// from a current authorized directory, request, or discovery projection.
export function profilePerson(state, accountRef) {
  if (!reference(accountRef)) return null;
  const ready = value => ['ready', 'empty'].includes(value?.status);
  const candidates = [
    ...(ready(state.friends) ? state.friends.data?.friends ?? [] : []),
    ...(ready(state.friends) ? state.friends.data?.requests ?? [] : []),
    ...(ready(state.members) ? state.members.data?.members ?? [] : []),
  ];
  return candidates.find(row => row.account_ref === accountRef && row.allowed_actions.can_view_profile === true) ?? null;
}
function profileData(data) {
  if (!object(data) || !Object.hasOwn(data, 'account_ref') || !reference(data.account_ref) || !relationships.includes(data.relationship)) invalid();
  return freeze({ ...personFields(data), relationship: data.relationship,
    allowed_actions: actions(data.allowed_actions, ['can_view_profile', 'can_view_activity', 'can_compare', 'can_request',
      'can_accept', 'can_decline', 'can_cancel', 'can_remove', 'can_block']) });
}
function recentData(data) {
  if (!object(data)) invalid();
  const normalize = row => freeze({ ...row, allowed_actions: actions(row.allowed_actions, ['can_open_album', 'can_play_album', 'can_view_details']) });
  return freeze({
    recent_local_albums: rows(data.recent_local_albums, normalize),
    recent_not_local_albums: rows(data.recent_not_local_albums, normalize),
  });
}
function friendsData(data) {
  if (!object(data)) invalid();
  const friends = rows(data.friends, row => {
    if (!Object.hasOwn(row, 'account_ref') || !reference(row.account_ref) || row.relationship !== 'accepted') invalid();
    return freeze({ ...personFields(row),
      relationship: row.relationship,
      allowed_actions: actions(row.allowed_actions, ['can_view_profile', 'can_view_activity', 'can_compare', 'can_remove', 'can_block']) });
  }, 'account_ref');
  const requests = rows(data.requests, row => {
    if (!reference(row.request_ref) || !['incoming', 'outgoing'].includes(row.direction)) invalid();
    return freeze({ ...personFields(row), request_ref: row.request_ref, created_at: timestamp(row.created_at),
      relationship: row.direction === 'incoming' ? 'incoming_pending' : 'outgoing_pending', direction: row.direction,
      allowed_actions: actions(row.allowed_actions, ['can_view_profile', 'can_accept', 'can_decline', 'can_cancel']) });
  }, 'request_ref');
  if (data.profile != null && !object(data.profile)) invalid();
  const profile = data.profile == null ? null : freeze({ display_name: text(data.profile.display_name),
    handle: text(data.profile.handle), bio: text(data.profile.bio), avatar_url: safeAvatarUrl(data.profile.avatar_url),
    allowed_actions: actions(data.profile.allowed_actions, ['can_edit', 'can_upload_avatar']) });
  return freeze({ friends, requests, profile, allowed_actions: actions(data.allowed_actions, ['can_request', 'can_discover_members']) });
}
function membersData(data) {
  if (!object(data) || !Array.isArray(data.members) || data.members.length > 100) invalid();
  return freeze({ members: rows(data.members, row => {
    if (!Object.hasOwn(row, 'account_ref') || !reference(row.account_ref)
      || !relationships.includes(row.relationship)) invalid();
    return freeze({ ...personFields(row), relationship: row.relationship,
      allowed_actions: actions(row.allowed_actions, ['can_view_profile', 'can_request']) });
  }, 'account_ref'), next_cursor: cursor(data.next_cursor) });
}
function historyIdentity(row) {
  if (!reference(row.id) || !['track', 'album', 'artist', 'listen'].includes(row.kind)) invalid();
  return { id: row.id, kind: row.kind, title: text(row.title), artist: text(row.artist) };
}
function cursor(value) {
  if (value != null && !reference(value)) invalid();
  return value ?? null;
}
function activityTrackPreference(value) {
  if (!object(value)) return null;
  const identity = reference(value.identity) ? value.identity : null;
  return freeze({identity,
    love_tier: ['off', 'loved', 'obsessed'].includes(value.love_tier) ? value.love_tier : null,
    rating: Number.isInteger(value.rating) && value.rating >= 1 && value.rating <= 5 ? value.rating : null,
    allowed_actions: actions(identity ? value.allowed_actions : null, ['can_set_love_tier'])});
}
function deniedActivityRow(identity) {
  return freeze({id: identity.id, kind: identity.kind,
    title: `Unavailable ${identity.kind === 'listen' ? 'track' : identity.kind}`, artist: '', album_title: '', artwork_url: null,
    source_readable: false, listen_count: null, last_listened_at: null, duration_seconds: null, rating: null,
    source_label: '', detail_ref: null, allowed_actions: actions(null, ['can_view_details']),
    ...(['track', 'listen'].includes(identity.kind) ? {secondary_artist: '', availability: 'unresolved', love_tier: null, track_preference: null} : {})});
}
function activityRevocations(previous, result) {
  const envelope = object(result) && Object.hasOwn(result, 'status');
  const data = envelope ? ['ready', 'empty'].includes(result.status) ? result.data : null : result;
  const incoming = object(data) && Array.isArray(data.rows) ? Array.from(data.rows) : null;
  // Paging metadata may be malformed, but valid identified denials still
  // revoke held facts. Nothing else from this response enters the old page.
  if (!incoming || incoming.some(row => !object(row)
    || !reference(row.id) || !['track', 'listen', 'album', 'artist'].includes(row.kind))
    || new Set(incoming.map(row => row.id)).size !== incoming.length) return null;
  const denied = new Set(incoming.filter(row => Object.hasOwn(row, 'source_readable') && row.source_readable === false).map(row => row.id));
  const reconciled = previous.rows.map(row => denied.has(row.id) ? deniedActivityRow(row) : row);
  return reconciled.some((row, index) => row !== previous.rows[index]) ? freeze({...previous, rows: freeze(reconciled)}) : null;
}
function activityData(data) {
  if (!object(data)) invalid();
  const normalizedRows = rows(data.rows, row => {
    const identity = historyIdentity(row), track = ['track', 'listen'].includes(row.kind);
    if (row.source_readable === false) return deniedActivityRow(identity);
    return freeze({ ...identity,
      source_readable: true,
      album_target: row.album_target?.kind === 'album' ? detailSelection(row.album_target) : null,
      artist_target: row.artist_target?.kind === 'artist' ? detailSelection(row.artist_target) : null,
      listen_count: nullableNumber(row.listen_count), last_listened_at: timestamp(row.last_listened_at),
      album_title: text(row.album_title), artwork_url: safeServerArtworkUrl(row.artwork_url),
      ...(track ? {
        availability: ['local', 'missing', 'unresolved'].includes(row.availability) ? row.availability : 'unresolved',
        secondary_artist: text(row.secondary_artist),
        love_tier: ['off', 'loved', 'obsessed'].includes(row.love_tier) ? row.love_tier : null,
        track_preference: activityTrackPreference(row.track_preference),
      } : {}),
      favorite: typeof row.favorite === 'boolean' ? row.favorite : null,
      taste_state: text(row.taste_state),
      duration_seconds: nullableNumber(row.duration_seconds),
      rating: Number.isInteger(row.rating) && row.rating >= 1
        && row.rating <= (track ? 5 : row.kind === 'album' ? 10 : 0) ? row.rating : null,
      source_label: text(row.source_label), detail_ref: reference(row.detail_ref) ? row.detail_ref : null,
      allowed_actions: actions(row.allowed_actions, ['can_view_details']) });
  }, 'id');
  return freeze({ rows: normalizedRows, pagination: activityPagination(data, normalizedRows.length),
    snapshot_ref: reference(data.snapshot_ref) ? data.snapshot_ref : null,
    total_listens: nullableNumber(data.total_listens), period_label: text(data.period_label),
    range_label: text(data.range_label), next_cursor: cursor(data.next_cursor) });
}
function comparisonData(data) {
  if (!object(data)) invalid();
  function side(value, kind) {
    if (value == null) return null;
    if (!object(value)) invalid();
    return freeze({ listen_count: nullableNumber(value.listen_count),
      rating: Number.isInteger(value.rating) && value.rating >= 1
        && value.rating <= (['track', 'listen'].includes(kind) ? 5 : kind === 'album' ? 10 : 0) ? value.rating : null,
      play_count: nullableNumber(value.play_count), full_listen_count: nullableNumber(value.full_listen_count),
      favorite: typeof value.favorite === 'boolean' ? value.favorite : null,
      last_listened_at: timestamp(value.last_listened_at) });
  }
  return freeze({ rows: rows(data.rows, row => freeze({ ...historyIdentity(row),
    artwork_url: safeServerArtworkUrl(row.artwork_url),
    yours: side(row.yours, row.kind), friend: side(row.friend, row.kind) }), 'id'),
    total_listens: nullableNumber(data.total_listens), period_label: text(data.period_label),
    range_label: text(data.range_label), next_cursor: cursor(data.next_cursor) });
}
const emptyData = {
  recent: data => !data.recent_local_albums.length && !data.recent_not_local_albums.length,
  friends: data => !data.friends.length && !data.requests.length,
  members: data => !data.members.length,
  activity: data => !data.rows.length,
  comparison: data => !data.rows.length,
  profile: () => false,
};
const normalizeData = { recent: recentData, friends: friendsData, members: membersData, activity: activityData, comparison: comparisonData, profile: profileData };
function readResult(channel, result) {
  let status = 'ready', data = result;
  if (object(result) && Object.hasOwn(result, 'status')) {
    ({ status, data } = result);
    if (!['ready', 'empty', 'denied', 'unavailable'].includes(status)) invalid();
    if (status === 'denied' || status === 'unavailable') return resource(status);
    if (status === 'empty' && data == null) return resource('empty');
  }
  const normalized = normalizeData[channel](data);
  const empty = emptyData[channel](normalized);
  if (status === 'empty' && !empty) invalid();
  return resource(empty ? 'empty' : 'ready', normalized);
}
const providerNames = ['readFriends', 'readMembers', 'readProfile', 'readActivity', 'readComparison', 'requestFriend', 'requestMember', 'acceptRequest',
  'declineRequest', 'cancelRequest', 'removeFriend', 'blockFriend', 'saveProfile'];
const mutationSpec = {
  requestFriend: ['can_request', 'handle'],
  requestMember: ['can_request', 'account_ref'],
  acceptRequest: ['can_accept', 'request_ref'],
  declineRequest: ['can_decline', 'request_ref'],
  cancelRequest: ['can_cancel', 'request_ref'],
  removeFriend: ['can_remove', 'account_ref'],
  blockFriend: ['can_block', 'account_ref'],
  saveProfile: ['can_edit', 'profile'],
};
function providerSet(value) {
  return Object.fromEntries(providerNames.map(name => [name, typeof value?.[name] === 'function' ? value[name] : null]));
}
function initialState(scopeKey) {
  return freeze({ scopeKey, recent: resource(), friends: resource(), members: resource(), memberQuery: null, profile: resource(), selectedProfileRef: null,
    activity: resource(), comparison: resource(),
    activityNavigation: activityNavigation(), selectedFriendRef: null, mutation: freeze({ status: 'idle', action: null, target: null, data: null }) });
}

export function createHomeFriendsController({ readRecent, providers = {}, onFriendsAuthority } = {}) {
  let currentProviders = providerSet(providers), state = initialState(null), disposed = false;
  const listeners = new Set(), requests = new Map();
  let activityQuery = null;
  const activityCursors = new Set();

  function publish(patch) {
    if (disposed) return;
    state = freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  }
  function abort(channel) {
    const request = requests.get(channel);
    requests.delete(channel);
    request?.abort();
  }
  function abortAll() {
    for (const channel of [...requests.keys()]) abort(channel);
    activityQuery = null; activityCursors.clear();
  }
  function resetActivity(status = 'unavailable') {
    abort('activity'); activityQuery = null; activityCursors.clear();
    return { activity: resource(status), activityNavigation: activityNavigation() };
  }
  function resetHistory(status = 'unavailable') {
    abort('comparison');
    return { ...resetActivity(status), comparison: resource(status) };
  }
  function resetMembers(status = 'unavailable') {
    abort('members');
    return { members: resource(status), memberQuery: null };
  }
  function resetProfile(status = 'unavailable') {
    abort('profile');
    return { profile: resource(status) };
  }
  function reconcileProfile(patch) {
    if (state.selectedProfileRef !== null && !profilePerson({ ...state, ...patch }, state.selectedProfileRef)) {
      Object.assign(patch, resetProfile('denied'), { selectedProfileRef: null });
    }
    return patch;
  }
  function selectedFriend() {
    return state.friends.data?.friends.find(row => row.account_ref === state.selectedFriendRef) ?? null;
  }
  function friendsPatch(next) {
    // Completed normalized reads and denied writes may withdraw native source
    // authority. Loading and UI/controller disposal are not permission changes.
    if (typeof onFriendsAuthority === 'function') onFriendsAuthority({scopeKey: state.scopeKey, friends: next});
    const patch = { friends: next };
    if (next.data?.allowed_actions.can_discover_members !== true) {
      Object.assign(patch, resetMembers(next.status === 'denied' || next.data ? 'denied' : 'unavailable'));
    }
    if (state.selectedFriendRef !== null) {
      const selected = next.data?.friends.find(row => row.account_ref === state.selectedFriendRef);
      if (!selected) {
        Object.assign(patch, resetHistory(next.status === 'denied' ? 'denied' : 'unavailable'), { selectedFriendRef: null });
      } else {
        if (!selected.allowed_actions.can_view_activity) Object.assign(patch, resetActivity('denied'));
        if (!selected.allowed_actions.can_compare) { abort('comparison'); patch.comparison = resource('denied'); }
      }
    }
    // A denied account projection cannot leave any earlier private history visible.
    if (next.status === 'denied') Object.assign(patch, resetHistory('denied'), { selectedFriendRef: null });
    return reconcileProfile(patch);
  }
  function activityPatch(next, args) {
    if (next.data?.pagination && (next.data.pagination.page !== 1 || args.cursor !== null)) invalid();
    if (next.data?.next_cursor && next.data.next_cursor === args.cursor) invalid();
    if (['denied', 'unavailable', 'error'].includes(next.status)) return resetActivity(next.status);
    if (args.cursor !== null) activityCursors.add(args.cursor);
    return { activity: next, activityNavigation: activityNavigation(next.data, null, activityQuery) };
  }
  function read(channel, provider, args = {}) {
    if (disposed) return Promise.resolve(resource());
    abort(channel);
    const history = channel === 'friends'
      ? { ...resetMembers(), ...resetProfile(), ...(state.selectedFriendRef !== null ? resetHistory() : {}) }
      : channel === 'members' && !profilePerson({ ...state, members: resource() }, state.selectedProfileRef) ? resetProfile() : {};
    const metadata = channel === 'members' ? { memberQuery: args.query ?? null }
      : channel === 'activity' ? { activityNavigation: activityNavigation(null, null, activityQuery) } : {};
    if (typeof provider !== 'function') {
      const next = resource();
      publish({ ...history, ...metadata, ...(channel === 'friends' ? friendsPatch(next)
        : channel === 'members' ? reconcileProfile({ [channel]: next }) : { [channel]: next }) });
      return Promise.resolve(next);
    }
    const request = new AbortController(), scopeKey = state.scopeKey;
    requests.set(channel, request);
    publish({ ...history, ...metadata, [channel]: resource('loading') });
    const active = () => !disposed && requests.get(channel) === request && !request.signal.aborted;
    if (!active()) return Promise.resolve(state[channel]);
    let result;
    try { result = provider({ scopeKey, ...args, signal: request.signal }); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(value => {
      if (!active()) return state[channel];
      let next = readResult(channel, value);
      if (channel === 'profile') {
        if (!profilePerson(state, args.account_ref) || state.selectedProfileRef !== args.account_ref) next = resource('denied');
        else if (next.data?.account_ref !== undefined && next.data.account_ref !== args.account_ref) invalid();
        else if (next.data && next.data.allowed_actions.can_view_profile !== true) next = resource('denied');
      }
      const patch = channel === 'activity' ? activityPatch(next, args)
        : channel === 'friends' ? friendsPatch(next)
          : channel === 'members' ? reconcileProfile({ [channel]: next }) : { [channel]: next };
      requests.delete(channel);
      publish(patch);
      return next;
    }).catch(error => {
      if (!active()) return state[channel];
      requests.delete(channel);
      const next = resource(error?.status === 401 || error?.status === 403 ? 'denied' : 'error');
      publish(channel === 'activity' ? resetActivity(next.status) : channel === 'friends' ? friendsPatch(next)
        : channel === 'members' ? reconcileProfile({ [channel]: next }) : { [channel]: next });
      return next;
    });
  }
  function historyRead(channel, provider, grant, options, defaultKind) {
    if (disposed) return Promise.resolve(resource());
    if (typeof provider !== 'function') return read(channel, provider);
    const { kind = defaultKind, period = 'week', cursor: nextCursor = null } = options ?? {};
    if (!['albums', 'tracks', 'artists', 'listens'].includes(kind) || !reference(period)
      || (nextCursor !== null && !reference(nextCursor))) {
      abort(channel); const next = resource('error'); publish({ [channel]: next }); return Promise.resolve(next);
    }
    const friend = selectedFriend();
    if ((channel === 'comparison' && state.selectedFriendRef === null)
      || (state.selectedFriendRef !== null && (!friend || friend.relationship !== 'accepted'
        || friend.allowed_actions[grant] !== true))) {
      abort(channel); const next = resource('denied'); publish({ [channel]: next }); return Promise.resolve(next);
    }
    return read(channel, provider, { account_ref: state.selectedFriendRef, kind, period, cursor: nextCursor });
  }
  function canReadActivity() {
    const friend = selectedFriend();
    return state.selectedProfileRef === null && (state.selectedFriendRef === null || (friend?.relationship === 'accepted'
      && friend.allowed_actions.can_view_activity === true));
  }
  function loadActivity(options = {}) {
    if (disposed) return Promise.resolve(resource());
    const patch = resetActivity();
    if (typeof currentProviders.readActivity !== 'function') {
      publish(patch); return Promise.resolve(patch.activity);
    }
    const { kind = 'albums', period = 'week', cursor: nextCursor = null } = options ?? {};
    if (!['albums', 'tracks', 'artists', 'listens'].includes(kind) || !reference(period)
      || (nextCursor !== null && !reference(nextCursor))) {
      publish({ ...patch, activity: resource('error') }); return Promise.resolve(state.activity);
    }
    if (!canReadActivity()) {
      publish({ ...patch, activity: resource('denied') }); return Promise.resolve(state.activity);
    }
    activityQuery = freeze({ account_ref: state.selectedFriendRef, kind, period });
    return read('activity', currentProviders.readActivity, { ...activityQuery, cursor: nextCursor });
  }
  function navigateActivity(page = null) {
    if (disposed) return Promise.resolve(false);
    const navigation = state.activityNavigation, append = page === null;
    if (!activityQuery || !state.activity.data || (append
      ? navigation.mode !== 'progressive' || !navigation.hasMore || requests.has('activity')
      : navigation.mode !== 'numbered' || !Number.isSafeInteger(page) || page < 1 || page > navigation.totalPages
        || (page === navigation.page && navigation.status === 'idle')
        || (page === navigation.requestedPage && navigation.status === 'loading'))) return Promise.resolve(false);
    if (!canReadActivity()) {
      const patch = resetActivity('denied'); publish(patch); return Promise.resolve(patch.activity);
    }
    if (typeof currentProviders.readActivity !== 'function') {
      const patch = resetActivity(); publish(patch); return Promise.resolve(patch.activity);
    }
    const nextCursor = append ? state.activity.data.next_cursor : null;
    if (append && activityCursors.has(nextCursor)) return Promise.resolve(false);
    abort('activity');
    const request = new AbortController(), scopeKey = state.scopeKey;
    const args = { ...activityQuery, cursor: nextCursor,
      ...(!append ? { pagination: freeze({ mode: 'numbered', page, page_size: HISTORY_PAGE_SIZE }) } : {}) };
    requests.set('activity', request);
    publish({ activityNavigation: freeze({ ...navigation, status: 'loading', requestedPage: page }) });
    const active = () => !disposed && requests.get('activity') === request && !request.signal.aborted;
    if (!active()) return Promise.resolve(false);
    let result, revokedActivity = null;
    try { result = currentProviders.readActivity({ scopeKey, ...args, signal: request.signal }); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(value => {
      if (!active()) return false;
      if (append) {
        const redacted = activityRevocations(state.activity.data, value);
        if (redacted) revokedActivity = resource(state.activity.status, redacted);
      }
      const next = readResult('activity', value);
      if (next.status === 'denied' || next.status === 'unavailable') {
        const patch = resetActivity(next.status); publish(patch); return patch.activity;
      }
      let data = next.data;
      if (append) {
        const previous = state.activity.data, ids = new Set(previous.rows.map(row => row.id));
        const incoming = new Map((data?.rows ?? []).map(row => [row.id, row]));
        if (data?.pagination || (data?.next_cursor && (data.next_cursor === nextCursor || activityCursors.has(data.next_cursor)))) invalid();
        const additions = data?.rows.filter(row => !ids.has(row.id)) ?? [];
        if (data?.rows.length && !additions.length) invalid();
        const retained = previous.rows.map(row => incoming.get(row.id) ?? row);
        data = freeze({ ...(data ?? previous), rows: freeze([...retained, ...additions]), next_cursor: data?.next_cursor ?? null });
        activityCursors.add(nextCursor);
      } else if (!data?.pagination || data.pagination.page !== page) invalid();
      const completed = resource(data.rows.length ? 'ready' : 'empty', data);
      requests.delete('activity');
      publish({ activity: completed, activityNavigation: activityNavigation(data, append ? 'progressive' : null, activityQuery) });
      return completed;
    }).catch(error => {
      if (!active()) return false;
      requests.delete('activity');
      if (error?.status === 401 || error?.status === 403) {
        const patch = resetActivity('denied'); publish(patch); return patch.activity;
      }
      publish({ ...(revokedActivity ? {activity: revokedActivity} : {}),
        activityNavigation: freeze({ ...navigation, status: 'error', requestedPage: page }) });
      return resource('error');
    });
  }
  function loadMembers(options = {}) {
    if (disposed) return Promise.resolve(resource());
    const { query, cursor: nextCursor = null } = options ?? {};
    if (typeof currentProviders.readMembers !== 'function') return read('members', null, { query: validMemberQuery(query) ? query.trim() : null });
    if (state.friends.data?.allowed_actions.can_discover_members !== true) {
      const patch = reconcileProfile(resetMembers('denied')); publish(patch); return Promise.resolve(patch.members);
    }
    if (!validMemberQuery(query) || (nextCursor !== null && !reference(nextCursor))) {
      const patch = reconcileProfile(resetMembers('error')); publish(patch); return Promise.resolve(patch.members);
    }
    return read('members', currentProviders.readMembers, { query: query.trim(), cursor: nextCursor });
  }
  function loadProfile() {
    if (disposed) return Promise.resolve(resource());
    if (!profilePerson(state, state.selectedProfileRef)) {
      const patch = resetProfile('denied'); publish(patch); return Promise.resolve(patch.profile);
    }
    return read('profile', currentProviders.readProfile, { account_ref: state.selectedProfileRef });
  }
  function mutationState(status, action, target, data = null) {
    return freeze({ status, action, target, data });
  }
  function mutationInput(action, target, value) {
    const spec = Object.hasOwn(mutationSpec, action) ? mutationSpec[action] : null;
    if (!spec) return null;
    const [grant, field] = spec, data = state.friends.data;
    const owner = action === 'saveProfile' ? data?.profile : action === 'requestFriend' ? data
      : action === 'requestMember' ? state.members.data?.members.find(row => row.account_ref === target)
      : field === 'request_ref' ? data?.requests.find(row => row.request_ref === target)
        : data?.friends.find(row => row.account_ref === target && row.relationship === 'accepted');
    if (owner?.allowed_actions?.[grant] !== true) return null;
    if (field === 'request_ref' && owner.direction !== (action === 'cancelRequest' ? 'outgoing' : 'incoming')) return null;
    if (action === 'requestMember' && (data?.allowed_actions.can_discover_members !== true || owner.relationship !== 'none')) return null;
    if (action === 'saveProfile') {
      if (target !== null || !validProfileDraft(value)) return null;
      const file = Object.hasOwn(value, 'avatar_file') ? value.avatar_file : null;
      if (file != null && (owner.allowed_actions.can_upload_avatar !== true || !validAvatarFile(file))) return null;
      return { profile: { display_name: value.display_name, handle: value.handle, bio: value.bio },
        ...(file != null ? { avatar_file: file } : {}) };
    }
    return reference(target) ? { [field]: target } : null;
  }
  async function mutate(action, target = null, value = null) {
    if (disposed) return resource();
    if (requests.has('mutation')) return state.mutation;
    const input = mutationInput(action, target, value);
    if (!input) {
      const next = mutationState('denied', action, target);
      publish({ mutation: next });
      return next;
    }
    const provider = currentProviders[action];
    if (typeof provider !== 'function') {
      const next = mutationState('unavailable', action, target);
      publish({ mutation: next });
      return next;
    }
    const request = new AbortController(), scopeKey = state.scopeKey;
    requests.set('mutation', request);
    publish({ mutation: mutationState('loading', action, target) });
    const active = () => !disposed && requests.get('mutation') === request && !request.signal.aborted;
    try {
      if (!active()) return state.mutation;
      const result = await provider({ scopeKey, ...input, signal: request.signal });
      if (!active()) return state.mutation;
      if (result?.status === 'denied' || result?.status === 'unavailable') {
        const next = mutationState(result.status, action, target);
        if (result.status === 'denied') abort('friends');
        publish({ mutation: next, ...(result.status === 'denied' ? friendsPatch(resource('denied')) : {}) });
        return next;
      }
      if (!object(result) || (result.status !== 'ready' && result.ok !== true)
        || (result.status != null && result.status !== 'ready') || result.ok === false) invalid();
      // Relationships/profile are never patched from a write response. Reload
      // the authoritative reader, keeping the write busy until refresh finishes.
      publish({ ...resetHistory(), ...resetMembers(), ...resetProfile(), selectedFriendRef: null });
      if (!active()) return state.mutation;
      await read('friends', currentProviders.readFriends);
      if (!active()) return state.mutation;
      const next = mutationState('ready', action, target);
      publish({ mutation: next });
      return next;
    } catch (error) {
      if (!active()) return state.mutation;
      const status = error?.status === 401 || error?.status === 403 ? 'denied' : 'error';
      const next = mutationState(status, action, target);
      if (status === 'denied') abort('friends');
      publish({ mutation: next, ...(status === 'denied' ? friendsPatch(resource('denied')) : {}) });
      return next;
    } finally {
      if (requests.get('mutation') === request) requests.delete('mutation');
    }
  }

  return freeze({
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A snapshot listener is required.');
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setScope(scopeKey) {
      if (disposed || Object.is(scopeKey, state.scopeKey)) return;
      abortAll();
      state = initialState(scopeKey);
      publish({});
    },
    configure(nextProviders = {}) {
      if (disposed) return;
      const next = providerSet(nextProviders);
      if (providerNames.every(name => next[name] === currentProviders[name])) return;
      currentProviders = next;
      abortAll();
      state = initialState(state.scopeKey);
      publish({});
    },
    acceptRecent(payload) {
      if (disposed) return resource();
      abort('recent');
      let next;
      try { next = readResult('recent', payload); }
      catch (_error) { next = resource('error'); }
      publish({ recent: next });
      return next;
    },
    loadRecent: () => read('recent', readRecent),
    loadFriends: () => read('friends', currentProviders.readFriends),
    loadMembers,
    selectProfile(accountRef) {
      if (disposed || accountRef !== null && !profilePerson(state, accountRef)) return false;
      if (state.selectedProfileRef === accountRef && state.selectedFriendRef === null) return true;
      publish({ ...resetProfile(), ...resetHistory(), selectedProfileRef: accountRef, selectedFriendRef: null });
      return true;
    },
    loadProfile,
    selectFriend(accountRef) {
      if (disposed) return false;
      if (accountRef !== null) {
        const friend = state.friends.data?.friends.find(row => row.account_ref === accountRef);
        if (!friend || friend.relationship !== 'accepted') return false;
      }
      if (state.selectedFriendRef === accountRef && state.selectedProfileRef === null) return true;
      publish({ ...resetHistory(), ...resetProfile(), selectedFriendRef: accountRef, selectedProfileRef: null });
      return true;
    },
    loadActivity,
    loadActivityPage: page => Number.isSafeInteger(page) ? navigateActivity(page) : Promise.resolve(false),
    loadMoreActivity: () => navigateActivity(),
    retryActivityNavigation: () => state.activityNavigation.status === 'error'
      ? navigateActivity(state.activityNavigation.requestedPage) : Promise.resolve(false),
    loadComparison: options => historyRead('comparison', currentProviders.readComparison, 'can_compare', options, 'tracks'),
    mutate,
    dispose() {
      if (disposed) return;
      abortAll(); listeners.clear();
      state = initialState(null);
      disposed = true;
    },
  });
}
