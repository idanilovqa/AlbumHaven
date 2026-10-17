// Translate authenticated backend contracts at the transport boundary. No media
// paths, relationship revisions or session context enter React presentation.
export function createHomeBackendProviders(transport, {runtime} = {}) {
  let owner = null;
  const relationships = new Map(), histories = new Map();
  const unsubscribe = transport.subscribe?.(() => {owner = null; relationships.clear(); histories.clear();});
  const fail = (message, status = 409) => Object.assign(new Error(message), {status});
  const identity = scopeKey => {
    if (runtime && runtime.snapshot().scopeKey !== scopeKey) throw fail('Home context changed.', 409);
    const next = JSON.stringify([transport.context(), scopeKey]);
    if (next !== owner) {owner = next; relationships.clear(); histories.clear();}
    return next;
  };
  const active = (token, signal) => {
    if (signal?.aborted || token !== owner || JSON.parse(token)[0] !== transport.context()) throw Object.assign(new Error('Request superseded.'), {name: 'AbortError'});
  };
  function person(row) {
    if (typeof row?.account_ref !== 'string' || !row.account_ref || !row.relationship) throw fail('Invalid member response.');
    const relation = row.relationship, actions = relation.allowed_actions || {};
    if (!Number.isSafeInteger(relation.revision) || relation.revision < 0) throw fail('Invalid relationship revision.');
    relationships.set(row.account_ref, {revision: relation.revision, state: relation.state, direction: relation.direction});
    return {account_ref: row.account_ref, display_name: row.display_name, handle: row.username_display,
      bio: '', avatar_url: null,
      relationship: relation.state === 'accepted' ? 'accepted' : relation.state === 'pending'
        ? relation.direction === 'incoming' ? 'incoming_pending' : 'outgoing_pending' : 'none',
      allowed_actions: {can_view_profile: actions.can_view_profile === true,
        can_request: actions.can_request === true, can_accept: actions.can_accept === true,
        can_decline: actions.can_decline === true, can_cancel: actions.can_cancel === true,
        can_remove: actions.can_unfriend === true, can_block: false,
        can_view_activity: actions.can_read_history === true, can_compare: actions.can_compare_taste === true}};
  }
  async function allMembers(mode, options, token) {
    const rows = [], cursors = new Set(); let cursor = null, grants = null, profile = null;
    do {
      const page = await transport.request(transport.query('/friends', {mode, cursor, limit: 100}), options);
      active(token, options.signal);
      if (!Array.isArray(page.members)) throw fail('Invalid Friends list.');
      rows.push(...page.members.map(person)); grants = page.allowed_actions; profile = page.current_user;
      cursor = page.next_cursor ?? null;
      if (cursor !== null && (typeof cursor !== 'string' || cursors.has(cursor))) throw fail('Invalid Friends continuation.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(rows.map(row => row.account_ref)).size !== rows.length) throw fail('Friends changed. Refresh the list.');
    return {rows, grants, profile};
  }
  async function transition(action, options) {
    const token = identity(options.scopeKey), ref = options.account_ref ?? options.request_ref;
    const prior = relationships.get(ref);
    if (!prior) throw fail('Refresh this relationship before changing it.');
    const result = await transport.request(action === 'request' ? '/friends/requests' : `/friends/${encodeURIComponent(ref)}/${action}`, {
      method: 'POST', signal: options.signal, expected: JSON.parse(token)[0],
      body: action === 'request' ? {target_account_ref: ref} : {expected_revision: prior.revision}});
    active(token, options.signal);
    const states = {request: ['pending', 'accepted'], accept: ['accepted'], decline: ['declined'], cancel: ['cancelled'], unfriend: ['removed']};
    if (!Number.isSafeInteger(result.revision) || result.revision < prior.revision || !states[action].includes(result.state)) throw fail('Relationship change was not acknowledged.');
    relationships.delete(ref); histories.clear();
    return {ok: true};
  }
  async function history(comparison, options) {
    const token = identity(options.scopeKey), {account_ref = null, kind, period, cursor = null, signal} = options;
    const key = JSON.stringify([comparison, account_ref, kind, period]), prior = histories.get(key);
    const continuation = cursor !== null || options.pagination != null;
    if (continuation && !prior) throw fail('Refresh this history before continuing.');
    const params = {kind, period, ...(continuation ? {snapshot_ref: prior.snapshot_ref, cursor,
      ...(options.pagination ? {page: options.pagination.page, page_size: options.pagination.page_size} : {})} : {})};
    if (comparison && !account_ref) throw fail('Select a friend.', 403);
    const path = account_ref ? `/friends/${encodeURIComponent(account_ref)}/${comparison ? 'comparison' : 'activity'}` : '/home/activity';
    try {
      const result = await transport.request(transport.query(path, params), {signal});
      active(token, signal);
      if (!['ready', 'empty'].includes(result.status) || typeof result.data?.snapshot_ref !== 'string'
        || account_ref !== null && result.account_ref !== account_ref
        || continuation && result.data.snapshot_ref !== prior.snapshot_ref) throw fail('History response changed. Refresh it.');
      histories.set(key, {snapshot_ref: result.data.snapshot_ref});
      return result;
    } catch (error) {if (owner === token) histories.delete(key); throw error;}
  }
  return Object.freeze({
    dispose() {unsubscribe?.(); owner = null; relationships.clear(); histories.clear();},
    async readFriends(options) {
      const token = identity(options.scopeKey); relationships.clear();
      const accepted = await allMembers('accepted', options, token);
      const incoming = await allMembers('incoming', options, token);
      const outgoing = await allMembers('outgoing', options, token);
      active(token, options.signal);
      return {status: 'ready', data: {friends: accepted.rows, requests: [
        ...incoming.rows.map(row => ({...row, request_ref: row.account_ref, direction: 'incoming'})),
        ...outgoing.rows.map(row => ({...row, request_ref: row.account_ref, direction: 'outgoing'}))], profile: accepted.profile ? {display_name: accepted.profile.display_name,
          handle: accepted.profile.username_display, bio: '', avatar_url: null, allowed_actions: {can_edit: false, can_upload_avatar: false}} : null,
        allowed_actions: {can_request: false, can_discover_members: accepted.grants?.can_discover_members === true}}};
    },
    async readMembers(options) {
      const token = identity(options.scopeKey);
      const page = await transport.request(transport.query('/friends/discover', {q: options.query, cursor: options.cursor, limit: 100}), options);
      active(token, options.signal);
      if (!Array.isArray(page.members)) throw fail('Invalid member response.');
      return {status: 'ready', data: {members: page.members.map(person), next_cursor: page.next_cursor}};
    },
    async readProfile(options) {
      const token = identity(options.scopeKey);
      const row = await transport.request(`/friends/${encodeURIComponent(options.account_ref)}`, options);
      active(token, options.signal);
      if (row.account_ref !== options.account_ref) throw fail('Profile response changed.');
      return {status: 'ready', data: person(row)};
    },
    async resolveActivityNativeTarget(options) {
      const token = identity(options.scopeKey);
      const origin = {audience: options.account_ref == null ? 'own' : 'friend', subject_ref: options.account_ref ?? null,
        kind: options.kind, period: options.period, snapshot_ref: options.snapshot_ref};
      const result = await transport.request('/home/activity/native-target', {method: 'POST', signal: options.signal,
        expected: JSON.parse(token)[0], body: {origin, row_ref: options.rowId, intent: options.intent, ...(options.intent === 'details' && options.target_kind ? {target_kind: options.target_kind} : {})}});
      active(token, options.signal);
      const data = result?.data;
      if (result.status !== 'ready' || data?.row_ref !== options.rowId || data.intent !== options.intent
        || !data.origin || Object.keys(data.origin).length !== Object.keys(origin).length
        || Object.keys(origin).some(key => data.origin[key] !== origin[key]) || !data.native_target) throw fail('Native activity target changed.');
      return data.native_target;
    },
    async readNowPlaying(options) {
      const token = identity(options.scopeKey);
      const result = await transport.request(transport.query('/home/activity/now-playing', {subject_ref: options.account_ref}), {signal: options.signal});
      active(token, options.signal);
      if (result.status !== 'ready' || result.data && result.data.subject_ref !== options.account_ref) throw fail('Live activity changed.');
      return result;
    },
    readActivity: options => history(false, options), readComparison: options => history(true, options),
    requestMember: options => transition('request', options), acceptRequest: options => transition('accept', options),
    declineRequest: options => transition('decline', options), cancelRequest: options => transition('cancel', options),
    removeFriend: options => transition('unfriend', options),
  });
}
