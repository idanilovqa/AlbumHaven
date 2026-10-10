const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../../music_app/static/js/runtime');
const TOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAMP = 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const descriptor = (top_ref = null) => ({surface: {active: 'album_tops'}, top_ref, context_ref: STAMP});
function load(context, ...files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {filename: file});
}
function node() {
  return {hidden: false, classes: new Set(),
    toggleAttribute(name, on) {assert.equal(name, 'hidden'); this.hidden = Boolean(on);},
    classList: {toggle() {}}, setAttribute() {},
  };
}
function harness(initial = descriptor()) {
  const shell = {...node(), dataset: {nativeAccountId: '41', nativeLibraryId: '73', privateUiContext: STAMP}};
  const nodes = new Map([['app-shell', shell], ...['album-tops-root', 'shell-main-surface', 'sidebar-list',
    'playlist-sidebar-root', 'album-tops-sidebar-root', 'collection-library-navigation'].map(id => [id, node()])]);
  const events = new Map(), observers = [], calls = {navigation: [], closes: [], forms: [], confirms: [], cancelled: []};
  const state = {view: initial, ui: {activeViewRequestId: 0}};
  const window = {location: new URL('https://music.test/'),
    history: {pushState() {assert.fail('Top bridge must use the native navigation owner');},
      replaceState() {assert.fail('Top bridge must use the native navigation owner');}},
    addEventListener(name, listener) {if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener);},
    dispatchEvent(event) {for (const listener of events.get(event.type) || []) listener(event);},
    matchMedia: () => ({matches: false}),
    AlbumHavenHomeRuntime: Object.fromEntries(['buttonHtml', 'actionHtml', 'alertHtml', 'galleryCardHtml',
      'artboxHtml', 'navigationItemHtml', 'openChoice'].map(name => [name, () => name])),
  };
  const context = vm.createContext({window, state, URL, URLSearchParams, Event,
    document: {getElementById: id => nodes.get(id)},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {}},
    activeAppConfirmDialog: null, activeAppFormDialog: null,
    openReactFormDialog(options, available) {
      const owner = {isCurrentContext: () => true};
      context.activeAppFormDialog = owner;
      calls.forms.push({options, available, owner}); return {close() {}};
    },
    deferAppFormPageReplacement: () => false,
    showAppConfirmDialog(options) {
      const pending = deferred();
      const owner = {promise: pending.promise, cancel(value) {calls.cancelled.push(value); pending.resolve(false);}};
      context.activeAppConfirmDialog = owner;
      calls.confirms.push({options, pending, owner});
      return pending.promise;
    },
    fetchAndRender(url, pushHistory, options) {
      const pending = deferred(), requestId = ++state.ui.activeViewRequestId;
      calls.navigation.push({url, pushHistory, options, requestId,
        finish(payload) {
          const accepted = options.shouldApplyResponse(payload);
          if (accepted) state.view = payload;
          pending.resolve(accepted);
          return accepted;
        }});
      return pending.promise;
    },
  });
  load(context, 'private-ui-transport.js', 'shell-navigation-drawer.js');
  context.closeArtistsDrawer = options => calls.closes.push(options);
  load(context, 'album-tops-react-bridge.js');
  return {context, bridge: window.AlbumHavenAlbumTopsRuntime, transport: window.AlbumHavenPrivateUITransport,
    window, state, shell, nodes, events, observers, calls};
}

test('native Top directory and detail URLs round-trip without inherited gallery or playlist filters', () => {
  const context = vm.createContext({URL, URLSearchParams});
  load(context, 'view-state-helpers.js');
  for (const top_ref of [null, TOP]) {
    const input = {surface: {active: 'album_tops'}, top_ref, query: 'Previous artist search', selected_artist: 'Old artist',
      playlist_id: OTHER, gallery_scope: 'new_arrivals', gallery_scale_percent: 200,
      visible_library_categories: ['hoard'], search_filters: {genre: ['Rock']}};
    const suffix = top_ref ? `&top_ref=${top_ref}` : '';
    assert.equal(context.buildUrl(input), `/?surface=album_tops${suffix}`);
    assert.equal(context.buildApiUrl(input, {omitSidebar: true, payloadTier: 'sidebar'}), `/view-data?surface=album_tops${suffix}`);
    const restored = context.parseUrlStateFromUrl(context.buildUrl(input), 'https://music.test');
    assert.equal(restored.surface_request, 'album_tops');
    assert.equal(restored.top_ref, top_ref || '');
    assert.equal(context.buildUrl(restored), context.buildUrl(input));
  }
});

test('collection normalization retires artist and playlist state and never inherits an old Top selection', () => {
  const context = vm.createContext({appBootstrap: {getInitialView: () => ({})}});
  load(context, 'response-state-helpers.js');
  const previous = {surface: {active: 'albums'}, top_ref: OTHER, selected_artist: 'Old artist', all_artists_active: true,
    artist_groups: [{artist: 'Old artist', albums: [{key: 'private-album'}]}], primary_artist_groups: [{}],
    family_artist_groups: [{}], artists_sidebar: [{}], related_artists: ['Old family'], related_filter_artists: ['Old family'],
    artist_family_filters: [{}], artist_page: {title: 'Old artist'}, gallery_page: {cursor: 'old'}, gallery_page_scope: 'old',
    playlist_detail: {playlist_id: OTHER}, playlist_index: {playlists: [{}]}, playlist_sidebar: {active_playlist_id: OTHER},
    playlist_creation_source: {ref: 'old'}, playlist_actions: {can_create: true}, search_context: {selected_artist: 'Old artist'}};
  const topView = context.normalizeViewPayload(descriptor(TOP), previous);
  assert.equal(topView.top_ref, TOP);
  for (const key of ['artist_groups', 'primary_artist_groups', 'family_artist_groups', 'artists_sidebar',
    'related_artists', 'related_filter_artists']) assert.deepEqual(plain(topView[key]), [], key);
  for (const key of ['artist_family_filters', 'artist_page', 'gallery_page', 'gallery_page_scope',
    'playlist_detail', 'playlist_index', 'playlist_sidebar', 'playlist_creation_source', 'playlist_actions', 'search_context']) {
    assert.equal(Object.hasOwn(topView, key), false, key);
  }
  assert.equal(topView.selected_artist, '');
  assert.equal(topView.all_artists_active, false);
  assert.equal(context.normalizeViewPayload(descriptor(), topView).top_ref, null);
  for (const active of ['albums', 'home', 'playlists']) {
    assert.equal(Object.hasOwn(context.normalizeViewPayload({surface: {active}}, topView), 'top_ref'), false);
  }
  assert.equal(previous.artist_groups[0].albums[0].key, 'private-album');
});

test('sidebar selection is presentation-only and retains the existing drawer and fold state', () => {
  const h = harness({surface: {active: 'albums'}}), before = h.state.view, href = h.window.location.href;
  h.state.ui.artistsDrawerOpen = true;
  h.state.ui.artistTreeFolded = true;
  for (const mode of ['album_tops', 'playlists', 'albums']) {
    assert.equal(h.bridge.selectSidebar(mode), true);
    assert.equal(h.context.getLibrarySidebarMode(), mode);
    assert.equal(h.state.view, before);
    assert.equal(h.window.location.href, href);
    assert.equal(h.state.ui.artistsDrawerOpen, true);
    assert.equal(h.state.ui.artistTreeFolded, true);
    assert.equal(h.nodes.get('album-tops-sidebar-root').hidden, mode !== 'album_tops');
    assert.equal(h.nodes.get('playlist-sidebar-root').hidden, mode !== 'playlists');
  }
  assert.equal(h.nodes.get('sidebar-list').hidden, true, 'the existing desktop fold still owns visibility');
  assert.equal(h.bridge.selectSidebar('foreign'), false);
  assert.equal(h.context.getLibrarySidebarMode(), 'albums');
  assert.equal(h.calls.navigation.length, 0);
});

test('Top and Playlist collection panes remain supported by the shared drawer', () => {
  const h = harness();
  for (const content_kind of ['artists_sidebar', 'playlist_sidebar', 'album_tops_sidebar']) {
    h.state.view = {shell_layout: {slots: {navigation_rail: {content_kind}}}};
    assert.equal(h.context.canUseArtistsDrawerForCurrentView(), true);
  }
  h.state.view = {shell_layout: {slots: {navigation_rail: {content_kind: 'foreign'}}}};
  assert.equal(h.context.canUseArtistsDrawerForCurrentView(), false);
});

test('snapshot publishes native identity and stable state without putting Top DTOs in shell history', () => {
  const h = harness({...descriptor(TOP), tops: [{title: 'Private title'}], items: [{local_path: '/private/item'}]});
  const first = h.bridge.snapshot();
  assert.equal(first.active, true);
  assert.equal(first.visible, true);
  assert.equal(first.topRef, TOP);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(h.bridge.snapshot(), first);
  assert.doesNotMatch(JSON.stringify(first), /Private title|local_path|private\/item|"tops"|"items"/);
  let updates = 0;
  const unsubscribe = h.bridge.subscribe(() => updates++);
  h.bridge.sync();
  assert.equal(updates, 0);
  h.state.view = descriptor(OTHER);
  h.window.dispatchEvent(new Event('popstate'));
  assert.equal(updates, 1);
  assert.equal(h.bridge.snapshot().topRef, OTHER);
  assert.ok(h.bridge.snapshot().viewVersion > first.viewVersion);
  unsubscribe();
  h.state.view = descriptor(); h.bridge.sync();
  assert.equal(updates, 1);
});

test('global Top notification reads need current native identity and stop outside the library', () => {
  const h = harness({surface: {active: 'albums'}});
  const scope = h.bridge.snapshot().scopeKey;
  assert.equal(h.bridge.acceptsPrivateScope(scope), true, 'global Top Notifications do not require a visible Top or selected sidebar');
  h.bridge.selectSidebar('album_tops');
  assert.equal(h.bridge.acceptsPrivateScope(scope), true);
  assert.equal(h.bridge.snapshot().visible, false);
  assert.equal(h.bridge.snapshot().topRef, null);
  h.window.location = new URL('https://music.test/settings');
  assert.equal(h.bridge.acceptsPrivateScope(scope), false);
  h.window.location = new URL('https://music.test/');
  h.shell.hidden = true;
  assert.equal(h.bridge.acceptsPrivateScope(scope), false);
  h.shell.hidden = false;
  h.shell.dataset.nativeAccountId = '42';
  assert.equal(h.bridge.acceptsPrivateScope(scope), false);
  const newScope = h.bridge.snapshot().scopeKey;
  assert.notEqual(newScope, scope);
  h.shell.dataset.privateUiContext = '';
  assert.equal(h.bridge.acceptsPrivateScope(newScope), false);
});

test('opening a Top uses one native navigation request and closes the drawer only after accepted paint', async () => {
  const h = harness({surface: {active: 'albums'}});
  h.bridge.selectSidebar('album_tops');
  const opening = h.bridge.navigate({top_ref: TOP});
  assert.equal(h.calls.navigation.length, 1);
  const call = h.calls.navigation[0];
  assert.equal(call.url, `/view-data?surface=album_tops&top_ref=${TOP}`);
  assert.equal(call.pushHistory, true);
  assert.equal(call.options.source, 'library');
  assert.equal(h.calls.closes.length, 0);
  assert.equal(call.finish(descriptor(TOP)), true);
  assert.equal(await opening, true);
  assert.deepEqual(plain(h.calls.closes), [{restoreFocus: false}]);
  assert.equal(h.bridge.snapshot().topRef, TOP);
});

test('invalid or no-longer-current Top intents cannot start native navigation', async () => {
  const h = harness();
  for (const top_ref of ['', 'not-a-uuid', TOP.toUpperCase(), 7, {}]) {
    assert.equal(await h.bridge.navigate({top_ref}), false);
  }
  assert.equal(await h.bridge.navigate({top_ref: TOP, isCurrent: () => false}), false);
  assert.equal(h.calls.navigation.length, 0);
});

test('a wrong resource reply never paints or closes the drawer', async () => {
  const h = harness(), previous = h.state.view;
  const opening = h.bridge.navigate({top_ref: TOP});
  assert.equal(h.calls.navigation[0].finish(descriptor(OTHER)), false);
  assert.equal(await opening, false);
  assert.equal(h.state.view, previous);
  assert.equal(h.calls.closes.length, 0);
});

test('context mismatch retires private scope rather than accepting a native Top navigation response', async () => {
  const h = harness(), priorScope = h.bridge.snapshot().scopeKey;
  const opening = h.bridge.navigate({top_ref: TOP});
  const rejected = assert.rejects(opening, {name: 'AbortError'});
  assert.equal(h.calls.navigation[0].finish({...descriptor(TOP), context_ref: 'b'.repeat(64)}), false);
  await rejected;
  assert.equal(h.bridge.acceptsPrivateScope(priorScope), false);
  assert.equal(h.bridge.snapshot().authenticated, false);
  assert.equal(h.calls.closes.length, 0);
});

test('newer shell navigation and Back/Forward prevent a late Top response from repainting', async () => {
  const h = harness();
  const opening = h.bridge.navigate({top_ref: TOP});
  const traversed = descriptor(OTHER);
  h.state.view = traversed;
  h.window.dispatchEvent(new Event('popstate'));
  assert.equal(h.calls.navigation[0].finish(descriptor(TOP)), false);
  assert.equal(await opening, false);
  assert.equal(h.state.view, traversed);
  assert.equal(h.calls.closes.length, 0);
});

test('a newer request owns native navigation even when the older response arrives last', async () => {
  const h = harness();
  const old = h.bridge.navigate({top_ref: TOP});
  const rejected = assert.rejects(old, {name: 'AbortError'});
  const latest = h.bridge.navigate({top_ref: OTHER});
  assert.equal(h.calls.navigation[1].finish(descriptor(OTHER)), true);
  assert.equal(await latest, true);
  assert.equal(h.calls.navigation[0].finish(descriptor(TOP)), false);
  await rejected;
  assert.equal(h.bridge.snapshot().topRef, OTHER);
  assert.equal(h.calls.closes.length, 1);
});

test('deferred form replacement cannot replay Top navigation after its native entry changes', async () => {
  const h = harness(), dismissed = deferred();
  let replay;
  h.context.deferAppFormPageReplacement = callback => {replay = callback; return dismissed.promise.then(ok => ok && replay());};
  const opening = h.bridge.navigate({top_ref: TOP});
  const rejected = assert.rejects(opening, {name: 'AbortError'});
  assert.equal(h.calls.navigation.length, 0);
  h.state.view = descriptor(OTHER);
  dismissed.resolve(true);
  await rejected;
  assert.equal(h.calls.navigation.length, 0);
});

test('forms use the existing dialog owner and become unavailable after scope or view replacement', () => {
  const h = harness(), options = {title: 'Edit Album Top', pageId: 'edit-album-top'};
  h.bridge.openForm(options);
  assert.equal(h.calls.forms[0].options.title, options.title);
  assert.equal(h.calls.forms[0].options.pageId, options.pageId);
  assert.equal(h.calls.forms[0].available(), true);
  assert.equal(h.calls.forms[0].options.retainParentView(), true);
  h.state.view = descriptor(OTHER);
  assert.equal(h.calls.forms[0].available(), false);
  assert.equal(h.calls.forms[0].options.retainParentView(), false);
  h.bridge.openForm(options);
  h.shell.dataset.nativeLibraryId = '74';
  assert.equal(h.calls.forms[1].available(), false);
});

test('native form return retains only its original entry and cannot retain a newer form owner', () => {
  const h = harness(); h.bridge.openForm({pageId: 'album-top-create'});
  const {options, owner} = h.calls.forms[0];
  const originalUrl = h.window.location.href;
  h.window.location = new URL(`${originalUrl}?mobile_page=form`);
  assert.equal(options.retainParentView(), false);
  h.window.location = new URL(originalUrl);
  h.context.activeAppFormDialog = null;
  assert.equal(options.retainParentView(), true, 'the retired form retains its matching returned parent');
  h.context.activeAppFormDialog = {isCurrentContext: () => true};
  assert.equal(options.retainParentView(), false);
  h.context.activeAppFormDialog = owner;
  owner.isCurrentContext = () => false;
  assert.equal(options.retainParentView(), false);
});

test('an owned confirmation is cancelled on revocation and its later acceptance cannot survive', async () => {
  const h = harness();
  const confirming = h.bridge.confirm('Delete this Album Top?', {title: 'Delete Album Top', acceptLabel: 'Delete'});
  assert.equal(h.calls.confirms[0].options.title, 'Delete Album Top');
  h.shell.dataset.nativeAccountId = '';
  h.bridge.sync();
  assert.equal(await confirming, false);
  assert.deepEqual(plain(h.calls.cancelled), [{restoreFocus: false}]);
});

test('Top cleanup never cancels a confirmation owned by a different native surface', async () => {
  const h = harness();
  const confirming = h.bridge.confirm('Discard?');
  h.context.activeAppConfirmDialog = {promise: Promise.resolve(true), cancel() {assert.fail('foreign dialog was cancelled');}};
  h.state.view = descriptor(OTHER); h.bridge.sync();
  h.calls.confirms[0].pending.resolve(true);
  assert.equal(await confirming, false);
  assert.equal(h.calls.cancelled.length, 0);
});

function bootstrapHarness({viewPatch = {}, bootstrapPatch = {}} = {}) {
  const requests = [], view = {...descriptor(TOP), artist_groups: [], artists_sidebar: [], album_count: 0,
    initial_view_partial: false, shell_layout: {slots: {main_content: {content_kind: 'album_tops'}}}, ...viewPatch};
  const bootstrap = {partialView: false, startupHydration: {required: false, endpoint: '/view-data?surface=album_tops'}, ...bootstrapPatch};
  const context = vm.createContext({URL, URLSearchParams, console,
    window: {location: new URL(`https://music.test/?surface=album_tops&top_ref=${TOP}`), addEventListener() {}},
    document: {querySelectorAll: () => [], getElementById: () => null, addEventListener() {}},
    state: {view, ui: {}, player: {}}, appBootstrap: {getBootstrap: () => bootstrap},
    normalizeBootstrapRuntimeStatePayload: payload => ({view: payload.initial_view, bootstrap: payload.bootstrap}),
    resolveGalleryDisplayPreferenceViewState: value => value,
    applyViewPayload(value) {context.state.view = value;},
    startupMetrics: {beginInitialRefresh() {}, markInitialRender() {}, completeInitialRefresh() {}},
    fetchAndRender(...args) {requests.push(args); return Promise.resolve(true);},
  });
  for (const name of ['restorePlayerAppearance', 'attachModalEvents', 'attachAccountMenu', 'attachCoverLookupModalEvents',
    'attachCoverLookupDeleteConfirmEvents', 'attachUtilityModalEvents', 'attachRepairConfirmEvents', 'attachPlayerEvents',
    'renderView', 'updateStatusIndicator', 'renderLibraryLoader', 'scheduleBrowserTimeout', 'pollStatus',
    'hideStatusContextMenu', 'hideVersionContextMenu']) context[name] = () => {};
  load(context, 'view-state-helpers.js', 'view-value-helpers.js', 'bootstrap-init.js');
  return {context, requests, view};
}

test('actual startup treats a complete Top descriptor as authoritative despite empty album galleries', () => {
  const {context, requests, view} = bootstrapHarness();
  assert.equal(context.isEffectivelyEmptyView(view), false);
  assert.equal(context.shouldRunImmediateStartupHydration(view, {startupHydration: {required: false}}), false);
  assert.equal(requests.length, 0);
  assert.equal(context.state.view.top_ref, TOP);
  for (const patch of [{shell_layout: {}}, {surface: {active: 'albums'}}]) {
    assert.equal(context.isEffectivelyEmptyView({...view, ...patch}), true, 'only a matching collection descriptor bypasses empty-gallery hydration');
  }
});

test('explicit required or partial startup hydration preserves the selected Top UUID', () => {
  for (const options of [{bootstrapPatch: {partialView: true}}, {viewPatch: {initial_view_partial: true}},
    {bootstrapPatch: {startupHydration: {required: true, endpoint: '/view-data?surface=album_tops&payload_tier=full'}}}]) {
    const {context, requests} = bootstrapHarness(options);
    assert.equal(requests.length, 1);
    const url = new URL(requests[0][0], 'https://music.test');
    assert.equal(url.pathname, '/view-data');
    assert.equal(url.searchParams.get('surface'), 'album_tops');
    assert.equal(url.searchParams.get('top_ref'), TOP);
    assert.equal(requests[0][1], false, 'initial hydration must not add browser history');
    assert.equal(requests[0][2].startupRefresh, true);
    assert.equal(context.state.view.top_ref, TOP);
  }
});

test('hydration identity reconciliation preserves server options and never crosses a different surface or route', () => {
  const {context} = bootstrapHarness();
  const expected = `/view-data?surface=album_tops&payload_tier=full&omit_sidebar=1&top_ref=${TOP}`;
  assert.equal(context.resolveInitialHydrationEndpoint({endpoint: '/view-data?surface=album_tops&payload_tier=full&omit_sidebar=1'}), expected);
  assert.equal(context.resolveInitialHydrationEndpoint({followupEndpoint: '/view-data?surface=album_tops&payload_tier=full&omit_sidebar=1'},
    {preferFollowupEndpoint: true}), expected);
  for (const endpoint of [`/view-data?surface=playlists&playlist_id=${OTHER}`, '/home-data?surface=album_tops']) {
    assert.equal(context.resolveInitialHydrationEndpoint({endpoint}), endpoint);
  }
});


test('global Top notification entry navigation works from Home and Playlists without sidebar selection', async () => {
  for (const active of ['home', 'playlists']) {
    const h = harness({surface: {active}}), scope = h.bridge.snapshot().scopeKey;
    assert.equal(h.bridge.acceptsPrivateScope(scope), true);
    assert.equal(h.bridge.snapshot().visible, false);
    const opening = h.bridge.navigate({top_ref: TOP});
    assert.equal(h.calls.navigation.length, 1);
    assert.equal(h.calls.navigation[0].finish(descriptor(TOP)), true);
    assert.equal(await opening, true);
  }
});

test('original copy view request cannot start or resume navigation after a newer native request', async () => {
  const h = harness(descriptor(TOP)), origin = h.bridge.snapshot();
  h.state.ui.activeViewRequestId++;
  assert.equal(h.bridge.snapshot().viewVersion, origin.viewVersion);
  assert.equal(await h.bridge.navigate({top_ref: OTHER, expectedViewRequestId: origin.viewRequestId}), false);
  assert.equal(h.calls.navigation.length, 0);
  const delayed = deferred(); let resume;
  h.context.deferAppFormPageReplacement = callback => {resume = callback; return delayed.promise;};
  const pending = h.bridge.navigate({top_ref: OTHER, expectedViewRequestId: h.bridge.snapshot().viewRequestId});
  h.state.ui.activeViewRequestId++;
  await assert.rejects(resume(), {name: 'AbortError'});
  delayed.resolve(false); assert.equal(await pending, false);
  assert.equal(h.calls.navigation.length, 0);
});
