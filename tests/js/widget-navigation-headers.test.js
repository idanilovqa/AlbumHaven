const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, requireOwner, buttonNamed} = require('./runtime/native-home-harness.cjs');

const homeSource = path.resolve(__dirname, '../../music_app/static/js/home-friends');
const helpers = import(pathToFileURL(path.join(homeSource, 'selection-presentation.mjs')));
const plain = value => JSON.parse(JSON.stringify(value));
const labels = node => node.querySelectorAll('button').map(button => button.getAttribute('aria-label') || button.textContent);
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const find = (tree, predicate) => elements(tree).find(predicate);
const hasClass = (node, name) => node.props.className?.split(' ').includes(name);

function nativeWidgets({backHost = false, actions = ['Play', 'Collapse', 'More', 'Close']} = {}) {
  const env = createNativeHomeRuntime({dashboard: true}), root = env.document.createElement('main');
  const pageHeader = env.document.createElement('header');
  pageHeader.innerHTML = '<div class="gallery-bar__context"><h1>My music</h1></div>';
  env.document.body.append(pageHeader, root);
  const widgets = ['album', 'artist'].map(key => {
    const element = env.document.createElement('section'), holder = env.document.createElement('div');
    holder.innerHTML = env.context.buildAlbumDetailsHeaderHtml({artist: 'Native artist', album: `Native ${key}`,
      titleId: `${key}-title`, subtitleId: `${key}-subtitle`, actionsHtml: actions.map(label =>
        env.context.ButtonComponent.renderActionButton({ariaLabel: label, icon: label === 'Close' ? 'close' : 'more'})).join('')});
    const header = holder.firstElementChild, body = env.document.createElement('div');
    body.innerHTML = '<button type="button" aria-label="Embedded control">Embedded control</button>';
    element.append(header, body); root.append(element);
    return {key, element, header, body, ...(backHost ? {backHost: pageHeader.querySelector('.gallery-bar__context')} : {})};
  });
  const intents = [], before = root.innerHTML, headerBefore = pageHeader.innerHTML;
  const owner = requireOwner(env, 'Dashboard').mount(root, {widgets, onSizeIntent: (...args) => intents.push(args)});
  return {...env, root, pageHeader, widgets, owner, intents, before, headerBefore};
}

// These execute the native owners in the existing bounded DOM fixture. DOM
// order, callback ownership and disposal are covered; painted layout is not.
test('shared widget actions put Full size first and retain only supplied middle and trailing actions', () => {
  for (const actions of [['Play', 'Collapse', 'More', 'Close'], ['More', 'Close'], ['Play'], []]) {
    const h = nativeWidgets({actions});
    for (const widget of h.widgets) {
      const group = widget.header.querySelector('.album-details-header__actions');
      assert.deepEqual(labels(group), ['Full size', ...actions]);
    }
    h.owner.dispose();
    assert.equal(h.root.innerHTML, h.before);
    assert.deepEqual(h.forbiddenCalls, []);
  }
});

test('every expanded native widget including AlbumDetails gets a left-header Back controlled by the existing owner', () => {
  const h = nativeWidgets(), foreground = h.document.createElement('button'); h.document.body.append(foreground);
  h.document.activeElement = foreground;
  for (const widget of h.widgets) {
    const body = widget.body, embedded = body.firstElementChild;
    body.scrollTop = 117; body.scrollLeft = 9;
    let embeddedCalls = 0; embedded.addEventListener('click', () => embeddedCalls++);
    const before = h.root.innerHTML;
    h.click(buttonNamed(widget.header, /^Full size$/));
    assert.equal(h.root.innerHTML, before, 'a sizing intent does not mutate controlled presentation');
    assert.deepEqual(h.intents.at(-1), [widget.key, widget.key]);
    h.owner.update({expandedKey: widget.key});
    const back = buttonNamed(widget.header, /^Back$/), actions = widget.header.querySelector('.album-details-header__actions');
    assert.equal(actions.contains(back), false, 'Back belongs to the header start, outside trailing actions');
    assert.equal(widget.header.firstElementChild === back || widget.header.firstElementChild.contains(back), true);
    assert.equal(buttonNamed(widget.header, /Widget size|Full size/, false), null);
    assert.deepEqual(labels(actions), ['Play', 'Collapse', 'More', 'Close']);
    h.click(embedded); assert.equal(embeddedCalls, 1); assert.equal(h.intents.length % 2, 1);
    const expandedMarkup = h.root.innerHTML;
    h.click(back.querySelector('path'));
    assert.deepEqual(h.intents.at(-1), [widget.key, null]);
    assert.equal(h.root.innerHTML, expandedMarkup, 'Back also waits for the controlled update');
    h.owner.update({expandedKey: null});
    assert.equal(buttonNamed(widget.header, /^Back$/, false), null);
    assert.deepEqual(labels(actions), ['Full size', 'Play', 'Collapse', 'More', 'Close']);
    assert.equal(widget.body, body); assert.equal(body.firstElementChild, embedded);
    assert.equal(body.scrollTop, 117); assert.equal(body.scrollLeft, 9);
    assert.equal(h.document.activeElement, foreground);
  }
  h.owner.dispose(); h.owner.dispose();
  assert.equal(h.root.innerHTML, h.before); assert.deepEqual(h.forbiddenCalls, []);
});

test('shared Back can occupy an existing page header without becoming another navigation or focus owner', () => {
  const h = nativeWidgets({backHost: true}), context = h.pageHeader.firstElementChild, identity = context.firstElementChild;
  h.owner.update({expandedKey: 'album'});
  const back = buttonNamed(context, /^Back$/);
  assert.equal(context.firstElementChild, back);
  assert.equal(identity.parentNode, context); assert.equal(identity.textContent, 'My music');
  assert.equal(h.root.querySelectorAll('[aria-label="Back"]').length, 0);
  h.click(back.querySelector('svg')); assert.deepEqual(h.intents, [['album', null]]);
  h.owner.update({expandedKey: 'artist'});
  assert.equal(context.querySelectorAll('[aria-label="Back"]').length, 1);
  const retired = buttonNamed(context, /^Back$/);
  h.owner.dispose(); h.click(retired);
  assert.deepEqual(h.intents, [['album', null]]);
  assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('Queue and Recent preserve independent bounded presentation in the same selection history', async () => {
  const {selectionQueryKey, selectionEntry, selectionPresentation, updateSelectionEntry} = await helpers;
  const recent = {section: 'recent', account_ref: null, kind: 'tracks', period: 'week'};
  const queue = {...recent, homeSection: 'queue'};
  assert.notEqual(selectionQueryKey(queue), selectionQueryKey(recent));
  let entries = updateSelectionEntry([], recent, {tracks: {rowIds: ['recent:one']}, expanded: 'artist', pane: 'artist', scroll: {source: 88}});
  entries = updateSelectionEntry(entries, queue, {tracks: {rowIds: ['queue:one'], native_media: '/private.flac'}, expanded: 'recent', pane: 'recent', scroll: {source: 23}});
  entries = selectionPresentation(plain(entries));
  assert.equal(entries.length, 2);
  assert.equal(selectionEntry(entries, recent).expanded, 'artist');
  assert.equal(selectionEntry(entries, recent).pane, 'artist');
  assert.deepEqual(selectionEntry(entries, recent).tracks.rowIds, ['recent:one']);
  assert.equal(selectionEntry(entries, recent).scroll.source, 88);
  assert.equal(selectionEntry(entries, queue).expanded, 'recent');
  assert.deepEqual(selectionEntry(entries, queue).tracks.rowIds, ['queue:one']);
  assert.equal(selectionEntry(entries, queue).scroll.source, 23);
  assert.doesNotMatch(JSON.stringify(entries), /native_media|private\.flac/);
});

let homeBundle;
const ownProfile = {display_name: 'Current listener', handle: 'listener', bio: 'My profile', allowed_actions: {can_edit: true}};
const activityOrigin = {source: 'activity', account_ref: null, kind: 'tracks', period: 'week'};
const activityTarget = kind => ({kind, ref: `recent:${kind}`, allowed_actions: {can_view_details: true}, origin: activityOrigin});
const homeState = () => ({scopeKey: 'account/library', selectedFriendRef: null,
  friends: {status: 'ready', data: {profile: ownProfile, friends: [], requests: []}}, members: {status: 'unavailable', data: null},
  recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
  activity: {status: 'ready', data: {rows: [{id: 'recent:one', kind: 'track', title: 'Recent track', source_readable: true,
    album_target: activityTarget('album'), artist_target: activityTarget('artist')}], snapshot_ref: null}},
  activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}},
  comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}});

function queuedSource() {
  const listeners = new Set(), reads = [];
  let value = {enabled: true, revision: 1, entries: [{id: 'queue:one', sourceReadable: true, title: 'Queued track'}]};
  const api = {getSnapshot: () => value,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async details(id, kind) {
      reads.push([id, kind]);
      return {target: {kind, ref: `queue:${kind}`, allowed_actions: {can_view_details: true}},
        data: {kind, ref: `queue:${kind}`, title: `Queued ${kind}`, tracks: null, listened_albums: null, discography: null},
        isCurrent: () => value.entries.some(row => row.id === id && row.sourceReadable)};
    },
  };
  return {api, reads, listeners, replace(patch) {value = {...value, ...patch, revision: value.revision + 1}; for (const listener of [...listeners]) listener();}};
}

// Runs the real Home effects, Dashboard, and Queue resource-selection owner.
// The explicit ref commit below supplies bounded native hosts; it does not
// simulate React reconciliation, real browser history traversal, or geometry.
function homeFixture(presentation = {kind: 'tracks'}, queue = queuedSource()) {
  homeBundle ||= buildSync({entryPoints: [path.join(homeSource, 'app.jsx')], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const env = createNativeHomeRuntime({dashboard: true}), native = requireOwner(env, 'Dashboard');
  env.context.AbortController = AbortController;
  for (const file of ['resource-selection.js', 'queue-resource-selection.js']) vm.runInContext(
    fs.readFileSync(path.resolve(homeSource, '../runtime', file), 'utf8'), env.context, {filename: file});
  const page = env.document.createElement('div'), pageHeader = env.document.createElement('header'), dashboard = env.document.createElement('div');
  pageHeader.className = 'gallery-bar home-friends__page-header';
  pageHeader.innerHTML = '<div class="gallery-bar__context"><h1>Current listener</h1></div><div class="gallery-bar__actions"></div>';
  page.append(pageHeader, dashboard); env.document.body.append(page);
  const nodes = new Map(), slots = [], saves = [], navigation = [], reads = [], mediaListeners = new Set();
  const media = {matches: false, addEventListener: (_type, listener) => mediaListeners.add(listener),
    removeEventListener: (_type, listener) => mediaListeners.delete(listener)};
  const window = {innerWidth: 1200, matchMedia: () => media};
  let cursor = 0, effects = [], dirty = false, tree, disposed = false;
  const h = {state: homeState(), shell: {section: 'recent', friendRef: null, accountName: 'Current listener', presentation}, readDetail() {}};
  const controller = {getSnapshot: () => h.state, selectFriend: () => true, selectProfile: () => true,
    loadActivity(value) {reads.push(value);}, loadFriends() {}, loadRecent() {}, loadProfile() {}};
  const runtime = {mountDashboard: (root, options) => native.mount(root, options), savePresentation: value => saves.push(plain(value)),
    navigate: value => navigation.push(value), explicitQueue: () => queue.api,
    createQueueResourceSelection: options => env.context.window.AlbumHavenQueueResourceSelection.create(options)};
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const effect = (run, deps) => {const index = cursor++, old = slots[index];
    if (changed(old, deps)) effects.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: run()};});};
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(value) {const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {if (disposed) return; const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) {slots[index].value = value; dirty = true;}}];},
    useMemo(factory, deps) {const index = cursor++, old = slots[index];
      if (changed(old, deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useEffect: effect, useLayoutEffect: effect,
  };
  const loaded = {exports: {}};
  vm.runInNewContext(homeBundle, {module: loaded, exports: loaded.exports, console, document: env.document, window,
    clearTimeout, setTimeout, require: name => name === 'react' ? hooks : require(name)});
  function scoped(node) {
    const original = node.querySelector.bind(node);
    node.querySelector = selector => selector.startsWith(':scope > ')
      ? node.children.find(child => child.matches(selector.slice(9))) ?? null : original(selector);
    return node;
  }
  function connect() {
    tree.props.ref.current = page; page.className = tree.props.className;
    const current = new Set();
    for (const element of elements(tree)) {
      if (hasClass(element, 'home-friends__page-header') && element.props.ref) element.props.ref.current = pageHeader;
      if (hasClass(element, 'home-friends__dashboard')) element.props.ref.current = dashboard;
      const key = element.props['data-home-widget']; if (!key) continue;
      current.add(key);
      if (!nodes.has(key)) {
        const node = scoped(env.document.createElement('section'));
        node.innerHTML = '<header class="gallery-bar"><div class="gallery-bar__context"></div><div class="gallery-bar__actions"></div></header>'
          + '<div class="home-friends__widget-body"><div class="home-friends__scroll"></div></div>';
        nodes.set(key, node); dashboard.append(node);
      }
      element.props.ref.current = nodes.get(key); nodes.get(key).hidden = element.props.hidden === true;
    }
    for (const [key, node] of nodes) if (!current.has(key)) {node.remove(); nodes.delete(key);}
  }
  h.render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 20, 'the real Home effects must settle'); cursor = 0; effects = []; dirty = false;
      tree = loaded.exports.HomeFriendsView({runtime, controller, state: h.state, shell: h.shell, readDetail: h.readDetail});
      connect(); for (const run of effects) run();
    } while (dirty);
    return tree;
  };
  h.resize = width => {window.innerWidth = width; media.matches = width <= 900; for (const listener of mediaListeners) listener(); return h.render();};
  h.settle = async () => {await new Promise(resolve => setImmediate(resolve)); return h.render();};
  h.section = value => {find(h.render(), node => node.props.id === 'home-recent-sections').props.onChange(value); return h.render();};
  h.dispose = () => {if (disposed) return; disposed = true; for (const slot of slots) slot?.cleanup?.(); page.remove(); assert.equal(mediaListeners.size, 0);};
  return Object.assign(h, {runtime, controller, env, queue, page, pageHeader, dashboard, nodes, saves, navigation, reads});
}

function assertOwnQueue(tree) {
  const pageHeader = find(tree, node => hasClass(node, 'home-friends__page-header'));
  const identity = component(pageHeader, 'ProfileIdentity');
  assert.ok(identity); assert.equal(identity.props.profile, ownProfile); assert.equal(identity.props.own, true);
  assert.equal(identity.props.fallbackName, 'Current listener');
  assert.equal(elements(tree).filter(node => hasClass(node, 'home-friends__page-header')).length, 1);
  assert.equal(elements(tree).some(node => ['h1', 'h2'].includes(node.type) && node.props.children === 'Queue'), false);
  assert.equal(find(tree, node => node.props['data-home-widget'] === 'queue'), undefined);
  assert.equal(tree.props['data-home-section'], 'recent'); assert.ok(component(tree, 'QueuePanel'));
  for (const name of ['ActivityPanel', 'Period', 'ViewControl', 'ActivityMissingAction']) assert.equal(component(tree, name), undefined, `${name} is not mounted in Queue`);
  assert.equal(find(tree, node => node.props.id === 'home-recent-kinds'), undefined);
  assert.equal(find(tree, node => hasClass(node, 'home-friends__catalog-controls')), undefined);
}

test('Queue selection, expansion, row inspection and Back keep the own profile header and native widget composition', async t => {
  const h = homeFixture(); t.after(h.dispose);
  let tree = h.section('queue'); assertOwnQueue(tree);
  component(tree, 'QueuePanel').props.onSelect(['queue:one']); tree = await h.settle(); assertOwnQueue(tree);
  const album = find(tree, node => node.type?.name === 'ResourceDetail' && node.props.selection?.kind === 'album');
  assert.equal(album.props.selection.ref, 'queue:album');
  const body = h.nodes.get('recent').querySelector('.home-friends__widget-body'); body.scrollTop = 74;
  for (const key of ['recent', 'artist', 'album']) {
    h.env.click(buttonNamed(h.nodes.get(key), /^Full size$/)); tree = h.render(); assertOwnQueue(tree);
    assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), key);
    const back = buttonNamed(h.pageHeader, /^Back$/); assert.equal(h.pageHeader.firstElementChild, back);
    if (key === 'recent') component(tree, 'QueuePanel').props.onSelect(['queue:one'], {inspect: true});
    else h.env.click(back.querySelector('svg'));
    tree = await h.settle(); assertOwnQueue(tree);
    assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null);
    assert.equal(buttonNamed(h.pageHeader, /^Back$/, false), null);
    assert.equal(h.nodes.get('recent').querySelector('.home-friends__widget-body'), body);
    assert.equal(body.scrollTop, 74);
  }
  assert.deepEqual(h.navigation, []); assert.deepEqual(h.env.forbiddenCalls, []);
});

test('Recent expansion and selection survive an independent Queue visit and source-only return', async t => {
  const h = homeFixture(); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onTracksSelect(['recent:one']); tree = h.render();
  h.env.click(buttonNamed(h.nodes.get('artist'), /^Full size$/)); h.render();
  tree = h.section('queue');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null, 'Queue does not inherit Recent expansion');
  component(tree, 'QueuePanel').props.onSelect(['queue:one']); tree = await h.settle();
  h.env.click(buttonNamed(h.nodes.get('album'), /^Full size$/)); h.render();
  tree = h.section('recent');
  assert.equal(component(tree, 'ActivityPanel').props.selectedTrackIds[0], 'recent:one');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'artist');
  assert.equal(component(tree, 'QueuePanel'), undefined);
  tree = h.section('queue'); tree = await h.settle(); assertOwnQueue(tree);
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'album');
  assert.deepEqual(plain(component(tree, 'QueuePanel').props.selectedIds), ['queue:one']);
  assert.deepEqual(h.navigation, []);
});

test('Queue is absent on friend and member profile routes and retired callbacks cannot reopen its selection', async t => {
  for (const route of [{friendRef: 'friend:one'}, {profileRef: 'member:one'}]) {
    const h = homeFixture(); t.after(h.dispose);
    let tree = h.section('queue'); component(tree, 'QueuePanel').props.onSelect(['queue:one']); tree = await h.settle();
    const select = component(tree, 'QueuePanel').props.onSelect;
    h.shell = {...h.shell, section: 'friends', ...route}; tree = h.render();
    assert.equal(component(tree, 'QueuePanel'), undefined); assert.equal(component(tree, 'QueueHeader'), undefined);
    const sections = find(tree, node => node.props.id === 'home-recent-sections');
    assert.equal(sections.props.items.some(([id]) => id === 'queue'), false);
    const readCount = h.queue.reads.length; select(['queue:one']); tree = await h.settle();
    assert.equal(h.queue.reads.length, readCount); assert.equal(component(tree, 'QueuePanel'), undefined);
    assert.equal(h.pageHeader.querySelectorAll('[aria-label="Back"]').length, 0);
    h.dispose(); assert.equal(h.queue.listeners.size, 0); assert.deepEqual(h.env.forbiddenCalls, []);
  }
});

function nativeHistory() {
  const {installPrivateContext} = require('./runtime/private-context-harness.cjs');
  const home = {dataset: {accountName: 'Current listener'}}, shell = {dataset: {nativeAccountId: 'account', nativeLibraryId: 'library'}};
  const nodes = new Map([['mobile-home', home], ['app-shell', shell]]), replacements = [];
  const window = {location: new URL('https://albumhaven.test/?surface=home'), addEventListener() {}, dispatchEvent() {},
    history: {state: {albumHavenNavigationPosition: 9},
      replaceState(value) {this.state = value; replacements.push(value);},
      pushState() {assert.fail('presentation must not add history entries');}, back() {assert.fail('presentation must not traverse browser history');}}};
  const context = vm.createContext({window, document: {getElementById: id => nodes.get(id)}, URL, Event, AbortController,
    state: {view: {recent_local_albums: [], recent_not_local_albums: []}, ui: {}}, shouldShowMobileHome: () => true,
    fetch() {assert.fail('saving presentation cannot read a provider');}, escapeHtml: String});
  installPrivateContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(homeSource, '../runtime/home-friends-bridge.js'), 'utf8'), context);
  return {bridge: window.AlbumHavenHomeRuntime, window, replacements};
}

test('native history roundtrip restores Queue occurrences through a fresh owner and preserves the separate Recent entry', async t => {
  const history = nativeHistory(), queue = queuedSource(), h = homeFixture({kind: 'tracks'}, queue); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onTracksSelect(['recent:one']); tree = h.render();
  h.env.click(buttonNamed(h.nodes.get('artist'), /^Full size$/)); h.render();
  tree = h.section('queue'); component(tree, 'QueuePanel').props.onSelect(['queue:one']); tree = await h.settle();
  h.env.click(buttonNamed(h.nodes.get('recent'), /^Full size$/)); h.render();
  const pending = h.saves.at(-1);
  assert.equal(history.bridge.savePresentation({...pending, provider_dto: {private_media: '/private/song.flac'}}, history.bridge.snapshot()), true);
  assert.equal(history.window.history.state.albumHavenNavigationPosition, 9);
  const saved = plain(history.bridge.snapshot().presentation);
  assert.equal(saved.selectionPresentation.length, 2, 'the native serializer must not merge Queue into Recent');
  assert.doesNotMatch(JSON.stringify(saved), /provider_dto|private_media|queue:album|queue:artist|\/private\//);
  const readsBefore = queue.reads.length;
  h.dispose(); assert.equal(queue.listeners.size, 0);
  const replay = homeFixture(saved, queue); t.after(replay.dispose);
  tree = replay.render(); tree = await replay.settle(); assertOwnQueue(tree);
  assert.deepEqual(plain(component(tree, 'QueuePanel').props.selectedIds), ['queue:one']);
  assert.equal(replay.dashboard.getAttribute('data-dashboard-expanded-key'), 'recent');
  assert.ok(queue.reads.length > readsBefore, 'restoration must refresh the captured occurrence through the actual Queue authority');
  const current = find(tree, node => node.type?.name === 'ResourceDetail' && node.props.selection?.kind === 'album');
  assert.equal(current.props.selection.ref, 'queue:album');
  replay.env.click(buttonNamed(replay.pageHeader, /^Back$/)); replay.render();
  tree = replay.section('recent');
  assert.equal(component(tree, 'ActivityPanel').props.selectedTrackIds[0], 'recent:one');
  assert.equal(replay.dashboard.getAttribute('data-dashboard-expanded-key'), 'artist');
  assert.equal(history.window.history.state.albumHavenNavigationPosition, 9);
});

test('removed or unreadable saved Queue occurrences do not return from history and unmount cannot steal focus', async t => {
  for (const entries of [[], [{id: 'queue:one', sourceReadable: false}]]) {
    const queue = queuedSource(); queue.replace({entries});
    const presentation = {kind: 'tracks', homeSection: 'queue', selectionPresentation: [{
      query: {section: 'recent', account_ref: null, kind: 'tracks', period: 'week', homeSection: 'queue'},
      tracks: {rowIds: ['queue:one'], snapshotRef: null}, pane: 'album', expanded: 'album'}]};
    const h = homeFixture(presentation, queue); t.after(h.dispose);
    let tree = h.render(); tree = await h.settle();
    assertOwnQueue(tree); assert.deepEqual(plain(component(tree, 'QueuePanel').props.selectedIds), []);
    assert.equal(component(tree, 'ResourceDetail'), undefined);
    assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null);
    assert.deepEqual(queue.reads, []);
    const foreground = h.env.document.createElement('button'); h.env.document.body.append(foreground);
    h.env.document.activeElement = foreground; h.dispose();
    assert.equal(h.env.document.activeElement, foreground); assert.equal(queue.listeners.size, 0);
    assert.deepEqual(h.env.forbiddenCalls, []);
  }
});

test('embedded native AlbumDetails puts its page action first while retaining the native lease and Close owner', () => {
  const h = createNativeHomeRuntime(), c = h.context, d = h.document;
  c.Node.prototype.before = function (node) {this.parentNode.insertBefore(node, this);};
  c.Node.prototype.replaceWith = function (node) {this.before(node); this.remove();};
  d.createComment = () => new c.Node(8);
  c.addEventListener = d.addEventListener.bind(d); c.removeEventListener = d.removeEventListener.bind(d);
  const overlay = d.createElement('div'); overlay.id = 'track-modal'; overlay.hidden = true;
  const dialog = d.createElement('div'); dialog.className = 'track-modal-dialog';
  dialog.innerHTML = c.buildAlbumDetailsHeaderHtml({artist: 'Native artist', album: 'Native Album',
    titleId: 'embedded-title', subtitleId: 'embedded-subtitle', actionsHtml: ['Play', 'More', 'Close'].map(label =>
      c.ButtonComponent.renderActionButton({ariaLabel: label, icon: label === 'Close' ? 'close' : 'more'})).join('')});
  overlay.append(dialog); const host = d.createElement('section'); d.body.append(overlay, host);
  c.state = {ui: {}, modalReleases: [], modalReleaseIndex: 0};
  c.renderTrackModalRelease = () => {};
  // Rendering the existing native header above is sufficient for the lease
  // decorator; clearing unrelated table markup is outside this header seam.
  c.getTrackModalElements = () => ({overlay});
  vm.runInContext(fs.readFileSync(path.resolve(homeSource, '../runtime/track-modal-lightbox-helpers.js'), 'utf8'), c);
  const actions = dialog.querySelector('.album-details-header__actions'), close = buttonNamed(actions, /^Close$/);
  let pageCalls = 0, closeCalls = 0; close.addEventListener('click', () => closeCalls++);
  const lease = c.acquireTrackModalSelection(host, {key: 'native:one', tracks: []}, {
    isCurrent: () => true, canPlay: () => true, canPage: () => true, onPage: () => pageCalls++, canOpen: () => false});
  assert.ok(lease); assert.equal(host.firstElementChild, dialog);
  assert.deepEqual(labels(actions), ['Full size', 'Play', 'More', 'Close']);
  h.click(buttonNamed(actions, /^Full size$/).querySelector('svg')); assert.equal(pageCalls, 1); assert.equal(closeCalls, 0);
  h.click(close); assert.equal(closeCalls, 1); assert.equal(pageCalls, 1);
  // A newer content owner prevents release from clearing its state, while the
  // actual lease still restores the retained dialog and header nodes.
  c.state.ui.pendingTrackModalLoadToken++;
  lease.release(); assert.equal(overlay.firstElementChild, dialog); assert.equal(buttonNamed(actions, /^Close$/), close);
  assert.deepEqual(h.forbiddenCalls, []);
});

function dashboardActionHidingSelectors(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => /\bdisplay:\s*none\s*(?:!important)?\s*;/.test(declarations))
    .flatMap(([, selectors]) => selectors.split(',').map(selector => selector.trim()))
    .filter(selector => selector.includes('[data-dashboard-action]'));
}
function narrowHomeSelectors() {
  const css = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/css/runtime/home-friends.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const media = css.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(media, 'Home owns its existing narrow pane breakpoint');
  return dashboardActionHidingSelectors(media);
}

test('Home narrow suppression covers its Dashboard actions without hiding generic consumers', () => {
  const h = nativeWidgets({backHost: true}), expand = buttonNamed(h.widgets[0].header, /^Full size$/);
  assert.equal(expand.getAttribute('data-dashboard-action'), 'expand');
  h.owner.update({expandedKey: 'album'});
  const back = buttonNamed(h.pageHeader, /^Back$/), embedded = h.widgets[0].body.firstElementChild;
  assert.equal(back.getAttribute('data-dashboard-action'), 'back');
  assert.equal(h.root.contains(back), false, 'the generic consumer can also use an external header');
  const selectors = narrowHomeSelectors();
  assert.ok(selectors.length, 'the pane-owning Home surface suppresses its desktop actions at narrow widths');
  const shared = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/css/runtime/dashboard.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const control of [expand, back]) {
    assert.equal(selectors.some(selector => control.matches(selector)), false, 'Home-specific suppression excludes a generic Dashboard');
    assert.equal(dashboardActionHidingSelectors(shared).some(selector => control.matches(selector)), false,
      'generic Dashboard does not hide controls for consumers without an alternative pane navigator');
  }
  assert.equal(selectors.some(selector => embedded.matches(selector)), false);
  h.click(back); assert.deepEqual(h.intents, [['album', null]], 'generic return remains available to its controlled owner');
  assert.equal(buttonNamed(h.pageHeader, /^Back$/), back);
  h.owner.dispose();
  assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
});

test('desktop expansion remains saved across narrow pane navigation while external Dashboard Back shares suppression', async t => {
  const h = homeFixture(); t.after(h.dispose);
  let tree = h.section('queue'); component(tree, 'QueuePanel').props.onSelect(['queue:one']); tree = await h.settle();
  h.env.click(buttonNamed(h.nodes.get('album'), /^Full size$/)); tree = h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'album');
  tree = h.resize(390);
  const externalBack = buttonNamed(h.pageHeader, /^Back$/), selectors = narrowHomeSelectors();
  assert.ok(selectors.some(selector => externalBack.matches(selector)), 'Home suppression includes its external page-header Back');
  const ordinaryExpand = buttonNamed(h.nodes.get('recent'), /^Full size$/);
  assert.ok(selectors.some(selector => ordinaryExpand.matches(selector)), 'Home retains suppression of ordinary widget expansion');
  assert.equal(tree.props['data-home-pane'], 'recent');
  find(tree, node => node.props.id === 'home-selected-sections').props.onChange('artist'); tree = h.render();
  assert.equal(tree.props['data-home-pane'], 'artist');
  const paneNavigation = find(tree, node => hasClass(node, 'home-friends__pane-navigation'));
  const back = find(paneNavigation, node => node.type?.name === 'Button' && node.props.icon === 'back');
  assert.equal(back.props.children, 'Back to Queue'); assert.equal(back.props.disabled, false);
  back.props.onClick(); tree = h.render();
  assert.equal(tree.props['data-home-pane'], 'recent');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'album', 'narrow pane return does not overwrite desktop expansion');
  tree = h.resize(1200); assertOwnQueue(tree);
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'album');
  assert.equal(buttonNamed(h.pageHeader, /^Back$/), externalBack);
  assert.deepEqual(h.navigation, []); assert.deepEqual(h.env.forbiddenCalls, []);
  // The media-query selector and actual retained component state are tested.
  // Visibility after CSS cascade and painted placement still require a browser.
});

test('controlled focus follows only outgoing Dashboard controls and disposal preserves embedded focus', () => {
  const h = nativeWidgets({backHost: true}), focusCalls = [];
  const prototype = h.context.HTMLElement.prototype, originalFocus = prototype.focus;
  prototype.focus = function (options) {focusCalls.push({node: this, options}); if (this.isConnected) h.document.activeElement = this;};
  try {
    const expand = buttonNamed(h.widgets[0].header, /^Full size$/);
    h.document.activeElement = expand;
    h.click(expand.querySelector('svg'));
    assert.equal(h.document.activeElement, expand); assert.equal(focusCalls.length, 0, 'an intent cannot move focus before its controlled update');
    h.owner.update({expandedKey: 'album'});
    const back = buttonNamed(h.pageHeader, /^Back$/);
    assert.equal(h.document.activeElement, back); assert.equal(focusCalls.length, 1);
    assert.deepEqual(plain(focusCalls[0].options), {preventScroll: true});
    h.owner.update({expandedKey: 'album'}); assert.equal(focusCalls.length, 1, 'an unchanged expansion does not refocus');
    h.click(back.querySelector('svg')); assert.equal(h.document.activeElement, back);
    h.owner.update({expandedKey: null});
    assert.equal(buttonNamed(h.widgets[0].header, /^Full size$/), expand);
    assert.equal(h.document.activeElement, expand); assert.equal(focusCalls.length, 2);
    assert.deepEqual(plain(focusCalls[1].options), {preventScroll: true});
    const embedded = h.widgets[0].body.firstElementChild;
    h.document.activeElement = embedded;
    h.owner.update({expandedKey: 'album'}); h.owner.update({expandedKey: 'artist'});
    assert.equal(h.document.activeElement, embedded); assert.equal(focusCalls.length, 2);
    const retiredBack = buttonNamed(h.pageHeader, /^Back$/), intents = plain(h.intents);
    h.owner.dispose(); h.owner.dispose(); h.click(retiredBack); h.click(expand); h.owner.update({expandedKey: 'album'});
    assert.deepEqual(plain(h.intents), intents); assert.equal(h.document.activeElement, embedded); assert.equal(focusCalls.length, 2);
    assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
    assert.deepEqual(h.forbiddenCalls, []);
  } finally {prototype.focus = originalFocus; h.owner.dispose();}
});
