const test = require('node:test');
const assert = require('node:assert/strict');

const modulePath = '../../../music_app/static/js/home-friends/';
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => {resolve = yes;});
  return {promise, resolve};
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const request = (extra = {}) => ({request_ref: 'request:one', account_ref: 'account:one', direction: 'incoming',
  display_name: 'One', avatar_url: '/avatar/one', created_at: '2026-10-08T10:00:00Z',
  allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}, ...extra});
const friends = (requests = [request()]) => ({friends: [], requests, profile: null});

async function fixture(providers, shellPatch = {}, runtimePatch = {}) {
  const {createFriendNotifications} = await import(modulePath + 'friend-notifications.mjs');
  const subscriptions = new Set(), registrations = [], forms = [], navigations = [];
  let shell = {scopeKey: 'account/library:1', authenticated: true, visible: false, ...shellPatch};
  const runtime = {snapshot: () => shell, subscribe: callback => {subscriptions.add(callback); return () => subscriptions.delete(callback);},
    openForm: () => assert.fail('Notification entry cannot use the visible-Home-only form adapter.'),
    openFriendRequestForm: options => {forms.push(options); return {close() {}};},
    navigate: () => assert.fail('A hidden notification cannot use visible-Home navigation.'),
    openFriendProfile: async ({scopeKey, accountRef, isCurrent}) => {
      assert.equal(scopeKey, shell.scopeKey); assert.equal(isCurrent(), true);
      navigations.push({section: 'friends', profile: accountRef}); return true;
    }, ...runtimePatch};
  const notifications = {registerSource(options) {
    const record = {...options, disposed: false, records: [], status: 'idle'};
    registrations.push(record);
    return {replace(records, {status}) {
      if (record.disposed || !options.isCurrent()) return false;
      record.records = records; record.status = status; return true;
    }, dispose() {record.disposed = true; record.records = [];}};
  }};
  const producer = createFriendNotifications({runtime, notifications, providers});
  return {producer, runtime, registrations, forms, navigations, subscriptions,
    get source() {return registrations.filter(record => !record.disposed).at(-1);},
    setShell(patch, notify = true) {shell = {...shell, ...patch}; if (notify) for (const callback of [...subscriptions]) callback();},
    open(id = 'request:one') {return this.source?.onOpen(id, {parentSurface: '#cover-lookup-drawer', returnFocus: () => null});}};
}

test('visible Home owns one authoritative snapshot and the drawer does not duplicate its reads', async () => {
  const {createHomeFriendsController} = await import(modulePath + 'model.mjs');
  let reads = 0;
  const providers = {readFriends: () => {reads++; return friends();}};
  const value = await fixture(providers, {visible: true});
  const home = createHomeFriendsController({providers}); home.setScope('account/library:1');
  const release = value.producer.useHome(home);
  assert.equal(reads, 0);
  await home.loadFriends();
  const source = value.source;
  await source.onShow(); await source.onShow();
  assert.equal(reads, 1); assert.equal(value.registrations.length, 1);
  assert.deepEqual(source.records, [{id: 'request:one', title: 'One', byline: 'Sent you a friend request',
    avatarUrl: '/avatar/one', createdAt: '2026-10-08T10:00:00Z'}]);
  assert.equal(value.open(), true);
  assert.equal(value.producer.getSnapshot().dialog.controller, home);
  release();
  assert.equal(value.producer.getSnapshot().dialog, null); assert.deepEqual(source.records, []);
  assert.equal(home.getSnapshot().scopeKey, 'account/library:1', 'only Session disposes the Home controller');
  value.producer.dispose(); home.dispose();
});

test('outside Home has one request-only controller and explicit drawer openings refresh it', async () => {
  const pending = deferred(); let reads = 0, privateReads = 0;
  const privateReader = () => {privateReads++; return {rows: []};};
  const value = await fixture({readFriends: () => {reads++; return reads === 1 ? pending.promise : friends();},
    readRecent: privateReader, readActivity: privateReader, readComparison: privateReader, readProfile: privateReader});
  assert.equal(reads, 1, 'a configured outside-Home source has one initial bounded read');
  const source = value.source;
  source.onShow(); source.onShow();
  assert.equal(reads, 1, 'opening during an in-flight read does not restart it');
  pending.resolve(friends([request(), request({request_ref: 'request:out', direction: 'outgoing'})])); await settle();
  assert.equal(source.records.length, 1); assert.equal(value.open(), true);
  const first = value.producer.getSnapshot().dialog;
  assert.equal(value.open(), false, 'repeat activation does not acquire another form');
  assert.equal((await first.controller.loadActivity()).status, 'unavailable');
  assert.equal((await first.controller.loadComparison()).status, 'unavailable');
  assert.equal((await first.controller.loadRecent()).status, 'unavailable');
  assert.equal(privateReads, 0);
  first.onClose(); await source.onShow();
  assert.equal(reads, 2); assert.equal(value.open(), true);
  assert.equal(value.producer.getSnapshot().dialog.controller, first.controller);
  value.producer.dispose();
  assert.equal(first.controller.getSnapshot().scopeKey, null); assert.equal(value.subscriptions.size, 0);
  assert.equal(source.isCurrent(), false); assert.deepEqual(source.records, []);
});

test('the background request controller forwards completed Friends authority without withdrawing at read start', async () => {
  const pending = deferred(), records = [];
  const value = await fixture({readFriends: () => pending.promise, acceptRequest: async () => ({status: 'denied'})}, {},
    {retireFriendActivity: packet => records.push(packet)});
  assert.equal(records.length, 0);
  pending.resolve(friends()); await settle();
  assert.equal(records.at(-1).scopeKey, 'account/library:1'); assert.equal(records.at(-1).friends.status, 'ready');
  const count = records.length, refreshing = value.producer.refresh();
  assert.equal(records.length, count); await refreshing;
  assert.equal(value.open(), true);
  const controller = value.producer.getSnapshot().dialog.controller;
  await controller.mutate('acceptRequest', 'request:one'); assert.equal(records.at(-1).friends.status, 'denied');
  value.producer.dispose();
});

test('Home acquisition aborts the fallback and late release cannot retire a newer Home owner', async () => {
  const {createHomeFriendsController} = await import(modulePath + 'model.mjs');
  const pending = deferred(); let signal;
  const value = await fixture({readFriends: args => {signal = args.signal; return pending.promise;}});
  const source = value.source;
  value.setShell({visible: true});
  const home = createHomeFriendsController({providers: {readFriends: () => friends()}}); home.setScope('account/library:1');
  const releaseHome = value.producer.useHome(home);
  assert.equal(signal.aborted, true);
  await home.loadFriends();
  pending.resolve(friends([request({request_ref: 'request:stale'})])); await settle();
  assert.deepEqual(source.records.map(record => record.id), ['request:one']);
  const newer = createHomeFriendsController({providers: {readFriends: () => friends([request({request_ref: 'request:new'})])}});
  newer.setScope('account/library:1'); const releaseNewer = value.producer.useHome(newer); await newer.loadFriends();
  releaseHome(); assert.deepEqual(source.records.map(record => record.id), ['request:new']);
  value.setShell({visible: false});
  assert.deepEqual(source.records, []);
  assert.equal(newer.getSnapshot().scopeKey, 'account/library:1');
  releaseNewer(); home.dispose(); newer.dispose(); value.producer.dispose();
});

for (const cleanupFirst of [false, true]) test(`leaving Home restores an already-open drawer through one bounded read (${cleanupFirst ? 'cleanup' : 'runtime'} first)`, async () => {
  const {createHomeFriendsController} = await import(modulePath + 'model.mjs');
  const pending = deferred(); let reads = 0;
  const providers = {readFriends: () => ++reads === 1 ? friends() : pending.promise,
    readActivity: () => assert.fail('Leaving Home cannot start private activity.'),
    readComparison: () => assert.fail('Leaving Home cannot start private comparison.')};
  const value = await fixture(providers, {visible: true});
  const home = createHomeFriendsController({providers}); home.setScope('account/library:1');
  const release = value.producer.useHome(home); await home.loadFriends();
  const source = value.source;
  await source.onShow();
  assert.equal(reads, 1); assert.deepEqual(source.records.map(record => record.id), ['request:one']);
  value.setShell({visible: false}, !cleanupFirst);
  home.dispose(); release();
  assert.equal(reads, 2, 'visibility retirement starts the fallback without reopening the drawer');
  assert.equal(source.status, 'loading'); assert.deepEqual(source.records, []);
  value.setShell({visible: false}); release();
  assert.equal(reads, 2, 'late runtime notification and repeated React cleanup do not restart the read');
  pending.resolve(friends()); await settle();
  assert.equal(value.source, source); assert.equal(source.status, 'ready');
  assert.deepEqual(source.records.map(record => record.id), ['request:one']);
  assert.equal(value.open(), true);
  assert.notEqual(value.producer.getSnapshot().dialog.controller, home);
  assert.equal(home.getSnapshot().scopeKey, null);
  value.producer.dispose();
});

test('leaving a denied Home projection does not revive its retired notification source', async () => {
  const {createHomeFriendsController} = await import(modulePath + 'model.mjs');
  let reads = 0;
  const providers = {readFriends: () => {reads++; return {status: 'denied'};}};
  const value = await fixture(providers, {visible: true});
  const home = createHomeFriendsController({providers}); home.setScope('account/library:1');
  const release = value.producer.useHome(home); await home.loadFriends();
  assert.equal(value.source, undefined);
  value.setShell({visible: false}); home.dispose(); release();
  assert.equal(reads, 1); assert.equal(value.source, undefined);
  value.producer.dispose();
});

test('removed, loading, outgoing and denied requests cannot reuse a notification as authority', async () => {
  let next = friends();
  const value = await fixture({readFriends: () => next}); await settle();
  const original = value.source;
  assert.equal(value.open('request:made-up'), false);
  assert.equal(value.open(), true);
  const dialog = value.producer.getSnapshot().dialog;
  dialog.onClose();
  next = friends([request({direction: 'outgoing'})]);
  const refreshing = value.producer.refresh();
  assert.deepEqual(original.records, []); assert.equal(value.open(), false);
  await refreshing; assert.deepEqual(original.records, []); assert.equal(value.open(), false);
  next = {status: 'empty'}; await value.producer.refresh();
  assert.deepEqual(original.records, []); assert.equal(value.open(), false);
  next = {status: 'denied'}; await value.producer.refresh();
  assert.equal(original.disposed, true); assert.equal(original.onOpen('request:one', {parentSurface: '#cover-lookup-drawer'}), false);
  assert.equal(value.producer.getSnapshot().dialog, null);
  next = friends(); await value.producer.refresh();
  assert.notEqual(value.source, original); assert.equal(original.isCurrent(), false);
  assert.equal(original.onOpen('request:one', {parentSurface: '#cover-lookup-drawer'}), false);
  assert.equal(value.open(), true);
  value.producer.dispose();
});

test('controller handoff revokes an open dialog before synchronous teardown callbacks run', async () => {
  const {createHomeFriendsController} = await import(modulePath + 'model.mjs');
  const value = await fixture({readFriends: () => friends()}); await settle(); value.open();
  const dialog = value.producer.getSnapshot().dialog; let navigationDuringClose;
  const unsubscribe = value.producer.subscribe(() => {
    if (value.producer.getSnapshot().dialog === null) {
      dialog.onClose(); navigationDuringClose = dialog.onProfile('account:one');
    }
  });
  value.setShell({visible: true});
  const home = createHomeFriendsController(); home.setScope('account/library:1');
  const release = value.producer.useHome(home);
  assert.equal(navigationDuringClose, false); assert.deepEqual(value.navigations, []);
  assert.equal(dialog.controller.getSnapshot().scopeKey, null);
  unsubscribe(); release(); home.dispose(); value.producer.dispose();
});

test('profile navigation requires native close, current request grant and the distinct account identity', async () => {
  let next = friends();
  const value = await fixture({readFriends: () => next}); await settle(); value.open();
  const dialog = value.producer.getSnapshot().dialog;
  dialog.runtime.openForm({title: 'Friend request', parentSurface: dialog.parentSurface});
  assert.equal(value.forms.length, 1); assert.equal(value.forms[0].scopeKey, 'account/library:1');
  assert.equal(value.forms[0].pageId, 'home-friend-request');
  assert.equal(value.forms[0].isCurrent(), true);
  assert.equal(dialog.onProfile('account:one'), false, 'a still-open native form cannot navigate');
  dialog.onClose();
  assert.equal(value.forms[0].isCurrent(), false);
  assert.throws(() => dialog.runtime.openForm({parentSurface: dialog.parentSurface}), /no longer available/);
  assert.equal(dialog.onProfile('request:one'), false, 'request identity is never an account identity');
  assert.equal(await dialog.onProfile('account:one'), true);
  assert.deepEqual(value.navigations, [{section: 'friends', profile: 'account:one'}]);
  assert.equal(dialog.onProfile('account:one'), false);
  value.open(); const superseded = value.producer.getSnapshot().dialog;
  superseded.onClose({current: false});
  assert.equal(superseded.onProfile('account:one'), false, 'displaced native form ownership cannot navigate');
  value.open(); const stale = value.producer.getSnapshot().dialog;
  next = friends([request({allowed_actions: {can_accept: true}})]); await value.producer.refresh();
  stale.onClose(); assert.equal(stale.onProfile('account:one'), false);
  value.setShell({authenticated: false});
  assert.equal(value.forms[0].isCurrent(), false); assert.equal(value.source, undefined);
  assert.throws(() => stale.runtime.openForm({}), /no longer available/);
  value.producer.dispose();
});

test('scope ABA, provider replacement and disposal abort old reads and cannot revive old callbacks', async () => {
  const pending = []; const signals = [];
  const value = await fixture({readFriends: args => {const read = deferred(); pending.push(read); signals.push(args.signal); return read.promise;}});
  const first = value.source;
  value.setShell({scopeKey: 'other/library:2'}); const second = value.source;
  value.setShell({scopeKey: 'account/library:1'}); const third = value.source;
  assert.notEqual(first, third); assert.equal(first.isCurrent(), false); assert.equal(second.isCurrent(), false);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true, false]);
  value.producer.configure({readFriends: () => friends([request({request_ref: 'request:new'})])}); await settle();
  assert.equal(third.isCurrent(), false); assert.ok(signals.every(signal => signal.aborted));
  for (const read of pending) read.resolve(friends()); await settle();
  assert.deepEqual(value.source.records.map(record => record.id), ['request:new']);
  for (const old of [first, second, third]) {
    assert.equal(old.onOpen('request:one', {parentSurface: '#cover-lookup-drawer'}), false);
    assert.equal(old.onShow(), undefined); assert.deepEqual(old.records, []);
  }
  const latest = value.source; value.producer.dispose(); value.producer.dispose();
  assert.equal(latest.isCurrent(), false); assert.equal(value.subscriptions.size, 0);
  assert.equal(value.producer.getSnapshot().dialog, null);
});

test('native profile navigation can recheck current request authority after an asynchronous guard', async () => {
  let next = friends(), navigation;
  const value = await fixture({readFriends: () => next}, {}, {openFriendProfile: async options => {navigation = options; return true;}});
  await settle(); value.open(); const dialog = value.producer.getSnapshot().dialog;
  dialog.onClose(); assert.equal(await dialog.onProfile('account:one'), true);
  assert.equal(navigation.isCurrent(), true); assert.equal(navigation.accountRef, 'account:one');
  next = friends([]); await value.producer.refresh();
  assert.equal(navigation.isCurrent(), false, 'a later native confirmation cannot reuse removed request authority');
  value.producer.dispose();
});

test('failed native form acquisition clears the hidden portal and reports through the existing drawer', async () => {
  const value = await fixture({readFriends: () => friends()}, {}, {
    openFriendRequestForm: () => {throw new Error('Native form unavailable.');},
  });
  await settle(); value.open(); const dialog = value.producer.getSnapshot().dialog, source = value.source;
  assert.throws(() => dialog.runtime.openForm({parentSurface: dialog.parentSurface}), /Native form unavailable/);
  assert.equal(value.producer.getSnapshot().dialog, null);
  assert.equal(source.status, 'unavailable'); assert.deepEqual(source.records, []);
  await source.onShow(); assert.equal(source.records.length, 1);
  value.producer.dispose();
});

test('outside-Home mutations reuse normalized grants and await authoritative refresh', async () => {
  const next = friends(); let writes = 0;
  const refreshed = deferred();
  const value = await fixture({readFriends: () => writes ? refreshed.promise : next,
    acceptRequest: ({request_ref}) => {assert.equal(request_ref, 'request:one'); writes++; return {ok: true};}});
  await settle(); value.open();
  const dialog = value.producer.getSnapshot().dialog, source = value.source;
  const mutation = dialog.controller.mutate('acceptRequest', 'request:one'); await settle();
  assert.equal(writes, 1); assert.equal(dialog.controller.getSnapshot().friends.status, 'loading');
  assert.equal(value.producer.getSnapshot().dialog, dialog, 'authoritative refresh does not close the native form prematurely');
  assert.deepEqual(source.records, []);
  refreshed.resolve({...friends([]), friends: [{account_ref: 'account:one', relationship: 'accepted', allowed_actions: {}}]});
  assert.equal((await mutation).status, 'ready'); assert.deepEqual(source.records, []);
  assert.equal((await dialog.controller.mutate('acceptRequest', 'request:one')).status, 'denied');
  assert.equal(writes, 1, 'resolved request references cannot call the writer again');
  value.producer.dispose();
});

test('missing provider or authentication does not register or read a request source', async () => {
  let reads = 0;
  const value = await fixture({readFriends: () => {reads++; return friends();}}, {authenticated: false});
  assert.equal(reads, 0); assert.equal(value.registrations.length, 0);
  value.producer.configure({}); value.setShell({authenticated: true});
  assert.equal(value.registrations.length, 0); assert.equal(reads, 0);
  value.producer.dispose();
  const unsupported = await fixture({readFriends: () => {reads++; return friends();}}, {}, {openFriendRequestForm: undefined});
  assert.equal(unsupported.registrations.length, 0); assert.equal(reads, 0);
  unsupported.producer.dispose();
  const noProfileEntry = await fixture({readFriends: () => friends()}, {}, {openFriendProfile: undefined});
  await settle(); assert.equal(noProfileEntry.open(), true);
  assert.equal(noProfileEntry.producer.getSnapshot().dialog.onProfile, undefined);
  noProfileEntry.producer.dispose();
});
