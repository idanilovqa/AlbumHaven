// Translate authenticated backend contracts at the transport boundary. No media
// paths, relationship revisions or session context enter React presentation.
export function createHomeBackendProviders(transport, {runtime} = {}) {
  let owner = null, historyImportPending = null;
  let retryPending = null, retryRevision = 0, retryDisposed = false, deliveryReadEpoch = 0;
  const spentRetrySnapshots = new Set();
  const relationships = new Map(), histories = new Map(), historyReads = new Map();
  const unsubscribe = transport.subscribe?.(() => {retryRevision++; deliveryReadEpoch++; spentRetrySnapshots.clear(); owner = null; relationships.clear(); histories.clear(); historyReads.clear();});
  const fail = (message, status = 409) => Object.assign(new Error(message), {status});
  const identity = scopeKey => {
    if (runtime && runtime.snapshot().scopeKey !== scopeKey) throw fail('Home context changed.', 409);
    const next = JSON.stringify([transport.context(), scopeKey]);
    if (next !== owner) {retryRevision++; deliveryReadEpoch++; spentRetrySnapshots.clear(); owner = next; relationships.clear(); histories.clear(); historyReads.clear();}
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
    const readEpoch = deliveryReadEpoch;
    // A read made before the outstanding mutation settles is not a refresh.
    if (!comparison && account_ref === null && kind === 'listens' && (retryPending || historyImportPending)) throw fail('Wait for the current delivery check to finish.');
    const key = JSON.stringify([comparison, account_ref, kind, period]), prior = histories.get(key);
    const continuation = cursor !== null || options.pagination != null;
    if (continuation && !prior) throw fail('Refresh this history before continuing.');
    const params = {kind, period, ...(continuation ? {snapshot_ref: prior.snapshot_ref, cursor,
      ...(options.pagination ? {page: options.pagination.page, page_size: options.pagination.page_size} : {})} : {})};
    if (comparison && !account_ref) throw fail('Select a friend.', 403);
    const path = account_ref ? `/friends/${encodeURIComponent(account_ref)}/${comparison ? 'comparison' : 'activity'}` : '/home/activity';
    // A cancelled older read must not replace or delete a newer receipt for the
    // same query, including refreshes after another adapter's command settles.
    const readOwner = {}; historyReads.set(key, readOwner);
    try {
      const result = await transport.request(transport.query(path, params), {signal});
      active(token, signal);
      if (historyReads.get(key) !== readOwner) throw fail('History read superseded. Refresh it.');
      if (!comparison && account_ref === null && kind === 'listens' && readEpoch !== deliveryReadEpoch) throw fail('Delivery changed. Refresh history.');
      if (!['ready', 'empty'].includes(result.status) || typeof result.data?.snapshot_ref !== 'string'
        || account_ref !== null && result.account_ref !== account_ref
        || continuation && result.data.snapshot_ref !== prior.snapshot_ref) throw fail('History response changed. Refresh it.');
      histories.set(key, {snapshot_ref: result.data.snapshot_ref});
      return result;
    } catch (error) {
      if (owner === token && historyReads.get(key) === readOwner
        && (comparison || account_ref !== null || kind !== 'listens' || readEpoch === deliveryReadEpoch)) histories.delete(key);
      throw error;
    } finally {if (historyReads.get(key) === readOwner) historyReads.delete(key);}
  }
  function canRetryActivityScrobble(options) {
    try {
      if (retryDisposed) return false;
      identity(options.scopeKey);
      return options.account_ref === null && options.kind === 'listens'
        && typeof options.rowId === 'string' && options.rowId.length === 73 && /^activity_[a-f0-9]{64}$/.test(options.rowId)
        && typeof options.snapshot_ref === 'string' && options.snapshot_ref.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(options.snapshot_ref)
        && histories.get(JSON.stringify([false, null, 'listens', options.period]))?.snapshot_ref === options.snapshot_ref
        && !retryPending && !historyImportPending && !spentRetrySnapshots.has(options.snapshot_ref) && spentRetrySnapshots.size < 1000;
    } catch {return false;}
  }
  return Object.freeze({
    dispose() {retryDisposed = true; retryRevision++; unsubscribe?.(); owner = null; relationships.clear(); histories.clear(); historyReads.clear();},
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
    canRetryActivityScrobble,
    async retryActivityScrobble(options) {
      if (!canRetryActivityScrobble(options)) throw fail('Refresh this play before checking delivery.');
      const token = identity(options.scopeKey), revision = retryRevision;
      const ticket = {}; retryPending = ticket; deliveryReadEpoch++; spentRetrySnapshots.add(options.snapshot_ref);
      const isCurrent = () => revision === retryRevision && token === owner
        && (!runtime || runtime.snapshot().scopeKey === options.scopeKey);
      try {
        const result = await transport.request('/home/activity/scrobbles/retry', {method: 'POST',
          expected: JSON.parse(token)[0], isCurrent,
          body: {origin: {audience: 'own', subject_ref: null, kind: 'listens', period: options.period,
            snapshot_ref: options.snapshot_ref}, row_ref: options.rowId}});
        if (!isCurrent()) throw Object.assign(new Error('Request superseded.'), {name: 'AbortError'});
        active(token);
        const data = result?.data;
        if (result.status !== 'ready' || result.refresh_required !== true || typeof data?.attempted !== 'boolean'
          || !['attempted','not_submitted','retry_blocked','connection_unavailable','claim_changed'].includes(data.result)
          || (data.result === 'attempted') !== data.attempted) throw fail('Delivery outcome needs a fresh history read.', 502);
        return Object.freeze({refresh_required: true});
      } catch (error) {
        if (isCurrent() && ([401,403].includes(error?.status) || error?.code === 'stale_context')) transport.invalidate();
        throw error;
      } finally {
        if (retryPending === ticket) {retryPending = null; deliveryReadEpoch++;}
        if (isCurrent()) histories.clear();
      }
    },
    async lastfmHistoryCommand(options) {
      if (retryDisposed || retryPending || historyImportPending || options.account_ref !== null || options.kind !== 'listens') throw fail('Last.fm history is not available here.');
      const token = identity(options.scopeKey), ticket = {}, revision = retryRevision;
      const command = options.command;
      let body;
      if (command === 'begin' && Number.isSafeInteger(options.range_start) && Number.isSafeInteger(options.range_end)
        && options.range_start >= 0 && options.range_end >= options.range_start
        && options.range_end - options.range_start <= 31 * 86400 && options.range_end <= Math.floor(Date.now()/1000)-60)
        body = {command, range_start: options.range_start, range_end: options.range_end};
      else if (['advance','abandon'].includes(command) && typeof options.generation === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.generation)
        && (command === 'abandon' || Number.isSafeInteger(options.page) && options.page >= 1 && options.page <= 100))
        body = {command, generation: options.generation, ...(command === 'advance' ? {page: options.page} : {})};
      else if (['pending','backfill_begin','backfill_pending'].includes(command)) body = {command};
      else if (['backfill_advance','backfill_pause','backfill_resume'].includes(command)
        && typeof options.plan === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.plan)
        && Number.isSafeInteger(options.revision) && options.revision >= 1)
        body = {command,plan:options.plan,revision:options.revision};
      else throw fail('Choose a valid history range or continuation.',422);
      const isCurrent = () => !retryDisposed && revision === retryRevision && token === owner
        && (!runtime || runtime.snapshot().scopeKey === options.scopeKey);
      const readOnly = ['pending','backfill_pending'].includes(command);
      historyImportPending = ticket; if (!readOnly) deliveryReadEpoch++;
      try {
        const result = await transport.request('/home/activity/lastfm/import', {method:'POST', body,
          signal:options.signal, expected:JSON.parse(token)[0], isCurrent});
        if (!isCurrent()) throw Object.assign(new Error('Request superseded.'),{name:'AbortError'});
        active(token,options.signal);
        const status = value => {
          if (!value || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)
            || !['reading','complete','uncertain','connection_changed'].includes(value.state)
            || (value.state === 'reading' ? !Number.isSafeInteger(value.next_page) || value.next_page < 1 || value.next_page > 100 : value.next_page !== null))
            throw fail('History import status needs a refresh.',502);
          return Object.freeze({generation:value.generation,state:value.state,next_page:value.next_page});
        };
        if (result?.status !== 'ready') throw fail('History import status needs a refresh.',502);
        const planStatus = value => {
          if (!value || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)
            || !['active','paused','observed','connection_changed','blocked'].includes(value.state)
            || !Number.isSafeInteger(value.revision) || value.revision < 1
            || !Number.isSafeInteger(value.upper_cut) || value.upper_cut < 0
            || !Number.isSafeInteger(value.cursor_end) || value.cursor_end < -1 || value.cursor_end > value.upper_cut
            || (value.state === 'observed' && value.cursor_end !== -1)
            || !Number.isSafeInteger(value.window_seconds) || value.window_seconds < 1 || value.window_seconds > 2678400
            || !Number.isSafeInteger(value.completed_windows) || value.completed_windows < 0
            || typeof value.next_allowed_at !== 'string' || value.next_allowed_at.length > 64 || !Number.isFinite(Date.parse(value.next_allowed_at)))
            throw fail('History backfill status needs a refresh.',502);
          return Object.freeze({plan:value.id,state:value.state,revision:value.revision,upper_cut:value.upper_cut,
            cursor_end:value.cursor_end,window_seconds:value.window_seconds,completed_windows:value.completed_windows,
            next_allowed_at:value.next_allowed_at,lower_bound:0,complete_history:false,provider_snapshot_guaranteed:false,
            reason:['paused','connection_changed','read_failed','range_split','single_second_over_budget',
              'pagination_changed','page_order_changed','page_count_changed','uncertain_range','abandoned','dense_second','storage_quota'].includes(value.reason)
              ? value.reason : null});
        };
        if (command === 'backfill_pending') {
          if (!Array.isArray(result.data?.plans) || result.data.plans.length > 5) throw fail('Invalid backfill plans.',502);
          return Object.freeze({plans:Object.freeze(result.data.plans.map(planStatus))});
        }
        if (command.startsWith('backfill_')) return planStatus(result.data);
        if (command === 'pending') {
          if (!Array.isArray(result.data?.generations) || result.data.generations.length > 4) throw fail('Invalid pending imports.',502);
          return Object.freeze({generations:Object.freeze(result.data.generations.map(status))});
        }
        return status(result.data);
      } catch (error) {
        if (isCurrent() && ([401,403].includes(error?.status) || error?.code === 'stale_context')) transport.invalidate();
        throw error;
      } finally {
        if (historyImportPending === ticket) historyImportPending = null;
        // Even a lost response may have committed. Never replay automatically.
        if (isCurrent() && !readOnly) {deliveryReadEpoch++; histories.clear();}
      }
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
