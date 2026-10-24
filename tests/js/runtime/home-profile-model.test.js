const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const model = import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/model.mjs')));
const navigation = import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/navigation.mjs')));
const person = (overrides = {}) => ({account_ref: 'account:member', display_name: 'Member', handle: 'member', bio: 'Bio',
  avatar_url: '/avatars/member.png', relationship: 'none', allowed_actions: {can_view_profile: true}, ...overrides});
const incoming = overrides => ({...person(), request_ref: 'request:one', direction: 'incoming',
  created_at: '2026-10-08T10:00:00Z', allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}, ...overrides});
const directory = overrides => ({friends: [], requests: [incoming()], profile: null,
  allowed_actions: {can_discover_members: true}, ...overrides});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
async function setup(providers = {}) {
  const {createHomeFriendsController} = await model;
  const controller = createHomeFriendsController({providers: {readFriends: async () => directory(), ...providers}});
  controller.setScope('viewer/library'); await controller.loadFriends(); return controller;
}

test('request profiles require exact supplied identity and independent own-property read grant', async () => {
  const {profilePerson} = await model;
  for (const overrides of [{account_ref: undefined}, {account_ref: ''}, {allowed_actions: {can_accept: true}},
    {allowed_actions: {can_view_profile: 'true'}}, {allowed_actions: Object.create({can_view_profile: true})}]) {
    const c = await setup({readFriends: async () => directory({requests: [incoming(overrides)]}),
      readProfile: () => assert.fail('An unreadable source cannot call a profile provider')});
    assert.equal(c.selectProfile('account:member'), false);
    assert.equal(c.selectProfile('member'), false); assert.equal(c.selectProfile('request:one'), false);
    assert.equal(profilePerson(c.getSnapshot(), 'account:member'), null);
    assert.equal((await c.loadProfile()).status, 'denied');
  }
});

test('request and member summaries preserve safe supplied display facts without inventing event dates', async () => {
  const c = await setup({readFriends: async () => directory({requests: [incoming({avatar_url: 'javascript:bad', created_at: 'invalid'})]}),
    readMembers: async () => ({members: [person()], next_cursor: null})});
  const row = c.getSnapshot().friends.data.requests[0];
  assert.equal(row.account_ref, 'account:member'); assert.equal(row.avatar_url, null);
  assert.equal(row.created_at, null); assert.equal(row.bio, 'Bio'); assert.equal(row.relationship, 'incoming_pending');
  await c.loadMembers({query: 'member'});
  assert.equal(c.getSnapshot().members.data.members[0].bio, 'Bio');
  assert.equal(Object.isFrozen(row.allowed_actions), true);
});

test('readable profile does not authorize friendship, private reads or profile-supplied mutations', async () => {
  let profileQuery;
  const c = await setup({readProfile: args => {profileQuery = args; return person({relationship: 'accepted',
    allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true, can_remove: true}});},
  readActivity: () => assert.fail('Profile selection must not fall through to own activity'),
  readComparison: () => assert.fail('A profile is not an accepted-friend grant'),
  removeFriend: () => assert.fail('A profile cannot authorize removal')});
  assert.equal(c.selectProfile('account:member'), true); await c.loadProfile();
  assert.equal(profileQuery.account_ref, 'account:member'); assert.equal(profileQuery.scopeKey, 'viewer/library');
  assert.ok(profileQuery.signal instanceof AbortSignal); assert.equal(c.getSnapshot().profile.status, 'ready');
  assert.equal(c.selectFriend('account:member'), false);
  assert.equal((await c.loadActivity()).status, 'denied'); assert.equal((await c.loadComparison()).status, 'denied');
  assert.equal((await c.mutate('removeFriend', 'account:member')).status, 'denied');
});

test('missing, mismatched and revoked profile readers never become ready from summary facts', async () => {
  const {profilePerson} = await model;
  const missing = await setup(); missing.selectProfile('account:member');
  assert.equal((await missing.loadProfile()).status, 'unavailable');
  assert.equal(profilePerson(missing.getSnapshot(), 'account:member').display_name, 'Member');
  for (const [response, expected] of [[person({account_ref: 'someone:else'}), 'error'],
    [person({allowed_actions: {can_view_profile: false}}), 'denied'], [{status: 'denied'}, 'denied'],
    [{status: 'empty', data: null}, 'empty']]) {
    const c = await setup({readProfile: async () => response}); c.selectProfile('account:member');
    assert.equal((await c.loadProfile()).status, expected); assert.equal(c.getSnapshot().profile.data, null);
  }
});

test('source refresh immediately erases detail and prevents a late profile result after revocation', async () => {
  const pending = deferred(); let revoked = false, signal;
  const c = await setup({readFriends: async () => directory({requests: revoked ? [] : [incoming()]}),
    readProfile: args => {signal = args.signal; return pending.promise;}});
  c.selectProfile('account:member'); const read = c.loadProfile(); revoked = true;
  const refresh = c.loadFriends(); assert.equal(signal.aborted, true); assert.equal(c.getSnapshot().profile.data, null);
  await refresh; const current = c.getSnapshot();
  assert.equal(current.selectedProfileRef, null); pending.resolve(person()); await read;
  assert.equal(c.getSnapshot(), current); assert.equal(current.profile.status, 'denied');
});

test('replacing member results, providers, scope or selection retires earlier profile work', async () => {
  for (const invalidate of [c => c.loadMembers({query: 'different'}), c => c.configure({}),
    c => c.setScope('other/library'), c => c.selectProfile(null), c => c.dispose()]) {
    const pending = deferred(); let memberReads = 0, signal;
    const c = await setup({readFriends: async () => directory({requests: []}),
      readMembers: async () => ({members: ++memberReads === 1 ? [person()] : [], next_cursor: null}),
      readProfile: args => {signal = args.signal; return pending.promise;}});
    await c.loadMembers({query: 'member'}); assert.equal(c.selectProfile('account:member'), true);
    const read = c.loadProfile(); await invalidate(c); const current = c.getSnapshot();
    assert.equal(signal.aborted, true); pending.resolve(person()); await read; assert.equal(c.getSnapshot(), current);
  }
});

test('unrelated discovery refresh cannot erase a profile still authorized by the directory', async () => {
  const c = await setup({readProfile: async () => person(), readMembers: async () => ({members: [], next_cursor: null})});
  c.selectProfile('account:member'); await c.loadProfile(); const profile = c.getSnapshot().profile;
  await c.loadMembers({query: 'another person'});
  assert.equal(c.getSnapshot().profile, profile); assert.equal(c.getSnapshot().selectedProfileRef, 'account:member');
});

test('acknowledged request action remains distinct from failed authoritative Friends refresh', async () => {
  for (const status of ['denied', 'unavailable', 'error']) {
    let reads = 0;
    const c = await setup({readFriends: async () => {
      if (++reads === 1) return directory();
      if (status === 'error') throw new Error('Refresh failed');
      return {status};
    }, acceptRequest: async () => ({ok: true})});
    assert.equal((await c.mutate('acceptRequest', 'request:one')).status, 'ready');
    assert.equal(c.getSnapshot().friends.status, status);
    assert.equal(c.getSnapshot().friends.data, null);
  }
});

test('profile route uses only current profile authority and clears previous accepted history', async () => {
  const {loadFriendRoute} = await navigation;
  let reads = 0;
  const c = await setup({readFriends: async () => directory({friends: [person({relationship: 'accepted',
    allowed_actions: {can_view_profile: true, can_view_activity: true}})]}),
    readProfile: async () => {reads++; return person();},
    readActivity: () => ({rows: [{id: 'a', kind: 'album', title: 'Private'}]})});
  c.selectFriend('account:member'); await c.loadActivity();
  await loadFriendRoute(c, {profileRef: 'account:member'});
  assert.equal(reads, 1); assert.equal(c.getSnapshot().selectedFriendRef, null); assert.equal(c.getSnapshot().activity.data, null);
  await loadFriendRoute(c, {profileRef: 'forged'}); assert.equal(reads, 1); assert.equal(c.getSnapshot().selectedProfileRef, null);
  await loadFriendRoute(c, {profileRef: 'account:member', friendRef: 'account:member'}); assert.equal(reads, 1);
});

test('profile scroll restoration waits for the selected authorized content and discards revoked replay', async () => {
  const {scrollRestoreState} = await navigation;
  const state = {section: 'friends', profileRef: 'account:member', selectedProfileRef: 'account:member',
    friendsStatus: 'ready', profileExists: true, profileStatus: 'ready'};
  for (const profileStatus of ['ready', 'empty', 'unavailable']) assert.equal(scrollRestoreState({...state, profileStatus}), 'ready');
  for (const patch of [{profileStatus: 'loading'}, {friendsStatus: 'loading'}, {selectedProfileRef: 'another'}]) {
    assert.equal(scrollRestoreState({...state, ...patch}), 'pending');
  }
  for (const patch of [{profileStatus: 'denied'}, {profileExists: false}, {friendRef: 'account:accepted'}]) {
    assert.equal(scrollRestoreState({...state, ...patch}), 'discard');
  }
});
