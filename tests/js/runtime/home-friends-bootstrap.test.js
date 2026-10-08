const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends/index.jsx');
// Exercise the public bootstrap and real model, while deliberately delaying
// React root commits. The shell and provider seams are test-only fixtures;
// this is not a browser, transport, or release-acceptance result.
const bundle = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-dom/client', './app.jsx', './friend-notifications.jsx', '../playlists/index.jsx']}).outputFiles[0].text;
const friends = () => ({friends: [{account_ref: 'friend:one', relationship: 'accepted',
  allowed_actions: {can_view_activity: true, can_remove: true}}], requests: [], profile: null});
const recent = () => ({recent_local_albums: [], recent_not_local_albums: []});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function bootstrap({withNotifications = false, visible = true} = {}) {
  const host = {}, renders = [], events = new Map(), sessions = new Map(), listeners = new Set(), sources = [];
  let pendingEffects = [], recentReads = 0, mounts = 0, currentSession = null, stateIndex = 0, effectIndex = 0;
  let shell = {visible, authenticated: true, scopeKey: 'account/library', entryKey: 'entry:one'};
  const bindings = [];
  const runtime = {readRecent: () => {recentReads++; return recent();},
    subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener);}, snapshot: () => shell,
    openFriendRequestForm: () => ({close() {}}), openFriendProfile: async () => true, navigate() {},
    configureActivityProvider: input => {bindings.push(input); return input.readActivity ?? null;}};
  const hooks = {...React, useState: value => {
    const index = stateIndex++;
    if (!(index in currentSession.states)) currentSession.states[index] = typeof value === 'function' ? value() : value;
    return [currentSession.states[index], () => {}];
  }, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(), useEffect: (callback, dependencies) => {
    const index = effectIndex++, previous = currentSession.effects[index], session = currentSession;
    if (previous && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      session.effects[index] = {dependencies, cleanup: callback()};
    });
  }};
  const window = {AlbumHavenHomeRuntime: runtime, addEventListener: (name, callback) => events.set(name, callback)};
  const registry = {registerSource(options) {
    const source = {...options, records: [], disposed: false}; sources.push(source);
    return {replace: records => {source.records = records;}, dispose: () => {source.disposed = true; source.records = [];}};
  }};
  if (withNotifications) window.AlbumHavenNotifications = registry;
  const document = {getElementById: id => id === 'home-friends-root' ? host : null};
  const modules = {
    react: hooks,
    'react-dom/client': {createRoot: element => {assert.equal(element, host); mounts++; return {render: view => renders.push(view)};}},
    './app.jsx': {HomeFriendsView() {assert.fail('The shell view is outside this bootstrap contract.');}},
    './friend-notifications.jsx': {FriendNotifications() {assert.fail('The native portal view is outside this bootstrap contract.');}},
    '../playlists/index.jsx': {mountPlaylists() {assert.fail('No playlist runtime is present.');}},
  };
  const fixture = {exports: {}};
  vm.runInNewContext(bundle, {module: fixture, exports: fixture.exports, window, document, console, AbortController, URL, Blob,
    require: name => {assert.ok(Object.hasOwn(modules, name), `Unexpected bootstrap dependency: ${name}`); return modules[name];}});
  return {
    api: window.AlbumHavenHomeUI, events, renders, runtime, bindings, sources,
    setShell(patch) {shell = {...shell, ...patch}; for (const listener of [...listeners]) listener();},
    installNotifications() {window.AlbumHavenNotifications = registry; events.get('albumhaven:notifications-ready')();},
    get recentReads() {return recentReads;}, get mounts() {return mounts;},
    commit() {
      pendingEffects = [];
      const root = renders.at(-1), layout = root.type(root.props), session = layout.props.children[1];
      if (!session) return {controller: null, layout, cleanup() {}};
      if (!sessions.has(session.key)) sessions.set(session.key, {states: [], effects: []});
      currentSession = sessions.get(session.key); stateIndex = 0; effectIndex = 0;
      const view = session.type(session.props);
      pendingEffects.forEach(effect => effect());
      const committed = currentSession; currentSession = null;
      return {controller: view.props.controller, view, layout, sessionKey: session.key,
        cleanup: () => {committed.effects.forEach(effect => effect.cleanup?.()); sessions.delete(session.key);}};
    },
  };
}

test('public provider replacement aborts active reads and writes before the next React commit', async () => {
  const oldRead = deferred(), oldWrite = deferred(), signals = []; let oldFriendReads = 0, newFriendReads = 0;
  const fixture = bootstrap();
  fixture.api.configureProviders({readFriends: () => {oldFriendReads++; return friends();},
    readActivity: args => {signals.push(args.signal); return oldRead.promise;},
    removeFriend: args => {signals.push(args.signal); return oldWrite.promise;}});
  const previous = fixture.commit(), controller = previous.controller;
  await controller.loadFriends(); assert.equal(controller.selectFriend('friend:one'), true);
  const activity = controller.loadActivity(), mutation = controller.mutate('removeFriend', 'friend:one');
  assert.equal(controller.getSnapshot().mutation.status, 'loading');
  const previousFriendReads = oldFriendReads, previousRecentReads = fixture.recentReads;
  fixture.api.configureProviders({readFriends: () => {newFriendReads++; return friends();}});
  assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
  const disposed = controller.getSnapshot();
  assert.equal(disposed.scopeKey, null); assert.equal(disposed.activity.data, null); assert.equal(disposed.mutation.status, 'idle');
  fixture.api.refresh();
  assert.equal(oldFriendReads, previousFriendReads); assert.equal(fixture.recentReads, previousRecentReads);
  assert.equal(newFriendReads, 0, 'the replacement React tree has not committed');
  oldRead.resolve({rows: [{id: 'private-old', kind: 'album', title: 'Old account data'}]});
  oldWrite.resolve({ok: true}); await Promise.all([activity, mutation]);
  assert.equal(controller.getSnapshot(), disposed);
  assert.equal(oldFriendReads, previousFriendReads, 'obsolete mutation cannot refresh the old provider');
  assert.equal(newFriendReads, 0, 'obsolete mutation cannot refresh the replacement provider');

  const replacement = fixture.commit();
  assert.notEqual(replacement.controller, controller);
  assert.equal(replacement.controller.getSnapshot().scopeKey, 'account/library');
  assert.equal(newFriendReads, 1);
  previous.cleanup();
  fixture.api.refresh();
  assert.equal(newFriendReads, 2, 'late cleanup of the old Session cannot clear the replacement active controller');
  replacement.cleanup();
});

test('the visible Home controller forwards normalized Friends authority to the native retirement owner', async () => {
  const fixture = bootstrap(), records = [];
  fixture.runtime.retireFriendActivity = packet => records.push(packet);
  fixture.api.configureProviders({readFriends: () => friends()});
  const session = fixture.commit(); await session.controller.loadFriends();
  assert.equal(records.at(-1).scopeKey, 'account/library');
  assert.equal(records.at(-1).friends, session.controller.getSnapshot().friends);
  const count = records.length; session.cleanup(); assert.equal(records.length, count);
});

test('invalid provider configuration leaves the active controller usable and mount stays idempotent', async () => {
  const fixture = bootstrap(); let reads = 0;
  fixture.api.configureProviders({readFriends: () => {reads++; return friends();}});
  const active = fixture.commit(); await active.controller.loadFriends();
  const state = active.controller.getSnapshot(), previousRenders = fixture.renders.length;
  for (const value of [null, [], 1, 'providers']) assert.throws(() => fixture.api.configureProviders(value), /must be an object/);
  assert.equal(active.controller.getSnapshot(), state);
  assert.equal(fixture.renders.length, previousRenders);
  const before = reads; fixture.api.refresh(); assert.equal(reads, before + 1);
  fixture.events.get('albumhaven:home-runtime-ready')();
  assert.equal(fixture.mounts, 1);
  active.cleanup();
});

test('the public bootstrap sends activity authority only through the native sanitized reader', async () => {
  const fixture = bootstrap(), rawReader = () => assert.fail('The raw reader must remain behind the native boundary.');
  const resolveActivityTrack = () => assert.fail('React cannot resolve private media authority.');
  let safeReads = 0;
  fixture.runtime.configureActivityProvider = input => {
    assert.equal(input.readActivity, rawReader); assert.equal(input.resolveActivityTrack, resolveActivityTrack);
    return () => {safeReads++; return {rows: [{id: 'public:one', kind: 'track', title: 'Safe projection'}]};};
  };
  fixture.api.configureProviders({readActivity: rawReader, resolveActivityTrack});
  const active = fixture.commit(); await active.controller.loadActivity({kind: 'tracks'});
  assert.equal(safeReads, 1);
  assert.equal(active.controller.getSnapshot().activity.data.rows[0].title, 'Safe projection');
  active.cleanup();
});

test('a runtime without the native activity boundary leaves activity unavailable', async () => {
  const fixture = bootstrap(); delete fixture.runtime.configureActivityProvider;
  fixture.api.configureProviders({readActivity: () => assert.fail('Raw authority cannot bypass a missing boundary.')});
  const active = fixture.commit(); await active.controller.loadActivity({kind: 'tracks'});
  assert.equal(active.controller.getSnapshot().activity.status, 'unavailable');
  active.cleanup();
});

test('the notification portal stays mounted outside Home without retaining its controller', async () => {
  const fixture = bootstrap({withNotifications: true}); let reads = 0;
  fixture.api.configureProviders({readFriends: () => {reads++; return friends();}});
  const home = fixture.commit(); await home.controller.loadFriends();
  const source = fixture.sources.at(-1), recentReads = fixture.recentReads;
  const before = reads; await source.onShow(); assert.equal(reads, before);
  fixture.setShell({visible: false}); home.cleanup();
  const hidden = fixture.commit();
  assert.equal(hidden.controller, null); assert.ok(hidden.layout.props.children[0]);
  assert.equal(home.controller.getSnapshot().scopeKey, null);
  assert.equal(reads, before + 1, 'Home retirement starts the bounded notification read before another drawer opening');
  await source.onShow(); assert.equal(reads, before + 1);
  assert.equal(fixture.recentReads, recentReads);
  fixture.api.refresh(); assert.equal(reads, before + 2); assert.equal(fixture.recentReads, recentReads);
  fixture.setShell({authenticated: false}); assert.equal(source.disposed, true);
});

test('a late native registry installation reuses the mounted Home controller and snapshot', async () => {
  const fixture = bootstrap(); let reads = 0;
  fixture.api.configureProviders({readFriends: () => {reads++; return friends();}});
  const before = fixture.commit(); await before.controller.loadFriends();
  const count = reads, recentCount = fixture.recentReads;
  fixture.installNotifications();
  const after = fixture.commit();
  assert.equal(after.controller, before.controller); assert.equal(reads, count);
  assert.equal(fixture.recentReads, recentCount); assert.equal(fixture.sources.length, 1);
  await fixture.sources[0].onShow(); assert.equal(reads, count);
  fixture.installNotifications(); assert.equal(fixture.sources.length, 1);
  after.cleanup();
});

test('outside-Home provider replacement retires notification reads before the React commit', async () => {
  const fixture = bootstrap({withNotifications: true, visible: false}), pending = deferred();
  let oldSignal, replacements = 0;
  fixture.api.configureProviders({readFriends: ({signal}) => {oldSignal = signal; return pending.promise;},
    readActivity: () => assert.fail('A notification cannot start a private activity read.')});
  const oldSource = fixture.sources.at(-1);
  assert.equal(fixture.commit().controller, null); assert.equal(fixture.recentReads, 0);
  fixture.api.configureProviders({readFriends: () => {replacements++; return friends();}});
  assert.equal(oldSignal.aborted, true); assert.equal(oldSource.isCurrent(), false);
  assert.equal(oldSource.disposed, true); assert.equal(replacements, 1);
  pending.resolve(friends()); await pending.promise; await Promise.resolve();
  assert.equal(oldSource.records.length, 0); assert.equal(fixture.recentReads, 0);
  fixture.setShell({authenticated: false});
});

test('Home history entries preserve member profile authority and retire prior private reads through route selection', async () => {
  const {loadFriendRoute} = await import('../../../music_app/static/js/home-friends/navigation.mjs');
  const fixture = bootstrap(), privateResult = deferred(); let privateSignal, profileReads = 0, friendReads = 0;
  fixture.api.configureProviders({readFriends: () => {friendReads++; return {...friends(), allowed_actions: {can_discover_members: true}};},
    readMembers: () => ({members: [{account_ref: 'member:one', display_name: 'Member', relationship: 'none',
      allowed_actions: {can_view_profile: true}}], next_cursor: null}),
    readActivity: ({signal}) => {privateSignal = signal; return privateResult.promise;},
    readProfile: ({account_ref}) => {profileReads++; return {account_ref, display_name: 'Member', relationship: 'none',
      allowed_actions: {can_view_profile: true}};}});
  const before = fixture.commit(); await before.controller.loadFriends();
  await before.controller.loadMembers({query: 'Member'});
  before.controller.selectFriend('friend:one');
  const history = before.controller.loadActivity();
  const reads = friendReads;
  fixture.setShell({entryKey: 'entry:two', section: 'friends', profileRef: 'member:one', friendRef: ''});
  const after = fixture.commit();
  assert.equal(after.controller, before.controller); assert.equal(after.sessionKey, before.sessionKey);
  assert.notEqual(after.view.key, before.view.key, 'presentation remounts for its own native history entry');
  assert.equal(friendReads, reads, 'entry changes do not refresh away member-only authority');
  await loadFriendRoute(after.controller, {profileRef: 'member:one', friendRef: '', mode: 'activity', kind: 'tracks', period: 'week'});
  assert.equal(privateSignal.aborted, true); assert.equal(profileReads, 1);
  assert.equal(after.controller.getSnapshot().selectedProfileRef, 'member:one');
  privateResult.resolve({rows: [{id: 'stale', kind: 'track', title: 'Old friend history'}]}); await history;
  assert.equal(after.controller.getSnapshot().activity.data, null);
  after.cleanup();
});
