const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const flush = () => new Promise(setImmediate);

function setup(width = 390) {
  const nodes = new Map(), historyEntries = [{state: {albumHavenNavigationPosition: 0}, url: 'https://albumhaven.test/?surface=playlists'}];
  let position = 0, queuedTraversal = null, context, capturePop = null;
  const document = {getElementById: id => nodes.get(id), querySelectorAll: () => [],
    createElement: tag => node(tag), createComment: () => node(), addEventListener() {}, removeEventListener() {}};
  function node(tag = 'div') {
    const attributes = new Map(), listeners = new Map(), classes = new Set();
    const element = {tagName: tag.toUpperCase(), hidden: false, inert: false, disabled: false, isConnected: true,
      style: {}, dataset: {}, children: [], parentNode: null, listeners,
      classList: {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, value) {if (value) classes.add(name); else classes.delete(name);}},
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null,
      hasAttribute: name => attributes.has(name),
      removeAttribute: name => attributes.delete(name), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, getClientRects: () => [{}],
      appendChild(child) {child.parentNode?.removeChild(child); this.children.push(child); child.parentNode = this;},
      removeChild(child) {this.children = this.children.filter(value => value !== child); child.parentNode = null;},
      replaceChildren(...children) {this.innerHTML = ''; children.forEach(child => this.appendChild(child));},
      before(child) {const parent = this.parentNode; child.parentNode?.removeChild(child); parent.children.splice(parent.children.indexOf(this), 0, child); child.parentNode = parent;},
      replaceWith(child) {this.before(child); this.parentNode.removeChild(this);},
      set innerHTML(_value) {this.children.forEach(child => {child.parentNode = null;}); this.children = [];},
      focus() {document.activeElement = this;}};
    return element;
  }
  document.body = node('body'); document.activeElement = node('button'); const trigger = document.activeElement;
  for (const id of ['app-shell', 'shell-main-surface', 'mobile-page-header', 'mobile-page-outlet', 'mobile-page-title', 'mobile-page-summary',
    'mobile-back-button', 'mobile-library-button', 'mobile-settings-actions', 'mobile-settings-button',
    'app-form-modal', 'app-form-title', 'app-form-content', 'app-form-error', 'app-form-cancel', 'app-form-submit']) nodes.set(id, node());
  const modal = nodes.get('app-form-modal'), panel = node();
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
  document.body.appendChild(modal); modal.appendChild(panel); panel.appendChild(nodes.get('app-form-content'));
  modal.querySelector = () => panel; modal.hidden = true;
  const window = {innerWidth: width, location: new URL(historyEntries[0].url),
    addEventListener(name, handler, capture) {if (name === 'popstate' && capture) capturePop = handler;}, removeEventListener() {}, history: {
    get state() {return historyEntries[position].state;},
    pushState(state, _title, url) {historyEntries.splice(position + 1); historyEntries.push({state, url: String(url)}); position++; window.location.href = String(url);},
    replaceState(state, _title, url) {historyEntries[position] = {state, url: String(url)}; window.location.href = String(url);},
    go(delta) {assert.equal(queuedTraversal, null, 'only one parent traversal may be pending'); queuedTraversal = delta;},
  }};
  window.AlbumHavenSettingsNavigation = {instance: {pushLibraryHistory(url, state) {
    window.history.pushState({...state, albumHavenNavigationPosition: position + 1}, '', url);
  }}};
  const restorations = [];
  context = vm.createContext({document, window, URL, Promise, AbortController,
    state: {view: {}, utility: {activeTab: 'appearance'}}, buildUrl: () => '/?surface=playlists',
    requestAnimationFrame: callback => callback(), closeArtistsDrawer() {}, closeGalleryMainSurface() {},
    handleGalleryBootstrapPopState: options => restorations.push(options),
    bindOverlayPointerOrigin() {}, overlayClickStartedOnOverlay: (_modal, event) => event.backdrop === true});
  for (const name of ['browser-dialog-helpers.js', 'mobile-navigation.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', name), 'utf8'), context);
  }
  context.syncMobileAlbumHeader = () => {}; context.syncMobileLoopHeader = () => {};
  function traverse(delta) {
    assert.ok(position + delta >= 0 && position + delta < historyEntries.length);
    position += delta; window.location.href = historyEntries[position].url;
    let stopped = false;
    capturePop?.({stopImmediatePropagation() {stopped = true;}});
    return stopped || context.handleMobilePagePopState();
  }
  return {context, document, window, nodes, node, modal, panel, trigger, historyEntries, restorations,
    get position() {return position;}, get queuedTraversal() {return queuedTraversal;},
    traverse, flushHistory(delta = queuedTraversal) {queuedTraversal = null; assert.notEqual(delta, null); return traverse(delta);}};
}

function installSettings(h) {
  const host = h.node(), outlet = h.node(), nav = h.node(), requests = [], listeners = new Map();
  host.hidden = true;
  h.document.addEventListener = (name, listener) => listeners.set(name, listener);
  h.document.querySelector = selector => ({'[data-settings-host]': host, '[data-settings-outlet]': outlet,
    '[data-settings-nav]': nav, '#app-shell': h.nodes.get('app-shell')})[selector] || null;
  h.window.NavigationTree = {setSelection() {}};
  h.window.fetch = async url => {requests.push(url); return {ok: true, status: 200, url, headers: {get: () => 'text/html'}, text: async () => 'Account'};};
  h.window.DOMParser = class {parseFromString() {
    const content = h.node(); content.childNodes = [];
    return {title: 'Account', querySelector: selector => selector === '[data-settings-outlet]' ? content
      : selector === '[data-settings-nav]' ? nav : null};
  }};
  // Browsers expose classic-script functions on window; the VM keeps it explicit.
  for (const name of ['getActiveAppFormPage', 'handleMobilePagePopState', 'handleGalleryBootstrapPopState', 'deferAppFormPageReplacement',
    'isMobileFormReturning', 'cancelSupersededMobileFormReturn']) h.window[name] = h.context[name];
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/settings-navigation.js'), 'utf8'), h.context);
  return {host, requests, navigation: h.window.AlbumHavenSettingsNavigation.instance, click: event => listeners.get('click')(event)};
}

test('an opt-in form transfers one live host and header across breakpoints with opaque history only', async () => {
  const h = setup(1180); let host;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', title: 'Create Playlist', onMount(value) {host = value;}});
  assert.strictEqual(h.nodes.get('app-form-content').children[0], host);
  assert.equal(h.panel.getAttribute('role'), 'dialog'); assert.equal(h.nodes.get('mobile-page-header').hidden, true);
  const snapshot = h.window.history.state.mobilePages[0];
  assert.deepEqual(Object.keys(snapshot).sort(), ['formToken', 'kind']);
  assert.equal(JSON.stringify(h.window.history.state).includes('Create Playlist'), false);
  h.window.innerWidth = 390; h.context.syncMobilePageShell();
  assert.strictEqual(h.modal.parentNode, h.nodes.get('mobile-page-outlet'));
  assert.equal(h.panel.getAttribute('role'), 'region'); assert.equal(h.panel.getAttribute('aria-modal'), null);
  assert.equal(h.nodes.get('mobile-page-title').textContent, 'Create Playlist');
  const event = {key: 'Tab', preventDefault() {throw new Error('A mobile form page must not trap the persistent player');}};
  h.modal.listeners.get('keydown')(event);
  h.window.innerWidth = 1180; h.context.syncMobilePageShell();
  assert.strictEqual(h.modal.parentNode, h.document.body); assert.equal(h.panel.getAttribute('role'), 'dialog');
  assert.strictEqual(h.nodes.get('app-form-content').children[0], host);
  const closing = owner.close(null, {force: true, restoreFocus: false});
  assert.equal(h.queuedTraversal, -1); h.flushHistory(); await closing; await owner.promise;
});

test('denied browser Back restores the existing position, then accepted Back retires Forward permanently', async () => {
  const h = setup(); let decide, prompts = 0;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss(reason) {
    assert.ok(['history', 'back'].includes(reason)); prompts++; return new Promise(resolve => {decide = resolve;});
  }});
  const token = h.window.history.state.mobilePages[0].formToken;
  h.traverse(-1); await flush(); assert.equal(prompts, 1); assert.equal(h.modal.hidden, false);
  decide(false); await flush(); assert.equal(h.queuedTraversal, 1);
  h.flushHistory(); assert.equal(h.position, 1); assert.equal(h.historyEntries.length, 2);
  assert.equal(h.context.getActiveAppFormPage().token, token);
  h.context.navigateMobileBack(); h.context.navigateMobileBack(); await flush(); assert.equal(prompts, 2);
  decide(true); await flush(); assert.equal(h.modal.hidden, true); assert.equal(h.queuedTraversal, -1);
  let settled = false; owner.promise.then(() => {settled = true;}); await flush(); assert.equal(settled, false);
  h.flushHistory(); await owner.promise; assert.equal(h.position, 0);
  assert.equal(h.historyEntries.length, 2, 'native return does not manufacture a duplicate parent entry');
  assert.equal(h.context.getActiveAppFormPage(), null);
  h.traverse(1); assert.equal(h.modal.hidden, true); assert.equal(h.context.getActiveAppFormPage(), null);
  assert.deepEqual(Array.from(h.window.history.state.mobilePages), []);
});

test('forced completion awaits the parent return before the next native route is pushed', async () => {
  const h = setup(), owner = h.context.openReactFormDialog({pageId: 'create-playlist'});
  let navigated = false;
  const completed = Promise.resolve(owner.close(null, {force: true, restoreFocus: false})).then(() => {
    h.window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory('https://albumhaven.test/?surface=playlists&playlist=created', {mobilePages: []});
    navigated = true;
  });
  await flush(); assert.equal(navigated, false); assert.equal(h.modal.hidden, true);
  h.flushHistory(); await completed;
  assert.equal(h.position, 1); assert.equal(h.historyEntries.length, 2);
  h.traverse(-1); assert.equal(h.position, 0); assert.match(h.window.location.href, /surface=playlists$/);
});

test('scope disposal clears a pending draft without a traversal or stale confirmation resurrection', async () => {
  const h = setup(); let accept;
  const old = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  const decision = old.dismiss('discard'); await flush();
  old.close(null, {force: true, restoreFocus: false, returnToParent: false}); await old.promise;
  assert.equal(h.queuedTraversal, null); assert.equal(h.modal.hidden, true);
  const next = h.context.openReactFormDialog({pageId: 'create-playlist', title: 'New scope'});
  const token = h.context.getActiveAppFormPage().token;
  accept(true); assert.equal(await decision, false);
  assert.equal(h.context.getActiveAppFormPage().token, token); assert.equal(h.modal.hidden, false);
  next.close(null, {force: true, restoreFocus: false, returnToParent: false}); await next.promise;
});

test('replacement search waits for one guarded dismissal and the same native parent return', async () => {
  const h = setup(); let accept, searches = 0;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  assert.equal(h.context.prepareMobileGallerySearch(() => {searches++;}), false);
  assert.equal(h.context.prepareMobileGallerySearch(() => {searches++;}), false);
  await flush(); accept(true); await flush(); assert.equal(searches, 0);
  assert.equal(h.context.prepareMobileGallerySearch(() => {searches += 100;}), false);
  h.flushHistory(); await owner.promise; await flush(); assert.equal(searches, 1);
});

test('a scope change suppresses a deferred opener even before React teardown arrives', async () => {
  const h = setup(); let accept, opened = 0;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  assert.ok(h.context.deferAppFormPageReplacement(() => {opened++;}));
  await flush(); h.nodes.get('app-shell').dataset.nativeAccountId = 'new-account';
  accept(true); await flush(); await owner.promise;
  assert.equal(opened, 0); assert.equal(h.modal.hidden, true); assert.equal(h.queuedTraversal, null);
});

test('Settings capture traversal confirms before hiding the library and reuses the committed destination', async () => {
  const h = setup(), settings = installSettings(h);
  h.window.history.replaceState({albumHavenNavigationPosition: 0}, '', 'https://albumhaven.test/account');
  settings.navigation.pushLibraryHistory('https://albumhaven.test/?surface=playlists', {});
  let accept;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  h.traverse(-2); await flush();
  assert.equal(settings.requests.length, 0); assert.equal(settings.host.hidden, true); assert.equal(h.modal.hidden, false);
  accept(false); await flush(); assert.equal(h.queuedTraversal, 2); h.flushHistory();
  assert.equal(h.position, 2); assert.equal(settings.requests.length, 0);
  h.traverse(-2); await flush(); accept(true); await flush(); await owner.promise;
  assert.equal(settings.requests.length, 1); assert.match(settings.requests[0], /\/account$/);
  assert.equal(settings.host.hidden, false); assert.equal(h.nodes.get('app-shell').hidden, true);
  assert.equal(h.position, 0); assert.equal(h.historyEntries.length, 3);
});

test('Settings click navigation waits for the shared form return and cannot replay after a scope change', async () => {
  const h = setup(), settings = installSettings(h); let accept;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  const navigation = settings.navigation.navigate('/account'); await flush();
  assert.equal(settings.requests.length, 0);
  h.nodes.get('app-shell').dataset.nativeLibraryId = 'new-library'; accept(true); await flush(); await owner.promise;
  assert.equal(await navigation, false);
  assert.equal(settings.requests.length, 0); assert.equal(settings.host.hidden, true); assert.equal(h.queuedTraversal, null);
});

test('a scope change during native return prevents old parent restoration and trigger focus', async () => {
  const h = setup(), owner = h.context.openReactFormDialog({pageId: 'create-playlist'});
  const closing = owner.close(null, {force: true});
  const nextFocus = h.node(); nextFocus.focus();
  h.nodes.get('app-shell').dataset.nativeAccountId = 'new-account';
  h.flushHistory(); await closing;
  assert.equal(h.restorations.length, 0); assert.strictEqual(h.document.activeElement, nextFocus);
});

for (const [file, opener, args] of [
  ['track-modal-lightbox-helpers.js', 'openTrackModal', [{key: 'album-original'}]],
  ['utility-loaders-and-cover-lookup.js', 'openUtilityModal', []],
  ['modal-and-overlay-helpers.js', 'openNonAlbumModal', []],
  ['cover-lookup-modal-and-drawer.js', 'openCoverLookupModal', [{key: 'album-original'}]],
]) test(`${opener} asks before any existing opener state mutation`, async () => {
  const h = setup(); let accept, prompts = 0;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), h.context);
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss() {prompts++; return new Promise(resolve => {accept = resolve;});}});
  // These openers cannot proceed in this minimal fixture; a pre-gate mutation
  // would touch their real missing dependencies instead of the form owner.
  await h.context[opener](...args); await h.context[opener](...args); await flush();
  assert.equal(prompts, 1); assert.equal(h.modal.hidden, false);
  accept(false); await flush(); assert.equal(h.modal.hidden, false);
  owner.close(null, {force: true, restoreFocus: false, returnToParent: false}); await owner.promise;
});

test('source-scoped Album opening asks before catalog lookup or source receipt allocation', async () => {
  const h = setup(); let accept, keyReads = 0, receiptReads = 0;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/track-modal-lightbox-helpers.js'), 'utf8'), h.context);
  h.context.getAlbumRequestKey = album => {keyReads++; return album.key;};
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  await h.context.openTrackModal({key: 'album-original'}, {
    presentationRestrictions: {can_play_album: false}, sourcePageOwner: {isCurrent() {receiptReads++; return true;}},
  });
  await flush();
  assert.equal(keyReads, 0); assert.equal(receiptReads, 0);
  assert.equal(vm.runInContext('trackModalSourcePageSequence', h.context), 0);
  assert.equal(h.context.getTrackModalSourcePageOwner(), null);
  accept(false); await flush(); assert.equal(h.modal.hidden, false);
  assert.equal(keyReads, 0); assert.equal(receiptReads, 0);
  owner.close(null, {force: true, restoreFocus: false, returnToParent: false}); await owner.promise;
});

for (const kind of ['artist', 'all-artists']) test(`${kind} navigation asks before cached or optimistic mutations and replays once`, async () => {
  const h = setup(), changes = [];
  const restore = h.context.handleGalleryBootstrapPopState;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/bootstrap-gallery-event-handlers.js'), 'utf8'), h.context);
  h.context.handleGalleryBootstrapPopState = restore;
  Object.assign(h.context.state, {ui: {}, gallery: {}, view: {selected_artist: 'Artist', query: '', artists_sidebar: []}});
  Object.assign(h.context, {hideVersionContextMenu() {}, renderSidebar() {}, renderRelated() {}, renderLibraryLoader() {}, renderArtistGroups() {},
    scheduleBrowserAnimationFrame: callback => callback(),
    applyImmediateSidebarArtistSelection: () => true,
    tryRenderOptimisticSidebarArtistSelection() {changes.push('optimistic'); return true;},
    getReusableRootBrowseView: view => ({...view, cached: true}),
    applyViewPayload: () => changes.push('cached'), pushBrowserViewState: () => changes.push('history'),
    buildApiUrl: () => '/view-data', fetchAndRender: async () => true});
  const selector = kind === 'artist' ? '[data-sidebar-artist]' : '[data-sidebar-all-artists="1"]';
  const link = h.node('a'); link.getAttribute = () => 'Artist';
  const event = {target: {closest: value => value === selector ? link : null}, prevented: false, preventDefault() {this.prevented = true;}};
  const click = () => kind === 'artist' ? h.context.handleSidebarArtistSelectionClick(event) : h.context.handleGalleryBootstrapClick(event);
  let accept, prompts = 0;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss() {prompts++; return new Promise(resolve => {accept = resolve;});}});
  const before = JSON.stringify(h.context.state);
  click(); assert.equal(event.prevented, true); await flush();
  assert.equal(JSON.stringify(h.context.state), before); assert.deepEqual(changes, []);
  accept(false); await flush(); assert.equal(h.modal.hidden, false); assert.deepEqual(changes, []);
  click(); click(); await flush(); assert.equal(prompts, 2);
  accept(true); await flush(); assert.deepEqual(changes, []);
  h.flushHistory(); await owner.promise; await flush();
  assert.deepEqual(changes, kind === 'artist' ? ['optimistic'] : ['cached', 'history']);
});

test('the persistent brand link prevents default immediately and navigates only after accepted return', async () => {
  const h = setup(), settings = installSettings(h), destinations = [];
  h.window.location.assign = url => destinations.push(url);
  const brand = h.node('a'); brand.classList.add('app-bar-brand'); brand.setAttribute('href', '/'); brand.href = 'https://albumhaven.test/';
  brand.closest = selector => selector === 'a[href]' ? brand : null;
  const click = () => {
    const event = {target: brand, button: 0, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}};
    settings.click(event); return event;
  };
  assert.equal(click().defaultPrevented, false, 'the ordinary brand link keeps its default navigation');
  let accept;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  assert.equal(click().defaultPrevented, true); await flush(); accept(false); await flush();
  assert.deepEqual(destinations, []); assert.equal(h.modal.hidden, false);
  assert.equal(click().defaultPrevented, true); await flush(); accept(true); await flush();
  assert.deepEqual(destinations, []); h.flushHistory(); await owner.promise; await flush();
  assert.deepEqual(destinations, ['https://albumhaven.test/']);
});

for (const result of [true, false]) test(`a deferred push request preserves its awaited ${result} result`, async () => {
  const h = setup(); let accept, resolveRequest, requests = 0;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8'), h.context);
  const original = h.context.fetchAndRender, options = {preserveScroll: true};
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => new Promise(resolve => {accept = resolve;})});
  let settled = false;
  const request = original('/view-data?surface=albums', true, options).then(value => {settled = true; return value;});
  assert.equal(await original('/view-data?surface=albums', true, options), false, 'a duplicate is cancelled, without a second replay');
  h.context.fetchAndRender = (url, push, actualOptions) => {
    requests++; assert.equal(url, '/view-data?surface=albums'); assert.equal(push, true); assert.strictEqual(actualOptions, options);
    return new Promise(resolve => {resolveRequest = resolve;});
  };
  await flush(); assert.equal(settled, false); accept(true); await flush(); assert.equal(requests, 0);
  h.flushHistory(); await owner.promise; await flush();
  assert.equal(requests, 1); assert.equal(settled, false);
  resolveRequest(result); assert.equal(await request, result);
});

test('non-push background refresh never asks to discard the active form', async () => {
  const h = setup(); let prompts = 0, entered = 0;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8'), h.context);
  Object.assign(h.context.state, {busy: true, ui: {activeViewRequestUrl: '/view-data?background=1', activeViewRequestTagEditMutationRevision: 0}});
  h.context.cancelTrackModalAlbumDetailsPrewarms = () => {entered++;};
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss() {prompts++; return false;}});
  assert.equal(await h.context.fetchAndRender('/view-data?background=1', false, {startupRefresh: true}), false);
  assert.equal(entered, 1); assert.equal(prompts, 0); assert.equal(h.modal.hidden, false);
  owner.close(null, {force: true, restoreFocus: false, returnToParent: false}); await owner.promise;
});

test('a newer committed history destination cancels the prior close result and trigger focus', async () => {
  const h = setup(); h.window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory('https://albumhaven.test/?surface=albums', {});
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist'});
  const closing = owner.close('saved', {force: true});
  assert.equal(h.queuedTraversal, -1);
  const nextFocus = h.node(); nextFocus.focus();
  h.flushHistory(-2);
  assert.equal(await closing, false); assert.equal(await owner.promise, null);
  assert.equal(h.position, 0); assert.equal(h.restorations.length, 0); assert.strictEqual(h.document.activeElement, nextFocus);
});

test('a newer Back handled by Settings cancels deferred opener replay', async () => {
  const h = setup(), settings = installSettings(h); let opens = 0;
  h.window.history.replaceState({albumHavenNavigationPosition: 0}, '', 'https://albumhaven.test/account');
  settings.navigation.pushLibraryHistory('https://albumhaven.test/?surface=playlists', {});
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => true});
  const replacement = h.context.deferAppFormPageReplacement(() => {opens++; return true;});
  await flush(); assert.equal(h.queuedTraversal, -1);
  h.flushHistory(-2); assert.equal(await replacement, false); await owner.promise; await flush();
  assert.equal(opens, 0); assert.equal(settings.host.hidden, false); assert.equal(settings.requests.length, 1); assert.equal(h.position, 0);
});

test('a declined push request resolves false without entering the gallery request pipeline', async () => {
  const h = setup();
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8'), h.context);
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss: () => false});
  const before = JSON.stringify(h.context.state);
  assert.equal(await h.context.fetchAndRender('/view-data?surface=albums', true), false);
  assert.equal(JSON.stringify(h.context.state), before); assert.equal(h.modal.hidden, false);
  owner.close(null, {force: true, restoreFocus: false, returnToParent: false}); await owner.promise;
});
