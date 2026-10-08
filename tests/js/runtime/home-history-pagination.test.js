const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const model = import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/model.mjs')));

// Provider contract fixtures exercise the real controller, without installing a
// backend, browser fixture, transport, or production history source.
const row = id => ({ id, kind: 'listen', title: 'The same track', artist: 'The same artist', last_listened_at: '2026-10-08T00:00:00Z' });
const progressive = (ids, next_cursor = null) => ({ rows: ids.map(row), next_cursor });
function numbered(page = 1, total_rows = 243) {
  const start = (page - 1) * 100;
  return { rows: Array.from({ length: Math.min(100, Math.max(0, total_rows - start)) }, (_, index) => row(`event:${start + index}`)),
    total_listens: 987654, next_cursor: null, pagination: { mode: 'numbered', page, page_size: 100, total_rows } };
}
const friends = can_view_activity => ({ friends: [{ account_ref: 'friend:one', relationship: 'accepted',
  allowed_actions: { can_view_activity, can_remove: true } }], requests: [], profile: null });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function controller(providers = {}, options = {}) {
  const { createHomeFriendsController } = await model;
  return createHomeFriendsController({ providers, ...options });
}
const ids = c => c.getSnapshot().activity.data.rows.map(item => item.id);

function assertRetired(c, status = 'unavailable') {
  assert.deepEqual(c.getSnapshot().activity, { status, data: null });
  const navigation = c.getSnapshot().activityNavigation;
  assert.equal(navigation.mode, 'none'); assert.equal(navigation.query, null);
  assert.equal(navigation.loadedCount, 0); assert.equal(navigation.hasMore, false);
  assert.equal(navigation.page, null); assert.equal(navigation.totalPages, null);
}

test('missing history reader leaves every navigation method inert and unavailable', async () => {
  const c = await controller();
  await c.loadActivity({ kind: 'listens' });
  const state = c.getSnapshot();
  for (const invoke of [() => c.loadActivityPage(2), () => c.loadMoreActivity(), () => c.retryActivityNavigation()]) {
    assert.equal(await invoke(), false); assert.equal(c.getSnapshot(), state);
  }
  assertRetired(c);
});

test('legacy cursor reads keep replacement semantics and their existing provider arguments', async () => {
  const calls = [];
  const c = await controller({ readActivity: args => { calls.push(args); return progressive([args.cursor ?? 'first'], args.cursor ? null : 'opaque:next'); } });
  c.setScope('own/library');
  await c.loadActivity({ kind: 'listens', period: 'server:period' });
  await c.loadActivity({ kind: 'listens', period: 'server:period', cursor: 'opaque:next' });
  assert.deepEqual(ids(c), ['opaque:next']);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['account_ref', 'cursor', 'kind', 'period', 'scopeKey', 'signal']);
  assert.equal(calls[1].cursor, 'opaque:next'); assert.equal(calls[1].account_ref, null);
  assert.equal(c.getSnapshot().activityNavigation.mode, 'none');
  assert.equal(c.getSnapshot().activityNavigation.totalRows, null);
});

test('numbered pages use exact 100-row slices and explicit page requests independent of listen totals', async () => {
  const calls = [];
  const first = numbered();
  const c = await controller({ readActivity: args => { calls.push(args); return args.pagination ? numbered(args.pagination.page) : first; } });
  const pending = c.loadActivity({ kind: 'listens', period: 'month' });
  const query = c.getSnapshot().activityNavigation.query;
  assert.deepEqual(query, { account_ref: null, kind: 'listens', period: 'month' });
  assert.ok(Object.isFrozen(query)); await pending;
  const navigation = c.getSnapshot().activityNavigation;
  assert.deepEqual({ ...navigation }, { mode: 'numbered', status: 'idle', query, page: 1, pageSize: 100,
    totalPages: 3, totalRows: 243, loadedCount: 100, hasMore: false, requestedPage: null });
  first.pagination.total_rows = 9;
  assert.equal(c.getSnapshot().activity.data.pagination.total_rows, 243);
  assert.equal(await c.loadActivityPage(3), c.getSnapshot().activity);
  assert.equal(ids(c).length, 43); assert.equal(ids(c)[0], 'event:200');
  assert.deepEqual(calls[1].pagination, { mode: 'numbered', page: 3, page_size: 100 });
  assert.equal(calls[1].cursor, null); assert.equal(calls[1].kind, 'listens'); assert.equal(calls[1].period, 'month');
  assert.equal(c.getSnapshot().activityNavigation.query, query);
  assert.equal(c.getSnapshot().activityNavigation.page, 3);
  await c.loadActivityPage(2);
  assert.equal(ids(c).length, 100); assert.equal(ids(c)[0], 'event:100');
  for (const value of [c.getSnapshot().activityNavigation, c.getSnapshot().activity.data.pagination,
    c.getSnapshot().activity.data.rows]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.hasOwn(calls[0], 'pagination'), false);
});

test('a complete empty numbered history is page one with zero rows', async () => {
  const c = await controller({ readActivity: () => numbered(1, 0) });
  await c.loadActivity({ kind: 'listens' });
  assert.equal(c.getSnapshot().activity.status, 'empty');
  assert.equal(c.getSnapshot().activityNavigation.totalRows, 0);
  assert.equal(c.getSnapshot().activityNavigation.totalPages, 1);
  assert.equal(c.getSnapshot().activityNavigation.page, 1);
});

test('invalid numbered metadata fails closed without deriving pages from listen totals', async () => {
  const badPagination = [
    {}, [], { ...numbered().pagination, mode: 'pages' }, { ...numbered().pagination, page_size: 50 },
    { ...numbered().pagination, page_size: '100' }, { ...numbered().pagination, page: 0 },
    { ...numbered().pagination, page: 1.5 }, { ...numbered().pagination, page: '1' },
    { ...numbered().pagination, page: 4 }, { ...numbered().pagination, total_rows: -1 },
    { ...numbered().pagination, total_rows: 243.5 }, { ...numbered().pagination, total_rows: '243' },
    { ...numbered().pagination, total_rows: Infinity }, { ...numbered().pagination, total_rows: Number.MAX_SAFE_INTEGER + 1 },
    Object.create(numbered().pagination),
  ];
  const bad = badPagination.map(pagination => ({ ...numbered(), pagination }));
  bad.push({ ...numbered(), rows: numbered().rows.slice(0, 99) },
    { ...numbered(), rows: [...numbered().rows, row('extra')] },
    { ...numbered(), next_cursor: 'mixed-mode' }, numbered(2),
    { ...numbered(1, 0), rows: [row('unexpected')] });
  for (const payload of bad) {
    const c = await controller({ readActivity: () => payload });
    await c.loadActivity(); assertRetired(c, 'error');
  }
  const c = await controller({ readActivity: () => ({ ...progressive(['one']), total_listens: 500000 }) });
  await c.loadActivity(); assert.equal(c.getSnapshot().activityNavigation.mode, 'none');
  assert.equal(c.getSnapshot().activityNavigation.totalRows, null);
});

test('inherited pagination cannot authorize numbered requests', async () => {
  const payload = Object.assign(Object.create({ pagination: numbered().pagination }), progressive(['one']));
  let reads = 0;
  const c = await controller({ readActivity: () => { reads++; return payload; } });
  await c.loadActivity(); await c.loadActivityPage(2);
  assert.equal(reads, 1); assert.equal(c.getSnapshot().activityNavigation.mode, 'none');
});

test('out-of-range and mode-incompatible page actions do not issue reads', async () => {
  let reads = 0;
  const c = await controller({ readActivity: () => { reads++; return numbered(); } });
  await c.loadActivity(); const loaded = c.getSnapshot();
  for (const page of [undefined, null, 0, -1, 1, 1.5, '2', 4, Infinity, NaN, {}]) assert.equal(await c.loadActivityPage(page), false);
  assert.equal(await c.loadMoreActivity(), false); assert.equal(await c.retryActivityNavigation(), false);
  assert.equal(reads, 1); assert.equal(c.getSnapshot(), loaded);
  c.configure({ readActivity: () => { reads++; return progressive(['a'], 'cursor:one'); } });
  await c.loadActivity(); const cursorPage = c.getSnapshot();
  for (const page of [undefined, null, 0, -1, 1, '2']) assert.equal(await c.loadActivityPage(page), false);
  assert.equal(reads, 2); assert.equal(c.getSnapshot(), cursorPage);
});

test('numbered failures retain committed rows and retry the failed target', async () => {
  const pending = deferred(); const calls = [];
  const c = await controller({ readActivity: args => { calls.push(args); return calls.length === 1 ? numbered()
    : calls.length === 2 ? pending.promise : numbered(args.pagination.page); } });
  await c.loadActivity({ kind: 'listens' }); const original = c.getSnapshot().activity;
  const loading = c.loadActivityPage(3); assert.equal(await c.loadActivityPage(3), false);
  assert.equal(calls.length, 2); assert.equal(c.getSnapshot().activity, original);
  assert.equal(c.getSnapshot().activityNavigation.status, 'loading');
  assert.equal(c.getSnapshot().activityNavigation.page, 1);
  pending.reject(new Error('raw private server failure')); assert.deepEqual(await loading, { status: 'error', data: null });
  assert.equal(c.getSnapshot().activity, original);
  assert.equal(c.getSnapshot().activityNavigation.status, 'error');
  assert.equal(c.getSnapshot().activityNavigation.requestedPage, 3);
  assert.equal(JSON.stringify(c.getSnapshot()).includes('raw private'), false);
  assert.equal(await c.retryActivityNavigation(), c.getSnapshot().activity);
  assert.equal(calls[2].pagination.page, 3); assert.equal(c.getSnapshot().activityNavigation.page, 3);
  assert.equal(c.getSnapshot().activityNavigation.status, 'idle');
});

test('numbered navigation rejects wrong pages, changed mode and partial nonfinal responses', async () => {
  for (const bad of [numbered(1), progressive(['replacement']), { status: 'empty', data: null },
    { ...numbered(2), rows: numbered(2).rows.slice(0, 50) }]) {
    let calls = 0;
    const c = await controller({ readActivity: () => ++calls === 1 ? numbered() : bad });
    await c.loadActivity(); const original = c.getSnapshot().activity;
    await c.loadActivityPage(2);
    assert.equal(c.getSnapshot().activity, original); assert.equal(c.getSnapshot().activityNavigation.status, 'error');
    assert.equal(c.getSnapshot().activityNavigation.page, 1);
  }
});

test('newer numbered jumps supersede stale successes and denials', async () => {
  for (const staleResult of [numbered(2), { status: 'denied' }]) {
    const pending = deferred(); const calls = [];
    const c = await controller({ readActivity: args => { calls.push(args); return args.pagination?.page === 2 ? pending.promise : numbered(args.pagination?.page); } });
    await c.loadActivity(); const stale = c.loadActivityPage(2); await c.loadActivityPage(3);
    assert.equal(calls[1].signal.aborted, true);
    const fresh = c.getSnapshot(); pending.resolve(staleResult); assert.equal(await stale, false);
    assert.equal(c.getSnapshot(), fresh); assert.equal(fresh.activityNavigation.page, 3);
  }
});

test('a stale request cannot report the newer successful jump to the same page as its own completion', async () => {
  const pending = deferred(); let secondPageCalls = 0;
  const c = await controller({ readActivity: args => {
    if (args.pagination?.page === 2 && ++secondPageCalls === 1) return pending.promise;
    return numbered(args.pagination?.page);
  } });
  await c.loadActivity(); const stale = c.loadActivityPage(2);
  await c.loadActivityPage(3);
  const committed = await c.loadActivityPage(2);
  assert.equal(committed, c.getSnapshot().activity); assert.equal(committed.status, 'ready');
  const fresh = c.getSnapshot(); pending.resolve(numbered(2));
  assert.equal(await stale, false); assert.equal(c.getSnapshot(), fresh);
});

test('progressive append is single flight and preserves distinct listen events with matching content', async () => {
  const pending = deferred(); const calls = [];
  const c = await controller({ readActivity: args => { calls.push(args); return calls.length === 1
    ? progressive(['event:1', 'event:2'], 'cursor:one') : pending.promise; } });
  await c.loadActivity({ kind: 'listens', period: 'year' });
  const query = c.getSnapshot().activityNavigation.query, original = c.getSnapshot().activity;
  const first = c.loadMoreActivity(), repeat = c.loadMoreActivity();
  assert.equal(calls.length, 2); assert.equal(c.getSnapshot().activity, original);
  assert.equal(c.getSnapshot().activityNavigation.status, 'loading');
  assert.equal(calls[1].cursor, 'cursor:one'); assert.equal(Object.hasOwn(calls[1], 'pagination'), false);
  assert.equal(await repeat, false);
  pending.resolve(progressive(['event:2', 'event:3'])); assert.equal(await first, c.getSnapshot().activity);
  assert.deepEqual(ids(c), ['event:1', 'event:2', 'event:3']);
  const navigation = c.getSnapshot().activityNavigation;
  assert.equal(navigation.mode, 'progressive'); assert.equal(navigation.hasMore, false);
  assert.equal(navigation.loadedCount, 3); assert.equal(navigation.totalRows, null); assert.equal(navigation.query, query);
  assert.equal(await c.loadMoreActivity(), false); assert.equal(calls.length, 2);
});

test('progressive overlaps replace current facts in place and append new rows after retained history', async () => {
  let calls = 0;
  const first = {rows: [{...row('a'), source_readable: true, title: 'Revoked title', artwork_url: '/artwork/revoked',
    album_title: 'Revoked album', love_tier: 'obsessed', detail_ref: 'detail:revoked',
    track_preference: {identity: 'pref:a', love_tier: 'obsessed', allowed_actions: {can_set_love_tier: true}},
    allowed_actions: {can_view_details: true}}, {...row('retained'), rating: 1}], next_cursor: 'cursor:one'};
  const c = await controller({readActivity: () => calls++ === 0 ? first : {
    rows: [{...row('retained'), rating: 4}, {...row('a'), source_readable: false}, row('b')], next_cursor: null,
  }});
  await c.loadActivity({kind: 'listens'}); await c.loadMoreActivity();
  assert.deepEqual(ids(c), ['a', 'retained', 'b']);
  const [revoked, updated] = c.getSnapshot().activity.data.rows;
  assert.equal(revoked.source_readable, false); assert.equal(revoked.title, 'Unavailable track');
  assert.equal(revoked.artwork_url, null); assert.equal(revoked.album_title, ''); assert.equal(revoked.love_tier, null);
  assert.equal(revoked.track_preference, null); assert.equal(revoked.detail_ref, null); assert.equal(revoked.allowed_actions.can_view_details, false);
  assert.doesNotMatch(JSON.stringify(revoked), /Revoked|artwork\/revoked|detail:revoked|pref:a|obsessed/);
  assert.equal(updated.rating, 4); assert.equal(c.getSnapshot().activityNavigation.status, 'idle');
});

test('invalid pages redact identified denials across activity kinds while preserving the error and retry cursor', async () => {
  for (const kind of ['listen', 'album', 'artist']) for (const failure of ['no-progress', 'cursor-cycle', 'malformed-pagination', 'invalid-cursor']) {
    const calls = [], first = {rows: [{...row('a'), kind, source_readable: true, title: 'Revoked title', artwork_url: '/artwork/revoked',
      love_tier: 'obsessed', detail_ref: 'detail:revoked', allowed_actions: {can_view_details: true}}], next_cursor: 'cursor:one'};
    const c = await controller({readActivity: args => {
      calls.push(args);
      if (calls.length === 1) return first;
      if (calls.length === 2) return {rows: [{...row('a'), kind, source_readable: false}, ...(failure === 'no-progress' ? [] : [{...row('b'), kind}])],
        next_cursor: failure === 'cursor-cycle' ? 'cursor:one' : failure === 'invalid-cursor' ? 7 : 'cursor:two',
        ...(failure === 'malformed-pagination' ? {pagination: {mode: 'numbered', page: 'invalid', page_size: 100, total_rows: 2}} : {})};
      return {rows: [{...row('b'), kind}], next_cursor: null};
    }});
    await c.loadActivity({kind: `${kind}s`}); const result = await c.loadMoreActivity();
    assert.equal(result.status, 'error'); assert.equal(c.getSnapshot().activityNavigation.status, 'error');
    assert.deepEqual(ids(c), ['a']); assert.equal(c.getSnapshot().activity.data.next_cursor, 'cursor:one');
    const denied = c.getSnapshot().activity.data.rows[0];
    assert.equal(denied.source_readable, false); assert.equal(denied.artwork_url, null); assert.equal(denied.love_tier ?? null, null);
    assert.equal(denied.track_preference ?? null, null); assert.equal(denied.detail_ref, null); assert.equal(denied.allowed_actions.can_view_details, false);
    assert.doesNotMatch(JSON.stringify(denied), /Revoked|artwork\/revoked|detail:revoked|obsessed/);
    await c.retryActivityNavigation(); assert.equal(calls[2].cursor, 'cursor:one');
    assert.deepEqual(ids(c), ['a', 'b']); assert.equal(c.getSnapshot().activity.data.rows[0], denied);
  }
});

test('revocation extraction cannot admit evidence from invalid or ambiguous row identities', async () => {
  for (const extra of [row('a'), {...row('b'), kind: 'file'}, {...row('b'), id: ''}]) {
    let calls = 0;
    const c = await controller({readActivity: () => calls++ === 0 ? progressive(['a'], 'cursor:one')
      : {rows: [{...row('a'), source_readable: false}, extra], next_cursor: 7}});
    await c.loadActivity({kind: 'listens'}); const original = c.getSnapshot().activity;
    await c.loadMoreActivity(); assert.equal(c.getSnapshot().activityNavigation.status, 'error');
    assert.equal(c.getSnapshot().activity, original); assert.deepEqual(ids(c), ['a']);
  }
});

test('cursor cycles, repeated responses and mode switches fail without duplicating rows or consuming retry', async () => {
  const failures = [progressive(['c'], 'cursor:two'), progressive(['c'], 'cursor:one'),
    progressive(['a', 'b'], 'cursor:three'), numbered()];
  for (const bad of failures) {
    const calls = [];
    const c = await controller({ readActivity: args => { calls.push(args); return [progressive(['a'], 'cursor:one'),
      progressive(['b'], 'cursor:two'), bad, progressive(['c'])][calls.length - 1]; } });
    await c.loadActivity(); await c.loadMoreActivity(); const original = c.getSnapshot().activity;
    await c.loadMoreActivity();
    assert.equal(c.getSnapshot().activity, original); assert.equal(c.getSnapshot().activityNavigation.status, 'error');
    assert.deepEqual(ids(c), ['a', 'b']);
    await c.retryActivityNavigation(); assert.equal(calls[3].cursor, 'cursor:two');
    assert.deepEqual(ids(c), ['a', 'b', 'c']);
  }
});

test('an append transport failure keeps the same opaque cursor available for retry', async () => {
  const calls = [];
  const c = await controller({ readActivity: args => {
    calls.push(args);
    if (calls.length === 1) return progressive(['a'], 'cursor:one');
    if (calls.length === 2) throw new Error('Private transport text');
    return progressive(['b']);
  } });
  await c.loadActivity(); const original = c.getSnapshot().activity;
  await c.loadMoreActivity();
  assert.equal(c.getSnapshot().activity, original); assert.equal(c.getSnapshot().activityNavigation.status, 'error');
  assert.equal(JSON.stringify(c.getSnapshot()).includes('Private transport text'), false);
  await c.retryActivityNavigation();
  assert.equal(calls[1].cursor, calls[2].cursor); assert.deepEqual(ids(c), ['a', 'b']);
});

test('empty cursor pages can advance explicitly and an empty terminal envelope finishes the history', async () => {
  let calls = 0;
  const c = await controller({ readActivity: () => [progressive([], 'cursor:one'), progressive(['a'], 'cursor:two'),
    progressive([], 'cursor:three'), { status: 'empty', data: null }][calls++] });
  await c.loadActivity();
  assert.equal(c.getSnapshot().activity.status, 'empty'); assert.equal(c.getSnapshot().activityNavigation.hasMore, true);
  await c.loadMoreActivity(); await c.loadMoreActivity();
  assert.deepEqual(ids(c), ['a']); assert.equal(c.getSnapshot().activityNavigation.hasMore, true);
  await c.loadMoreActivity();
  assert.deepEqual(ids(c), ['a']); assert.equal(c.getSnapshot().activityNavigation.hasMore, false);
  assert.equal(c.getSnapshot().activityNavigation.mode, 'progressive');
});

test('denied or unavailable navigation erases accumulated rows and disables retries', async () => {
  for (const result of [{ status: 'denied', data: progressive(['private']) }, { status: 'unavailable' }, { status: 401 }, { status: 403 }]) {
    let calls = 0;
    const c = await controller({ readActivity: () => {
      if (++calls === 1) return progressive(['a'], 'cursor:one');
      if (typeof result.status === 'number') throw result;
      return result;
    } });
    await c.loadActivity();
    const resultResource = await c.loadMoreActivity();
    assert.equal(resultResource, c.getSnapshot().activity);
    assert.equal(resultResource.status, result.status === 'unavailable' ? 'unavailable' : 'denied');
    assertRetired(c, result.status === 'unavailable' ? 'unavailable' : 'denied');
    const retired = c.getSnapshot(); await c.retryActivityNavigation(); await c.loadMoreActivity();
    assert.equal(calls, 2); assert.equal(c.getSnapshot(), retired);
  }
});

test('changing kind or period aborts an append and binds only the replacement query', async () => {
  for (const options of [{ kind: 'tracks', period: 'week' }, { kind: 'listens', period: 'month' }]) {
    const pending = deferred(); const calls = [];
    const c = await controller({ readActivity: args => { calls.push(args); return calls.length === 1
      ? progressive(['old'], 'cursor:one') : calls.length === 2 ? pending.promise : progressive(['fresh'], 'cursor:fresh'); } });
    await c.loadActivity({ kind: 'listens', period: 'week' }); const stale = c.loadMoreActivity();
    await c.loadActivity(options); const fresh = c.getSnapshot();
    assert.equal(calls[1].signal.aborted, true);
    assert.deepEqual(fresh.activityNavigation.query, { account_ref: null, ...options });
    pending.resolve({ status: 'denied' }); await stale;
    assert.equal(c.getSnapshot(), fresh); assert.deepEqual(ids(c), ['fresh']);
  }
});

test('scope, provider, friend, grant, account denial and disposal retire pending private history', async () => {
  for (const reason of ['scope', 'provider', 'friend', 'grant', 'denied', 'dispose']) {
    const pending = deferred(); const calls = []; let grant = true, denyFriends = false;
    const readFriends = () => denyFriends ? { status: 'denied' } : friends(grant);
    const c = await controller({ readFriends, readActivity: args => { calls.push(args); return calls.length === 1
      ? progressive(['private'], 'private:cursor') : pending.promise; } });
    await c.loadFriends(); c.selectFriend('friend:one'); await c.loadActivity({ kind: 'listens' });
    assert.equal(c.getSnapshot().activityNavigation.query.account_ref, 'friend:one');
    const stale = c.loadMoreActivity();
    if (reason === 'scope') c.setScope('different/account');
    if (reason === 'provider') c.configure({ readFriends, readActivity: () => progressive(['replacement']) });
    if (reason === 'friend') c.selectFriend(null);
    if (reason === 'grant') { grant = false; await c.loadFriends(); }
    if (reason === 'denied') { denyFriends = true; await c.loadFriends(); }
    if (reason === 'dispose') c.dispose();
    assert.equal(calls[1].signal.aborted, true);
    assertRetired(c, ['grant', 'denied'].includes(reason) ? 'denied' : 'unavailable');
    const retired = c.getSnapshot(); pending.resolve(progressive(['late-private'])); assert.equal(await stale, false);
    assert.equal(c.getSnapshot(), retired);
    assert.equal(await c.loadMoreActivity(), false); assert.equal(await c.loadActivityPage(2), false);
    assert.equal(await c.retryActivityNavigation(), false); assert.equal(c.getSnapshot(), retired);
  }
});

test('a denied relationship mutation erases held rows and rejects a late numbered response', async () => {
  const pending = deferred(); let calls = 0, signal;
  const c = await controller({ readFriends: () => friends(true),
    readActivity: args => { if (++calls === 1) return numbered(); signal = args.signal; return pending.promise; },
    removeFriend: () => ({ status: 'denied' }) });
  await c.loadFriends(); c.selectFriend('friend:one'); await c.loadActivity();
  const stale = c.loadActivityPage(2);
  await c.mutate('removeFriend', 'friend:one');
  assertRetired(c, 'denied'); assert.equal(signal.aborted, true);
  const retired = c.getSnapshot(); pending.reject(new Error('Late transport failure')); assert.equal(await stale, false);
  assert.equal(c.getSnapshot(), retired);
});

test('a loading subscriber can retire navigation before its provider is invoked', async () => {
  let calls = 0;
  const c = await controller({ readActivity: () => { calls++; return numbered(); } });
  await c.loadActivity();
  c.subscribe(() => { if (c.getSnapshot().activityNavigation.status === 'loading') c.setScope('new/account'); });
  assert.equal(await c.loadActivityPage(2), false);
  assert.equal(calls, 1); assertRetired(c);
});

test('query binding survives harmless reads while replacement clears accumulated cursor history', async () => {
  const calls = [];
  const c = await controller({ readActivity: args => { calls.push(args); return args.cursor ? progressive(['b']) : progressive(['a'], 'cursor:one'); } },
    { readRecent: () => ({ recent_local_albums: [], recent_not_local_albums: [] }) });
  await c.loadActivity({ kind: 'listens' }); const navigation = c.getSnapshot().activityNavigation;
  await c.loadRecent(); assert.equal(c.getSnapshot().activityNavigation, navigation);
  await c.loadMoreActivity(); assert.deepEqual(ids(c), ['a', 'b']);
  await c.loadActivity({ kind: 'listens' }); assert.deepEqual(ids(c), ['a']);
  await c.loadMoreActivity(); assert.deepEqual(ids(c), ['a', 'b']); assert.equal(calls.length, 4);
});
