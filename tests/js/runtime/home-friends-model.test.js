const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const model = import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/model.mjs')));

// Source-level provider contract fixtures only. These are not an application
// backend mock, account migration, database test, browser test, or E2E result.
const friend = (account_ref = 'account:one', allowed_actions = {}) => ({
  account_ref, display_name: `Person ${account_ref}`, handle: `handle-${account_ref}`, relationship: 'accepted',
  allowed_actions: { can_view_activity: true, can_compare: true, can_remove: true, can_block: true, ...allowed_actions },
});
const request = (request_ref = 'request:one', overrides = {}) => ({ request_ref, display_name: 'Request sender',
  handle: 'sender', direction: 'incoming', allowed_actions: { can_accept: true, can_decline: true }, ...overrides });
const friends = (overrides = {}) => ({ friends: [friend()], requests: [request()],
  profile: { display_name: 'Self', handle: 'self', bio: '', allowed_actions: { can_edit: true } },
  allowed_actions: { can_request: true }, ...overrides });
const activity = (id = 'activity:one', overrides = {}) => ({
  rows: [{ id, kind: 'album', title: 'An album', artist: 'An artist', listen_count: 0, last_listened_at: null }],
  total_listens: null, period_label: 'This week', range_label: 'Server-owned date range', next_cursor: null, ...overrides,
});
const comparison = (id = 'comparison:one') => ({ rows: [{ id, kind: 'track', title: 'A track', artist: 'An artist',
  yours: { listen_count: 0, rating: null, last_listened_at: null }, friend: null }], next_cursor: null });
const recent = () => ({ recent_local_albums: [{ album_ref: 'album:one', row_kind: 'local_album',
  name: 'A recent album', album_artist: 'An artist', local_match_state: 'matched_local',
  listened_duration_seconds: null, allowed_actions: { can_open_album: true, can_play_album: false } }], recent_not_local_albums: [] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function controller(providers = {}, options = {}) {
  const { createHomeFriendsController } = await model;
  return createHomeFriendsController({ providers, ...options });
}
async function selected(providers = {}) {
  const c = await controller({ readFriends: async () => friends(), ...providers });
  await c.loadFriends(); assert.equal(c.selectFriend('account:one'), true); return c;
}

test('resources default to unavailable and metrics never invent zero for unknown data', async () => {
  const { resource, metric } = await model;
  assert.deepEqual(resource(), { status: 'unavailable', data: null });
  assert.deepEqual(resource('denied', null), { status: 'denied', data: null });
  for (const value of [undefined, null, '', '0', false, true, NaN, Infinity, -Infinity, -1, {}, []]) assert.equal(metric(value), '–');
  for (const value of [0, 1, 1.5, 1000000]) assert.equal(metric(value), String(value));
});

test('snapshot identity is stable until a change; subscriptions unsubscribe and dispose', async () => {
  const c = await controller({ readFriends: async () => friends() });
  const first = c.getSnapshot(); assert.equal(c.getSnapshot(), first);
  assert.equal(first.mutation.status, 'idle');
  let calls = 0; const stop = c.subscribe(() => { calls++; });
  c.setScope('account/library'); assert.equal(calls, 1); assert.notEqual(c.getSnapshot(), first);
  const scoped = c.getSnapshot(); c.setScope('account/library'); assert.equal(c.getSnapshot(), scoped);
  stop(); await c.loadFriends(); assert.equal(calls, 1);
  c.dispose(); await c.loadFriends(); c.setScope('another');
  assert.equal(c.getSnapshot().friends.status, 'unavailable');
  assert.equal(c.getSnapshot().scopeKey, null); assert.equal(calls, 1);
});

test('missing readers update unavailable synchronously without loading or fake records', async () => {
  const c = await controller();
  for (const [method, channel] of [['loadRecent', 'recent'], ['loadFriends', 'friends'], ['loadMembers', 'members'], ['loadActivity', 'activity'], ['loadComparison', 'comparison']]) {
    const pending = c[method]();
    assert.deepEqual(c.getSnapshot()[channel], { status: 'unavailable', data: null });
    await pending;
  }
  assert.equal(c.getSnapshot().friends.data, null);
});

test('real recent callback receives scope and abort signal, preserves server unknowns', async () => {
  let args;
  const c = await controller({}, { readRecent: async query => { args = query; return recent(); } });
  c.setScope('account/library');
  await c.loadRecent();
  assert.equal(args.scopeKey, 'account/library'); assert.ok(args.signal instanceof AbortSignal);
  assert.equal(c.getSnapshot().recent.data.recent_local_albums[0].listened_duration_seconds, null);
  assert.equal(c.getSnapshot().recent.data.recent_local_albums[0].allowed_actions.can_play_album, false);
});

test('raw and wrapped read responses share ready/empty semantics', async () => {
  for (const wrap of [data => data, data => ({ status: 'ready', data })]) {
    const c = await controller({ readFriends: async () => wrap(friends()), readActivity: async () => wrap(activity()) });
    await c.loadFriends(); await c.loadActivity();
    assert.equal(c.getSnapshot().friends.status, 'ready'); assert.equal(c.getSnapshot().activity.status, 'ready');
  }
  const c = await controller({ readFriends: async () => ({ status: 'ready', data: friends({ friends: [], requests: [] }) }),
    readActivity: async () => ({ status: 'empty', data: null }) },
  { readRecent: async () => ({ recent_local_albums: [], recent_not_local_albums: [] }) });
  await c.loadRecent(); await c.loadFriends(); await c.loadActivity();
  assert.equal(c.getSnapshot().recent.status, 'empty');
  assert.equal(c.getSnapshot().friends.status, 'empty');
  assert.equal(c.getSnapshot().friends.data.allowed_actions.can_request, true);
  assert.deepEqual(c.getSnapshot().activity, { status: 'empty', data: null });
});

for (const [name, bad] of [
  ['null', null], ['missing arrays', {}], ['non-array friends', { friends: {}, requests: [] }],
  ['duplicate friends', friends({ friends: [friend(), friend()] })],
  ['duplicate requests', friends({ requests: [request(), request()] })],
  ['pending friendship', friends({ friends: [{ ...friend(), relationship: 'pending' }] })],
  ['non-object profile', friends({ profile: [] })], ['nonempty empty envelope', { status: 'empty', data: friends() }],
  ['unknown status', { status: 'surprise', data: friends() }], ['sparse rows', friends({ friends: Array(1) })],
]) {
  test(`malformed friend response fails closed (${name})`, async () => {
    const c = await controller({ readFriends: async () => bad }); await c.loadFriends();
    assert.deepEqual(c.getSnapshot().friends, { status: 'error', data: null });
    assert.equal(c.selectFriend('account:one'), false);
  });
}

test('recent array/row contract rejects malformed payloads', async () => {
  for (const data of [{}, { recent_local_albums: [], recent_not_local_albums: null },
    { recent_local_albums: [null], recent_not_local_albums: [] }, { recent_local_albums: [[]], recent_not_local_albums: [] }]) {
    const c = await controller({}, { readRecent: async () => data }); await c.loadRecent();
    assert.deepEqual(c.getSnapshot().recent, { status: 'error', data: null });
  }
});

test('activity validates rows and IDs while normalizing unknown metrics and timestamps', async () => {
  const data = activity('a', { rows: [{ id: 'a', kind: 'track', title: 'Track', listen_count: '7', last_listened_at: 'bad-date' }], total_listens: -3 });
  const c = await controller({ readActivity: async () => data }); await c.loadActivity();
  const result = c.getSnapshot().activity.data;
  assert.equal(result.total_listens, null); assert.equal(result.rows[0].listen_count, null); assert.equal(result.rows[0].last_listened_at, null);
  for (const bad of [{ rows: null }, activity('a', { rows: [{ id: '', kind: 'album' }] }),
    activity('a', { rows: [{ id: 'a', kind: 'file' }] }), activity('a', { rows: [...activity().rows, ...activity().rows] }),
    activity('a', { next_cursor: 7 })]) {
    c.configure({ readActivity: async () => bad }); await c.loadActivity();
    assert.deepEqual(c.getSnapshot().activity, { status: 'error', data: null });
  }
});

test('comparison preserves missing sides, known zero and unknown rating', async () => {
  const c = await selected({ readComparison: async () => comparison() }); await c.loadComparison();
  const row = c.getSnapshot().comparison.data.rows[0];
  assert.equal(row.friend, null); assert.equal(row.yours.listen_count, 0); assert.equal(row.yours.rating, null);
});

test('read snapshots cannot gain grants from later provider-object mutation', async () => {
  const data = friends({ friends: [friend('account:one', { can_view_activity: false, can_compare: false })] });
  let reads = 0;
  const c = await controller({ readFriends: async () => data, readActivity: async () => { reads++; return activity(); } }); await c.loadFriends();
  data.friends[0].allowed_actions.can_view_activity = true;
  assert.equal(c.selectFriend('account:one'), true); await c.loadActivity();
  assert.equal(reads, 0); assert.equal(c.getSnapshot().activity.status, 'denied');
  assert.equal(Object.isFrozen(c.getSnapshot().friends.data.friends[0].allowed_actions), true);
});

test('identity, truthy and inherited values never grant selected-account access', async () => {
  for (const value of [undefined, null, false, 1, 'true']) {
    const c = await controller({ readFriends: async () => friends({ friends: [friend('account:one', {
      can_view_activity: value, can_compare: value,
    })] }), readActivity: async () => assert.fail('Nonboolean grant must not call activity reader'),
      readComparison: async () => assert.fail('Nonboolean grant must not call comparison reader') });
    await c.loadFriends(); assert.equal(c.selectFriend('account:one'), true);
    await c.loadActivity(); await c.loadComparison();
    assert.equal(c.getSnapshot().activity.status, 'denied'); assert.equal(c.getSnapshot().comparison.status, 'denied');
  }
  const c = await controller({ readFriends: async () => friends({ friends: [{ ...friend(),
    allowed_actions: Object.create({ can_view_activity: true, can_compare: true }) }] }),
    readActivity: async () => assert.fail('Inherited grant must not call activity reader'),
    readComparison: async () => assert.fail('Inherited grant must not call comparison reader') });
  await c.loadFriends(); assert.equal(c.selectFriend('account:one'), true);
  await c.loadActivity(); await c.loadComparison();
  assert.equal(c.getSnapshot().activity.status, 'denied'); assert.equal(c.getSnapshot().comparison.status, 'denied');
});

test('activity and comparison enforce separate explicit grants', async () => {
  let reads = 0;
  const c = await selected({ readFriends: async () => friends({ friends: [friend('account:one', { can_compare: false })] }),
    readActivity: async () => { reads++; return activity(); }, readComparison: async () => { reads++; return comparison(); } });
  await c.loadActivity(); await c.loadComparison(); assert.equal(reads, 1);
  assert.deepEqual(c.getSnapshot().comparison, { status: 'denied', data: null });
  c.selectFriend(null); await c.loadComparison(); assert.equal(reads, 1);
});

test('own activity calls only an explicit reader with account_ref null', async () => {
  const calls = [];
  const c = await controller({ readActivity: async args => { calls.push(args); return activity(); } });
  c.setScope('self/library'); await c.loadActivity({ kind: 'tracks', period: 'server-period', cursor: 'cursor:2' });
  assert.equal(calls.length, 1);
  const { signal, ...query } = calls[0];
  assert.deepEqual(query, { scopeKey: 'self/library', account_ref: null, kind: 'tracks', period: 'server-period', cursor: 'cursor:2' });
  assert.ok(signal instanceof AbortSignal);
});

test('history passes selected opaque ref and defaults unchanged, never synthesizes a page', async () => {
  let query;
  const c = await selected({ readActivity: async args => { query = args; return activity('next', { next_cursor: 'more' }); } });
  await c.loadActivity();
  assert.equal(query.account_ref, 'account:one'); assert.equal(query.kind, 'albums'); assert.equal(query.period, 'week'); assert.equal(query.cursor, null);
  assert.equal(c.getSnapshot().activity.data.next_cursor, 'more');
});

test('invalid history query does not call its reader', async () => {
  let calls = 0;
  const c = await controller({ readActivity: async () => { calls++; return activity(); } });
  for (const query of [{ kind: 'files' }, { period: '' }, { cursor: {} }]) {
    await c.loadActivity(query); assert.deepEqual(c.getSnapshot().activity, { status: 'error', data: null });
  }
  assert.equal(calls, 0);
});

for (const reject of [false, true]) {
  test(`newer recent read wins over stale ${reject ? 'error' : 'success'} even if provider ignores abort`, async () => {
    const old = deferred(); let calls = 0, oldSignal;
    const c = await controller({}, { readRecent: args => { if (++calls === 1) { oldSignal = args.signal; return old.promise; } return recent(); } });
    const pending = c.loadRecent(); await c.loadRecent(); const accepted = c.getSnapshot();
    assert.equal(oldSignal.aborted, true);
    if (reject) old.reject(Object.assign(new Error('Aborted old request'), { name: 'AbortError' })); else old.resolve({ status: 'denied' });
    await pending; assert.equal(c.getSnapshot(), accepted);
  });
}

test('selection aborts history and comparison and rejects late data or errors', async () => {
  const a = deferred(), b = deferred(), signals = [];
  const c = await selected({ readActivity: args => { signals.push(args.signal); return a.promise; },
    readComparison: args => { signals.push(args.signal); return b.promise; } });
  const pending = [c.loadActivity(), c.loadComparison()]; c.selectFriend(null);
  assert.ok(signals.every(signal => signal.aborted));
  a.resolve(activity()); b.reject(new Error('Late failure')); await Promise.all(pending);
  assert.equal(c.getSnapshot().selectedFriendRef, null);
  assert.deepEqual(c.getSnapshot().activity, { status: 'unavailable', data: null });
  assert.deepEqual(c.getSnapshot().comparison, { status: 'unavailable', data: null });
});

test('scope reset aborts all old reads and mutation with no cross-account refresh', async () => {
  const pending = { activity: deferred(), comparison: deferred(), mutation: deferred() };
  const signals = []; let friendReads = 0;
  const c = await selected({ readFriends: () => { friendReads++; return friends(); },
    readActivity: args => { signals.push(args.signal); return pending.activity.promise; },
    readComparison: args => { signals.push(args.signal); return pending.comparison.promise; },
    removeFriend: args => { signals.push(args.signal); return pending.mutation.promise; } });
  const waiting = [c.loadActivity(), c.loadComparison(), c.mutate('removeFriend', 'account:one')];
  c.setScope('new-account/library'); const reset = c.getSnapshot();
  assert.ok(signals.every(signal => signal.aborted));
  pending.activity.resolve(activity()); pending.comparison.reject(new Error('Late')); pending.mutation.resolve({ ok: true });
  await Promise.all(waiting);
  assert.equal(c.getSnapshot(), reset); assert.equal(friendReads, 1);
  assert.equal(reset.selectedFriendRef, null); assert.equal(reset.mutation.status, 'idle');
});

test('configure is inert for equal function identities and resets on provider replacement', async () => {
  const old = deferred(); let signal;
  const providers = { readActivity: args => { signal = args.signal; return old.promise; } };
  const c = await controller(providers); const pending = c.loadActivity(); const loading = c.getSnapshot();
  c.configure({ ...providers }); assert.equal(c.getSnapshot(), loading); assert.equal(signal.aborted, false);
  c.configure({ readActivity: async () => activity('new') }); assert.equal(signal.aborted, true);
  await c.loadActivity(); const newest = c.getSnapshot(); old.resolve(activity('old')); await pending;
  assert.equal(c.getSnapshot(), newest); assert.equal(newest.activity.data.rows[0].id, 'new');
});

test('a denied friends refresh purges selected private history', async () => {
  let denied = false;
  const c = await selected({ readFriends: async () => denied ? { status: 'denied', data: friends() } : friends(),
    readActivity: async () => activity(), readComparison: async () => comparison() });
  await c.loadActivity(); await c.loadComparison(); denied = true; await c.loadFriends();
  for (const channel of ['friends', 'activity', 'comparison']) assert.deepEqual(c.getSnapshot()[channel], { status: 'denied', data: null });
  assert.equal(c.getSnapshot().selectedFriendRef, null);
});

test('friend refresh aborts pending history; removal clears selection while revoked reads remain denied', async () => {
  for (const updated of [friends({ friends: [] }), friends({ friends: [friend('account:one', { can_view_activity: false, can_compare: false })] })]) {
    let refreshed = false, signal; const old = deferred();
    const c = await selected({ readFriends: async () => refreshed ? updated : friends(),
      readActivity: args => { signal = args.signal; return old.promise; } });
    const pending = c.loadActivity(); refreshed = true; await c.loadFriends();
    assert.equal(signal.aborted, true);
    assert.equal(c.getSnapshot().selectedFriendRef, updated.friends.length ? 'account:one' : null);
    old.resolve(activity()); await pending; assert.equal(c.getSnapshot().activity.data, null);
    if (updated.friends.length) {
      assert.equal(c.getSnapshot().activity.status, 'denied'); assert.equal(c.getSnapshot().comparison.status, 'denied');
    }
  }
});

test('partial grant revocation retains only the permitted selected-account mode', async () => {
  let revoke = false;
  const c = await selected({ readFriends: async () => friends({ friends: [friend('account:one', { can_view_activity: !revoke })] }),
    readActivity: async () => activity(), readComparison: async () => comparison() });
  await c.loadActivity(); await c.loadComparison(); revoke = true; await c.loadFriends();
  assert.equal(c.getSnapshot().selectedFriendRef, 'account:one');
  assert.deepEqual(c.getSnapshot().activity, { status: 'denied', data: null });
  assert.deepEqual(c.getSnapshot().comparison, { status: 'unavailable', data: null });
  await c.loadComparison(); assert.equal(c.getSnapshot().comparison.status, 'ready');
});

test('rejected authorization and transport errors clear the affected read data', async () => {
  for (const status of [401, 403, 500]) {
    let fail = false;
    const c = await controller({ readActivity: async () => { if (fail) throw Object.assign(new Error('Do not expose private details'), { status }); return activity(); } });
    await c.loadActivity(); fail = true; await c.loadActivity();
    assert.deepEqual(c.getSnapshot().activity, { status: status === 500 ? 'error' : 'denied', data: null });
  }
});

test('mutations require exact current grants and incoming requests', async () => {
  let writes = 0;
  for (const value of [false, 'true', 1, null]) {
    const c = await controller({ readFriends: async () => friends({ friends: [friend('account:one', { can_remove: value })] }),
      removeFriend: async () => { writes++; return { ok: true }; } });
    await c.loadFriends(); assert.equal((await c.mutate('removeFriend', 'account:one')).status, 'denied');
  }
  const c = await controller({ readFriends: async () => friends({ requests: [request('request:one', { direction: 'outgoing' })] }),
    acceptRequest: async () => { writes++; return { ok: true }; } });
  await c.loadFriends(); assert.equal((await c.mutate('acceptRequest', 'request:one')).status, 'denied');
  assert.equal((await c.mutate('constructor', 'account:one')).status, 'denied');
  assert.equal(writes, 0);
});

test('authorized action with missing mutation provider is unavailable synchronously', async () => {
  const c = await selected(); const pending = c.mutate('removeFriend', 'account:one');
  assert.equal(c.getSnapshot().mutation.status, 'unavailable'); await pending;
  assert.equal(c.getSnapshot().friends.data.friends.length, 1);
});

test('mutations pass only explicit action DTOs and refresh authoritative projection after success', async () => {
  for (const [action, target, value, expected] of [
    ['requestFriend', 'new-handle', null, { handle: 'new-handle' }],
    ['acceptRequest', 'request:one', null, { request_ref: 'request:one' }],
    ['declineRequest', 'request:one', null, { request_ref: 'request:one' }],
    ['removeFriend', 'account:one', null, { account_ref: 'account:one' }],
    ['blockFriend', 'account:one', null, { account_ref: 'account:one' }],
    ['saveProfile', null, { display_name: 'New name', handle: 'self', bio: 'New bio', unrelated: 'omit' },
      { profile: { display_name: 'New name', handle: 'self', bio: 'New bio' } }],
  ]) {
    let calls = 0, args;
    const c = await selected({ readFriends: async () => { calls++; return friends(); },
      [action]: async query => { args = query; return { status: 'ready', data: { ignored: 'No optimistic projection' } }; } });
    const result = await c.mutate(action, target, value);
    assert.equal(result.status, 'ready'); assert.equal(calls, 2);
    const { signal, scopeKey, ...dto } = args;
    assert.deepEqual(dto, expected); assert.ok(signal instanceof AbortSignal); assert.equal(scopeKey, null);
  }
});

test('Friends authority hook receives only completed normalized results and denied mutation projections', async () => {
  const pending = deferred(), records = [];
  const c = await controller({readFriends: () => pending.promise, removeFriend: async () => ({status: 'denied'})},
    {onFriendsAuthority: packet => records.push(packet)});
  c.setScope('viewer/library'); const reading = c.loadFriends();
  assert.equal(records.length, 0, 'a read start is not a source permission withdrawal');
  pending.resolve(friends({friends: [{...friend(), private_path: '/private', allowed_actions: {
    can_view_activity: 'true', can_remove: true,
  }}]})); await reading;
  assert.equal(records.length, 1); assert.equal(records[0].scopeKey, 'viewer/library');
  assert.equal(records[0].friends, c.getSnapshot().friends); assert.ok(Object.isFrozen(records[0].friends));
  assert.equal(records[0].friends.data.friends[0].allowed_actions.can_view_activity, false);
  assert.doesNotMatch(JSON.stringify(records[0]), /private_path|\/private/);
  await c.mutate('removeFriend', 'account:one'); assert.equal(records.at(-1).friends.status, 'denied');
  const count = records.length; c.dispose(); assert.equal(records.length, count, 'UI lifetime is separate from completed authority');
});

test('Friends authority hook retires unavailable/error sources but ignores superseded provider results', async () => {
  const records = [], pending = deferred();
  const c = await controller({readFriends: () => pending.promise}, {onFriendsAuthority: packet => records.push(packet)});
  c.setScope('old'); const reading = c.loadFriends(); c.setScope('new');
  pending.resolve(friends()); await reading; assert.equal(records.length, 0);
  c.configure({}); await c.loadFriends(); assert.equal(records.at(-1).friends.status, 'unavailable');
  c.configure({readFriends: () => {throw new Error('Unavailable source');}}); await c.loadFriends();
  assert.equal(records.at(-1).friends.status, 'error'); assert.equal(records.at(-1).scopeKey, 'new');
});

test('no optimistic success; duplicate writes remain blocked through projection refresh', async () => {
  const write = deferred(), refresh = deferred(); let writes = 0, reads = 0;
  const c = await selected({ readFriends: () => ++reads === 1 ? friends() : refresh.promise,
    removeFriend: () => { writes++; return write.promise; } });
  const pending = c.mutate('removeFriend', 'account:one');
  assert.equal(c.getSnapshot().mutation.status, 'loading'); assert.equal(c.getSnapshot().friends.data.friends.length, 1);
  await c.mutate('removeFriend', 'account:one'); assert.equal(writes, 1);
  write.resolve({ ok: true }); await Promise.resolve();
  assert.equal(reads, 2); assert.equal(c.getSnapshot().mutation.status, 'loading');
  await c.mutate('removeFriend', 'account:one'); assert.equal(writes, 1);
  refresh.resolve(friends({ friends: [] })); await pending;
  assert.equal(c.getSnapshot().mutation.status, 'ready'); assert.equal(c.getSnapshot().friends.data.friends.length, 0);
});

test('successful relationship writes clear selected history without trusting write payload rows', async () => {
  const c = await selected({ readActivity: async () => activity(), readComparison: async () => comparison(),
    removeFriend: async () => ({ ok: true, friends: [friend('not-authoritative')] }) });
  await c.loadActivity(); await c.loadComparison(); await c.mutate('removeFriend', 'account:one');
  assert.equal(c.getSnapshot().selectedFriendRef, null); assert.equal(c.getSnapshot().activity.data, null); assert.equal(c.getSnapshot().comparison.data, null);
  assert.equal(c.getSnapshot().friends.data.friends[0].account_ref, 'account:one');
});

test('unacknowledged/failed mutation responses never report success or refresh', async () => {
  for (const response of [undefined, null, {}, { ok: false }, { status: 'empty' }, { status: 'error', ok: true }, { status: 'ready', ok: false }]) {
    let reads = 0;
    const c = await selected({ readFriends: async () => { reads++; return friends(); }, removeFriend: async () => response });
    assert.equal((await c.mutate('removeFriend', 'account:one')).status, 'error'); assert.equal(reads, 1);
  }
});

test('mutation denial purges private history and aborts an older friends refresh', async () => {
  const denial = deferred(), oldFriends = deferred(); let reads = 0, signal;
  const c = await selected({ readFriends: args => { if (++reads === 1) return friends(); signal = args.signal; return oldFriends.promise; },
    readActivity: async () => activity(), removeFriend: () => denial.promise });
  await c.loadActivity(); const mutation = c.mutate('removeFriend', 'account:one'); const refresh = c.loadFriends();
  denial.resolve({ status: 'denied', data: friends() }); await mutation;
  assert.equal(signal.aborted, true); const denied = c.getSnapshot();
  assert.equal(denied.mutation.status, 'denied'); assert.equal(denied.friends.data, null); assert.equal(denied.activity.data, null);
  oldFriends.resolve(friends()); await refresh; assert.equal(c.getSnapshot(), denied);
});

test('dispose aborts outstanding requests and cannot publish their completion', async () => {
  const pending = deferred(); let signal, changes = 0;
  const c = await controller({ readActivity: args => { signal = args.signal; return pending.promise; } });
  c.subscribe(() => { changes++; }); const read = c.loadActivity(); c.dispose(); const disposed = c.getSnapshot();
  assert.equal(signal.aborted, true); pending.resolve(activity()); await read;
  assert.equal(c.getSnapshot(), disposed); assert.equal(changes, 1);
});

test('native recent payload supersedes an older reader and rejects malformed replacements', async () => {
  const older = deferred(); let signal;
  const c = await controller({}, { readRecent: args => { signal = args.signal; return older.promise; } });
  const pending = c.loadRecent(); const data = recent(); data.recent_local_albums[0].name = 'Fresh native payload';
  assert.equal(c.acceptRecent(data).status, 'ready'); assert.equal(signal.aborted, true);
  const accepted = c.getSnapshot(); older.resolve(recent()); await pending;
  assert.equal(c.getSnapshot(), accepted);
  assert.equal(accepted.recent.data.recent_local_albums[0].name, 'Fresh native payload');
  assert.equal(c.acceptRecent({ recent_local_albums: [], recent_not_local_albums: [] }).status, 'empty');
  assert.equal(c.acceptRecent({ recent_local_albums: null }).status, 'error');
  assert.equal(c.getSnapshot().recent.data, null);
  c.dispose(); const disposed = c.getSnapshot(); c.acceptRecent(recent()); assert.equal(c.getSnapshot(), disposed);
});

test('scope change from a loading subscriber prevents invoking a stale provider', async () => {
  let reads = 0;
  const c = await controller({ readActivity: async () => { reads++; return activity(); } });
  c.subscribe(() => { if (c.getSnapshot().activity.status === 'loading') c.setScope('new-scope'); });
  await c.loadActivity(); assert.equal(reads, 0);
  assert.equal(c.getSnapshot().scopeKey, 'new-scope'); assert.equal(c.getSnapshot().activity.status, 'unavailable');
});

test('scope change on write acknowledgement prevents a cross-account projection refresh', async () => {
  let reads = 0;
  const c = await selected({ readFriends: async () => { reads++; return friends(); }, removeFriend: async () => ({ ok: true }) });
  c.subscribe(() => {
    const state = c.getSnapshot();
    if (state.mutation.status === 'loading' && state.selectedFriendRef === null) c.setScope('new-scope');
  });
  await c.mutate('removeFriend', 'account:one');
  assert.equal(reads, 1); assert.equal(c.getSnapshot().scopeKey, 'new-scope');
  assert.equal(c.getSnapshot().friends.status, 'unavailable'); assert.equal(c.getSnapshot().mutation.status, 'idle');
});


test('accepted friends without read grants can still be selected for an expressly allowed relationship action', async () => {
  let writes = 0;
  const c = await controller({ readFriends: async () => friends({ friends: [friend('account:one', {
    can_view_activity: false, can_compare: false, can_remove: true, can_block: false,
  })] }), readActivity: async () => assert.fail('Denied activity must not load'),
  readComparison: async () => assert.fail('Denied comparison must not load'),
  removeFriend: async () => { writes++; return { ok: true }; } });
  await c.loadFriends(); assert.equal(c.selectFriend('account:one'), true);
  await c.loadActivity(); await c.loadComparison();
  assert.equal(c.getSnapshot().activity.status, 'denied'); assert.equal(c.getSnapshot().comparison.status, 'denied');
  assert.equal((await c.mutate('removeFriend', 'account:one')).status, 'ready'); assert.equal(writes, 1);
});

test('profile image URLs allow only explicit HTTP(S) or root-relative references', async () => {
  const {safeAvatarUrl} = await model;
  for (const value of ['/avatars/person.webp', '/avatars/person.png?version=2', 'https://images.example/person.jpg', 'http://localhost:8080/avatar.png']) {
    assert.equal(safeAvatarUrl(value), value);
  }
  for (const value of [null, {}, '', 'avatar.png', '//images.example/avatar.png', 'https:/images.example/avatar.png',
    'javascript:alert(1)', 'data:image/png;base64,ABC', 'blob:https://app.example/id', 'file:///tmp/image.png',
    'https://user:secret@example.com/a.png', 'https://user@example.com/a.png', 'https://', '/\\outside.example/photo',
    ' /image.png', '/image.png\n', 'https://example.com/hello world.png']) assert.equal(safeAvatarUrl(value), null, String(value));
});

test('own and friend identity fields are normalized without fabricating avatars or granting friend edits', async () => {
  const c = await controller({readFriends: async () => friends({friends: [{...friend(), bio: 'Friend bio',
    avatar_url: 'javascript:alert(1)', allowed_actions: {can_edit: true, can_upload_avatar: true}}],
    profile: {display_name: 'Self', handle: 'self', bio: 'Own bio', avatar_url: '/avatars/self.png',
      allowed_actions: {can_edit: true, can_upload_avatar: 'true'}}})});
  await c.loadFriends();
  const data = c.getSnapshot().friends.data;
  assert.equal(data.profile.avatar_url, '/avatars/self.png'); assert.equal(data.profile.bio, 'Own bio');
  assert.equal(data.profile.allowed_actions.can_upload_avatar, false);
  assert.equal(data.friends[0].avatar_url, null); assert.equal(data.friends[0].bio, 'Friend bio');
  assert.equal(Object.hasOwn(data.friends[0].allowed_actions, 'can_edit'), false);
});

test('profile draft and file validators reject malformed or oversize values at the controller boundary', async () => {
  const {validAvatarFile, validProfileDraft} = await model;
  const {File} = require('node:buffer');
  const draft = {display_name: 'Self', handle: 'self', bio: ''};
  assert.equal(validProfileDraft(draft), true);
  for (const value of [null, Object.create(draft), {...draft, display_name: ' '}, {...draft, display_name: 'x'.repeat(51)},
    {...draft, handle: 'ab'}, {...draft, handle: '@self'}, {...draft, handle: 'x'.repeat(31)}, {...draft, bio: 'x'.repeat(241)}]) {
    assert.equal(validProfileDraft(value), false);
  }
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(validAvatarFile(new File(['bytes'], 'photo', {type})), true);
  }
  assert.equal(validAvatarFile(new File([new Uint8Array(5 * 1024 * 1024)], 'photo.png', {type: 'image/png'})), true);
  for (const value of [null, {}, {name: 'fake', type: 'image/png', size: 10}, new Blob(['bytes'], {type: 'image/png'}),
    new File([], 'empty.png', {type: 'image/png'}), new File(['bytes'], 'photo.svg', {type: 'image/svg+xml'}),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', {type: 'image/png'})]) assert.equal(validAvatarFile(value), false);
});

test('profile file writes require both exact own-profile grants and cannot target a friend', async () => {
  const {File} = require('node:buffer');
  const avatar_file = new File(['bytes'], 'photo.png', {type: 'image/png'});
  const value = {display_name: 'Self', handle: 'self', bio: '', avatar_file};
  let writes = 0;
  for (const allowed_actions of [{can_edit: true}, {can_edit: false, can_upload_avatar: true},
    {can_edit: true, can_upload_avatar: 'true'}, {can_edit: 'true', can_upload_avatar: true},
    Object.assign(Object.create({can_upload_avatar: true}), {can_edit: true})]) {
    const c = await controller({readFriends: async () => friends({profile: {...value, allowed_actions}}),
      saveProfile: async () => {writes++; return {ok: true};}});
    await c.loadFriends(); assert.equal((await c.mutate('saveProfile', null, value)).status, 'denied');
  }
  const c = await controller({readFriends: async () => friends({profile: {...value, allowed_actions: {can_edit: true, can_upload_avatar: true}}}),
    saveProfile: async () => {writes++; return {ok: true};}});
  await c.loadFriends();
  assert.equal((await c.mutate('saveProfile', 'account:one', value)).status, 'denied');
  assert.equal((await c.mutate('saveProfile', null, {...value, avatar_file: {name: 'fake', type: 'image/png', size: 10}})).status, 'denied');
  assert.equal(writes, 0);
});

test('profile File reaches only the authorized save call, is not persisted, and URL changes are omitted', async () => {
  const {File} = require('node:buffer');
  const avatar_file = new File(['bytes'], 'photo.webp', {type: 'image/webp'});
  const profile = {display_name: 'Self', handle: 'self', bio: '', allowed_actions: {can_edit: true, can_upload_avatar: true}};
  let args;
  const c = await controller({readFriends: async () => friends({profile}), saveProfile: async input => {args = input; return {ok: true};}});
  await c.loadFriends(); assert.equal(args, undefined);
  const result = await c.mutate('saveProfile', null, {...profile, avatar_file, avatar_url: 'blob:local-only', unrelated: 'omit'});
  assert.equal(result.status, 'ready'); assert.equal(args.avatar_file, avatar_file);
  assert.deepEqual(args.profile, {display_name: 'Self', handle: 'self', bio: ''});
  assert.deepEqual(Object.keys(args).sort(), ['avatar_file', 'profile', 'scopeKey', 'signal']);
  assert.equal(JSON.stringify(c.getSnapshot()).includes('avatar_file'), false);
  assert.equal(c.getSnapshot().friends.data.profile.avatar_url, null);
});

test('unsupported and denied profile saves never synthesize success or retain image drafts', async () => {
  const {File} = require('node:buffer');
  const avatar_file = new File(['bytes'], 'photo.png', {type: 'image/png'});
  const profile = {display_name: 'Self', handle: 'self', bio: '', allowed_actions: {can_edit: true, can_upload_avatar: true}};
  for (const status of ['unavailable', 'denied']) {
    const c = await controller({readFriends: async () => friends({profile}), saveProfile: async () => ({status})});
    await c.loadFriends(); assert.equal((await c.mutate('saveProfile', null, {...profile, avatar_file})).status, status);
    assert.equal(JSON.stringify(c.getSnapshot()).includes('avatar_file'), false);
    if (status === 'denied') assert.equal(c.getSnapshot().friends.data, null);
  }
  const c = await controller({readFriends: async () => friends({profile})});
  await c.loadFriends(); assert.equal((await c.mutate('saveProfile', null, {...profile, avatar_file})).status, 'unavailable');
  assert.equal(c.getSnapshot().friends.data.profile.display_name, 'Self');
});

test('profile upload cancellation on account change cannot refresh or publish into the next account', async () => {
  const {File} = require('node:buffer');
  const avatar_file = new File(['bytes'], 'photo.png', {type: 'image/png'}), pending = deferred();
  const profile = {display_name: 'Self', handle: 'self', bio: '', allowed_actions: {can_edit: true, can_upload_avatar: true}};
  let signal, reads = 0;
  const c = await controller({readFriends: async () => {reads++; return friends({profile});},
    saveProfile: query => {signal = query.signal; return pending.promise;}});
  c.setScope('original'); await c.loadFriends();
  const saving = c.mutate('saveProfile', null, {...profile, avatar_file});
  c.setScope('another-account'); const reset = c.getSnapshot();
  assert.equal(signal.aborted, true); pending.resolve({ok: true}); await saving;
  assert.equal(c.getSnapshot(), reset); assert.equal(reads, 1); assert.equal(reset.friends.data, null);
  assert.equal(reset.mutation.status, 'idle');
});

test('activity DTO retains only normalized facts and explicit detail authority', async () => {
  const input = {id: 'listen:one', kind: 'listen', title: 'A song', artist: 'Artist', album_title: 'Album',
    listen_count: 0, duration_seconds: 185.5, rating: 5, last_listened_at: '2026-10-08T00:00:00Z',
    artwork_url: '/artwork/opaque', source_label: 'Provider source', detail_ref: 'detail:opaque',
    allowed_actions: {can_view_details: true, can_play_album: true}, track_path: '/private/music/song',
    album_ref: 'private-native-ref'};
  const c = await controller({readActivity: async () => ({rows: [input], total_listens: 943,
    period_label: 'Provider period', range_label: 'Provider range', next_cursor: 'cursor:opaque'})});
  await c.loadActivity({kind: 'listens'});
  const data = c.getSnapshot().activity.data;
  assert.equal(data.total_listens, 943, 'summary is not calculated from this page');
  assert.equal(data.rows[0].listen_count, 0);
  assert.equal(data.rows[0].duration_seconds, 185.5);
  assert.equal(data.rows[0].rating, 5);
  assert.equal(data.rows[0].detail_ref, 'detail:opaque');
  assert.deepEqual(data.rows[0].allowed_actions, {can_view_details: true});
  assert.equal(data.rows[0].track_path, undefined);
  assert.equal(data.rows[0].album_ref, undefined);
  assert.equal(data.next_cursor, 'cursor:opaque');
  assert.equal(data.period_label, 'Provider period');
  assert.equal(data.range_label, 'Provider range');
  input.title = 'Mutated provider'; input.allowed_actions.can_view_details = false;
  assert.equal(data.rows[0].title, 'A song');
  assert.equal(data.rows[0].allowed_actions.can_view_details, true);
  for (const value of [data, data.rows, data.rows[0], data.rows[0].allowed_actions]) assert.ok(Object.isFrozen(value));
});

test('activity rating limits depend on resource kind; malformed optional facts stay unknown', async () => {
  const cases = [['track', 5, 5], ['track', 6, null], ['listen', 5, 5], ['listen', 6, null],
    ['album', 10, 10], ['album', 11, null], ['artist', 1, null], ['album', 0, null], ['track', 2.5, null]];
  const c = await controller({readActivity: async () => ({rows: cases.map(([kind, rating], index) => ({
    id: `item:${index}`, kind, rating, title: null, artist: false, album_title: {},
    listen_count: '0', duration_seconds: Infinity, last_listened_at: 'not a timestamp',
    artwork_url: '//foreign.example/art', detail_ref: '', allowed_actions: Object.create({can_view_details: true}),
  }))})});
  await c.loadActivity();
  for (const [index, row] of c.getSnapshot().activity.data.rows.entries()) {
    assert.equal(row.rating, cases[index][2]);
    assert.equal(row.listen_count, null); assert.equal(row.duration_seconds, null);
    assert.equal(row.last_listened_at, null); assert.equal(row.artwork_url, null); assert.equal(row.detail_ref, null);
    assert.equal(row.title, ''); assert.equal(row.artist, ''); assert.equal(row.album_title, '');
    assert.equal(row.allowed_actions.can_view_details, false);
  }
});

test('activity track preferences keep public facts and strict grants while stripping private authority', async () => {
  const input = {id: 'track:one', kind: 'track', title: 'Track', source_readable: true, availability: 'local',
    secondary_artist: 'Guest', love_tier: 'obsessed', path: '/private/song.flac', track_ref: 'private:track',
    track_preference: {identity: 'public:preference', love_tier: 'obsessed', rating: 4, actor_id: 'private:actor',
      track_ref: 'private:track', allowed_actions: {can_set_love_tier: true, can_set_rating: true}}};
  const c = await controller({readActivity: async () => ({rows: [input,
    {...input, id: 'track:ungranted', track_preference: {...input.track_preference, allowed_actions: {can_set_love_tier: 'true'}}},
    {...input, id: 'track:unknown', availability: 'fabricated', love_tier: true, track_preference: {love_tier: 'loved'}}]})});
  await c.loadActivity(); const [known, denied, unknown] = c.getSnapshot().activity.data.rows;
  assert.deepEqual(known.track_preference, {identity: 'public:preference', love_tier: 'obsessed', rating: 4,
    allowed_actions: {can_set_love_tier: true}});
  assert.equal(known.secondary_artist, 'Guest'); assert.equal(known.availability, 'local');
  assert.equal(known.path, undefined); assert.equal(known.track_ref, undefined);
  assert.equal(denied.track_preference.allowed_actions.can_set_love_tier, false);
  assert.equal(unknown.availability, 'unresolved'); assert.equal(unknown.love_tier, null);
  assert.equal(unknown.track_preference.identity, null); assert.equal(unknown.track_preference.allowed_actions.can_set_love_tier, false);
  assert.ok(Object.isFrozen(known.track_preference)); assert.ok(Object.isFrozen(known.track_preference.allowed_actions));
});

test('activity catalog targets retain explicit kind/ref/origin without deriving Artist identity from labels', async () => {
  const origin = {source: 'activity', account_ref: null, kind: 'tracks', period: 'month', snapshot_ref: 'snapshot:one'};
  const album = {kind: 'album', ref: 'album:canonical', origin, allowed_actions: {can_view_details: true},
    native_actions: {album_ref: 'local:album', path: '/private', allowed_actions: {can_open_album: true}}, private: 'omit'};
  const artist = {kind: 'artist', ref: 'artist:canonical', allowed_actions: Object.create({can_view_details: true}),
    native_actions: {artist_ref: 'local:artist', gallery_target: {artist: 'private navigation'}, allowed_actions: {can_open_artist_gallery: true}}};
  const c = await controller({readActivity: async () => ({snapshot_ref: 'snapshot:one', rows: [
    {id: 'track:one', kind: 'track', artist: 'Display only', album_target: album, artist_target: artist},
    {id: 'artist:label', kind: 'artist', title: 'Display only'},
    {id: 'wrong:kind', kind: 'album', album_target: artist},
    {id: 'album:denied', kind: 'album', source_readable: false, album_target: album, artist_target: artist},
  ]})});
  await c.loadActivity({kind: 'tracks', period: 'month'});
  const data = c.getSnapshot().activity.data, [known, label, wrong, denied] = data.rows;
  assert.equal(data.snapshot_ref, 'snapshot:one'); assert.deepEqual(known.album_target.origin, origin);
  assert.equal(known.album_target.native_actions.album_ref, 'local:album'); assert.ok(Object.isFrozen(known.album_target));
  assert.equal(known.artist_target.allowed_actions.can_view_details, false);
  assert.equal(label.artist_target, null); assert.equal(wrong.album_target, null);
  assert.equal(denied.album_target, undefined); assert.equal(denied.artist_target, undefined);
  assert.doesNotMatch(JSON.stringify(data), /private|"path"/);
});

test('denied activity tracks retain only an opaque row placeholder and cannot leak prior preference facts', async () => {
  const c = await controller({readActivity: async () => ({rows: [{id: 'listen:denied', kind: 'listen', source_readable: false,
    title: 'Private title', artist: 'Private artist', album_title: 'Private album', source_label: 'Private source',
    artwork_url: '/artwork/private', duration_seconds: 180, listen_count: 4, rating: 5, love_tier: 'obsessed',
    detail_ref: 'private:detail', track_preference: {identity: 'private:pref', love_tier: 'obsessed', allowed_actions: {can_set_love_tier: true}},
    allowed_actions: {can_view_details: true}}]})});
  await c.loadActivity({kind: 'listens'}); const denied = c.getSnapshot().activity.data.rows[0];
  assert.equal(denied.id, 'listen:denied'); assert.equal(denied.kind, 'listen'); assert.equal(denied.source_readable, false);
  assert.equal(denied.title, 'Unavailable track'); assert.equal(denied.track_preference, null);
  assert.equal(denied.love_tier, null); assert.equal(denied.listen_count, null); assert.equal(denied.duration_seconds, null);
  assert.equal(denied.allowed_actions.can_view_details, false); assert.doesNotMatch(JSON.stringify(denied), /[Pp]rivate/);
});

test('malformed history identities, duplicate rows and cursors fail closed for both channels', async () => {
  for (const channel of ['activity', 'comparison']) {
    const valid = channel === 'activity' ? activity().rows[0] : comparison().rows[0];
    for (const payload of [{rows: [valid, valid]}, {rows: [null]}, {rows: Array(1)},
      {rows: [{...valid, id: ''}]}, {rows: [{...valid, kind: 'file'}]}, {rows: [valid], next_cursor: {}},
      {status: 'empty', data: {rows: [valid]}}]) {
      const c = await selected({[channel === 'activity' ? 'readActivity' : 'readComparison']: async () => payload});
      await c[channel === 'activity' ? 'loadActivity' : 'loadComparison']();
      assert.deepEqual(c.getSnapshot()[channel], {status: 'error', data: null});
    }
  }
});

test('a newer history page supersedes stale denied completion without changing the new page', async () => {
  for (const channel of ['activity', 'comparison']) {
    const pending = deferred(), queries = [];
    const reader = args => {queries.push(args); return queries.length === 1 ? pending.promise
      : channel === 'activity' ? activity('fresh-page') : comparison('fresh-page');};
    const c = await selected({[channel === 'activity' ? 'readActivity' : 'readComparison']: reader});
    const load = options => c[channel === 'activity' ? 'loadActivity' : 'loadComparison'](options);
    const old = load({period: 'week'});
    await load({period: 'month', cursor: 'next-page'});
    const fresh = c.getSnapshot();
    assert.equal(queries[0].signal.aborted, true);
    assert.equal(queries[1].period, 'month'); assert.equal(queries[1].cursor, 'next-page');
    pending.resolve({status: 'denied'}); await old;
    assert.equal(c.getSnapshot(), fresh);
    assert.equal(fresh[channel].data.rows[0].id, 'fresh-page');
  }
});

test('replacing providers during a write aborts its acknowledgement and prevents an obsolete refresh', async () => {
  const write = deferred(); let signal, newReads = 0;
  const c = await selected({removeFriend: args => {signal = args.signal; return write.promise;}});
  const pending = c.mutate('removeFriend', 'account:one');
  c.configure({readFriends: async () => {newReads++; return friends();}});
  const replaced = c.getSnapshot();
  assert.equal(signal.aborted, true);
  write.resolve({ok: true}); await pending;
  assert.equal(c.getSnapshot(), replaced); assert.equal(newReads, 0);
  assert.equal(replaced.mutation.status, 'idle'); assert.equal(replaced.selectedFriendRef, null);
});

test('recent album detail grants remain independent of native open and play grants', async () => {
  for (const [allowed_actions, expected] of [
    [{can_open_album: true, can_play_album: true}, false],
    [{can_open_album: false, can_view_details: true}, true],
    [{can_view_details: 'true'}, false],
    [Object.create({can_view_details: true}), false],
  ]) {
    const data = recent(); data.recent_local_albums[0].allowed_actions = allowed_actions;
    const c = await controller({}, {readRecent: () => data});
    await c.loadRecent();
    const actions = c.getSnapshot().recent.data.recent_local_albums[0].allowed_actions;
    assert.equal(actions.can_view_details, expected);
    assert.equal(actions.can_open_album, Object.hasOwn(allowed_actions, 'can_open_album') && allowed_actions.can_open_album === true);
  }
});
