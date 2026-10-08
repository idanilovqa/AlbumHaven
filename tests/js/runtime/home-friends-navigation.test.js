const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const staticPath = path.resolve(__dirname, '../../../music_app/static/js');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function setup() {
  const native = createNativeHomeRuntime(), {context, document} = native, listeners = [], historyCalls = [], requests = [];
  const node = (id, attribute) => {const value = document.createElement('div'); if (id) value.id = id; if (attribute) value.setAttribute(attribute, ''); document.body.appendChild(value); return value;};
  const shell = node('app-shell'), home = node('mobile-home'), settings = node(null, 'data-settings-host'); settings.hidden = true;
  shell.dataset.nativeAccountId = 'account:one'; shell.dataset.nativeLibraryId = 'library:one';
  home.dataset.accountName = 'Listener';
  const outlet = node(null, 'data-settings-outlet'), navigation = node(null, 'data-settings-nav');
  settings.appendChild(outlet); settings.appendChild(navigation);
  document.title = 'Home';
  const location = new URL('https://albumhaven.test/?surface=home&artist=kept#selection');
  const entries = [{url: location.href, state: {albumHavenNavigationPosition: 8, nativeMarker: 'preserved'}}]; let index = 0;
  const history = {
    get state() {return entries[index].state;},
    replaceState(value, _title, url) {
      historyCalls.push(['replace', value, url]);
      if (url !== undefined) location.href = new URL(url, location).href;
      entries[index] = {url: location.href, state: structuredClone(value)};
    },
    pushState(value, _title, url) {
      historyCalls.push(['push', value, url]); location.href = new URL(url, location).href;
      entries.splice(++index, Infinity, {url: location.href, state: structuredClone(value)});
    },
    go(delta) {
      const next = index + delta; if (next < 0 || next >= entries.length) return;
      index = next; location.href = entries[index].url;
      const event = new context.Event('popstate'); event.state = history.state;
      for (const entry of listeners.filter(value => value.type === 'popstate').sort((a, b) => Number(b.capture) - Number(a.capture))) {
        entry.callback(event); if (event.immediate) break;
      }
    },
  };
  const state = {view: {recent_local_albums: [], recent_not_local_albums: []}, ui: {}, player: {}};
  Object.assign(context, {state, location, history, URL, AbortController, innerWidth: 1200,
    addEventListener: (type, callback, capture = false) => listeners.push({type, callback, capture}),
    removeEventListener: (type, callback) => {const i = listeners.findIndex(value => value.type === type && value.callback === callback); if (i >= 0) listeners.splice(i, 1);},
    dispatchEvent() {}, shouldShowMobileHome: () => !shell.hidden,
    fetch: (...args) => {const result = deferred(); requests.push({args, result}); return result.promise;},
    DOMParser: class {parseFromString() {throw new Error('A superseded Settings response must not be parsed');}},
  });
  // Execute both existing owners. Home must participate in native history
  // sequencing instead of providing a second navigation implementation.
  for (const filename of ['settings-navigation.js', 'runtime/home-friends-bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(staticPath, filename), 'utf8'), context, {filename});
  }
  historyCalls.length = 0;
  return {...native, bridge: context.AlbumHavenHomeRuntime, nativeNavigation: context.AlbumHavenSettingsNavigation.instance,
    state, shell, home, settings, outlet, location, history, entries, historyCalls, requests};
}

function profileNavigation() {
  const h = setup(), reads = [];
  h.context.shouldShowMobileHome = () => !h.shell.hidden && h.location.pathname === '/'
    && h.location.searchParams.get('surface') === 'home';
  h.nativeNavigation.writeLibraryHistory('/?surface=albums', h.history.state, {mode: 'replace'});
  h.context.buildUrl = () => '/?surface=home';
  h.context.syncMobileHome = () => h.bridge.sync();
  h.context.fetchAndRender = (url, push, options) => {
    const result = deferred(), id = Number(h.state.ui.activeViewRequestId || 0) + 1;
    h.state.ui.activeViewRequestId = id;
    const payload = {surface: {active: 'home'}, recent_local_albums: [], recent_not_local_albums: []};
    reads.push({url, push, finish() {
      if (!options.shouldApplyResponse(payload)) {result.resolve(false); return;}
      h.state.view = payload;
      if (push) h.nativeNavigation.pushLibraryHistory('/?surface=home', payload);
      h.bridge.sync(); result.resolve(true);
    }});
    return result.promise;
  };
  h.historyCalls.length = 0;
  return {...h, reads};
}

test('Home destinations use the real native history owner and preserve unrelated URL and entry state', () => {
  const h = setup(), initial = h.bridge.snapshot();
  h.bridge.navigate({section: 'friends', friend: 'friend:/A & B'});
  assert.equal(h.historyCalls.length, 1); assert.equal(h.historyCalls[0][0], 'push');
  assert.equal(h.location.searchParams.get('artist'), 'kept'); assert.equal(h.location.hash, '#selection');
  assert.equal(h.location.searchParams.get('home_section'), 'friends');
  assert.equal(h.location.searchParams.get('home_friend'), 'friend:/A & B');
  assert.equal(h.history.state.nativeMarker, 'preserved');
  assert.equal(h.bridge.snapshot().entryKey, initial.entryKey + 1);
  h.bridge.navigate({section: 'friends', friend: 'friend:/A & B'});
  assert.equal(h.historyCalls.length, 1, 'reselecting a destination does not add duplicate browser entries');
  h.bridge.navigate();
  assert.equal(h.location.searchParams.has('home_section'), false);
  assert.equal(h.location.searchParams.has('home_friend'), false);
  assert.equal(h.bridge.snapshot().section, 'recent'); assert.equal(h.entries.length, 3);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('a Home history commit cancels a pending real Settings navigation before its response can apply', async () => {
  const h = setup(), pending = h.nativeNavigation.navigate('/account');
  assert.equal(h.requests.length, 1);
  h.bridge.navigate({section: 'friends', friend: 'friend:one'});
  assert.equal(h.requests[0].args[1].signal.aborted, true);
  h.requests[0].result.resolve({ok: true, status: 200, url: 'https://albumhaven.test/account'});
  assert.equal(await pending, false);
  assert.equal(h.location.pathname, '/'); assert.equal(h.bridge.snapshot().friendRef, 'friend:one');
  assert.equal(h.shell.hidden, false); assert.equal(h.settings.hidden, true);
  assert.equal(h.outlet.children.length, 0); assert.equal(h.entries.length, 2);
});

test('Home presentation history whitelists view choices and strips provider records, drafts and grants', () => {
  const h = setup(), input = {kind: 'tracks', period: 'month', views: {albums: 'covers', tracks: 'history', artists: 'cards'},
    friendKind: 'artists', friendPeriod: 'year', friendViews: {artists: 'cards'}, friendMode: 'comparison', selectedAlbum: 'album:opaque',
    comparison: {friendRef: 'friend:opaque', kind: 'albums', period: 'all', commonOnly: false, order: 'friend', ascending: true,
      view: 'covers', selection: {id: 'album:opaque', kind: 'album', allowed_actions: {can_play_album: true}, private: 'do-not-save'},
      rows: [{private: 'do-not-save'}]}, expanded: 'selection', scroll: {page: 300, recent: 40, friends: 12},
    profileDraft: {biography: 'do-not-save'}, payload: {private: 'do-not-save'}, allowed_actions: {can_play_album: true}};
  assert.equal(h.bridge.savePresentation(input), true);
  assert.equal(h.historyCalls[0][0], 'replace'); assert.equal(h.entries.length, 1);
  assert.equal(h.history.state.nativeMarker, 'preserved');
  const saved = h.history.state.homeFriendsPresentation;
  assert.equal(saved.version, 1); assert.equal(saved.scopeKey, h.bridge.snapshot().scopeKey);
  assert.equal(saved.value.kind, 'tracks'); assert.equal(saved.value.views.albums, 'covers');
  assert.equal(saved.value.kindExplicit, true, 'a saved legacy kind remains an explicit choice');
  assert.deepEqual(saved.value.comparison.selection, {id: 'album:opaque', kind: 'album'});
  assert.doesNotMatch(JSON.stringify(saved), /do-not-save|profileDraft|allowed_actions|payload|"rows"/);
  input.views.albums = 'list'; input.scroll.page = 0;
  assert.equal(h.bridge.snapshot().presentation.views.albums, 'covers');
  assert.equal(h.bridge.snapshot().presentation.scroll.page, 300);
  assert.equal(Object.isFrozen(h.bridge.snapshot().presentation.comparison.selection), true);
  assert.equal(h.bridge.savePresentation(saved.value), true);
  assert.equal(h.historyCalls.length, 1, 'unchanged presentation must not spend browser history quota');
  assert.equal(h.bridge.albumDetailSelection('album:opaque', h.bridge.snapshot().scopeKey), null, 'restored identity is never a native album grant');
});

test('viewport-derived Home kind stays distinct from an explicit saved tab choice', () => {
  const h = setup();
  h.bridge.savePresentation({kind: 'tracks', kindExplicit: false});
  assert.equal(h.bridge.snapshot().presentation.kindExplicit, false);
  h.bridge.savePresentation({kind: 'artists', kindExplicit: true});
  assert.equal(h.bridge.snapshot().presentation.kindExplicit, true);
  h.bridge.savePresentation({kind: 'invalid', kindExplicit: true});
  assert.equal(h.bridge.snapshot().presentation.kindExplicit, false);
});

test('Back and Forward restore each Home entry presentation through native popstate handling', () => {
  const h = setup(); h.bridge.savePresentation({kind: 'albums', scroll: {page: 120}});
  const original = h.bridge.snapshot();
  h.bridge.navigate({section: 'friends', friend: 'friend:two'});
  h.bridge.savePresentation({kind: 'artists', friendPeriod: 'year', scroll: {page: 900}});
  const friends = h.bridge.snapshot();
  h.history.go(-1);
  assert.equal(h.bridge.snapshot().entryKey, original.entryKey);
  assert.equal(h.bridge.snapshot().section, 'recent');
  assert.equal(h.bridge.snapshot().presentation.scroll.page, 120);
  h.history.go(1);
  assert.equal(h.bridge.snapshot().entryKey, friends.entryKey);
  assert.equal(h.bridge.snapshot().friendRef, 'friend:two');
  assert.equal(h.bridge.snapshot().presentation.scroll.page, 900);
  assert.equal(h.bridge.snapshot().presentation.friendPeriod, 'year');
  assert.equal(h.entries.length, 2);
});

test('stale entry, route, friend, hidden surface and account scope cannot overwrite current presentation', () => {
  for (const invalidate of [h => h.bridge.navigate({section: 'friends'}),
    h => {h.location.searchParams.set('home_friend', 'other'); h.location.searchParams.set('home_section', 'friends');},
    h => {h.shell.hidden = true;}, h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.history.replaceState({...h.history.state, albumHavenNavigationPosition: 40}, '');}]) {
    const h = setup(), before = h.bridge.snapshot(); invalidate(h);
    const writes = h.historyCalls.length;
    assert.equal(h.bridge.savePresentation({kind: 'artists'}, before), false);
    assert.equal(h.historyCalls.length, writes);
    assert.equal(h.history.state.homeFriendsPresentation, undefined);
  }
});

test('corrupt or foreign-scope history is sanitized without reviving private selection authority', () => {
  const h = setup(), scopeKey = h.bridge.snapshot().scopeKey;
  h.history.replaceState({...h.history.state, homeFriendsPresentation: {version: 1, scopeKey, value: {
    kind: 'arbitrary', period: 'forever', views: {albums: 'unsafe'}, friendMode: 'unsafe', selectedAlbum: 'bad\nref',
    comparison: {friendRef: 'friend:one', kind: 'tracks', period: 'month', selection: {id: 'album:one', kind: 'album'}},
    scroll: {page: Infinity, recent: -1, friends: 10000001},
  }}}, '');
  const clean = h.bridge.snapshot().presentation;
  assert.equal(clean.kind, 'albums'); assert.equal(clean.period, 'week'); assert.equal(clean.views.albums, 'cards');
  assert.equal(clean.friendMode, 'activity'); assert.equal(clean.selectedAlbum, null); assert.equal(clean.comparison.selection, null);
  assert.deepEqual(plain(clean.scroll), {page: 0, recent: 0, friends: 0});
  h.shell.dataset.nativeLibraryId = 'different'; assert.equal(h.bridge.snapshot().presentation, null);
  h.history.replaceState({...h.history.state, homeFriendsPresentation: {version: 99, scopeKey: h.bridge.snapshot().scopeKey, value: {kind: 'artists'}}}, '');
  assert.equal(h.bridge.snapshot().presentation, null);
});

test('history quota failure and unknown entry positions leave the current Home usable', () => {
  const h = setup(), snapshot = h.bridge.snapshot();
  h.history.replaceState = () => {throw new Error('History quota exceeded');};
  assert.equal(h.bridge.savePresentation({kind: 'tracks'}), false);
  assert.strictEqual(h.bridge.snapshot(), snapshot);
  h.entries[0].state = {nativeMarker: 'legacy'};
  assert.equal(h.bridge.snapshot().entryKey, null); assert.equal(h.bridge.savePresentation({kind: 'artists'}), false);
});

test('invalid or hidden Home destinations cannot produce a native browser history entry', () => {
  const h = setup();
  assert.throws(() => h.bridge.navigate({section: 'settings'}), /unavailable/);
  assert.throws(() => h.bridge.navigate({section: 'friends', friend: {id: 'friend'}}), /unavailable/);
  h.shell.hidden = true; assert.throws(() => h.bridge.navigate({section: 'friends'}), /unavailable/);
  assert.equal(h.historyCalls.length, 0); assert.equal(h.entries.length, 1);
});

test('profile and accepted-friend routes remain distinct across native Back and Forward', () => {
  const h = setup();
  h.bridge.navigate({section: 'friends', profile: 'account:member'});
  assert.equal(h.location.searchParams.get('home_profile'), 'account:member');
  assert.equal(h.location.searchParams.has('home_friend'), false);
  const profile = h.bridge.snapshot(); assert.equal(profile.profileRef, 'account:member'); assert.equal(profile.friendRef, '');
  h.bridge.navigate({section: 'friends', friend: 'account:accepted'});
  assert.equal(h.location.searchParams.has('home_profile'), false);
  assert.equal(h.bridge.snapshot().friendRef, 'account:accepted'); assert.equal(h.bridge.snapshot().profileRef, '');
  assert.equal(h.bridge.savePresentation({kind: 'albums'}, profile), false);
  h.history.go(-1); assert.equal(h.bridge.snapshot().profileRef, 'account:member'); assert.equal(h.bridge.snapshot().friendRef, '');
  h.history.go(1); assert.equal(h.bridge.snapshot().friendRef, 'account:accepted');
  h.bridge.navigate(); assert.equal(h.location.searchParams.has('home_profile'), false);
  assert.deepEqual(h.forbiddenCalls, [], 'profile navigation performs no private read or native media intent');
});

test('conflicting profile and friend destinations never pick an arbitrary identity', () => {
  const h = setup();
  assert.throws(() => h.bridge.navigate({section: 'friends', friend: 'a', profile: 'b'}), /unavailable/);
  assert.throws(() => h.bridge.navigate({section: 'friends', profile: {account_ref: 'b'}}), /unavailable/);
  assert.equal(h.historyCalls.length, 0);
  h.location.searchParams.set('home_section', 'friends'); h.location.searchParams.set('home_friend', 'a');
  h.location.searchParams.set('home_profile', 'b');
  assert.equal(h.bridge.snapshot().friendRef, ''); assert.equal(h.bridge.snapshot().profileRef, '');
});

test('notification profile navigation makes one native Home entry and accepts its intentional controller handoff', async () => {
  const h = profileNavigation(), scopeKey = h.bridge.snapshot().scopeKey;
  let authorized = true;
  h.bridge.subscribe(() => {if (h.bridge.snapshot().visible) authorized = false;});
  const opening = h.bridge.openFriendProfile({scopeKey, accountRef: 'account:member', isCurrent: () => authorized});
  assert.equal(h.reads.length, 1); assert.equal(h.reads[0].url, '/home-data'); assert.equal(h.reads[0].push, true);
  h.reads[0].finish(); assert.equal(await opening, true);
  assert.equal(authorized, false); assert.equal(h.bridge.snapshot().profileRef, 'account:member');
  assert.equal(h.entries.length, 2); assert.deepEqual(h.historyCalls.map(value => value[0]), ['push', 'replace']);
  assert.equal(h.location.searchParams.has('home_friend'), false);
  assert.equal(Object.hasOwn(h.history.state, 'allowed_actions'), false);
});

test('notification profile navigation rechecks request authority and native scope before applying a response', async () => {
  for (const invalidate of [h => {h.allowed = false;}, h => {h.shell.dataset.nativeAccountId = 'another';},
    h => {h.nativeNavigation.writeLibraryHistory('/?surface=playlists', {}, {mode: 'push'});}]) {
    const h = profileNavigation(), scopeKey = h.bridge.snapshot().scopeKey; h.allowed = true;
    const opening = h.bridge.openFriendProfile({scopeKey, accountRef: 'account:member', isCurrent: () => h.allowed});
    invalidate(h); const writes = h.historyCalls.length;
    h.reads[0].finish(); assert.equal(await opening, false); assert.equal(h.historyCalls.length, writes);
    assert.equal(h.location.searchParams.has('home_profile'), false);
  }
});

test('notification profile navigation respects deferred form guards and does not navigate a revoked request afterward', async () => {
  const h = profileNavigation(), guard = deferred(), scopeKey = h.bridge.snapshot().scopeKey;
  let resume, allowed = true;
  h.context.deferAppFormPageReplacement = callback => {resume = callback; return guard.promise;};
  const opening = h.bridge.openFriendProfile({scopeKey, accountRef: 'account:member', isCurrent: () => allowed});
  assert.equal(h.reads.length, 0); allowed = false; guard.resolve(await resume());
  assert.equal(await opening, false); assert.equal(h.historyCalls.length, 0); assert.equal(h.reads.length, 0);
});

test('Settings returns through its native leave guard and reuses the resulting history entry for profile', async () => {
  const h = profileNavigation(), scopeKey = h.bridge.snapshot().scopeKey;
  h.history.pushState(h.history.state, '', '/account'); h.shell.hidden = true; h.settings.hidden = false;
  h.context.AlbumHavenAppearance = {instance: {allowLeave: () => false}};
  assert.equal(await h.bridge.openFriendProfile({scopeKey, accountRef: 'account:member', isCurrent: () => true}), false);
  assert.equal(h.location.pathname, '/account'); assert.equal(h.reads.length, 0);
  h.context.AlbumHavenAppearance.instance.allowLeave = () => true;
  const count = h.entries.length;
  const opening = h.bridge.openFriendProfile({scopeKey, accountRef: 'account:member', isCurrent: () => true});
  await Promise.resolve(); assert.equal(h.reads.length, 1); assert.equal(h.reads[0].push, false);
  h.reads[0].finish(); assert.equal(await opening, true);
  assert.equal(h.shell.hidden, false); assert.equal(h.settings.hidden, true);
  assert.equal(h.entries.length, count + 1); assert.equal(h.bridge.snapshot().profileRef, 'account:member');
});

test('selection history admits bounded identities and presentation without target grants or source DTOs', () => {
  const h = setup();
  const entry = index => ({query: {section: 'recent', account_ref: null, kind: 'artists', period: ['week', 'month', 'six', 'year', 'all'][index % 5]},
    selected: {rowId: `row:${index}`, targetKind: 'artist', targetRef: `artist:${index}`, snapshotRef: 'snapshot:one',
      allowed_actions: {can_view_details: true}, native_actions: {artist_ref: 'private-native'}},
    childAlbumRef: 'album:child', pane: 'artist', expanded: 'artist', scroll: {source: 20, artist: 30, album: -1},
    rows: [{secret: 'private-data'}]});
  const rows = [entry(0), {...entry(1), query: {...entry(1).query, account_ref: 'forged'}}, entry(1), entry(2), entry(3), entry(4),
    {...entry(0), query: {section: 'friends', account_ref: 'friend:one', kind: 'albums', period: 'week'}},
    {...entry(0), query: {section: 'friends', account_ref: 'friend:two', kind: 'albums', period: 'week'}}];
  h.bridge.savePresentation({selectionPresentation: rows, expanded: 'artist'});
  const saved = h.bridge.snapshot().presentation;
  assert.equal(saved.selectionPresentation.length, 6); assert.equal(saved.expanded, 'artist');
  assert.deepEqual(plain(saved.selectionPresentation[0].selected), {rowId: 'row:0', targetKind: 'artist', targetRef: 'artist:0', snapshotRef: 'snapshot:one'});
  assert.deepEqual(plain(saved.selectionPresentation[0].scroll), {source: 20, artist: 30, album: 0});
  assert.doesNotMatch(JSON.stringify(saved), /allowed_actions|native_actions|private-data|private-native|"rows"|forged/);
  assert.ok(Object.isFrozen(saved.selectionPresentation[0].selected));
});
